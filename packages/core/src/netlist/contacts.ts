/**
 * Physical contacts: two pins of different parts whose world positions are within CONTACT_MM
 * are connected — a leg pressed into a breadboard hole, a module plugged onto a header. No wire
 * is drawn; the netlist unions contacts exactly like wires.
 *
 * Pins are hashed on the 2.54 mm grid (each cell holds a linked list over an Int32Array), and
 * each pin is compared with the pins of its own cell and of the neighboring cells it lies
 * within CONTACT_MM of. Positions use the shared rotation rule (packages/core/src/geometry.ts),
 * so the editor shows the same contacts.
 */

import type { PinRef, ProjectDoc } from '../contracts/project.ts';
import type { Size } from '../geometry.ts';

/** Two pins closer than this (mm) touch. Breadboard holes are 2.54 mm apart. */
export const CONTACT_MM = 0.4;
const CELL_MM = 2.54;
/**
 * Cell keys pack 15 bits of each cell coordinate into a small integer (fast Map keys). Benches
 * wider than 32,768 cells (83 m) wrap around: farther cells share keys, which only adds
 * candidates — the exact distance test decides.
 */
const cellKey = (ix: number, iy: number): number => ((ix & 0x7fff) << 15) | (iy & 0x7fff);

export interface PartGeometry {
  /** mm, the unrotated part's box (rotation is about its center). */
  size: Size;
  /** Pin positions in mm from the unrotated part's top-left. */
  pins: readonly { name: string; x: number; y: number }[];
}

export interface Contact {
  a: PinRef;
  b: PinRef;
}

/** Every pair of pins of different parts within CONTACT_MM, each pair once, in document order. */
export function findContacts(doc: ProjectDoc, geometry: (type: string) => PartGeometry | undefined): Contact[] {
  // Pin world positions, owner part and pin name, in flat arrays.
  let count = 0;
  const geometries: (PartGeometry | undefined)[] = [];
  for (const part of doc.parts) {
    const g = geometry(part.type);
    geometries.push(g);
    if (g !== undefined) count += g.pins.length;
  }
  const xs = new Float64Array(count);
  const ys = new Float64Array(count);
  const owner = new Int32Array(count);
  const pinOf = new Int32Array(count);
  let n = 0;
  for (let p = 0; p < doc.parts.length; p++) {
    const g = geometries[p];
    if (g === undefined) continue;
    const part = doc.parts[p];
    const cx = g.size.w / 2;
    const cy = g.size.h / 2;
    for (let k = 0; k < g.pins.length; k++) {
      const dx = g.pins[k].x - cx;
      const dy = g.pins[k].y - cy;
      let rx: number;
      let ry: number;
      switch (part.rotation) {
        case 90:
          rx = -dy;
          ry = dx;
          break;
        case 180:
          rx = -dx;
          ry = -dy;
          break;
        case 270:
          rx = dy;
          ry = -dx;
          break;
        default:
          rx = dx;
          ry = dy;
      }
      xs[n] = part.x + cx + rx;
      ys[n] = part.y + cy + ry;
      owner[n] = p;
      pinOf[n] = k;
      n++;
    }
  }

  // Spatial hash: cell key → first pin, `next` chains the rest.
  const head = new Map<number, number>();
  const next = new Int32Array(count).fill(-1);
  const cellX = new Int32Array(count);
  const cellY = new Int32Array(count);
  for (let i = 0; i < count; i++) {
    const ix = Math.floor(xs[i] / CELL_MM);
    const iy = Math.floor(ys[i] / CELL_MM);
    cellX[i] = ix;
    cellY[i] = iy;
    const key = cellKey(ix, iy);
    const first = head.get(key);
    if (first !== undefined) next[i] = first;
    head.set(key, i);
  }

  const contacts: Contact[] = [];
  const limit = CONTACT_MM * CONTACT_MM;
  const ref = (i: number): PinRef => ({ part: doc.parts[owner[i]].id, pin: (geometries[owner[i]] as PartGeometry).pins[pinOf[i]].name });
  for (let i = 0; i < count; i++) {
    // CONTACT_MM is far below half a cell: only look at the neighbors the pin is near (most
    // pins sit mid-cell and check just their own).
    const fx = xs[i] - cellX[i] * CELL_MM;
    const fy = ys[i] - cellY[i] * CELL_MM;
    const x0 = fx <= CONTACT_MM ? -1 : 0;
    const x1 = fx >= CELL_MM - CONTACT_MM ? 1 : 0;
    const y0 = fy <= CONTACT_MM ? -1 : 0;
    const y1 = fy >= CELL_MM - CONTACT_MM ? 1 : 0;
    for (let ox = x0; ox <= x1; ox++) {
      for (let oy = y0; oy <= y1; oy++) {
        let j = head.get(cellKey(cellX[i] + ox, cellY[i] + oy)) ?? -1;
        for (; j >= 0; j = next[j]) {
          if (j <= i || owner[j] === owner[i]) continue;
          const dx = xs[j] - xs[i];
          const dy = ys[j] - ys[i];
          if (dx * dx + dy * dy <= limit) contacts.push({ a: ref(i), b: ref(j) });
        }
      }
    }
  }
  return contacts;
}
