/**
 * The environment's heatmap (BT55): the room badge's view hands the worker's packed grid here;
 * the canvas's environment layer listens and paints it under the parts. DOM-free (tested in
 * Node): the store, unpacking and the colour scale.
 */

import { unpackBytes, type VisualState } from '@benchtop/core';

export interface Heatmap {
  /** OVERLAY_FIELDS code: 1 gas, 2 temperature, 3 light, 4 sound. */
  field: number;
  /** Cells across and down. */
  w: number;
  h: number;
  /** Top-left corner and cell size, bench mm. */
  x: number;
  y: number;
  cell: number;
  /** One byte per cell, row-major (0 = the field's floor, 255 = its ceiling). */
  bytes: Uint8Array;
}

let current: Heatmap | null = null;
const listeners = new Set<(heatmap: Heatmap | null) => void>();

/** The latest heatmap, or null while the overlay is off. */
export function heatmap(): Heatmap | null {
  return current;
}

/** Listens for heatmap changes; returns the unsubscribe function. */
export function onHeatmap(listener: (heatmap: Heatmap | null) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Takes the room part's visual state (its `overlay` and packed `hm`). */
export function setHeatmap(visual: VisualState): void {
  if (typeof visual.overlay !== 'number') return;
  const { hmW, hmH, hmX, hmY, hmCell, hm } = visual;
  if (visual.overlay === 0 || typeof hmW !== 'number' || typeof hmH !== 'number' || !Array.isArray(hm)) {
    if (current !== null) publish(null);
    return;
  }
  const w = Math.max(0, Math.min(256, Math.floor(hmW)));
  const h = Math.max(0, Math.min(256, Math.floor(hmH)));
  const bytes = current !== null && current.bytes.length === w * h ? current.bytes : new Uint8Array(w * h);
  unpackBytes(hm as readonly number[], bytes);
  publish({ field: visual.overlay, w, h, x: Number(hmX) || 0, y: Number(hmY) || 0, cell: Number(hmCell) || 1, bytes });
}

/** Forgets the heatmap (a new bench, or no room any more). */
export function clearHeatmap(): void {
  if (current !== null) publish(null);
}

function publish(next: Heatmap | null): void {
  current = next;
  for (const listener of listeners) listener(next);
}

/** Colour stops (byte, r, g, b): blue → cyan → green → yellow → red. */
const STOPS: readonly (readonly [number, number, number, number])[] = [
  [0, 40, 80, 220],
  [64, 0, 190, 230],
  [128, 40, 200, 80],
  [192, 250, 210, 40],
  [255, 230, 40, 30],
];

/** RGBA of a heat byte into `out` at `offset`: transparent at 0, more opaque as it rises (faint low values). */
export function heatRgba(byte: number, out: Uint8ClampedArray, offset: number): void {
  let i = 0;
  while (i < STOPS.length - 2 && byte > STOPS[i + 1][0]) i++;
  const [b0, r0, g0, bl0] = STOPS[i];
  const [b1, r1, g1, bl1] = STOPS[i + 1];
  const t = b1 === b0 ? 0 : Math.min(1, Math.max(0, (byte - b0) / (b1 - b0)));
  out[offset] = r0 + (r1 - r0) * t;
  out[offset + 1] = g0 + (g1 - g0) * t;
  out[offset + 2] = bl0 + (bl1 - bl0) * t;
  out[offset + 3] = Math.min(255, Math.round(byte * 1.5));
}
