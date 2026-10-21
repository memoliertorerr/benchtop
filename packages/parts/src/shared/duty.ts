/**
 * Turns an on/off signal (an LED lit or not) into a brightness 0..1, from exact edge
 * timestamps. Used by every LED-type part.
 *
 * - A change after the signal was steady for DUTY_HOLD_NS (50 ms) shows at once: a blinking
 *   LED flips at the edge's exact time.
 * - While the signal toggles faster than that, brightness is the lit fraction of a window of at
 *   least DUTY_WINDOW_NS (10 ms) that starts and ends on rising edges, so a periodic PWM or
 *   multiplex waveform is measured over whole periods (analogWrite(9, 64) reads 64/255).
 *   Until the first window closes, the brightness shown before the toggling started stays.
 * - When toggling stops, `settle()` (called once the signal has been quiet for DUTY_HOLD_NS)
 *   snaps to 0 or 1.
 * Waveforms slower than 20 Hz therefore blink visibly, as they do on real hardware.
 * Updates smaller than 1/255 are not reported. No allocation.
 */

import type { Nanos, PartContext } from '@benchtop/core';

export const DUTY_WINDOW_NS = 10_000_000;
export const DUTY_HOLD_NS = 50_000_000;
const STEP = 1 / 255;

export class DutyIntegrator {
  /** Current brightness, 0..1. */
  brightness = 0;
  private lit = false;
  private lastEdge = Number.NEGATIVE_INFINITY;
  private before = 0;
  private windowStart = 0;
  private litTime = 0;
  private litSince = 0;
  private measured = false;

  /** The signal is `lit` at `now`. Returns true when `brightness` changed. */
  update(lit: boolean, now: Nanos): boolean {
    if (lit === this.lit) return false;
    let changed = false;
    if (now - this.lastEdge >= DUTY_HOLD_NS) {
      // Steady until now: show the new level at once, and start measuring in case it toggles.
      this.before = this.brightness;
      this.brightness = lit ? 1 : 0;
      changed = this.brightness !== this.before;
      this.windowStart = now;
      this.litTime = 0;
      this.measured = false;
    } else {
      if (this.lit) this.litTime += now - this.litSince;
      if (!this.measured && this.brightness !== this.before) {
        // A second edge right after the first: it wasn't a steady change after all.
        this.brightness = this.before;
        changed = true;
      }
      if (lit && now - this.windowStart >= DUTY_WINDOW_NS) {
        const value = this.litTime / (now - this.windowStart);
        this.windowStart = now;
        this.litTime = 0;
        this.measured = true;
        if (Math.abs(value - this.brightness) > STEP) {
          this.brightness = value;
          changed = true;
        }
      }
    }
    this.lit = lit;
    if (lit) this.litSince = now;
    this.lastEdge = now;
    return changed;
  }

  /** When the next `settle()` call can settle: DUTY_HOLD_NS after the last edge. */
  get quietAt(): Nanos {
    return this.lastEdge + DUTY_HOLD_NS;
  }

  /** If no edge came for DUTY_HOLD_NS, snaps to the steady level. Returns true when it changed. */
  settle(now: Nanos): boolean {
    if (now < this.quietAt) return false;
    const steady = this.lit ? 1 : 0;
    if (steady === this.brightness) return false;
    this.brightness = steady;
    return true;
  }

  reset(): void {
    this.brightness = 0;
    this.lit = false;
    this.lastEdge = Number.NEGATIVE_INFINITY;
    this.before = 0;
    this.measured = false;
  }
}

/**
 * A DutyIntegrator wired to a part's context: `set(lit)` from pin listeners invalidates the
 * part when brightness changes, and one preallocated timer settles it once the signal is quiet.
 */
export class DutyChannel {
  readonly integrator = new DutyIntegrator();
  private lit = false;
  private armed = false;
  private readonly ctx: PartContext;

  constructor(ctx: PartContext) {
    this.ctx = ctx;
  }

  get brightness(): number {
    return this.integrator.brightness;
  }

  set(lit: boolean): void {
    if (lit === this.lit) return;
    this.lit = lit;
    if (this.integrator.update(lit, this.ctx.now())) this.ctx.invalidate();
    if (!this.armed) {
      this.armed = true;
      this.ctx.schedule(DUTY_HOLD_NS, this.settle);
    }
  }

  /** After a bench reset (its timers are gone). */
  reset(): void {
    this.integrator.reset();
    this.lit = false;
    this.armed = false;
  }

  private readonly settle = (): void => {
    const now = this.ctx.now();
    if (this.integrator.settle(now)) this.ctx.invalidate();
    const quietAt = this.integrator.quietAt;
    if (now < quietAt) this.ctx.schedule(quietAt - now, this.settle);
    else this.armed = false;
  };
}
