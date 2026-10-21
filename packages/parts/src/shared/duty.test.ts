import { describe, expect, it } from 'vitest';
import { DUTY_HOLD_NS, DutyIntegrator } from './duty.ts';

const MS = 1_000_000;

/** Feeds a square wave: `count` periods of `period` ns, high for `high` ns, from `start`. */
function pwm(d: DutyIntegrator, start: number, period: number, high: number, count: number): number[] {
  const seen: number[] = [];
  for (let i = 0; i < count; i++) {
    const t = start + i * period;
    d.update(true, t);
    seen.push(d.brightness);
    d.update(false, t + high);
    seen.push(d.brightness);
  }
  return seen;
}

describe('DutyIntegrator', () => {
  it('flips at once on a change after a steady period (a blink)', () => {
    const d = new DutyIntegrator();
    expect(d.update(true, 0)).toBe(true);
    expect(d.brightness).toBe(1);
    expect(d.update(false, 500 * MS)).toBe(true);
    expect(d.brightness).toBe(0);
    expect(d.update(false, 600 * MS)).toBe(false);
  });

  it('measures PWM over whole periods, without a flash when it starts', () => {
    const d = new DutyIntegrator();
    // analogWrite at 490 Hz (2.04 ms), duty 64/255.
    const period = 2_040_816;
    const seen = pwm(d, 10 * MS, period, Math.round((period * 64) / 255), 40);
    // The first rising edge briefly shows 1, but the falling edge right after takes it back.
    expect(seen[1]).toBe(0);
    expect(Math.max(...seen.slice(1))).toBeLessThan(0.3);
    expect(d.brightness).toBeCloseTo(64 / 255, 3);
  });

  it('ignores a single short glitch and settles once quiet', () => {
    const d = new DutyIntegrator();
    d.update(true, 0);
    d.update(false, 1000); // a 1 µs pulse
    expect(d.brightness).toBe(0);
    expect(d.settle(DUTY_HOLD_NS - 1)).toBe(false);
    expect(d.settle(1000 + DUTY_HOLD_NS)).toBe(false); // already 0
    pwm(d, 100 * MS, 2 * MS, 1 * MS, 20); // last falling edge at 139 ms
    d.update(true, 140 * MS); // the PWM ends high
    expect(d.brightness).toBeCloseTo(0.5, 2);
    expect(d.settle(140 * MS + DUTY_HOLD_NS - 1)).toBe(false);
    expect(d.settle(140 * MS + DUTY_HOLD_NS)).toBe(true);
    expect(d.brightness).toBe(1);
  });

  it('reports a multiplexed quarter duty', () => {
    const d = new DutyIntegrator();
    pwm(d, 0, 8 * MS, 2 * MS, 20);
    expect(d.brightness).toBeCloseTo(0.25, 6);
  });
});
