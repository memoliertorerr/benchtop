/**
 * Framing the canvas: the box around parts (and the waypoints of wires between them), and the
 * camera that shows it — after opening a project, an example or an imported diagram, and when
 * a problem's parts are shown.
 */

import type { PartInstance, ProjectDoc } from '@benchtop/core';
import { CATALOG } from '@benchtop/parts';
import { frameWorldRect } from './Canvas.tsx';
import { partBounds } from './geometry.ts';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The world box (mm) around `parts` and `points`, or undefined for nothing. */
export function boundsOf(parts: readonly PartInstance[], points: readonly { x: number; y: number }[] = []): Rect | undefined {
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const part of parts) {
    const def = CATALOG.get(part.type);
    const b = def === undefined ? { x: part.x, y: part.y, w: 10, h: 10 } : partBounds(def, part);
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w);
    y1 = Math.max(y1, b.y + b.h);
  }
  for (const p of points) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return x0 === Number.POSITIVE_INFINITY ? undefined : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** The box around a whole document: its parts and its wires' waypoints. */
export function docBounds(doc: ProjectDoc): Rect | undefined {
  return boundsOf(
    doc.parts,
    doc.wires.flatMap((w) => w.waypoints),
  );
}

/** Frames the canvas on these parts. */
export function frameParts(parts: readonly PartInstance[]): void {
  const rect = boundsOf(parts);
  if (rect !== undefined) frameWorldRect(rect);
}

/** Frames the canvas on a whole document (nothing to frame: the camera stays). */
export function frameDoc(doc: ProjectDoc): void {
  const rect = docBounds(doc);
  if (rect !== undefined) frameWorldRect(rect);
}
