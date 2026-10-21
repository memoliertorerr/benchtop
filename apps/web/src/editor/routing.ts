/**
 * Wire routing: an orthogonal polyline through a wire's endpoints and waypoints, its SVG path
 * with rounded corners, and hit testing. Pure.
 */

import type { Point } from './camera.ts';

/** Corner radius of drawn wires, mm. */
export const CORNER_MM = 1;

/**
 * Fills each step between consecutive points with horizontal and vertical segments. A step that
 * isn't straight gets one corner: horizontal-first or vertical-first, whichever bends less given
 * the direction the wire arrived in; ties go horizontal-first. Collinear points are dropped.
 */
export function orthogonalPath(points: readonly Point[]): Point[] {
  if (points.length === 0) return [];
  const out: Point[] = [{ x: points[0].x, y: points[0].y }];
  for (let i = 1; i < points.length; i++) {
    const a = out[out.length - 1];
    const b = points[i];
    if (a.x !== b.x && a.y !== b.y) {
      const prev = out.length >= 2 ? out[out.length - 2] : undefined;
      const arrived = prev === undefined ? null : prev.y === a.y ? 'h' : 'v';
      const horizontalFirst = 1 + (arrived === 'v' ? 1 : 0);
      const verticalFirst = 1 + (arrived === 'h' ? 1 : 0);
      out.push(verticalFirst < horizontalFirst ? { x: a.x, y: b.y } : { x: b.x, y: a.y });
    }
    out.push({ x: b.x, y: b.y });
  }
  return simplify(out);
}

/** Drops repeated points and the middle of three collinear ones. */
function simplify(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last !== undefined && last.x === p.x && last.y === p.y) continue;
    const before = out[out.length - 2];
    if (before !== undefined && last !== undefined && ((before.x === last.x && last.x === p.x) || (before.y === last.y && last.y === p.y))) {
      out[out.length - 1] = p;
      continue;
    }
    out.push(p);
  }
  return out;
}

/** SVG path data for a polyline with rounded corners (radius in the same units, capped per corner). */
export function pathData(points: readonly Point[], radius = CORNER_MM): string {
  if (points.length === 0) return '';
  const f = (n: number) => String(Math.round(n * 1000) / 1000);
  let d = `M${f(points[0].x)} ${f(points[0].y)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1];
    const v = points[i];
    const b = points[i + 1];
    const inLen = Math.hypot(v.x - a.x, v.y - a.y);
    const outLen = Math.hypot(b.x - v.x, b.y - v.y);
    const r = Math.min(radius, inLen / 2, outLen / 2);
    const p1 = { x: v.x - ((v.x - a.x) / inLen) * r, y: v.y - ((v.y - a.y) / inLen) * r };
    const p2 = { x: v.x + ((b.x - v.x) / outLen) * r, y: v.y + ((b.y - v.y) / outLen) * r };
    d += ` L${f(p1.x)} ${f(p1.y)} Q${f(v.x)} ${f(v.y)} ${f(p2.x)} ${f(p2.y)}`;
  }
  const last = points[points.length - 1];
  if (points.length > 1) d += ` L${f(last.x)} ${f(last.y)}`;
  return d;
}

/** Distance from `p` to the nearest segment of a polyline. */
export function distanceToPolyline(p: Point, points: readonly Point[]): number {
  if (points.length === 1) return Math.hypot(p.x - points[0].x, p.y - points[0].y);
  let best = Number.POSITIVE_INFINITY;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length2 = dx * dx + dy * dy;
    const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length2));
    best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)));
  }
  return best;
}
