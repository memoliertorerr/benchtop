/**
 * Timed callbacks on the simulated clock: a binary min-heap keyed by (time, sequence), so
 * callbacks run in time order and in scheduling order when times are equal.
 *
 * Entries live in preallocated parallel arrays (grown by doubling) and are recycled through a
 * free list, so scheduling allocates nothing in steady state. Cancelling is lazy: the entry is
 * marked dead and dropped when it reaches the top of the heap (the heap is compacted if dead
 * entries pile up). A timer id packs the entry index and that entry's generation, so ids of
 * fired or cancelled timers never match a recycled entry.
 */

import type { Nanos } from '../contracts/time.ts';

/** Entry indexes fit in the low 20 bits of an id: at most ~1 M pending timers. */
const INDEX_BITS = 2 ** 20;

export class Scheduler {
  private time = new Float64Array(64);
  private seq = new Float64Array(64);
  private gen = new Float64Array(64);
  private callbacks: ((() => void) | null)[] = new Array(64).fill(null);
  private free = new Int32Array(64);
  private freeLen = 64;
  private heap = new Int32Array(64);
  private heapLen = 0;
  private nextSeq = 0;
  private live = 0;

  constructor() {
    for (let i = 0; i < 64; i++) this.free[i] = 63 - i;
  }

  /** Pending (not cancelled, not fired) timers. */
  get size(): number {
    return this.live;
  }

  /** Runs `callback` once when the clock reaches `at` (absolute ns). Returns a timer id ≥ 0. */
  schedule(at: Nanos, callback: () => void): number {
    if (Number.isNaN(at)) throw new RangeError('timer time is NaN');
    if (this.freeLen === 0) this.grow();
    const e = this.free[--this.freeLen];
    this.time[e] = at;
    this.seq[e] = this.nextSeq++;
    this.callbacks[e] = callback;
    this.live++;
    this.push(e);
    return this.gen[e] * INDEX_BITS + e;
  }

  /** Cancels a pending timer; ids that already fired or were cancelled are ignored. */
  cancel(id: number): void {
    if (!(id >= 0)) return;
    const e = id % INDEX_BITS;
    if (e >= this.callbacks.length || this.gen[e] !== Math.floor(id / INDEX_BITS)) return;
    if (this.callbacks[e] === null) return;
    this.callbacks[e] = null;
    this.gen[e]++;
    this.live--;
    if (this.heapLen > 1024 && this.heapLen > 2 * this.live) this.compact();
  }

  /** Time of the earliest pending timer, or Infinity. */
  nextTime(): Nanos {
    this.dropDeadTop();
    return this.heapLen === 0 ? Infinity : this.time[this.heap[0]];
  }

  /**
   * Runs every timer due at or before `upTo`, in (time, scheduling) order, including timers that
   * callbacks schedule within the window. Returns how many ran.
   */
  runDue(upTo: Nanos): number {
    let ran = 0;
    for (;;) {
      this.dropDeadTop();
      if (this.heapLen === 0) return ran;
      const e = this.heap[0];
      if (this.time[e] > upTo) return ran;
      this.pop();
      const callback = this.callbacks[e] as () => void;
      this.callbacks[e] = null;
      this.gen[e]++;
      this.live--;
      this.free[this.freeLen++] = e;
      ran++;
      callback();
    }
  }

  /** Drops every pending timer. Their ids stay invalid. */
  clear(): void {
    for (let i = 0; i < this.heapLen; i++) {
      const e = this.heap[i];
      if (this.callbacks[e] !== null) {
        this.callbacks[e] = null;
        this.gen[e]++;
      }
      this.free[this.freeLen++] = e;
    }
    this.heapLen = 0;
    this.live = 0;
  }

  private less(a: number, b: number): boolean {
    const ta = this.time[a];
    const tb = this.time[b];
    return ta < tb || (ta === tb && this.seq[a] < this.seq[b]);
  }

  private push(e: number): void {
    const heap = this.heap;
    let i = this.heapLen++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(e, heap[parent])) break;
      heap[i] = heap[parent];
      i = parent;
    }
    heap[i] = e;
  }

  private pop(): void {
    const heap = this.heap;
    const last = heap[--this.heapLen];
    if (this.heapLen === 0) return;
    let i = 0;
    for (;;) {
      const left = 2 * i + 1;
      if (left >= this.heapLen) break;
      const right = left + 1;
      const child = right < this.heapLen && this.less(heap[right], heap[left]) ? right : left;
      if (!this.less(heap[child], last)) break;
      heap[i] = heap[child];
      i = child;
    }
    heap[i] = last;
  }

  private dropDeadTop(): void {
    while (this.heapLen > 0 && this.callbacks[this.heap[0]] === null) {
      const e = this.heap[0];
      this.pop();
      this.free[this.freeLen++] = e;
    }
  }

  /** Rebuilds the heap from live entries only. */
  private compact(): void {
    let n = 0;
    for (let i = 0; i < this.heapLen; i++) {
      const e = this.heap[i];
      if (this.callbacks[e] === null) this.free[this.freeLen++] = e;
      else this.heap[n++] = e;
    }
    this.heapLen = 0;
    for (let i = 0; i < n; i++) this.push(this.heap[i]);
  }

  private grow(): void {
    const old = this.time.length;
    const size = old * 2;
    if (size > INDEX_BITS) throw new RangeError(`more than ${INDEX_BITS} pending timers`);
    const time = new Float64Array(size);
    time.set(this.time);
    this.time = time;
    const seq = new Float64Array(size);
    seq.set(this.seq);
    this.seq = seq;
    const gen = new Float64Array(size);
    gen.set(this.gen);
    this.gen = gen;
    for (let i = old; i < size; i++) this.callbacks.push(null);
    const heap = new Int32Array(size);
    heap.set(this.heap);
    this.heap = heap;
    const free = new Int32Array(size);
    free.set(this.free.subarray(0, this.freeLen));
    for (let i = size - 1; i >= old; i--) free[this.freeLen++] = i;
    this.free = free;
  }
}
