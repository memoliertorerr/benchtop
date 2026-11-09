/**
 * BT173: the common red L298N dual H-bridge module (`l298n`). Pins as on the board: the motor
 * terminals OUT1/OUT2 (channel A) on the left and OUT3/OUT4 (channel B) on the right, the power
 * terminal +12V (VS), GND and +5V along the bottom, and the header ENA, IN1, IN2, IN3, IN4, ENB.
 *
 * A channel is enabled while its enable jumper is on (`enaJumper`/`enbJumper`, true as shipped) or
 * its EN pin reads high; enabled and powered (VS at least 4.5 V over GND), it drives each of its
 * outputs at supply strength — VS − 1.4 V while its IN reads high, 0.8 V over GND while it reads
 * low (the L298's typical saturation drops at 1 A) — so IN1 ≠ IN2 turns a motor one way or the
 * other and IN1 = IN2 brakes it (both terminals together); disabled or unpowered, the outputs are
 * released and a motor coasts. The 5 V regulator (`regulator` jumper, true as shipped) drives +5V
 * while VS is at least 7 V. Inputs read TTL levels: high at 2.3 V or more over GND. BT177: the
 * module's eight flyback diodes are the analog layer's (`analogSpecFor`: each OUT to +12V, GND to
 * each OUT), so a disabled bridge returns an inductive load's current to the supply. Current sensing
 * isn't modeled. Our own drawing (apps/web views/motors.ts).
 */

import { type PartProps, Strength } from '@benchtop/core';
import { definePart } from '../define.ts';

/** The L298's typical drops at 1 A: VS − HIGH_DROP high, LOW_VOLTS low (over GND). */
export const L298_HIGH_DROP = 1.4;
export const L298_LOW_VOLTS = 0.8;
/** VS below this drives nothing; the regulator needs this much. */
export const L298_VS_MIN = 4.5;
export const L298_REGULATOR_MIN = 7;
const TTL_HIGH = 2.3;

const OUTS = ['OUT1', 'OUT2', 'OUT3', 'OUT4'] as const;
const INS = ['IN1', 'IN2', 'IN3', 'IN4'] as const;

export const l298n = definePart({
  type: 'l298n',
  title: 'L298N motor driver',
  category: 'motors',
  size: { w: 43.18, h: 43.18 },
  pins: [
    { name: 'OUT1', x: 2.54, y: 15.24, role: 'passive' },
    { name: 'OUT2', x: 2.54, y: 20.32, role: 'passive' },
    { name: 'OUT3', x: 40.64, y: 15.24, role: 'passive' },
    { name: 'OUT4', x: 40.64, y: 20.32, role: 'passive' },
    { name: '+12V', x: 7.62, y: 40.64, role: 'power' },
    { name: 'GND', x: 12.7, y: 40.64, role: 'ground' },
    { name: '+5V', x: 17.78, y: 40.64, role: 'power' },
    { name: 'ENA', x: 25.4, y: 40.64, role: 'digital' },
    { name: 'IN1', x: 27.94, y: 40.64, role: 'digital' },
    { name: 'IN2', x: 30.48, y: 40.64, role: 'digital' },
    { name: 'IN3', x: 33.02, y: 40.64, role: 'digital' },
    { name: 'IN4', x: 35.56, y: 40.64, role: 'digital' },
    { name: 'ENB', x: 38.1, y: 40.64, role: 'digital' },
  ],
  defaults: { enaJumper: true, enbJumper: true, regulator: true },
  createModel(ctx, props) {
    const p = props as PartProps;
    const jumpers = [p.enaJumper !== false, p.enbJumper !== false];
    const regulator = p.regulator !== false;
    const outs = OUTS.map((name) => ctx.pin(name));
    const ins = INS.map((name) => ctx.pin(name));
    const ens = [ctx.pin('ENA'), ctx.pin('ENB')];
    const vs = ctx.pin('+12V');
    const gnd = ctx.pin('GND');
    const v5 = ctx.pin('+5V');
    /** What each output was last told: 0 released, else its volts + 1 (so 0 V can be told apart). */
    const told = new Float64Array(4);
    let fiveTold = 0;
    /** For the view: the outputs (0 off, 1 high, 2 low), the channels enabled (1), power and the regulator. */
    const visual = { outs: [0, 0, 0, 0], enabled: [0, 0], powered: false, regulator: false };
    const high = (pin: (typeof ins)[number], ground: number): boolean => pin.read().volts - ground >= TTL_HIGH;
    const update = (): void => {
      const ground = gnd.read().volts;
      const supply = vs.read().volts - ground;
      const powered = supply >= L298_VS_MIN;
      let changed = powered !== visual.powered;
      visual.powered = powered;
      for (let c = 0; c < 2; c++) {
        const enabled = jumpers[c] || high(ens[c], ground);
        if ((enabled ? 1 : 0) !== visual.enabled[c]) changed = true;
        visual.enabled[c] = enabled ? 1 : 0;
        for (let k = 0; k < 2; k++) {
          const i = c * 2 + k;
          let volts = -1;
          let state = 0;
          if (enabled && powered) {
            const on = high(ins[i], ground);
            volts = on ? ground + supply - L298_HIGH_DROP : ground + L298_LOW_VOLTS;
            state = on ? 1 : 2;
          }
          if (told[i] === volts + 1) continue;
          told[i] = volts + 1;
          visual.outs[i] = state;
          changed = true;
          if (volts < 0) outs[i].release();
          else outs[i].driveVolts(volts, Strength.supply);
        }
      }
      const five = regulator && supply >= L298_REGULATOR_MIN;
      const fiveVolts = five ? ground + 5 : -1;
      if (fiveTold !== fiveVolts + 1) {
        fiveTold = fiveVolts + 1;
        visual.regulator = five;
        changed = true;
        if (five) v5.driveVolts(fiveVolts, Strength.supply);
        else v5.release();
      }
      if (changed) ctx.invalidate();
    };
    for (const pin of [...ins, ...ens, vs, gnd]) pin.onChange(update);
    update();
    return {
      visual: () => visual,
      reset() {
        told.fill(0);
        fiveTold = 0;
        update();
        ctx.invalidate();
      },
    };
  },
});
