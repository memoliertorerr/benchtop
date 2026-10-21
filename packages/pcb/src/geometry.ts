/**
 * Plane geometry for the PCB (BT57): copper shapes as capsules (a segment swept by a radius —
 * traces, round and oval pads, vias) and axis-aligned rectangles (square pads), with the
 * distances DRC and connectivity need. Millimetres, y down like the bench.
 */

export interface Point {
  x: number;
  y: number;
}

/** A segment swept by radius r; a circle when its two ends coincide. */
export interface Capsule {
  k: 'cap';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  r: number;
}

/** An axis-aligned rectangle. */
export interface Rect {
  k: 'rect';
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export type Shape = Capsule | Rect;

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Distance from point p to segment ab. */
export function pointSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function orient(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

/** True when segments ab and cd intersect (touching counts). */
export function segmentsIntersect(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): boolean {
  const d1 = orient(cx, cy, dx, dy, ax, ay);
  const d2 = orient(cx, cy, dx, dy, bx, by);
  const d3 = orient(ax, ay, bx, by, cx, cy);
  const d4 = orient(ax, ay, bx, by, dx, dy);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  const on = (px: number, py: number, qx: number, qy: number, rx: number, ry: number): boolean =>
    Math.min(px, qx) - 1e-12 <= rx && rx <= Math.max(px, qx) + 1e-12 && Math.min(py, qy) - 1e-12 <= ry && ry <= Math.max(py, qy) + 1e-12;
  if (d1 === 0 && on(cx, cy, dx, dy, ax, ay)) return true;
  if (d2 === 0 && on(cx, cy, dx, dy, bx, by)) return true;
  if (d3 === 0 && on(ax, ay, bx, by, cx, cy)) return true;
  if (d4 === 0 && on(ax, ay, bx, by, dx, dy)) return true;
  return false;
}

/** Distance between segments ab and cd (0 when they cross). */
export function segmentSegment(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): number {
  if (segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy)) return 0;
  return Math.min(pointSegment(ax, ay, cx, cy, dx, dy), pointSegment(bx, by, cx, cy, dx, dy), pointSegment(cx, cy, ax, ay, bx, by), pointSegment(dx, dy, ax, ay, bx, by));
}

/** Distance from a point to a rectangle (0 inside). */
export function pointRect(px: number, py: number, r: Box): number {
  const dx = Math.max(r.x0 - px, 0, px - r.x1);
  const dy = Math.max(r.y0 - py, 0, py - r.y1);
  return Math.hypot(dx, dy);
}

/** Distance from segment ab to a rectangle (0 when it touches or enters it). */
export function segmentRect(ax: number, ay: number, bx: number, by: number, r: Box): number {
  const da = pointRect(ax, ay, r);
  const db = pointRect(bx, by, r);
  if (da === 0 || db === 0) return 0;
  const edges = [
    [r.x0, r.y0, r.x1, r.y0],
    [r.x1, r.y0, r.x1, r.y1],
    [r.x1, r.y1, r.x0, r.y1],
    [r.x0, r.y1, r.x0, r.y0],
  ] as const;
  let best = Math.min(da, db);
  for (const [cx, cy, dx, dy] of edges) best = Math.min(best, segmentSegment(ax, ay, bx, by, cx, cy, dx, dy));
  return best;
}

/** Gap between two rectangles (0 when they touch or overlap). */
export function rectRect(a: Box, b: Box): number {
  const dx = Math.max(0, a.x0 - b.x1, b.x0 - a.x1);
  const dy = Math.max(0, a.y0 - b.y1, b.y0 - a.y1);
  return Math.hypot(dx, dy);
}

/** Gap between two copper shapes: ≤ 0 when they touch or overlap. */
export function shapeDistance(a: Shape, b: Shape): number {
  if (a.k === 'cap' && b.k === 'cap') return segmentSegment(a.x1, a.y1, a.x2, a.y2, b.x1, b.y1, b.x2, b.y2) - a.r - b.r;
  if (a.k === 'cap' && b.k === 'rect') return segmentRect(a.x1, a.y1, a.x2, a.y2, b) - a.r;
  if (a.k === 'rect' && b.k === 'cap') return segmentRect(b.x1, b.y1, b.x2, b.y2, a) - b.r;
  return rectRect(a as Rect, b as Rect);
}

/** Bounding box of a shape. */
export function shapeBox(s: Shape): Box {
  if (s.k === 'rect') return { x0: s.x0, y0: s.y0, x1: s.x1, y1: s.y1 };
  return { x0: Math.min(s.x1, s.x2) - s.r, y0: Math.min(s.y1, s.y2) - s.r, x1: Math.max(s.x1, s.x2) + s.r, y1: Math.max(s.y1, s.y2) + s.r };
}

/** True when p lies inside the polygon (even-odd rule; points on an edge count as inside). */
export function pointInPolygon(px: number, py: number, poly: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (pointSegment(px, py, a.x, a.y, b.x, b.y) < 1e-9) return true;
    if (a.y > py !== b.y > py && px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** (x, y) in a part's frame turned clockwise by `rotation` (y down, as the bench turns parts). */
export function rotate(x: number, y: number, rotation: number): Point {
  switch (rotation) {
    case 90:
      return { x: -y, y: x };
    case 180:
      return { x: -x, y: -y };
    case 270:
      return { x: y, y: -x };
    default:
      return { x, y };
  }
}
