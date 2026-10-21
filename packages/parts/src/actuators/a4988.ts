/**
 * A4988 microstepping driver on a Pololu-style carrier (BT53; Allegro A4988 datasheet, "Step
 * Sequencing" table and "Microstep Resolution Truth Table"). Our own drawing (no element exists):
 * 0.6″ × 0.8″, two 8-pin headers 0.5″ apart.
 *
 * Each STEP rising edge moves the translator one step of the resolution MS1–MS3 select — 000
 * full, 100 half, 010 quarter, 110 eighth, 111 sixteenth — forward with DIR high, back with DIR
 * low. The translator walks a 64-entry table over one electrical turn (1/16 step = 5.625° of the
 * field); coil 1 (1A/1B) carries cos θ and coil 2 (2A/2B) sin θ of VMOT, as volts on the outputs
 * (the positive side driven, the other at 0 V), so a stepper-bipolar on them follows every
 * microstep. Full steps sit at 45° + k·90° (both coils at 70.7 %), as the datasheet's full-step
 * sequence does; reset and power-up return to the 45° home state.
 *
 * ENABLE high, SLEEP low or RESET low turn the outputs off (released: the coils go slack);
 * RESET low also returns home and STEP is ignored while it is. Unwired inputs read as the
 * carrier's defaults: ENABLE and MS1–3 pulled down (enabled, full step), SLEEP pulled up, RESET
 * floating counts as high (most wire it to SLEEP). An unpowered VMOT releases the outputs.
 */

import { type PartContext, type PinHandle, Strength } from '@benchtop/core';
import { definePart } from '../define.ts';

const PITCH = 2.54;
/** Left header top to bottom, then right header top to bottom (the Pololu carrier's order). */
const LEFT = ['ENABLE', 'MS1', 'MS2', 'MS3', 'RESET', 'SLEEP', 'STEP', 'DIR'];
const RIGHT = ['VMOT', 'GND.1', '2B', '2A', '1A', '1B', 'VDD', 'GND.2'];

/** Table steps (of 64 per electrical turn) per STEP pulse, by MS3·4 + MS2·2 + MS1. */
const STRIDE: Readonly<Record<number, number>> = { 0b000: 16, 0b001: 8, 0b010: 4, 0b011: 2, 0b111: 1 };
/** The home state: 45° (table index 8). */
const HOME = 8;

export const a4988 = definePart({
  type: 'a4988',
  title: 'A4988 stepper driver',
  category: 'motors',
  size: { w: 6 * PITCH, h: 8 * PITCH },
  pins: [
    ...LEFT.map((name, i) => ({ name, x: PITCH / 2, y: PITCH / 2 + i * PITCH, role: 'digital' as const })),
    ...RIGHT.map((name, i) => ({
      name,
      x: PITCH / 2 + 5 * PITCH,
      y: PITCH / 2 + i * PITCH,
      role: name.startsWith('GND') ? ('ground' as const) : name === 'VMOT' || name === 'VDD' ? ('power' as const) : ('passive' as const),
    })),
  ],
  buses: [['GND.1', 'GND.2']],
  defaults: {},
  createModel(ctx: PartContext) {
    const pin = (name: string): PinHandle => ctx.pin(name);
    const step = pin('STEP');
    const dir = pin('DIR');
    const enable = pin('ENABLE');
    const sleep = pin('SLEEP');
    const reset = pin('RESET');
    const ms = [pin('MS1'), pin('MS2'), pin('MS3')];
    const vmot = pin('VMOT');
    const out1a = pin('1A');
    const out1b = pin('1B');
    const out2a = pin('2A');
    const out2b = pin('2B');
    let index = HOME;
    let stepHigh = false;
    let steps = 0;

    /** A pulled-down input reads 1 only when driven high; a pulled-up or floating-high one 0 only when driven low. */
    const high = (p: PinHandle): boolean => p.read().level === 1;
    const low = (p: PinHandle): boolean => p.read().level === 0;
    const active = (): boolean => !high(enable) && !low(sleep) && !low(reset);

    const drive = (positive: PinHandle, negative: PinHandle, volts: number): void => {
      if (volts >= 0) {
        positive.driveVolts(volts, Strength.strong);
        negative.driveVolts(0, Strength.strong);
      } else {
        positive.driveVolts(0, Strength.strong);
        negative.driveVolts(-volts, Strength.strong);
      }
    };

    const update = (): void => {
      const supply = vmot.read();
      if (!active() || supply.strength === Strength.hiz || supply.volts <= 0) {
        out1a.release();
        out1b.release();
        out2a.release();
        out2b.release();
      } else {
        const theta = (index * Math.PI) / 32;
        drive(out1a, out1b, supply.volts * Math.cos(theta));
        drive(out2a, out2b, supply.volts * Math.sin(theta));
      }
      ctx.invalidate();
    };

    step.onChange((state) => {
      const rising = state.level === 1 && !stepHigh;
      stepHigh = state.level === 1;
      if (!rising || low(reset) || low(sleep)) return;
      const resolution = (high(ms[2]) ? 4 : 0) + (high(ms[1]) ? 2 : 0) + (high(ms[0]) ? 1 : 0);
      const stride = STRIDE[resolution] ?? 16;
      const forward = high(dir);
      // Full steps sit at 45° + k·90°: snap there when the resolution changed mid-turn.
      const next = stride === 16 ? (Math.round((index - HOME) / 16) * 16 + HOME + (forward ? 16 : -16)) : index + (forward ? stride : -stride);
      index = ((next % 64) + 64) % 64;
      steps += forward ? 1 : -1;
      update();
    });
    reset.onChange((state) => {
      if (state.level === 0) index = HOME;
      update();
    });
    for (const p of [enable, sleep, vmot]) p.onChange(update);
    update();

    return {
      visual: () => ({ index, steps, on: active() }),
      reset() {
        index = HOME;
        steps = 0;
        stepHigh = step.read().level === 1;
        update();
      },
    };
  },
});
