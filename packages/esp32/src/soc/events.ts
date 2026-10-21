/**
 * The SoC's timed events: a fixed table of slots, each a callback registered once at setup with
 * at most one pending time (reference cycles). Scheduling and firing allocate nothing; the table
 * is small (a few dozen slots), so the earliest time is found by a scan when it changes.
 *
 * Times are rounded up to whole reference cycles (≤ 4.2 ns), so slice boundaries — which end at
 * events — stay integers and WAITI skip-ahead lands on exactly the slice boundaries a normal run
 * would (soc.ts).
 */

export class EventTable {
  private readonly times: number[] = [];
  private readonly callbacks: (() => void)[] = [];
  /** The earliest pending time (Infinity when nothing is pending). */
  next = Number.POSITIVE_INFINITY;
  /**
   * While a callback runs: its own time (BT37), which the SoC reports as now() — an event
   * scheduled during a slice fires at the slice's end, but what it does happens at its time
   * (an RMT edge's timestamp, the next edge it schedules). −1 otherwise.
   */
  firing = -1;

  /** Registers a callback; returns its slot. */
  add(callback: () => void): number {
    this.times.push(Number.POSITIVE_INFINITY);
    this.callbacks.push(callback);
    return this.times.length - 1;
  }

  /** (Re)schedules `slot` at `time` (rounded up to a whole reference cycle). */
  schedule(slot: number, time: number): void {
    const t = Math.ceil(time);
    this.times[slot] = t;
    if (t < this.next) this.next = t;
    else this.rescan();
  }

  cancel(slot: number): void {
    if (this.times[slot] === Number.POSITIVE_INFINITY) return;
    this.times[slot] = Number.POSITIVE_INFINITY;
    this.rescan();
  }

  /** Cancels everything (a reboot). */
  clear(): void {
    this.times.fill(Number.POSITIVE_INFINITY);
    this.next = Number.POSITIVE_INFINITY;
  }

  pending(slot: number): boolean {
    return this.times[slot] !== Number.POSITIVE_INFINITY;
  }

  /** When `slot` fires (Infinity if it isn't pending). */
  timeOf(slot: number): number {
    return this.times[slot];
  }

  /** Fires every slot due at or before `time`, earliest first (a callback may reschedule). */
  fireDue(time: number): void {
    while (this.next <= time) {
      let slot = 0;
      for (let i = 1; i < this.times.length; i++) if (this.times[i] < this.times[slot]) slot = i;
      this.firing = this.times[slot];
      this.times[slot] = Number.POSITIVE_INFINITY;
      this.rescan();
      this.callbacks[slot]();
      this.firing = -1;
    }
  }

  private rescan(): void {
    let next = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.times.length; i++) if (this.times[i] < next) next = this.times[i];
    this.next = next;
  }
}
