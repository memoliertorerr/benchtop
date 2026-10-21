/**
 * A fast-PWM ordering fix for avr8js 0.21.1's timers (BT41), applied to each AVRTimer right
 * after it is built.
 *
 * The timer counts lazily: one step advances the counter by the cycles since the last step (an
 * instruction's 1–5 cycles, an interrupt's entry). When a step wraps past TOP and also reaches
 * OCRnx again in the new period, avr8js applies that compare match first and the BOTTOM set
 * after it, so a non-inverting output ends the step set and stays set for the whole period: with
 * OCR2B = 1 at prescaler 1 — a 2-cycle pulse on the chip — the pin is high 100 % of the time.
 * PCM played through fast PWM (8-bit samples near 0, uno/pcm-playback) is exactly that case.
 *
 * The fix wraps the step: in fast PWM, a BOTTOM set that comes after the same step's new-period
 * compare match on that channel is skipped, so the output ends the step where the chip's would.
 * The new period compares against the OCR latched at BOTTOM (fast PWM double-buffers OCRnx).
 * A pulse shorter than one step still has no width — the duty error is a few cycles in 256. No
 * allocation per step; one extra call and two flag writes.
 */

import type { AVRTimer } from 'avr8js';

/** The members of avr8js's AVRTimer the fix reads and wraps (not in its public typings). */
interface TimerInternals {
  count: (reschedule?: boolean, external?: boolean) => void;
  timerUpdated(value: number, prevValue: number): void;
  updateCompPin(compValue: number, pinName: 'A' | 'B' | 'C', bottom?: boolean): void;
  timerMode: number;
  nextOcrA: number;
  nextOcrB: number;
  nextOcrC: number;
}

/** avr8js's TimerMode.FastPWM. */
const FAST_PWM = 3;

export function fixFastPwmOrder(timer: AVRTimer): void {
  const t = timer as unknown as TimerInternals;
  const count = t.count;
  const timerUpdated = t.timerUpdated.bind(t);
  const updateCompPin = t.updateCompPin.bind(t);
  let stepping = false;
  /** Channels (A 1, B 2, C 4) whose compare matched in the new period during this step. */
  let matched = 0;
  // Clock events and register hooks call `this.count`, so replacing the property reroutes them.
  t.count = (reschedule = true, external = false) => {
    stepping = true;
    matched = 0;
    count(reschedule, external);
    stepping = false;
  };
  t.timerUpdated = (value, prevValue) => {
    if (stepping && t.timerMode === FAST_PWM && prevValue > value) {
      matched = (value >= t.nextOcrA ? 1 : 0) | (value >= t.nextOcrB ? 2 : 0) | (value >= t.nextOcrC ? 4 : 0);
    }
    timerUpdated(value, prevValue);
  };
  t.updateCompPin = (compValue, pinName, bottom = false) => {
    if (bottom && stepping && (matched & (pinName === 'A' ? 1 : pinName === 'B' ? 2 : 4)) !== 0) return;
    updateCompPin(compValue, pinName, bottom);
  };
}
