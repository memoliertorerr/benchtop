/**
 * Edge capture for one probe: a preallocated ring of (time ns, level) pairs. Levels are 0, 1,
 * 2 = floating (z) and 3 = conflict (x). When full it overwrites the oldest edge and counts the
 * drop. `written` counts every edge ever pushed, so a reader can ask for what's new since its
 * last read. push() never allocates.
 */

export const PROBE_CAPACITY = 1 << 17;
export const MAX_PROBES = 16;

export const LEVEL_Z = 2;
export const LEVEL_X = 3;

export class ProbeRing {
  readonly capacity: number;
  readonly times: Float64Array;
  readonly levels: Uint8Array;
  /** Edges ever pushed (the absolute index of the next one). */
  written = 0;
  /** Edges overwritten before anyone could read them out of the ring. */
  get dropped(): number {
    return Math.max(0, this.written - this.capacity);
  }

  constructor(capacity = PROBE_CAPACITY) {
    this.capacity = capacity;
    this.times = new Float64Array(capacity);
    this.levels = new Uint8Array(capacity);
  }

  push(time: number, level: number): void {
    const i = this.written % this.capacity;
    this.times[i] = time;
    this.levels[i] = level;
    this.written++;
  }

  /** Number of edges held (≤ capacity). */
  get size(): number {
    return Math.min(this.written, this.capacity);
  }

  /** Absolute index of the oldest edge held. */
  get first(): number {
    return this.written - this.size;
  }

  /** The edge at absolute index `index` (first ≤ index < written). */
  timeAt(index: number): number {
    return this.times[index % this.capacity];
  }

  levelAt(index: number): number {
    return this.levels[index % this.capacity];
  }

  /**
   * Copies the edges from absolute index `since` on (at most `max`, the newest ones) into new
   * arrays. Returns where the copy starts and how many requested edges were lost (overwritten,
   * or beyond `max`).
   */
  read(since: number, max = this.capacity): { from: number; times: Float64Array; levels: Uint8Array; lost: number } {
    const start = Math.max(since, this.first, this.written - max);
    const count = Math.max(0, this.written - start);
    const times = new Float64Array(count);
    const levels = new Uint8Array(count);
    for (let k = 0; k < count; k++) {
      const i = (start + k) % this.capacity;
      times[k] = this.times[i];
      levels[k] = this.levels[i];
    }
    return { from: start, times, levels, lost: Math.max(0, start - since) };
  }

  clear(): void {
    this.written = 0;
  }
}
