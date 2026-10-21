/**
 * Breadboards, generated: 'breadboard' (63 columns, 830 holes), 'breadboard-half' (30 columns,
 * 400 holes) and 'breadboard-mini' (17 columns, 170 holes, no rails). Our own design — the
 * element library has none — on the 2.54 mm grid.
 *
 * Pin names follow Wokwi's breadboard, so the diagram importer (BT38) maps them 1:1:
 *   '<col>t.<a–e>'  top half of column <col> (1-based)
 *   '<col>b.<f–j>'  bottom half
 *   'tp.<n>', 'tn.<n>', 'bp.<n>', 'bn.<n>'  top/bottom + and − rails (n from 1)
 * Buses: each 5-hole half column, and each rail over its full length.
 *
 * Layout in pitches (2.54 mm), top to bottom: margin, tp, tn, gap, a–e, a 3-pitch center
 * channel (so a DIP straddles e/f), f–j, gap, bn, bp, margin. Columns sit at x = (col) pitches.
 * Rail holes come in groups of 5 with a one-hole gap between groups, centered on the columns:
 * 50 per rail on the full board, 25 on the half.
 */

import type { PinDef } from '@benchtop/core';
import { definePart } from '../define.ts';

export const PITCH = 2.54;

export interface BreadboardSpec {
  type: string;
  title: string;
  columns: number;
  /** Holes per rail, 0 for none. */
  railHoles: number;
}

export const BREADBOARD_SPECS: readonly BreadboardSpec[] = [
  { type: 'breadboard', title: 'Breadboard', columns: 63, railHoles: 50 },
  { type: 'breadboard-half', title: 'Half breadboard', columns: 30, railHoles: 25 },
  { type: 'breadboard-mini', title: 'Mini breadboard', columns: 17, railHoles: 0 },
];

const TOP_ROWS = ['a', 'b', 'c', 'd', 'e'];
const BOTTOM_ROWS = ['f', 'g', 'h', 'i', 'j'];

export interface BreadboardGeometry {
  pins: PinDef[];
  buses: string[][];
  size: { w: number; h: number };
}

/** Pins (in hole order), buses and size of a breadboard with this many columns and rail holes. */
export function breadboardGeometry(columns: number, railHoles: number): BreadboardGeometry {
  const rails = railHoles > 0;
  // Row positions in pitches from the top edge.
  const rowTp = 1;
  const rowTn = 2;
  const rowA = rails ? 4 : 1;
  const rowF = rowA + 7; // e = rowA + 4, then a 3-pitch channel
  const rowBn = rowF + 6;
  const rowBp = rowBn + 1;
  const height = (rails ? rowBp + 1 : rowF + 5) * PITCH;
  const width = (columns + 1) * PITCH;
  const x = (col: number) => round(col * PITCH);
  const y = (row: number) => round(row * PITCH);

  const pins: PinDef[] = [];
  const buses: string[][] = [];
  for (let col = 1; col <= columns; col++) {
    const top = TOP_ROWS.map((r, i) => {
      pins.push({ name: `${col}t.${r}`, x: x(col), y: y(rowA + i), role: 'passive' });
      return `${col}t.${r}`;
    });
    const bottom = BOTTOM_ROWS.map((r, i) => {
      pins.push({ name: `${col}b.${r}`, x: x(col), y: y(rowF + i), role: 'passive' });
      return `${col}b.${r}`;
    });
    buses.push(top, bottom);
  }
  if (rails) {
    // Groups of 5 with a gap; the whole run is centered on the columns.
    const span = Math.ceil(railHoles / 5) * 6 - 1;
    const firstCol = 1 + Math.floor((columns - span) / 2);
    const railCol = (n: number) => firstCol + Math.floor((n - 1) / 5) * 6 + ((n - 1) % 5);
    for (const [rail, row] of [
      ['tp', rowTp],
      ['tn', rowTn],
      ['bn', rowBn],
      ['bp', rowBp],
    ] as const) {
      const names: string[] = [];
      for (let n = 1; n <= railHoles; n++) {
        pins.push({ name: `${rail}.${n}`, x: x(railCol(n)), y: y(row), role: 'passive' });
        names.push(`${rail}.${n}`);
      }
      buses.push(names);
    }
  }
  return { pins, buses, size: { w: round(width), h: round(height) } };
}

function round(mm: number): number {
  return Math.round(mm * 1000) / 1000;
}

export const breadboards = BREADBOARD_SPECS.map((spec) => {
  const { pins, buses, size } = breadboardGeometry(spec.columns, spec.railHoles);
  return definePart({ type: spec.type, title: spec.title, category: 'breadboards', size, pins, buses, defaults: {} });
});
