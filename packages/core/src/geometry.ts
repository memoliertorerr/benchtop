/**
 * Part geometry shared by the editor and the netlist: where a pin is once its part is placed
 * and rotated. Rotation is clockwise (screen coordinates, y down) about the part's center, as
 * `PartInstance.rotation` says.
 */

import type { PartInstance } from './contracts/project.ts';

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  w: number;
  h: number;
}

/** A point in the unrotated part's frame (mm from its top-left) → its offset after rotation. */
export function rotateInPart(size: Size, local: Point, rotation: PartInstance['rotation']): Point {
  const cx = size.w / 2;
  const cy = size.h / 2;
  const dx = local.x - cx;
  const dy = local.y - cy;
  switch (rotation) {
    case 90:
      return { x: cx - dy, y: cy + dx };
    case 180:
      return { x: cx - dx, y: cy - dy };
    case 270:
      return { x: cx + dy, y: cy - dx };
    default:
      return { x: local.x, y: local.y };
  }
}

/** World position (mm) of a point of a placed part. */
export function partPointToWorld(part: Pick<PartInstance, 'x' | 'y' | 'rotation'>, size: Size, local: Point): Point {
  const p = rotateInPart(size, local, part.rotation);
  return { x: part.x + p.x, y: part.y + p.y };
}
