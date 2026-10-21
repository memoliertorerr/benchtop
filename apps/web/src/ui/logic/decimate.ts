/**
 * Waveform decimation: a probe's edges over [t0, t1] → at most 2 segments per pixel column, so
 * drawing cost follows pixels, not edges. A column with more than one edge becomes one "mixed"
 * segment (drawn as a full-height bar). Pure; tested in Node.
 */

/** What decimation reads: a ring of edges by absolute index (ProbeRing fits). */
export interface EdgeSource {
  readonly first: number;
  readonly written: number;
  timeAt(index: number): number;
  levelAt(index: number): number;
}

export interface Segment {
  /** Pixel columns [x0, x1). */
  x0: number;
  x1: number;
  /** 0, 1, 2 = z, 3 = x; −1 for a mixed column (several edges). */
  level: number;
}

/** Index of the last edge at or before `t`, or first − 1 when all are later. */
export function edgeAt(source: EdgeSource, t: number): number {
  let lo = source.first;
  let hi = source.written - 1;
  if (hi < lo || source.timeAt(lo) > t) return lo - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (source.timeAt(mid) <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Segments for `width` pixel columns spanning [t0, t1]; the trace ends at `tEnd` (the latest
 * simulated time — the last level holds until then).
 */
export function decimate(source: EdgeSource, t0: number, t1: number, width: number, tEnd: number): Segment[] {
  const segments: Segment[] = [];
  if (width <= 0 || t1 <= t0 || source.written === source.first) return segments;
  const perPx = (t1 - t0) / width;
  const xOf = (t: number): number => Math.floor((t - t0) / perPx);
  const endX = Math.min(width, Math.max(0, Math.ceil((Math.min(tEnd, t1) - t0) / perPx)));
  let i = edgeAt(source, t0);
  let x = 0;
  let level = i >= source.first ? source.levelAt(i) : -2; // −2: nothing recorded yet here
  if (i < source.first) {
    // Before the first edge: start where it is.
    i = source.first - 1;
    x = Math.max(0, xOf(source.timeAt(source.first)));
  }
  const push = (x0: number, x1: number, l: number): void => {
    if (x1 <= x0 || l === -2) return;
    const last = segments[segments.length - 1];
    if (last !== undefined && last.level === l && last.x1 === x0) last.x1 = x1;
    else segments.push({ x0, x1, level: l });
  };
  let next = i + 1;
  while (x < endX) {
    if (next >= source.written || source.timeAt(next) > t1) {
      push(x, endX, level);
      break;
    }
    const col = Math.max(x, xOf(source.timeAt(next)));
    if (col >= endX) {
      push(x, endX, level);
      break;
    }
    push(x, col, level);
    // Every edge in this column (found by binary search, so a dense range costs per pixel, not
    // per edge): one edge → the new level from here; several → a mixed column.
    const last = lastInColumn(source, next, col, xOf, t1);
    const count = last - next + 1;
    level = source.levelAt(last);
    next = last + 1;
    if (count > 1) {
      push(col, col + 1, -1);
      x = col + 1;
    } else {
      x = col;
    }
  }
  return segments;
}

/** The last edge index ≥ `from` that falls in pixel column `col` (and not after t1). */
function lastInColumn(source: EdgeSource, from: number, col: number, xOf: (t: number) => number, t1: number): number {
  let lo = from;
  let hi = source.written - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    const t = source.timeAt(mid);
    if (xOf(t) <= col && t <= t1) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
