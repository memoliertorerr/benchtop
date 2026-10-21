/**
 * Wokwi diagram.json → ProjectDoc (BT38), from Wokwi's published format
 * (docs.wokwi.com/diagram-format, read 2026-10-20) — an interchange file format, read for
 * interoperability; nothing of Wokwi's code is used:
 *   { version: 1, author, editor, parts: [{ id, type, left, top, rotate?, attrs?, hide? }],
 *     connections: [[from "part:pin", to "part:pin", color, route?]] }
 *
 * Parts: `type` maps to a catalog type (TYPES below; some by attrs — an LCD with `pins: "i2c"`,
 * a 7-segment's `digits`, a NeoPixel matrix's rows × cols); `left`/`top` are px → mm (÷ 96/25.4,
 * the unit our pin tables use); `rotate` snaps to a multiple of 90°; known attrs become props,
 * unknown ones warnings. Ids that don't fit ours (`[a-z][a-z0-9_-]{0,31}`) are rewritten.
 * Connections: each becomes a wire whose waypoints are the route's explicit moves — before
 * `*` from the source pin, after it from the target pin in reverse order (px → mm) — our
 * router fills the gap with orthogonal segments as Wokwi does. An empty color is a hidden
 * wire: imported green, with a warning.
 *
 * Breadboards: Wokwi records a part plugged into a breadboard as connections with the route
 * `["$bb"]`. Our breadboard has its own geometry and touching pins connect, so the importer
 * moves the part by the mean of its `$bb` pins' offsets to their holes; when every pin then
 * lies within CONTACT_MM of its hole (parts whose pin spacing is a hair off the 2.54 mm grid,
 * like the LED's 2.646 mm, still fit) no wire is drawn; otherwise the connections become wires
 * and a warning says so.
 *
 * The input is a user file: every shape problem is a warning (the item is skipped) or the
 * single error result; nothing throws. The result goes through parseProject before it's used.
 */

import { COLOR_PATTERN, CONTACT_MM, ID_PATTERN, parseProject, partPointToWorld, type PartDefinition, type PartInstance, type ProjectDoc, type Wire } from '@benchtop/core';
import { CATALOG } from '../catalog.ts';

/** Wokwi's px per mm (CSS px: 96 per inch). */
export const WOKWI_PX_PER_MM = 96 / 25.4;
const MAX_PARTS = 500;
const MAX_CONNECTIONS = 2000;

export type WokwiImport = { ok: true; doc: ProjectDoc; warnings: string[] } | { ok: false; error: string; warnings: string[] };

type Attrs = Readonly<Record<string, string>>;
type PropValue = string | number | boolean;
/** An attr's prop: [name, value], or a warning string. */
type AttrMap = (value: string) => [string, PropValue] | string;

interface Mapping {
  /** Our type for these attrs, or why the part can't come in. */
  type: string | ((attrs: Attrs) => string | { unsupported: string });
  attrs?: Readonly<Record<string, AttrMap>>;
}

const num =
  (prop: string, scale = 1): AttrMap =>
  (v) => {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? [prop, n * scale] : `"${v}" is not a number`;
  };
const text =
  (prop: string): AttrMap =>
  (v) => [prop, v];
const ohms: AttrMap = (v) => {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([kKM]?)\s*(?:Ω|ohms?)?\s*$/.exec(v);
  if (m === null) return `"${v}" is not a resistance`;
  const scale = m[2] === 'M' ? 1e6 : m[2] === '' ? 1 : 1e3;
  return ['ohms', Number.parseFloat(m[1]) * scale];
};
/** Wokwi's 0–1023 slider positions → our 0–1. */
const fraction: AttrMap = (v) => {
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? ['value', Math.min(1, Math.max(0, n / 1023))] : `"${v}" is not a number`;
};
const flag =
  (prop: string): AttrMap =>
  (v) => [prop, v === '1' || v === 'true'];
const i2cAddress: AttrMap = (v) => (/^0x[0-9a-fA-F]{1,2}$/.test(v) ? ['address', `0x${v.slice(2).toUpperCase().padStart(2, '0')}`] : `"${v}" is not an I2C address`);

const LCD_ATTRS: Readonly<Record<string, AttrMap>> = {
  pins: () => ['', ''], // chose the type
  i2cAddress,
  background: text('background'),
};
const lcd =
  (base: string): Mapping['type'] =>
  (attrs) =>
    attrs.pins === 'i2c' ? `${base}-i2c` : base;

/** Wokwi part type → ours. Element names per @wokwi/elements 1.9.2, as our views use them. */
const TYPES: Readonly<Record<string, Mapping>> = {
  'wokwi-arduino-uno': { type: 'arduino-uno' },
  'wokwi-arduino-nano': { type: 'arduino-nano' },
  'wokwi-arduino-mega': { type: 'arduino-mega' },
  'wokwi-esp32-devkit-v1': { type: 'esp32-devkit-v1' },
  'wokwi-breadboard': { type: 'breadboard' },
  'wokwi-breadboard-half': { type: 'breadboard-half' },
  'wokwi-breadboard-mini': { type: 'breadboard-mini' },
  'wokwi-resistor': { type: 'resistor', attrs: { value: ohms } },
  'wokwi-led': { type: 'led', attrs: { color: text('color') } },
  'wokwi-rgb-led': { type: 'rgb-led', attrs: { common: text('common') } },
  'wokwi-pushbutton': { type: 'pushbutton', attrs: { color: text('color') } },
  'wokwi-slide-switch': { type: 'slide-switch', attrs: { value: num('value') } },
  'wokwi-potentiometer': { type: 'potentiometer', attrs: { value: fraction } },
  'wokwi-slide-potentiometer': { type: 'slide-potentiometer', attrs: { value: fraction } },
  'wokwi-buzzer': { type: 'buzzer' },
  'wokwi-servo': { type: 'servo' },
  'wokwi-stepper-motor': { type: 'stepper-bipolar' },
  'wokwi-ks2e-m-dc5': { type: 'relay-ks2e-m-dc5' },
  'wokwi-lcd1602': { type: lcd('lcd1602'), attrs: LCD_ATTRS },
  'wokwi-lcd2004': { type: lcd('lcd2004'), attrs: LCD_ATTRS },
  'board-ssd1306': { type: 'ssd1306', attrs: { i2cAddress } },
  'wokwi-ili9341': { type: 'ili9341' },
  'wokwi-ir-receiver': { type: 'ir-receiver' },
  'wokwi-ir-remote': { type: 'ir-remote' },
  'wokwi-hx711': { type: 'hx711', attrs: { type: text('type') } },
  'wokwi-flame-sensor': { type: 'flame-sensor' },
  'wokwi-gas-sensor': { type: 'gas-sensor' },
  'wokwi-ssd1306': { type: 'ssd1306', attrs: { i2cAddress } },
  'wokwi-7segment': {
    type: (a) => {
      const digits = a.digits ?? '1';
      return digits === '1' ? 'seven-segment' : digits === '2' ? 'seven-segment-2' : digits === '4' ? 'seven-segment-4' : { unsupported: `${digits} digits (Benchtop has 1, 2 and 4)` };
    },
    attrs: { digits: () => ['', ''], common: text('common'), color: text('color'), colon: flag('colon') },
  },
  'wokwi-led-bar-graph': { type: 'led-bar-graph', attrs: { color: text('color') } },
  'wokwi-analog-joystick': { type: 'analog-joystick' },
  'wokwi-ky-040': { type: 'ky-040' },
  'wokwi-membrane-keypad': { type: 'membrane-keypad' },
  'wokwi-dip-switch-8': { type: 'dip-switch-8' },
  'wokwi-tilt-switch': { type: 'tilt-switch' },
  'wokwi-pir-motion-sensor': { type: 'pir-motion-sensor', attrs: { delayTime: num('holdMs', 1000), inhibitTime: num('blockMs', 1000) } },
  'wokwi-photoresistor-sensor': { type: 'photoresistor-sensor', attrs: { lux: num('lux') } },
  'wokwi-ntc-temperature-sensor': { type: 'ntc-temperature-sensor', attrs: { temperature: num('temperature'), beta: num('beta') } },
  'wokwi-small-sound-sensor': { type: 'small-sound-sensor' },
  'wokwi-big-sound-sensor': { type: 'big-sound-sensor' },
  'wokwi-dht22': { type: 'dht22', attrs: { temperature: num('temperature'), humidity: num('humidity') } },
  'wokwi-hc-sr04': { type: 'hc-sr04', attrs: { distance: num('distance') } },
  'wokwi-ds1307': { type: 'ds1307' },
  'wokwi-mpu6050': { type: 'mpu6050' },
  'wokwi-neopixel-matrix': {
    type: (a) => {
      const rows = a.rows ?? '8';
      const cols = a.cols ?? '8';
      if (rows === '1' && cols === '8') return 'neopixel-strip';
      if (rows === '8' && cols === '8') return 'neopixel-matrix';
      return { unsupported: `a ${rows}×${cols} matrix (Benchtop has 1×8 and 8×8)` };
    },
    attrs: { rows: () => ['', ''], cols: () => ['', ''], serpentine: flag('serpentine') },
  },
  'wokwi-led-ring': { type: (a) => ((a.pixels ?? '16') === '16' ? 'neopixel-ring' : { unsupported: `a ${a.pixels}-pixel ring (Benchtop has 16)` }), attrs: { pixels: () => ['', ''] } },
};

/** The Wokwi part types the importer knows (tests check them against the catalog). */
export const WOKWI_TYPES: readonly string[] = Object.keys(TYPES);

interface PlacedPart {
  part: PartInstance;
  def: PartDefinition;
  /** The Wokwi id it came from. */
  wokwiId: string;
}

interface Endpoint {
  placed: PlacedPart;
  pin: string;
}

const round = (v: number): number => Math.round(v * 1000) / 1000;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Wokwi ids → ours: lowercase, other characters → '-', a letter first, ≤ 32, unique. */
function idFor(raw: string, taken: Set<string>): string {
  let id = raw.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  if (!/^[a-z]/.test(id)) id = `p-${id}`;
  id = id.slice(0, 32);
  for (let n = 2; taken.has(id) || !ID_PATTERN.test(id); n++) id = `${id.slice(0, 28)}-${n}`;
  taken.add(id);
  return id;
}

function pinWorld(placed: PlacedPart, pin: string): { x: number; y: number } {
  const def = placed.def.pins.find((p) => p.name === pin)!;
  return partPointToWorld(placed.part, placed.def.size, { x: def.x, y: def.y });
}

/** Parses a Wokwi diagram (already JSON-parsed) into a project. Never throws. */
export function importWokwiDiagram(json: unknown, name = 'Imported diagram'): WokwiImport {
  const warnings: string[] = [];
  if (!isRecord(json)) return { ok: false, error: 'not a diagram: expected a JSON object', warnings };
  if (!Array.isArray(json.parts)) return { ok: false, error: 'not a diagram: no "parts" array', warnings };
  if (json.version !== undefined && json.version !== 1) warnings.push(`diagram version ${String(json.version)}: only version 1 is documented; imported as if it were 1`);
  if (json.parts.length > MAX_PARTS) return { ok: false, error: `${json.parts.length} parts — more than ${MAX_PARTS}`, warnings };
  const connections: unknown[] = Array.isArray(json.connections) ? json.connections : [];
  if (json.connections !== undefined && !Array.isArray(json.connections)) warnings.push('"connections" is not an array; no wires imported');
  if (connections.length > MAX_CONNECTIONS) return { ok: false, error: `${connections.length} connections — more than ${MAX_CONNECTIONS}`, warnings };

  // Parts.
  const taken = new Set<string>();
  const byWokwiId = new Map<string, PlacedPart>();
  /** Parts skipped with a warning: their connections go silently. */
  const skipped = new Set<string>();
  json.parts.forEach((raw, index) => {
    if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.type !== 'string') {
      warnings.push(`parts[${index}]: needs a string "id" and "type"; skipped`);
      return;
    }
    const wokwiId = raw.id;
    skipped.add(wokwiId); // until it's placed
    if (byWokwiId.has(wokwiId)) {
      warnings.push(`${wokwiId}: a second part with this id; skipped`);
      return;
    }
    const mapping = TYPES[raw.type];
    if (mapping === undefined) {
      warnings.push(`${wokwiId}: ${raw.type} has no Benchtop part yet; skipped with its connections`);
      return;
    }
    const attrs: Record<string, string> = {};
    if (isRecord(raw.attrs)) for (const [k, v] of Object.entries(raw.attrs)) if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') attrs[k] = String(v);
    const typed = typeof mapping.type === 'string' ? mapping.type : mapping.type(attrs);
    if (typeof typed !== 'string') {
      warnings.push(`${wokwiId}: ${raw.type} as ${typed.unsupported}; skipped with its connections`);
      return;
    }
    const def = CATALOG.get(typed);
    if (def === undefined) {
      warnings.push(`${wokwiId}: ${raw.type} maps to ${typed}, which isn't in the catalog; skipped`);
      return;
    }
    const props: Record<string, PropValue> = {};
    for (const [k, v] of Object.entries(attrs)) {
      const map = mapping.attrs?.[k];
      if (map === undefined) {
        warnings.push(`${wokwiId}: attribute ${k}="${v}" isn't supported; ignored`);
        continue;
      }
      const result = map(v);
      if (typeof result === 'string') warnings.push(`${wokwiId}: attribute ${k}: ${result}; ignored`);
      else if (result[0] !== '') props[result[0]] = result[1];
    }
    const left = typeof raw.left === 'number' && Number.isFinite(raw.left) ? raw.left : 0;
    const top = typeof raw.top === 'number' && Number.isFinite(raw.top) ? raw.top : 0;
    const rotate = typeof raw.rotate === 'number' && Number.isFinite(raw.rotate) ? (((Math.round(raw.rotate) % 360) + 360) % 360) : 0;
    const rotation = ((Math.round(rotate / 90) % 4) * 90) as PartInstance['rotation'];
    if (rotate !== rotation && rotate !== rotation + 360) warnings.push(`${wokwiId}: rotation ${rotate}° snapped to ${rotation}°`);
    if (raw.hide === true) warnings.push(`${wokwiId}: hidden in Wokwi; shown here`);
    const id = idFor(wokwiId, taken);
    if (id !== wokwiId) warnings.push(`${wokwiId}: renamed ${id} (ids are lowercase letters, digits, - and _)`);
    const part: PartInstance = { id, type: typed, x: round(left / WOKWI_PX_PER_MM), y: round(top / WOKWI_PX_PER_MM), rotation, props };
    byWokwiId.set(wokwiId, { part, def, wokwiId });
    skipped.delete(wokwiId);
  });

  // Connections.
  const endpoint = (ref: unknown, where: string): Endpoint | undefined => {
    if (typeof ref !== 'string' || !ref.includes(':')) {
      warnings.push(`${where}: "${String(ref)}" is not a "part:pin" reference; skipped`);
      return undefined;
    }
    const colon = ref.indexOf(':');
    const partId = ref.slice(0, colon);
    const placed = byWokwiId.get(partId);
    const pin = ref.slice(colon + 1);
    if (placed === undefined) {
      if (!skipped.has(partId)) warnings.push(`${where}: no part "${partId}"; skipped`);
      return undefined;
    }
    if (!placed.def.pins.some((p) => p.name === pin)) {
      warnings.push(`${where}: ${placed.def.title} has no pin "${pin}"; skipped`);
      return undefined;
    }
    return { placed, pin };
  };

  interface Pending {
    from: Endpoint;
    to: Endpoint;
    color: string;
    route: string[];
    breadboard: boolean;
  }
  const pending: Pending[] = [];
  connections.forEach((raw, index) => {
    const where = `connections[${index}]`;
    if (!Array.isArray(raw) || raw.length < 2) {
      warnings.push(`${where}: expected [from, to, color, route]; skipped`);
      return;
    }
    const from = endpoint(raw[0], where);
    const to = endpoint(raw[1], where);
    if (from === undefined || to === undefined) return;
    const route = Array.isArray(raw[3]) ? raw[3].filter((s): s is string => typeof s === 'string') : [];
    const breadboard = route.includes('$bb');
    let color = typeof raw[2] === 'string' ? raw[2] : '';
    if (!breadboard && (color === '' || !COLOR_PATTERN.test(color))) {
      warnings.push(`${where}: ${color === '' ? 'a hidden wire' : `color "${color}"`} (${String(raw[0])} → ${String(raw[1])}) imported green`);
      color = 'green';
    }
    pending.push({ from, to, color, route: route.filter((s) => s !== '$bb'), breadboard });
  });

  // Snap parts plugged into breadboards onto the holes.
  const offsets = new Map<PlacedPart, { x: number; y: number }[]>();
  for (const p of pending) {
    if (!p.breadboard) continue;
    const board = p.from.placed.def.type.startsWith('breadboard') ? p.from : p.to.placed.def.type.startsWith('breadboard') ? p.to : undefined;
    const other = board === p.from ? p.to : p.from;
    if (board === undefined || other.placed.def.type.startsWith('breadboard')) continue;
    const hole = pinWorld(board.placed, board.pin);
    const pin = pinWorld(other.placed, other.pin);
    const list = offsets.get(other.placed) ?? [];
    list.push({ x: hole.x - pin.x, y: hole.y - pin.y });
    offsets.set(other.placed, list);
  }
  const snapped = new Set<PlacedPart>();
  for (const [placed, list] of offsets) {
    const mx = list.reduce((a, o) => a + o.x, 0) / list.length;
    const my = list.reduce((a, o) => a + o.y, 0) / list.length;
    if (list.every((o) => Math.hypot(o.x - mx, o.y - my) < CONTACT_MM)) {
      placed.part.x = round(placed.part.x + mx);
      placed.part.y = round(placed.part.y + my);
      snapped.add(placed);
    } else {
      warnings.push(`${placed.wokwiId}: its pins don't all fit our breadboard's holes; connected with wires instead`);
    }
  }

  // Wires, from the final positions.
  const wires: Wire[] = [];
  for (const p of pending) {
    if (p.breadboard && (snapped.has(p.from.placed) || snapped.has(p.to.placed))) continue;
    const waypoints = routeWaypoints(pinWorld(p.from.placed, p.from.pin), pinWorld(p.to.placed, p.to.pin), p.route, warnings, `${p.from.placed.wokwiId}:${p.from.pin}`);
    wires.push({
      id: `w${wires.length + 1}`,
      from: { part: p.from.placed.part.id, pin: p.from.pin },
      to: { part: p.to.placed.part.id, pin: p.to.pin },
      waypoints,
      color: p.breadboard ? 'gray' : p.color,
    });
  }

  const candidate = { format: 1, name, parts: [...byWokwiId.values()].map((p) => p.part), wires, firmware: {} };
  const parsed = parseProject(candidate);
  if (!parsed.ok) return { ok: false, error: `the imported circuit doesn't validate: ${parsed.errors[0]?.path} ${parsed.errors[0]?.message}`, warnings };
  return { ok: true, doc: parsed.doc, warnings };
}

/**
 * The route's explicit moves as waypoints (mm): moves before `*` walk from the source pin,
 * moves after it walk from the target pin in reverse order; the wire runs source → source
 * moves → target moves (reversed back) → target. No `*`: every move is the source's.
 */
export function routeWaypoints(from: { x: number; y: number }, to: { x: number; y: number }, route: readonly string[], warnings: string[], label: string): { x: number; y: number }[] {
  const star = route.indexOf('*');
  const head = star < 0 ? route : route.slice(0, star);
  const tail = star < 0 ? [] : route.slice(star + 1);
  const walk = (start: { x: number; y: number }, moves: readonly string[]): { x: number; y: number }[] | undefined => {
    const out: { x: number; y: number }[] = [];
    let { x, y } = start;
    for (const move of moves) {
      const m = /^([vh])(-?\d+(?:\.\d+)?)$/.exec(move);
      if (m === null) return undefined;
      const d = Number.parseFloat(m[2]) / WOKWI_PX_PER_MM;
      if (m[1] === 'v') y += d;
      else x += d;
      out.push({ x: round(x), y: round(y) });
    }
    return out;
  };
  const source = walk(from, head);
  const target = walk(to, [...tail].reverse());
  if (source === undefined || target === undefined || route.filter((s) => s === '*').length > 1) {
    warnings.push(`wire from ${label}: route ${JSON.stringify(route)} isn't valid; drawn without it`);
    return [];
  }
  return [...source, ...target.reverse()];
}
