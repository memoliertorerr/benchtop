/**
 * The environment on a bench (BT54): built from the document when it holds a part whose
 * `envSpecFor` role is `ambient`. Every ENV_PERIOD_NS of simulated time the bench calls
 * `tick()`: sources follow their control pins, the world steps, and every sensor gets what the
 * world holds at its position through the input it already takes — only when the value moved
 * by more than its epsilon, so an analog island isn't re-solved for nothing. Inputs to the
 * ambient part, a source or a body change the world (channels `set:<name>=<v>`, press/release
 * switch it). Visuals: bodies' offsets from their document position (bench mm, in the part's own
 * unrotated frame), sources' on/off, and the
 * ambient part's packed heatmap at most HEATMAP_PERIOD_NS apart while its overlay is on.
 */

import type { PartDefinition, PartInput, PartProps, VisualState } from '../contracts/part.ts';
import type { PartInstance } from '../contracts/project.ts';
import { type Nanos, NS_PER_MS } from '../contracts/time.ts';
import type { Shape } from './cone.ts';
import {
  type AmbientSpec,
  type EnvCone,
  type EnvSample,
  type EnvSpec,
  type EnvSpecFor,
  FOLLOW_ENV_PROP,
  OVERLAY_FIELDS,
  type PointField,
  type SourceSpec,
} from './spec.ts';
import { World, type WorldBody, type WorldSource } from './world.ts';

/** Simulated time between world steps and sensor samples. */
export const ENV_PERIOD_NS = 50 * NS_PER_MS;
/** Simulated time between heatmap visuals while an overlay is on. */
export const HEATMAP_PERIOD_NS = 250 * NS_PER_MS;
/** Smallest gap between a part and the room's wall, m (the room grows to keep it). */
export const ROOM_EDGE_MARGIN_M = 0.25;
/** Control input threshold, volts across IN–GND. */
export const CONTROL_ON_VOLTS = 1.5;

/** What the runtime needs from the bench. */
export interface EnvHost {
  /** Delivers an input to a sensor part's model. */
  deliver(partId: string, input: PartInput): void;
  /** Volts on a part pin's net, or undefined when the pin is on no net. */
  pinVolts(partId: string, pin: string): number | undefined;
  /** True when the pin's net holds other pins (something is wired to it). */
  pinWired(partId: string, pin: string): boolean;
}

interface SensorSlot {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  /** Facing, unit vector (local −y rotated with the part). */
  readonly fx: number;
  readonly fy: number;
  readonly samples: readonly EnvSample[];
  readonly cone: EnvCone | undefined;
  readonly last: Float64Array;
}

interface SourceSlot {
  readonly id: string;
  readonly spec: SourceSpec;
  readonly x: number;
  readonly y: number;
  readonly controlled: boolean;
  source: WorldSource | null;
  shownOn: boolean | null;
}

interface BodySlot {
  readonly id: string;
  readonly x0: number;
  readonly y0: number;
  readonly shape: Shape;
  readonly warm: boolean;
  readonly patrol: { x1: number; y1: number; speed: number; pause: number };
  readonly on: boolean;
  body: WorldBody | null;
  shownX: number;
  shownY: number;
  readonly sizeW: number;
  readonly sizeH: number;
  /** The part's rotation: offsets are reported in its own (unrotated) frame. */
  readonly rotation: number;
}

/** Bench mm (part centre) → room metres with the ambient's scale. */
function centreOf(part: PartInstance, def: PartDefinition, scale: number): { x: number; y: number } {
  return { x: ((part.x + def.size.w / 2) * scale) / 1000, y: ((part.y + def.size.h / 2) * scale) / 1000 };
}

/** A facing in the part's own frame turned clockwise by its rotation (y down; geometry.ts's rule). */
function facingOf(rotation: number, local: { x: number; y: number } = { x: 0, y: -1 }): { fx: number; fy: number } {
  const { x, y } = local;
  switch (rotation) {
    case 90:
      return { fx: -y, fy: x };
    case 180:
      return { fx: -x, fy: -y };
    case 270:
      return { fx: y, fy: -x };
    default:
      return { fx: x, fy: y };
  }
}

/** Packs bytes four to a number (b0 + b1·2⁸ + b2·2¹⁶ + b3·2²⁴), as the SSD1306 framebuffer does. */
export function packBytes(bytes: Uint8Array): number[] {
  const out: number[] = new Array(Math.ceil(bytes.length / 4));
  for (let i = 0; i < out.length; i++) {
    const j = i * 4;
    out[i] = (bytes[j] ?? 0) + (bytes[j + 1] ?? 0) * 0x100 + (bytes[j + 2] ?? 0) * 0x10000 + (bytes[j + 3] ?? 0) * 0x1000000;
  }
  return out;
}

/** The inverse of packBytes into `out` (length = the cell count). */
export function unpackBytes(packed: readonly number[], out: Uint8Array): void {
  for (let i = 0; i < out.length; i++) {
    const word = packed[i >> 2] ?? 0;
    out[i] = Math.floor(word / 0x100 ** (i & 3)) & 0xff;
  }
}

/** A field value → 0..255 for the heatmap (fixed scales, so colours mean the same everywhere). */
export function heatByte(field: PointField, value: number, ambient: AmbientSpec): number {
  let t: number;
  switch (field) {
    case 'gas': // log scale above the baseline, 10 000 ppm full
      t = Math.log10(1 + Math.max(0, value - ambient.gas)) / 4;
      break;
    case 'temperature': // 0..+20 °C above the ambient
      t = (value - ambient.temperature) / 20;
      break;
    case 'humidity':
      t = value / 100;
      break;
    case 'light': // log lux, 1..100 000
      t = Math.log10(Math.max(1, value)) / 5;
      break;
    case 'sound': // 30..110 dB
      t = (value - 30) / 80;
      break;
  }
  return Math.round(255 * Math.min(1, Math.max(0, t)));
}

export class EnvRuntime {
  readonly ambientId: string;
  private readonly ambientSpec: AmbientSpec;
  private world: World;
  private readonly sensors: SensorSlot[] = [];
  private readonly sources: SourceSlot[] = [];
  private readonly bodies: BodySlot[] = [];
  private readonly extent: { x0: number; y0: number; x1: number; y1: number };
  private readonly host: EnvHost;
  /** Bench time of the last step, ns. */
  private lastStep: Nanos = 0;
  private lastHeatmap: Nanos = -Infinity;
  private overlay: number;
  private heatmapDirty = true;
  private heatBytes: Uint8Array = new Uint8Array(0);
  /** Parts the runtime owns (inputs go to the world, not a model). */
  private readonly owned = new Set<string>();

  /**
   * A runtime for the document, or null when it has no ambient part. `duplicate` receives the
   * ids of ambient parts after the first (only the first is used).
   */
  static build(
    parts: readonly PartInstance[],
    defOf: (type: string) => PartDefinition | undefined,
    envSpecFor: EnvSpecFor,
    host: EnvHost,
    duplicate: (ids: string[]) => void,
  ): EnvRuntime | null {
    const specs: { part: PartInstance; def: PartDefinition; spec: EnvSpec; props: PartProps }[] = [];
    for (const part of parts) {
      const def = defOf(part.type);
      if (def === undefined) continue;
      const props = { ...def.defaults, ...part.props };
      const spec = envSpecFor(part.type, props);
      if (spec !== undefined) specs.push({ part, def, spec, props });
    }
    const ambients = specs.filter((s) => s.spec.role === 'ambient');
    if (ambients.length === 0) return null;
    if (ambients.length > 1) duplicate(ambients.slice(1).map((s) => s.part.id));
    return new EnvRuntime(ambients[0], specs, host);
  }

  private constructor(
    ambient: { part: PartInstance; spec: EnvSpec },
    specs: readonly { part: PartInstance; def: PartDefinition; spec: EnvSpec; props: PartProps }[],
    host: EnvHost,
  ) {
    if (ambient.spec.role !== 'ambient') throw new Error('not an ambient part');
    this.host = host;
    this.ambientId = ambient.part.id;
    this.ambientSpec = { ...ambient.spec.ambient };
    this.owned.add(this.ambientId);
    this.overlay = this.ambientSpec.overlay;
    const scale = this.ambientSpec.scale > 0 ? this.ambientSpec.scale : 10;
    const toWorld = (mm: number): number => (mm * scale) / 1000;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    const include = (x: number, y: number): void => {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    };
    for (const { part, def, spec, props } of specs) {
      const { x, y } = centreOf(part, def, scale);
      switch (spec.role) {
        case 'ambient':
          break;
        case 'sensor': {
          if (props[FOLLOW_ENV_PROP] === false) break;
          include(x, y);
          const { fx, fy } = facingOf(part.rotation, spec.cone?.facing);
          this.sensors.push({ id: part.id, x, y, fx, fy, samples: spec.samples, cone: spec.cone, last: new Float64Array(spec.samples.length).fill(Number.NaN) });
          break;
        }
        case 'source': {
          include(x, y);
          const control = spec.source.control;
          const controlled = control !== undefined && host.pinWired(part.id, control.pin);
          this.sources.push({ id: part.id, spec: spec.source, x, y, controlled, source: null, shownOn: null });
          this.owned.add(part.id);
          break;
        }
        case 'body': {
          const b = spec.body;
          const quarter = part.rotation === 90 || part.rotation === 270;
          const shape: Shape =
            b.shape.kind === 'circle'
              ? { kind: 'circle', x, y, r: b.shape.radius, hw: 0, hh: 0 }
              : { kind: 'box', x, y, r: 0, hw: (quarter ? b.shape.h : b.shape.w) / 2, hh: (quarter ? b.shape.w : b.shape.h) / 2 };
          const ex = x + toWorld(b.toX);
          const ey = y + toWorld(b.toY);
          include(x, y);
          include(ex, ey);
          const sizeW = b.shape.kind === 'circle' ? (2 * b.shape.radius * 1000) / scale : (2 * shape.hw * 1000) / scale;
          const sizeH = b.shape.kind === 'circle' ? sizeW : (2 * shape.hh * 1000) / scale;
          this.bodies.push({
            id: part.id,
            x0: x,
            y0: y,
            shape,
            warm: b.warm,
            patrol: { x1: ex, y1: ey, speed: b.speed, pause: b.pause },
            on: b.on,
            body: null,
            shownX: Number.NaN,
            shownY: Number.NaN,
            sizeW,
            sizeH,
            rotation: part.rotation,
          });
          this.owned.add(part.id);
          break;
        }
      }
    }
    if (!Number.isFinite(x0)) {
      const { x, y } = centreOf(ambient.part, specs.find((s) => s.part.id === ambient.part.id)!.def, scale);
      x0 = x1 = x;
      y0 = y1 = y;
    }
    // The room: its floor centred on the parts, grown to hold them all with a margin.
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const halfW = Math.max(0.25, this.ambientSpec.roomWidth || 0) / 2;
    const halfD = Math.max(0.25, this.ambientSpec.roomDepth || 0) / 2;
    this.extent = {
      x0: Math.min(cx - halfW, x0 - ROOM_EDGE_MARGIN_M),
      y0: Math.min(cy - halfD, y0 - ROOM_EDGE_MARGIN_M),
      x1: Math.max(cx + halfW, x1 + ROOM_EDGE_MARGIN_M),
      y1: Math.max(cy + halfD, y1 + ROOM_EDGE_MARGIN_M),
    };
    this.world = this.makeWorld();
  }

  private makeWorld(): World {
    const world = new World(this.ambientSpec, this.extent);
    for (const slot of this.sources) {
      slot.source = world.addSource(slot.id, slot.spec.kind, slot.x, slot.y, slot.spec.params, slot.controlled ? false : slot.spec.on);
      slot.shownOn = null;
    }
    for (const slot of this.bodies) {
      const p = slot.patrol;
      slot.body = world.addBody(slot.id, slot.shape, slot.warm, { x0: slot.x0, y0: slot.y0, x1: p.x1, y1: p.y1, speed: p.speed, pause: p.pause }, slot.on);
      world.placeBody(slot.body);
      slot.shownX = Number.NaN;
      slot.shownY = Number.NaN;
    }
    return world;
  }

  /** The world as it is now (for queries; don't keep it across a reset). */
  get current(): World {
    return this.world;
  }

  /** True for parts whose inputs the runtime takes (the ambient part, sources and bodies). */
  owns(partId: string): boolean {
    return this.owned.has(partId);
  }

  /** Back to the document's state at time 0, and the sensors told what the world holds. */
  reset(): void {
    this.world = this.makeWorld();
    this.overlay = this.ambientSpec.overlay;
    this.lastStep = 0;
    this.lastHeatmap = -Infinity;
    this.heatmapDirty = true;
    for (const s of this.sensors) s.last.fill(Number.NaN);
    this.readControls();
    this.sample();
  }

  /** One period: controls, a world step to `now`, samples. */
  tick(now: Nanos): void {
    const dt = (now - this.lastStep) / 1e9;
    this.lastStep = now;
    this.readControls();
    this.world.step(dt);
    this.sample();
    this.heatmapDirty = true;
  }

  /** An input for a part the runtime owns. */
  input(partId: string, event: PartInput): void {
    const world = this.world;
    const channel = readChannel(event);
    if (partId === this.ambientId) {
      if (channel === null) return;
      const a = world.ambient;
      if (channel.name === 'overlay') {
        this.overlay = Math.max(0, Math.min(OVERLAY_FIELDS.length - 1, Math.round(channel.value)));
        this.heatmapDirty = true;
        this.lastHeatmap = -Infinity;
        return;
      }
      if (channel.name in a && channel.name !== 'scale') {
        (a as unknown as Record<string, number>)[channel.name] = channel.value;
        world.applyAmbient();
        this.sample();
      }
      return;
    }
    const source = this.sources.find((s) => s.id === partId);
    if (source !== undefined && source.source !== null) {
      const s = source.source;
      if (event.kind === 'press' || event.kind === 'release') {
        if (!source.controlled) s.on = event.kind === 'press';
      } else if (channel !== null) {
        if (channel.name === 'on') {
          if (!source.controlled) s.on = channel.value !== 0;
        } else if (channel.name in s.params) {
          s.params[channel.name] = channel.value;
        }
      }
      world.applySources();
      this.sample();
      return;
    }
    const body = this.bodies.find((b) => b.id === partId);
    if (body !== undefined && body.body !== null && channel !== null) {
      const b = body.body;
      if (channel.name === 'on') b.on = channel.value !== 0;
      else if (channel.name === 'speed') {
        // Keep the distance walked so the body doesn't jump (exact while walking, pauses aside).
        if (b.patrol.speed > 0 && channel.value > 0) b.walked *= b.patrol.speed / channel.value;
        b.patrol.speed = channel.value;
      }
      else if (channel.name === 'pause') b.patrol.pause = channel.value;
      world.placeBody(b);
      this.sample();
    }
  }

  /** The value of a point field at a part's centre (its world position). */
  sampleAt(partId: string, field: PointField): number | undefined {
    const sensor = this.sensors.find((s) => s.id === partId);
    if (sensor !== undefined) return this.world.fieldAt(field, sensor.x, sensor.y);
    const source = this.sources.find((s) => s.id === partId);
    if (source !== undefined) return this.world.fieldAt(field, source.x, source.y);
    const body = this.bodies.find((b) => b.id === partId);
    if (body?.body != null) return this.world.fieldAt(field, body.body.shape.x, body.body.shape.y);
    return undefined;
  }

  /** Visual states that changed (appended to `out`). */
  collect(out: [string, VisualState][], now: Nanos): void {
    for (const slot of this.sources) {
      const on = slot.source?.on ?? false;
      if (on !== slot.shownOn) {
        slot.shownOn = on;
        out.push([slot.id, { on }]);
      }
    }
    for (const slot of this.bodies) {
      const b = slot.body;
      if (b === null) continue;
      if (b.shape.x === slot.shownX && b.shape.y === slot.shownY) continue;
      slot.shownX = b.shape.x;
      slot.shownY = b.shape.y;
      const scale = this.scale;
      const wx = ((b.shape.x - slot.x0) * 1000) / scale;
      const wy = ((b.shape.y - slot.y0) * 1000) / scale;
      // World offset → the part's own frame (the view moves its drawing inside the rotated wrapper).
      const [dx, dy] = slot.rotation === 90 ? [wy, -wx] : slot.rotation === 180 ? [-wx, -wy] : slot.rotation === 270 ? [-wy, wx] : [wx, wy];
      out.push([slot.id, { dx: dx + 0, dy: dy + 0, walking: b.speed > 0, sizeW: slot.sizeW, sizeH: slot.sizeH }]);
    }
    if (this.heatmapDirty && now - this.lastHeatmap >= HEATMAP_PERIOD_NS) {
      this.lastHeatmap = now;
      this.heatmapDirty = false;
      out.push([this.ambientId, this.heatmap()]);
    }
  }

  private get scale(): number {
    return this.ambientSpec.scale > 0 ? this.ambientSpec.scale : 10;
  }

  /** The ambient part's visual: the overlay's field over the grid, packed, in bench mm. */
  private heatmap(): VisualState {
    const field = OVERLAY_FIELDS[this.overlay] ?? null;
    if (field === null) return { overlay: 0 };
    const world = this.world;
    const { w, h, dx } = world.gas;
    if (this.heatBytes.length !== w * h) this.heatBytes = new Uint8Array(w * h);
    const bytes = this.heatBytes;
    for (let cy = 0; cy < h; cy++) {
      for (let cx = 0; cx < w; cx++) {
        const x = world.ox + (cx + 0.5) * dx;
        const y = world.oy + (cy + 0.5) * dx;
        bytes[cy * w + cx] = heatByte(field, world.fieldAt(field, x, y), world.ambient);
      }
    }
    const k = 1000 / this.scale;
    return { overlay: this.overlay, hmW: w, hmH: h, hmX: world.ox * k, hmY: world.oy * k, hmCell: dx * k, hm: packBytes(bytes) };
  }

  /** Sources with a wired control input follow it. */
  private readControls(): void {
    let changed = false;
    for (const slot of this.sources) {
      const control = slot.spec.control;
      if (!slot.controlled || control === undefined || slot.source === null) continue;
      const vin = this.host.pinVolts(slot.id, control.pin) ?? 0;
      const vgnd = control.ground === undefined ? 0 : (this.host.pinVolts(slot.id, control.ground) ?? 0);
      const on = vin - vgnd > CONTROL_ON_VOLTS;
      if (on !== slot.source.on) {
        slot.source.on = on;
        changed = true;
      }
    }
    if (changed) this.world.applySources();
  }

  /** Delivers every sensor's samples that changed beyond their epsilon. */
  private sample(): void {
    const world = this.world;
    for (const sensor of this.sensors) {
      for (let i = 0; i < sensor.samples.length; i++) {
        const spec = sensor.samples[i];
        const raw = this.read(world, sensor, spec);
        if (spec.deliver.kind === 'press-while') {
          if (raw > 0) this.host.deliver(sensor.id, PRESS);
          continue;
        }
        const value = spec.map === undefined ? raw : spec.map(raw);
        const last = sensor.last[i];
        if (!Number.isNaN(last) && Math.abs(value - last) <= spec.epsilon) continue;
        sensor.last[i] = value;
        this.host.deliver(
          sensor.id,
          spec.deliver.kind === 'value' ? { kind: 'value', value } : { kind: 'key', key: `set:${spec.deliver.channel}=${value}`, down: true },
        );
      }
    }
  }

  private read(world: World, s: SensorSlot, spec: EnvSample): number {
    const half = ((s.cone?.halfAngleDeg ?? 30) * Math.PI) / 180;
    const range = s.cone?.range ?? 4;
    switch (spec.field) {
      case 'flame':
        return world.flameAt(s.x, s.y, s.fx, s.fy, half, range);
      case 'distance': {
        const d = world.distanceAt(s.x, s.y, s.fx, s.fy, half, range);
        return Number.isFinite(d) ? d : 0;
      }
      case 'motion':
        return world.motionAt(s.x, s.y, s.fx, s.fy, half, range);
      default:
        return world.fieldAt(spec.field, s.x, s.y);
    }
  }
}

const PRESS: PartInput = Object.freeze({ kind: 'press' });

/** A channel input `set:<name>=<number>` (the channel-input convention), or null. */
function readChannel(event: PartInput): { name: string; value: number } | null {
  if (event.kind !== 'key' || !event.down) return null;
  const match = /^set:([a-zA-Z][a-zA-Z0-9_-]*)=(.+)$/.exec(event.key);
  if (match === null) return null;
  const value = match[2] === 'true' ? 1 : match[2] === 'false' ? 0 : Number(match[2]);
  return Number.isFinite(value) ? { name: match[1], value } : null;
}
