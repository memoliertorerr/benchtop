/**
 * Stepper motors, decoded from coil levels. Electrical position runs over 8 half-steps; a change
 * of ±1..±3 rotates, ±4 is ambiguous (no move, counted, info problem 'stepper-sequence'), and any
 * other coil set holds. The first defined state sets the reference without moving. The coils are
 * read once they have been steady for 100 µs (the rotor can't follow microsecond states), so a
 * library writing four pins one by one makes one step; a RunSplitter keeps MCU runs that short
 * once the motor is in use, so the read lands on time.
 * Visual: `angle` (degrees, unbounded), `steps` (full steps = half-steps / 2), `coils` (4 levels).
 *
 * - stepper-28byj48: a 28BYJ-48 on a ULN2003 board (our own view). A coil is energized while its
 *   IN net is 1; positions A=0, AB=1, B=2, BC=3, C=4, CD=5, D=6, DA=7 (IN1..IN4 = A..D).
 *   Decided: 4096 half-steps per output turn (64:1 gearing).
 * - stepper-bipolar: two coils behind an H-bridge (stepper-motor element, NEMA 17 drawing). Each
 *   coil's drive is its volts difference, A = V(A+) − V(A−), B = V(B+) − V(B−), and the electrical
 *   position is the angle atan2(B, A) in eighths of a turn — for digital drive exactly the
 *   half-steps (A, B) = (1,0)=0, (1,1)=1, (0,1)=2, (−1,1)=3, (−1,0)=4, (−1,−1)=5, (0,−1)=6,
 *   (1,−1)=7, and between them for a microstepping driver's sine/cosine currents (BT53, A4988);
 *   both coils under 0.5 V hold. 400 half-steps per turn (1.8° full step).
 */

import { NS_PER_US, type PartContext, type PinHandle } from '@benchtop/core';
import { definePart } from '../define.ts';
import { RunSplitter } from '../shared/run-splitter.ts';

const SETTLE_NS = 100 * NS_PER_US;

/** Coil bitmask (A=1, B=2, C=4, D=8) → electrical position, or −1 to hold. */
const UNIPOLAR = new Int8Array(16).fill(-1);
for (const [mask, pos] of [
  [1, 0],
  [3, 1],
  [2, 2],
  [6, 3],
  [4, 4],
  [12, 5],
  [8, 6],
  [9, 7],
] as const) {
  UNIPOLAR[mask] = pos;
}

/** (A+1)·3 + (B+1) for A, B in −1..1 → electrical position, or −1 to hold. */
const BIPOLAR = new Int8Array(9).fill(-1);
for (const [a, b, pos] of [
  [1, 0, 0],
  [1, 1, 1],
  [0, 1, 2],
  [-1, 1, 3],
  [-1, 0, 4],
  [-1, -1, 5],
  [0, -1, 6],
  [1, -1, 7],
] as const) {
  BIPOLAR[(a + 1) * 3 + (b + 1)] = pos;
}

/**
 * A bipolar motor's electrical position (0 ≤ p < 8, eighths of a turn of the field) from its coil
 * drives A and B (volts), or −1 to hold when neither coil carries current.
 */
export function bipolarPosition(a: number, b: number): number {
  if (Math.abs(a) < 0.5 && Math.abs(b) < 0.5) return -1;
  const p = (Math.atan2(b, a) / (2 * Math.PI)) * 8;
  // Rounded to a millionth: drives that should be exact half-steps compare equal.
  return Math.round((p < 0 ? p + 8 : p) * 1e6) / 1e6 % 8;
}

/** Signed shortest move from electrical position `from` to `to` (−4 < d ≤ 4; 4 = ambiguous). */
export function halfStepDelta(from: number, to: number): number {
  const d = (((to - from) % 8) + 8) % 8;
  return d > 4 ? d - 8 : d;
}

/** Tracks position from successive electrical states. Allocation-free. */
export class StepTracker {
  halfSteps = 0;
  ambiguous = 0;
  private position = -1;
  private instant = Number.NaN;
  private positionBefore = -1;
  private halfStepsBefore = 0;

  /** The coils now show electrical position `pos` (−1 = hold) at time `now`. */
  update(pos: number, now: number): 'moved' | 'ambiguous' | 'none' {
    if (now === this.instant) {
      // Another pin of the same port write: replace this instant's earlier change.
      this.position = this.positionBefore;
      this.halfSteps = this.halfStepsBefore;
    } else {
      this.instant = now;
      this.positionBefore = this.position;
      this.halfStepsBefore = this.halfSteps;
    }
    if (pos < 0) return 'none';
    if (this.position < 0) {
      this.position = pos;
      return 'none';
    }
    const delta = halfStepDelta(this.position, pos);
    if (delta === 4) {
      this.ambiguous++;
      return 'ambiguous';
    }
    if (delta === 0) return 'none';
    this.position = pos;
    this.halfSteps += delta;
    return 'moved';
  }

  reset(): void {
    this.halfSteps = 0;
    this.ambiguous = 0;
    this.position = -1;
    this.instant = Number.NaN;
  }
}

function stepperModel(ctx: PartContext, pinNames: readonly string[], halfStepsPerTurn: number, position: (pins: readonly PinHandle[], coils: number[]) => number, sequenceHint: string) {
  const pins = pinNames.map((name) => ctx.pin(name));
  const tracker = new StepTracker();
  const coils: number[] = [0, 0, 0, 0];
  const visual = { angle: 0, steps: 0, coils };
  const splitter = new RunSplitter(ctx);
  let warned = false;
  let lastChange = 0;
  let pending = false;
  const settle = (): void => {
    const now = ctx.now();
    if (now - lastChange < SETTLE_NS) {
      ctx.schedule(lastChange + SETTLE_NS - now, settle);
      return;
    }
    pending = false;
    const result = tracker.update(position(pins, coils), now);
    if (result === 'ambiguous' && !warned) {
      warned = true;
      ctx.report({ severity: 'info', code: 'stepper-sequence', message: sequenceHint, parts: [] });
    }
    ctx.invalidate();
  };
  const changed = (): void => {
    lastChange = ctx.now();
    splitter.arm(SETTLE_NS);
    if (!pending) {
      pending = true;
      ctx.schedule(SETTLE_NS, settle);
    }
  };
  for (const pin of pins) pin.onChange(changed);
  return {
    visual() {
      visual.angle = Math.round(((tracker.halfSteps * 360) / halfStepsPerTurn) * 1000) / 1000;
      visual.steps = tracker.halfSteps / 2;
      return visual;
    },
    reset() {
      tracker.reset();
      splitter.reset();
      warned = false;
      pending = false;
      ctx.invalidate();
    },
  };
}

export const stepper28byj48 = definePart({
  type: 'stepper-28byj48',
  title: 'Stepper 28BYJ-48 + ULN2003',
  category: 'motors',
  size: { w: 36, h: 64 },
  pins: [
    { name: 'IN1', x: 11.57, y: 61.46, role: 'digital' },
    { name: 'IN2', x: 14.11, y: 61.46, role: 'digital' },
    { name: 'IN3', x: 16.65, y: 61.46, role: 'digital' },
    { name: 'IN4', x: 19.19, y: 61.46, role: 'digital' },
    { name: 'VCC', x: 21.73, y: 61.46, role: 'power' },
    { name: 'GND', x: 24.27, y: 61.46, role: 'ground' },
  ],
  defaults: {},
  createModel: (ctx) =>
    stepperModel(
      ctx,
      ['IN1', 'IN2', 'IN3', 'IN4'],
      4096,
      (pins, coils) => {
        let mask = 0;
        for (let i = 0; i < 4; i++) {
          coils[i] = pins[i].read().level === 1 ? 1 : 0;
          mask |= coils[i] << i;
        }
        return UNIPOLAR[mask];
      },
      'The 28BYJ-48 jumped between opposite coils — check the coil order: Stepper.h needs IN1, IN3, IN2, IN4 for a 28BYJ-48.',
    ),
});

export const stepperBipolar = definePart({
  type: 'stepper-bipolar',
  title: 'Stepper (bipolar, NEMA 17)',
  category: 'motors',
  size: { w: 43.3, h: 47.3 },
  pins: [
    { name: 'A-', x: 17.667, y: 47.306, role: 'passive' },
    { name: 'A+', x: 20.207, y: 47.306, role: 'passive' },
    { name: 'B+', x: 22.747, y: 47.306, role: 'passive' },
    { name: 'B-', x: 25.287, y: 47.306, role: 'passive' },
  ],
  defaults: {},
  createModel: (ctx) =>
    stepperModel(
      ctx,
      ['A+', 'A-', 'B+', 'B-'],
      400,
      (pins, coils) => {
        for (let i = 0; i < 4; i++) coils[i] = pins[i].read().level === 1 ? 1 : 0;
        const a = pins[0].read().volts - pins[1].read().volts;
        const b = pins[2].read().volts - pins[3].read().volts;
        return bipolarPosition(a, b);
      },
      'The stepper jumped between opposite coil states — check the coil wiring (A+/A−, B+/B−).',
    ),
});
