/**
 * Part geometry in world mm for the editor: pin positions, bounds and grid snapping. Rotation
 * uses the rule in packages/core/src/geometry.ts, which the netlist's breadboard contacts use
 * too, so a leg the editor shows in a hole is a leg the simulation connects.
 */

import { type PartDefinition, type PartInstance, rotateInPart } from '@benchtop/core';
import type { Point } from './camera.ts';

export { rotateInPart };

/** The breadboard pitch: 0.1". */
export const GRID_MM = 2.54;

/** World position of a pin of a placed part. */
export function pinWorld(def: PartDefinition, part: PartInstance, pin: Point): Point {
  const p = rotateInPart(def.size, pin, part.rotation);
  return { x: part.x + p.x, y: part.y + p.y };
}

/** Axis-aligned world bounds of a placed part (rotation about its center). */
export function partBounds(def: PartDefinition, part: PartInstance): { x: number; y: number; w: number; h: number } {
  const quarter = part.rotation === 90 || part.rotation === 270;
  const w = quarter ? def.size.h : def.size.w;
  const h = quarter ? def.size.w : def.size.h;
  return { x: part.x + (def.size.w - w) / 2, y: part.y + (def.size.h - h) / 2, w, h };
}

export function snapValue(mm: number): number {
  return Math.round(mm / GRID_MM) * GRID_MM;
}

/**
 * Where a part dragged to `position` lands: its first pin snaps to the 0.1" grid, so its legs
 * line up with breadboard holes (whose own top-left is on the grid). With `snap` false (Alt
 * held) it lands exactly where it was dropped.
 */
export function snapPart(def: PartDefinition, rotation: PartInstance['rotation'], position: Point, snap: boolean): Point {
  if (!snap) return position;
  const anchor = def.pins.length > 0 ? rotateInPart(def.size, def.pins[0], rotation) : { x: 0, y: 0 };
  return { x: round(snapValue(position.x + anchor.x) - anchor.x), y: round(snapValue(position.y + anchor.y) - anchor.y) };
}

function round(mm: number): number {
  return Math.round(mm * 1000) / 1000;
}
