/**
 * Bodies in the environment (BT54): a person (a warm circle) or an object (a box), standing or
 * on a patrol — from its start to an end point at a speed, a pause at each end, and back,
 * forever. Position is a pure function of the body's walking time, which only advances while
 * it walks, so stopping and resuming continues from where it stood and a replay at the same
 * times lands on the same positions.
 */

export interface Patrol {
  /** Start and end, metres. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** m/s; ≤ 0 means standing at the start. */
  speed: number;
  /** Seconds standing at each end. */
  pause: number;
}

/**
 * Where a body on `patrol` is after walking `t` seconds, written into out[0..1], and its speed
 * then (m/s; 0 while pausing or standing) as the return value.
 */
export function patrolAt(patrol: Patrol, t: number, out: Float64Array): number {
  const { x0, y0, x1, y1, speed } = patrol;
  const pause = Math.max(0, patrol.pause);
  const length = Math.hypot(x1 - x0, y1 - y0);
  if (!(speed > 0) || length === 0 || !(t > 0)) {
    out[0] = x0;
    out[1] = y0;
    return 0;
  }
  const travel = length / speed;
  const cycle = 2 * travel + 2 * pause;
  const phase = t % cycle;
  let f: number;
  let moving: boolean;
  if (phase < pause) {
    f = 0;
    moving = false;
  } else if (phase < pause + travel) {
    f = (phase - pause) / travel;
    moving = true;
  } else if (phase < 2 * pause + travel) {
    f = 1;
    moving = false;
  } else {
    f = 1 - (phase - 2 * pause - travel) / travel;
    moving = true;
  }
  out[0] = x0 + (x1 - x0) * f;
  out[1] = y0 + (y1 - y0) * f;
  return moving ? speed : 0;
}
