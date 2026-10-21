/**
 * Cone (wedge) queries for the environment (BT54): the nearest point of a circle or an
 * axis-aligned box that lies inside a sensor's field of view — apex at the sensor, a facing
 * direction, a half-angle below 90°, a range. Exact: the distance to a point is convex and the
 * wedge ∩ a convex shape is convex, so the nearest point is either the shape's own nearest point
 * (when that lies inside the wedge) or on one of the wedge's two edge rays.
 */

/** A shape the wedge queries test: a circle (r > 0) or an axis-aligned box (hw, hh > 0). */
export interface Shape {
  kind: 'circle' | 'box';
  x: number;
  y: number;
  /** Circle radius. */
  r: number;
  /** Box half width and half height. */
  hw: number;
  hh: number;
}

/** First t ≥ 0 where the ray (px, py) + t·(dx, dy) (unit direction) meets the shape, or Infinity. */
export function rayHit(shape: Shape, px: number, py: number, dx: number, dy: number): number {
  if (shape.kind === 'circle') {
    const ox = px - shape.x;
    const oy = py - shape.y;
    const b = ox * dx + oy * dy;
    const c = ox * ox + oy * oy - shape.r * shape.r;
    if (c <= 0) return 0;
    const disc = b * b - c;
    if (disc < 0) return Infinity;
    const t = -b - Math.sqrt(disc);
    return t >= 0 ? t : Infinity;
  }
  // Slabs.
  let t0 = 0;
  let t1 = Infinity;
  for (let axis = 0; axis < 2; axis++) {
    const p = axis === 0 ? px : py;
    const d = axis === 0 ? dx : dy;
    const lo = axis === 0 ? shape.x - shape.hw : shape.y - shape.hh;
    const hi = axis === 0 ? shape.x + shape.hw : shape.y + shape.hh;
    if (d === 0) {
      if (p < lo || p > hi) return Infinity;
      continue;
    }
    const a = (lo - p) / d;
    const b = (hi - p) / d;
    t0 = Math.max(t0, Math.min(a, b));
    t1 = Math.min(t1, Math.max(a, b));
    if (t0 > t1) return Infinity;
  }
  return t0;
}

/** Distance from (px, py) to the shape (0 inside), and the nearest point into `out`. */
export function nearestPoint(shape: Shape, px: number, py: number, out: Float64Array): number {
  if (shape.kind === 'circle') {
    const vx = px - shape.x;
    const vy = py - shape.y;
    const d = Math.hypot(vx, vy);
    if (d <= shape.r) {
      out[0] = px;
      out[1] = py;
      return 0;
    }
    out[0] = shape.x + (vx / d) * shape.r;
    out[1] = shape.y + (vy / d) * shape.r;
    return d - shape.r;
  }
  out[0] = Math.min(shape.x + shape.hw, Math.max(shape.x - shape.hw, px));
  out[1] = Math.min(shape.y + shape.hh, Math.max(shape.y - shape.hh, py));
  return Math.hypot(out[0] - px, out[1] - py);
}

const scratch = new Float64Array(2);

/**
 * Distance from the apex to the nearest point of `shape` inside the wedge (apex (px, py), unit
 * facing (fx, fy), half-angle in radians < π/2), or Infinity when none lies within `range`.
 */
export function nearestInCone(shape: Shape, px: number, py: number, fx: number, fy: number, halfAngle: number, range: number): number {
  const d = nearestPoint(shape, px, py, scratch);
  if (d > range) return Infinity;
  if (d === 0) return 0;
  const cosHalf = Math.cos(halfAngle);
  const vx = scratch[0] - px;
  const vy = scratch[1] - py;
  if ((vx * fx + vy * fy) / d >= cosHalf - 1e-12) return d;
  // The nearest point is outside the wedge: the wedge's nearest is on an edge ray.
  const s = Math.sin(halfAngle);
  const c = cosHalf;
  const hitA = rayHit(shape, px, py, fx * c - fy * s, fx * s + fy * c);
  const hitB = rayHit(shape, px, py, fx * c + fy * s, -fx * s + fy * c);
  const best = Math.min(hitA, hitB);
  return best <= range ? best : Infinity;
}

/** True when the point (x, y) lies inside the wedge (and within range). */
export function pointInCone(x: number, y: number, px: number, py: number, fx: number, fy: number, halfAngle: number, range: number): boolean {
  const vx = x - px;
  const vy = y - py;
  const d = Math.hypot(vx, vy);
  if (d > range) return false;
  if (d === 0) return true;
  return (vx * fx + vy * fy) / d >= Math.cos(halfAngle) - 1e-12;
}
