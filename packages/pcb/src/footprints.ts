/**
 * Through-hole footprints for the catalog's parts (BT57). Most parts reach a PCB as what they
 * plug into — a module's header row, a board's headers (an Uno or a Mega as a shield, a Nano or a
 * DevKit as its two rows) — so a footprint is made from the part's own pin positions (copied
 * from the drawings at real size), with each run of pins about 0.1″ apart snapped to an exact
 * 2.54 mm pitch: the drawings' small rounding (2.52, 2.64 mm) would not fit a real header. A
 * few basic components get their standard footprints instead (resistor, LED, RGB LED, 6 mm
 * pushbutton). Breadboards, the IR remote and the environment parts aren't on a PCB.
 *
 * Coordinates are mm relative to the footprint's origin — the part's centre — unrotated, y down.
 * Pads a part shorts inside (a board's GND pins, a pushbutton's two legs per side) share a pad
 * number, as KiCad numbers them, and count as one connection.
 */

import type { PartDefinition, PartProps } from '@benchtop/core';

export type PadShape = 'circle' | 'rect' | 'oval';

export interface FootprintPad {
  /** Pad number ("1", "2", …); pads on one internal bus share one. */
  number: string;
  /** The part pin it is. */
  pin: string;
  x: number;
  y: number;
  shape: PadShape;
  /** Pad size, mm (a circle has w = h). */
  w: number;
  h: number;
  /** Plated hole diameter, mm. */
  drill: number;
}

export type SilkShape = { kind: 'line'; x1: number; y1: number; x2: number; y2: number } | { kind: 'circle'; x: number; y: number; r: number };

export interface Footprint {
  /** Name in the exported library (`Benchtop:<name>`). */
  name: string;
  pads: readonly FootprintPad[];
  silk: readonly SilkShape[];
  /** The part's keep-out rectangle, relative to the origin, unrotated. */
  courtyard: { x0: number; y0: number; x1: number; y1: number };
}

/** The 0.1″ pitch. */
export const PITCH = 2.54;
/** Header pads: 1.7 mm copper around a 1.0 mm hole (pad 1 square). */
const HEADER_PAD = 1.7;
const HEADER_DRILL = 1.0;
/** Pins whose spacing is this close to 2.54 mm form a header run. */
const RUN_TOLERANCE = 0.35;
/** Pins on one row or column when their other coordinate is this close. */
const LINE_TOLERANCE = 0.3;
const COURTYARD_MARGIN = 0.25;

/** Part types that don't go on a PCB (besides parts with no pins). */
export function isOffBoard(def: PartDefinition): boolean {
  return def.pins.length === 0 || def.type.startsWith('breadboard') || def.category === 'environment' || OFF_BOARD.has(def.type);
}

/** BT83: a bench supply stays on the bench, and a ground symbol is a symbol, not a component. */
const OFF_BOARD = new Set(['bench-supply', 'ground']);

const round = (v: number): number => Math.round(v * 1000) / 1000;

function rectSilk(x0: number, y0: number, x1: number, y1: number): SilkShape[] {
  return [
    { kind: 'line', x1: x0, y1: y0, x2: x1, y2: y0 },
    { kind: 'line', x1: x1, y1: y0, x2: x1, y2: y1 },
    { kind: 'line', x1: x1, y1: y1, x2: x0, y2: y1 },
    { kind: 'line', x1: x0, y1: y1, x2: x0, y2: y0 },
  ];
}

/** Pad numbers: definition order, pins on one bus share the first one's number. */
function padNumbers(def: PartDefinition): Map<string, string> {
  const numbers = new Map<string, string>();
  let next = 1;
  for (const pin of def.pins) {
    if (numbers.has(pin.name)) continue;
    const bus = def.buses?.find((b) => b.includes(pin.name));
    const number = String(next++);
    for (const name of bus ?? [pin.name]) numbers.set(name, number);
  }
  return numbers;
}

/**
 * Snaps runs of pins about 0.1″ apart — rows first, then columns — to an exact 2.54 mm pitch from
 * each run's first pin, the run's other coordinate to its mean.
 */
export function snapRuns(points: { x: number; y: number }[]): void {
  const done = new Set<number>();
  const pass = (along: 'x' | 'y'): void => {
    const across = along === 'x' ? 'y' : 'x';
    const order = points.map((_, i) => i).filter((i) => !done.has(i));
    order.sort((a, b) => points[a][across] - points[b][across] || points[a][along] - points[b][along]);
    // Lines: pins sharing the cross coordinate.
    let start = 0;
    while (start < order.length) {
      let end = start + 1;
      while (end < order.length && Math.abs(points[order[end]][across] - points[order[start]][across]) < LINE_TOLERANCE) end++;
      const line = order.slice(start, end).sort((a, b) => points[a][along] - points[b][along]);
      let r0 = 0;
      for (let k = 1; k <= line.length; k++) {
        const gap = k < line.length ? points[line[k]][along] - points[line[k - 1]][along] : Infinity;
        if (Math.abs(gap - PITCH) <= RUN_TOLERANCE) continue;
        const run = line.slice(r0, k);
        if (run.length >= 2) {
          const first = points[run[0]][along];
          const mean = run.reduce((sum, i) => sum + points[i][across], 0) / run.length;
          run.forEach((i, j) => {
            points[i][along] = round(first + j * PITCH);
            points[i][across] = round(mean);
            done.add(i);
          });
        }
        r0 = k;
      }
      start = end;
    }
  };
  pass('x');
  pass('y');
}

function generic(def: PartDefinition): Footprint {
  const cx = def.size.w / 2;
  const cy = def.size.h / 2;
  const points = def.pins.map((p) => ({ x: p.x - cx, y: p.y - cy }));
  snapRuns(points);
  const numbers = padNumbers(def);
  const pads = def.pins.map((pin, i): FootprintPad => {
    const number = numbers.get(pin.name) ?? String(i + 1);
    return { number, pin: pin.name, x: round(points[i].x), y: round(points[i].y), shape: number === '1' ? 'rect' : 'circle', w: HEADER_PAD, h: HEADER_PAD, drill: HEADER_DRILL };
  });
  return { name: def.type, pads, silk: rectSilk(-cx, -cy, cx, cy), courtyard: courtyardOf(pads, -cx, -cy, cx, cy) };
}

function courtyardOf(pads: readonly FootprintPad[], x0: number, y0: number, x1: number, y1: number): Footprint['courtyard'] {
  for (const p of pads) {
    x0 = Math.min(x0, p.x - p.w / 2);
    y0 = Math.min(y0, p.y - p.h / 2);
    x1 = Math.max(x1, p.x + p.w / 2);
    y1 = Math.max(y1, p.y + p.h / 2);
  }
  return { x0: round(x0 - COURTYARD_MARGIN), y0: round(y0 - COURTYARD_MARGIN), x1: round(x1 + COURTYARD_MARGIN), y1: round(y1 + COURTYARD_MARGIN) };
}

const pad = (number: string, pin: string, x: number, y: number, shape: PadShape, size: number, drill: number): FootprintPad => ({ number, pin, x, y, shape, w: size, h: size, drill });

/** Standard footprints for the basic components (KiCad library geometry). */
const STANDARD: Readonly<Record<string, () => Footprint>> = {
  // TO-220-3_Vertical (BT84): pad 1 IN, 2 GND, 3 OUT, 2.54 mm apart; the tab behind them.
  lm7805: () => {
    const pads = [pad('1', 'IN', -2.54, 0, 'rect', 1.9, 1.1), pad('2', 'GND', 0, 0, 'circle', 1.9, 1.1), pad('3', 'OUT', 2.54, 0, 'circle', 1.9, 1.1)];
    const silk: SilkShape[] = [...rectSilk(-5.2, -3.2, 5.2, 1.6), { kind: 'line', x1: -5.2, y1: -1.9, x2: 5.2, y2: -1.9 }];
    return { name: 'TO-220-3_Vertical', pads, silk, courtyard: { x0: -5.45, y0: -3.45, x1: 5.45, y1: 1.85 } };
  },
  // TO-92_Inline (BT84): the MCP1700's TO-92 order, pad 1 GND, 2 VIN, 3 VOUT, 1.27 mm apart.
  'mcp1700-3v3': () => {
    const pads = [pad('1', 'GND', -1.27, 0, 'rect', 1.05, 0.75), pad('2', 'VIN', 0, 0, 'circle', 1.05, 0.75), pad('3', 'VOUT', 1.27, 0, 'circle', 1.05, 0.75)];
    return { name: 'TO-92_Inline', pads, silk: [...rectSilk(-2.4, -1.6, 2.4, 1.0)], courtyard: { x0: -2.65, y0: -1.85, x1: 2.65, y1: 1.25 } };
  },
  // The AMS1117-3.3 breakout as a 3-pin header (BT84): pad 1 VIN, 2 GND, 3 VOUT.
  'ams1117-3v3': () => {
    const pads = [pad('1', 'VIN', -2.54, 0, 'rect', HEADER_PAD, HEADER_DRILL), pad('2', 'GND', 0, 0, 'circle', HEADER_PAD, HEADER_DRILL), pad('3', 'VOUT', 2.54, 0, 'circle', HEADER_PAD, HEADER_DRILL)];
    return { name: 'PinHeader_1x03_P2.54mm', pads, silk: rectSilk(-6.35, -14.6, 6.35, 1.9), courtyard: { x0: -6.6, y0: -14.85, x1: 6.6, y1: 2.15 } };
  },
  // R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal
  resistor: () => {
    const pads = [pad('1', '1', -5.08, 0, 'circle', 1.6, 0.8), pad('2', '2', 5.08, 0, 'circle', 1.6, 0.8)];
    const silk: SilkShape[] = [...rectSilk(-3.15, -1.25, 3.15, 1.25), { kind: 'line', x1: -4.04, y1: 0, x2: -3.15, y2: 0 }, { kind: 'line', x1: 3.15, y1: 0, x2: 4.04, y2: 0 }];
    return { name: 'R_Axial_P10.16mm', pads, silk, courtyard: { x0: -6.15, y0: -1.5, x1: 6.15, y1: 1.5 } };
  },
  // LED_D5.0mm: pad 1 is the cathode.
  led: () => {
    const pads = [pad('1', 'C', -1.27, 0, 'rect', 1.8, 0.9), pad('2', 'A', 1.27, 0, 'circle', 1.8, 0.9)];
    return { name: 'LED_D5.0mm', pads, silk: [{ kind: 'circle', x: 0, y: 0, r: 2.5 }], courtyard: { x0: -3.25, y0: -3.25, x1: 3.25, y1: 3.25 } };
  },
  // A 5 mm common-cathode/anode RGB LED, four leads in a row: R, COM, G, B.
  'rgb-led': () => {
    const pads = ['R', 'COM', 'G', 'B'].map((pin, i) => pad(String(i + 1), pin, -3.81 + i * PITCH, 0, i === 0 ? 'rect' : 'circle', 1.6, 0.8));
    return { name: 'LED_RGB_D5.0mm', pads, silk: [{ kind: 'circle', x: 0, y: 0, r: 2.9 }], courtyard: { x0: -5.0, y0: -3.25, x1: 5.0, y1: 3.25 } };
  },
  // SW_PUSH_6mm: legs 6.5 mm apart across, 4.5 mm along; each side's two legs are one contact.
  pushbutton: () => {
    const pads = [pad('1', '1.l', -3.25, -2.25, 'circle', 2.0, 1.1), pad('2', '2.l', -3.25, 2.25, 'circle', 2.0, 1.1), pad('1', '1.r', 3.25, -2.25, 'circle', 2.0, 1.1), pad('2', '2.r', 3.25, 2.25, 'circle', 2.0, 1.1)];
    return { name: 'SW_PUSH_6mm', pads, silk: rectSilk(-3, -3, 3, 3), courtyard: { x0: -4.5, y0: -3.5, x1: 4.5, y1: 3.5 } };
  },
};

const cache = new Map<string, Footprint | null>();

/** The footprint of a part type, or null for a part that isn't on a PCB. */
export function footprintOf(def: PartDefinition): Footprint | null {
  const cached = cache.get(def.type);
  if (cached !== undefined) return cached;
  const fp = isOffBoard(def) ? null : (STANDARD[def.type]?.() ?? generic(def));
  cache.set(def.type, fp);
  return fp;
}

/** Reference designator prefixes by part type (IEEE 315 / KiCad habits); U for everything else. */
const PREFIX: Readonly<Record<string, string>> = {
  'battery-9v': 'BT',
  'battery-2aa': 'BT',
  'battery-4aa': 'BT',
  'battery-lipo': 'BT',
  'battery-cr2032': 'BT',
  resistor: 'R',
  led: 'D',
  'rgb-led': 'D',
  pushbutton: 'SW',
  'slide-switch': 'SW',
  'dip-switch-8': 'SW',
  'tilt-switch': 'SW',
  potentiometer: 'RV',
  'slide-potentiometer': 'RV',
  buzzer: 'BZ',
  speaker: 'LS',
  microphone: 'MK',
  'relay-ks2e-m-dc5': 'K',
  servo: 'M',
  'stepper-28byj48': 'M',
  'stepper-bipolar': 'M',
  'membrane-keypad': 'J',
  'analog-joystick': 'J',
  'neopixel-strip': 'J',
  'neopixel-ring': 'J',
  'neopixel-matrix': 'J',
};

export function refPrefix(def: PartDefinition): string {
  if (def.board !== undefined) return 'A';
  if (def.category === 'displays') return 'DS';
  return PREFIX[def.type] ?? 'U';
}

/** The BOM's value column: a resistor's ohms, an LED's colour, else the part's title. */
export function valueOf(def: PartDefinition, props: PartProps): string {
  const merged = { ...def.defaults, ...props };
  if (def.type === 'resistor') return formatOhms(Number(merged.ohms));
  if (def.type === 'led') return `LED ${String(merged.color)}`;
  return def.title;
}

/** 220 → "220", 4700 → "4.7k", 1000000 → "1M" (the value code on a schematic). */
export function formatOhms(ohms: number): string {
  if (!Number.isFinite(ohms)) return '?';
  const [div, unit] = ohms >= 1e6 ? [1e6, 'M'] : ohms >= 1e3 ? [1e3, 'k'] : [1, ''];
  return `${Number((ohms / div).toPrecision(3))}${unit}`;
}
