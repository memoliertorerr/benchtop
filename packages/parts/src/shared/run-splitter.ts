/**
 * Keeps one timer pending every `period` ns while armed, so the bench never lets an MCU run
 * longer than that without coming back to its scheduler.
 *
 * Why: a timer a part schedules from a pin listener *during* an MCU run fires when that run ends
 * (the bench can't stop an MCU early — see "Time" in bench.ts). Runs end at the next pending
 * timer, so with a timer at most `period` away, a response scheduled ≥ `period` after the edge
 * that caused it fires exactly on time. Timed-protocol parts (DHT22: 30 µs after the start
 * pulse; HC-SR04: 200 µs after the trigger) arm one while they wait for that edge. One
 * preallocated callback; no allocation per tick.
 */

import type { Nanos, PartContext } from '@benchtop/core';

export class RunSplitter {
  private readonly ctx: PartContext;
  private period: Nanos = 0;
  private timer = -1;

  constructor(ctx: PartContext) {
    this.ctx = ctx;
  }

  /** Ticks every `period` ns from now (re-arming with a new period restarts the chain). */
  arm(period: Nanos): void {
    if (this.timer >= 0 && period === this.period) return;
    this.disarm();
    this.period = period;
    this.timer = this.ctx.schedule(period, this.tick);
  }

  disarm(): void {
    if (this.timer >= 0) this.ctx.cancel(this.timer);
    this.timer = -1;
  }

  /** After a bench reset (its timers are gone). */
  reset(): void {
    this.timer = -1;
  }

  private readonly tick = (): void => {
    this.timer = this.ctx.schedule(this.period, this.tick);
  };
}
