/**
 * The environment's world (BT54): ambient conditions, a gas grid and a heat grid over the room,
 * point sources (gas leak, heater, flame, lamp, sound, fan) and bodies (people, objects).
 * Coordinates are metres in the room, y down, the same orientation as the bench (bench mm ×
 * scale / 1000). Deterministic: the same steps give the same fields.
 *
 * Physics (decided, simple and fast):
 * - Gas: ppm above the ambient baseline. A leak of `rate` L/min of pure gas fills one cell
 *   column (cell² × the mixing layer, 0.3 m by default — the grids are 2D, so the layer stands
 *   for how far it spreads vertically near the source): +rate/60 000 / V × 10⁶ ppm/s there. It diffuses with the
 *   room's turbulent mixing coefficient and decays at ventilation ACH / 3600 per second. A fan
 *   draws `flow` m³/min from the air within FAN_REACH_M of it (the cells whose centres lie in
 *   that disc, the mixing layer deep): each of them decays at flow / 60 / (their volume) per
 *   second — the grids have no air currents, so this stands for the room air moving toward it.
 * - Heat: °C above the ambient. A heater of `watts` W adds watts / (ρ·cp·V) °C/s to its cell
 *   column (ρ·cp = 1200 J/m³K); a flame adds 80 W per unit of strength. The same mixing
 *   coefficient diffuses it; it decays at ventilation/3600 + heatLoss per second.
 * - Humidity: the ambient's absolute humidity, so RH falls where it's warmer (Magnus formula).
 * - Light: ambient lux + Σ lumens / (4π r²) per lamp (a flame gives 12 lm per unit of strength),
 *   r ≥ 5 cm, no occlusion.
 * - Sound: L = L₁ − 20·log₁₀(r / 1 m) per source (r ≥ 10 cm), added as energies with the
 *   ambient level.
 * - Flame infrared: Σ strength·(0.2 m / r)² over flames inside the sensor's cone, at most 1.
 * - Distance: the nearest body inside the sensor's cone (exact wedge test); motion: a warm body
 *   walking inside the cone.
 */

import { patrolAt, type Patrol } from './bodies.ts';
import { nearestInCone, pointInCone, type Shape } from './cone.ts';
import { FieldGrid } from './grid.ts';
import type { AmbientSpec, PointField, SourceKind } from './spec.ts';

/** ρ·cp of air, J/(m³·K). */
export const AIR_HEAT_CAPACITY = 1200;
/** Heat of a flame per unit of strength, W (a candle). */
export const FLAME_WATTS = 80;
/** Light of a flame per unit of strength, lm (a candle). */
export const FLAME_LUMENS = 12;
/** Distance at which a unit flame saturates a flame sensor, m. */
export const FLAME_IR_REFERENCE_M = 0.2;
/** Smallest distance used by the inverse-square laws, m. */
export const MIN_LIGHT_DISTANCE_M = 0.05;
export const MIN_SOUND_DISTANCE_M = 0.1;
/** How far a fan draws air from, m. */
export const FAN_REACH_M = 0.5;
/** Cells along the room's longer side, and the smallest cell, m. */
export const GRID_CELLS = 64;
export const MIN_CELL_M = 0.05;

/** Saturation vapour pressure over water, hPa (Magnus, Sonntag 1990 constants). */
export function saturationPressure(celsius: number): number {
  return 6.112 * Math.exp((17.62 * celsius) / (243.12 + celsius));
}

export interface WorldSource {
  readonly id: string;
  readonly kind: SourceKind;
  readonly x: number;
  readonly y: number;
  on: boolean;
  readonly params: Record<string, number>;
}

export interface WorldBody {
  readonly id: string;
  readonly shape: Shape;
  readonly warm: boolean;
  readonly patrol: Patrol;
  on: boolean;
  /** Seconds walked so far (advances only while on). */
  walked: number;
  /** Current speed, m/s. */
  speed: number;
}

export interface WorldExtent {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export class World {
  readonly ambient: AmbientSpec;
  /** Top-left corner of the grids, m. */
  readonly ox: number;
  readonly oy: number;
  readonly gas: FieldGrid;
  readonly heat: FieldGrid;
  readonly sources: WorldSource[] = [];
  readonly bodies: WorldBody[] = [];
  /** Seconds simulated. */
  time = 0;
  private readonly pos = new Float64Array(2);

  /** A world over `extent` (m; the grids cover it with GRID_CELLS cells along the longer side). */
  constructor(ambient: AmbientSpec, extent: WorldExtent) {
    this.ambient = { ...ambient };
    const width = Math.max(extent.x1 - extent.x0, MIN_CELL_M);
    const height = Math.max(extent.y1 - extent.y0, MIN_CELL_M);
    const cell = Math.max(MIN_CELL_M, Math.max(width, height) / GRID_CELLS);
    const w = Math.max(1, Math.ceil(width / cell));
    const h = Math.max(1, Math.ceil(height / cell));
    this.ox = extent.x0;
    this.oy = extent.y0;
    this.gas = new FieldGrid(w, h, cell);
    this.heat = new FieldGrid(w, h, cell);
    this.applyAmbient();
  }

  /** Cell column volume, m³ (cell² × the mixing layer, at least 5 cm). */
  get cellVolume(): number {
    return this.gas.dx * this.gas.dx * Math.max(0.05, this.ambient.layer);
  }

  addSource(id: string, kind: SourceKind, x: number, y: number, params: Readonly<Record<string, number>>, on: boolean): WorldSource {
    const source: WorldSource = { id, kind, x, y, on, params: { ...params } };
    this.sources.push(source);
    this.applySources();
    return source;
  }

  addBody(id: string, shape: Shape, warm: boolean, patrol: Patrol, on: boolean): WorldBody {
    const body: WorldBody = { id, shape: { ...shape, x: patrol.x0, y: patrol.y0 }, warm, patrol, on, walked: 0, speed: 0 };
    this.bodies.push(body);
    return body;
  }

  /** Re-reads the ambient's mixing and ventilation into the grids. */
  applyAmbient(): void {
    const a = this.ambient;
    const vent = Math.max(0, a.ventilation) / 3600;
    this.gas.diffusion = Math.max(0, a.mixing);
    this.heat.diffusion = Math.max(0, a.mixing);
    this.gas.decay = vent;
    this.heat.decay = vent + Math.max(0, a.heatLoss);
    this.applySources();
  }

  /** Rewrites the grids' source and sink terms from the sources (after any change to one). */
  applySources(): void {
    const { gas, heat } = this;
    gas.source.fill(0);
    gas.sink.fill(0);
    heat.source.fill(0);
    const volume = this.cellVolume;
    for (const s of this.sources) {
      if (!s.on) continue;
      const lx = s.x - this.ox;
      const ly = s.y - this.oy;
      const cell = gas.cellOf(lx, ly);
      switch (s.kind) {
        case 'gas':
          gas.source[cell] += (Math.max(0, s.params.rate ?? 0) / 60_000 / volume) * 1e6;
          break;
        case 'heat':
          heat.source[cell] += (s.params.watts ?? 0) / (AIR_HEAT_CAPACITY * volume);
          break;
        case 'flame':
          heat.source[cell] += (Math.max(0, s.params.strength ?? 0) * FLAME_WATTS) / (AIR_HEAT_CAPACITY * volume);
          break;
        case 'fan': {
          // The cells within reach (at least the fan's own), each taking an equal share.
          const reach = Math.max(FAN_REACH_M, gas.dx / 2);
          const cells: number[] = [];
          for (let y = 0; y < gas.h; y++) {
            for (let x = 0; x < gas.w; x++) {
              if (Math.hypot((x + 0.5) * gas.dx - lx, (y + 0.5) * gas.dx - ly) <= reach + 1e-9) cells.push(y * gas.w + x);
            }
          }
          if (cells.length === 0) cells.push(cell);
          const rate = Math.max(0, s.params.flow ?? 0) / 60 / (cells.length * volume);
          for (const c of cells) gas.sink[c] += rate;
          break;
        }
        default:
          break;
      }
    }
    gas.wake();
    heat.wake();
  }

  /** Advances bodies and grids by `dt` seconds. */
  step(dt: number): void {
    if (!(dt > 0)) return;
    this.time += dt;
    for (const body of this.bodies) {
      if (body.on) body.walked += dt;
      this.placeBody(body);
    }
    this.gas.step(dt);
    this.heat.step(dt);
  }

  /** Puts a body at its patrol position for its walked time (and its speed: 0 while stopped). */
  placeBody(body: WorldBody): void {
    const speed = patrolAt(body.patrol, body.walked, this.pos);
    body.shape.x = this.pos[0];
    body.shape.y = this.pos[1];
    body.speed = body.on ? speed : 0;
  }

  gasAt(x: number, y: number): number {
    return this.ambient.gas + Math.max(0, this.gas.sample(x - this.ox, y - this.oy));
  }

  temperatureAt(x: number, y: number): number {
    return this.ambient.temperature + this.heat.sample(x - this.ox, y - this.oy);
  }

  humidityAt(x: number, y: number): number {
    const t = this.temperatureAt(x, y);
    const rh = (this.ambient.humidity * saturationPressure(this.ambient.temperature)) / saturationPressure(t);
    return Math.min(100, Math.max(0, rh));
  }

  lightAt(x: number, y: number): number {
    let lux = Math.max(0, this.ambient.light);
    for (const s of this.sources) {
      if (!s.on) continue;
      const lumens = s.kind === 'light' ? (s.params.lumens ?? 0) : s.kind === 'flame' ? (s.params.strength ?? 0) * FLAME_LUMENS : 0;
      if (!(lumens > 0)) continue;
      const r = Math.max(MIN_LIGHT_DISTANCE_M, Math.hypot(s.x - x, s.y - y));
      lux += lumens / (4 * Math.PI * r * r);
    }
    return lux;
  }

  soundAt(x: number, y: number): number {
    let energy = 10 ** (this.ambient.sound / 10);
    for (const s of this.sources) {
      if (!s.on || s.kind !== 'sound') continue;
      const r = Math.max(MIN_SOUND_DISTANCE_M, Math.hypot(s.x - x, s.y - y));
      energy += 10 ** (((s.params.db ?? 0) - 20 * Math.log10(r)) / 10);
    }
    return 10 * Math.log10(energy);
  }

  /** The value of a point field at (x, y). */
  fieldAt(field: PointField, x: number, y: number): number {
    switch (field) {
      case 'gas':
        return this.gasAt(x, y);
      case 'temperature':
        return this.temperatureAt(x, y);
      case 'humidity':
        return this.humidityAt(x, y);
      case 'light':
        return this.lightAt(x, y);
      case 'sound':
        return this.soundAt(x, y);
    }
  }

  /** Infrared reaching a flame sensor at (x, y) facing (fx, fy), 0..1. */
  flameAt(x: number, y: number, fx: number, fy: number, halfAngle: number, range: number): number {
    let ir = 0;
    for (const s of this.sources) {
      if (!s.on || s.kind !== 'flame') continue;
      if (!pointInCone(s.x, s.y, x, y, fx, fy, halfAngle, range)) continue;
      const r = Math.max(MIN_LIGHT_DISTANCE_M, Math.hypot(s.x - x, s.y - y));
      ir += Math.max(0, s.params.strength ?? 0) * (FLAME_IR_REFERENCE_M / r) ** 2;
    }
    return Math.min(1, ir);
  }

  /** Distance to the nearest body inside the cone, m, or Infinity. */
  distanceAt(x: number, y: number, fx: number, fy: number, halfAngle: number, range: number): number {
    let best = Infinity;
    for (const body of this.bodies) best = Math.min(best, nearestInCone(body.shape, x, y, fx, fy, halfAngle, range));
    return best;
  }

  /** 1 while a warm body walks inside the cone, else 0. */
  motionAt(x: number, y: number, fx: number, fy: number, halfAngle: number, range: number): number {
    for (const body of this.bodies) {
      if (!body.warm || !(body.speed > 0)) continue;
      if (nearestInCone(body.shape, x, y, fx, fy, halfAngle, range) < Infinity) return 1;
    }
    return 0;
  }
}
