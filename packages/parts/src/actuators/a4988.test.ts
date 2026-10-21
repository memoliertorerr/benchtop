import { type Level, type NetState, type PartContext, Strength } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { bipolarPosition } from './stepper.ts';
import { a4988 } from './a4988.ts';

// BT53: the A4988's translator on a stub context — input levels set by the test, outputs read
// back as the coil drives a bipolar motor would see.

function harness() {
  const levels: Record<string, Level | null> = { STEP: 0, DIR: 1, ENABLE: 0, SLEEP: null, RESET: null, MS1: 0, MS2: 0, MS3: 0 };
  const listeners: Record<string, ((s: NetState) => void)[]> = {};
  const out: Record<string, number | null> = {};
  const state = (name: string): NetState =>
    name === 'VMOT'
      ? { level: 1, strength: Strength.supply, conflict: false, volts: 12 }
      : { level: levels[name] ?? null, strength: levels[name] === null || levels[name] === undefined ? Strength.hiz : Strength.strong, conflict: false, volts: levels[name] === 1 ? 5 : 0 };
  const ctx = {
    pin: (name: string) => ({
      read: () => state(name),
      onChange: (fn: (s: NetState) => void) => (listeners[name] ??= []).push(fn),
      driveVolts: (v: number) => (out[name] = v),
      release: () => (out[name] = null),
    }),
    invalidate: () => {},
  } as unknown as PartContext;
  a4988.createModel?.(ctx, {} as never);
  const set = (name: string, level: Level | null): void => {
    levels[name] = level;
    for (const fn of listeners[name] ?? []) fn(state(name));
  };
  const pulse = (n = 1): void => {
    for (let i = 0; i < n; i++) {
      set('STEP', 1);
      set('STEP', 0);
    }
  };
  /** The electrical position (half-steps, 0..8) the outputs show, or null while released. */
  const position = (): number | null => {
    if (out['1A'] === null || out['1A'] === undefined) return null;
    return bipolarPosition((out['1A'] ?? 0) - (out['1B'] ?? 0), (out['2A'] ?? 0) - (out['2B'] ?? 0));
  };
  return { set, pulse, position };
}

describe('A4988 (BT53)', () => {
  it('starts at the 45° home state; full steps move 90° of the field (2 half-steps) each', () => {
    const t = harness();
    expect(t.position()).toBe(1);
    t.pulse();
    expect(t.position()).toBe(3);
    t.set('DIR', 0);
    t.pulse(2);
    expect(t.position()).toBe(7);
  });

  it.each([
    [[1, 0, 0], 1], // half
    [[0, 1, 0], 0.5], // quarter
    [[1, 1, 0], 0.25], // eighth
    [[1, 1, 1], 0.125], // sixteenth
  ] as const)('MS1–3 = %s moves %s half-steps a pulse', ([ms1, ms2, ms3], halfSteps) => {
    const t = harness();
    t.set('MS1', ms1);
    t.set('MS2', ms2);
    t.set('MS3', ms3);
    t.pulse();
    expect(t.position()).toBeCloseTo(1 + halfSteps, 6);
  });

  it('ENABLE high or SLEEP low release the coils; RESET low returns home and ignores STEP', () => {
    const t = harness();
    t.pulse();
    t.set('ENABLE', 1);
    expect(t.position()).toBeNull();
    t.set('ENABLE', 0);
    expect(t.position()).toBe(3);
    t.set('SLEEP', 0);
    expect(t.position()).toBeNull();
    t.set('SLEEP', 1);
    t.set('RESET', 0);
    t.pulse(3);
    expect(t.position()).toBeNull();
    t.set('RESET', 1);
    expect(t.position()).toBe(1);
  });
});
