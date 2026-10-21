/**
 * KY-040 rotary encoder module. At rest CLK and DT are 1 through the module's 10 kΩ pull-ups
 * (weak 1); a closed contact is a strong 0. One detent is four transitions `phaseUs` apart
 * (prop, default 1000): CW — CLK falls, DT falls, CLK rises, DT rises; CCW mirrors (DT first).
 * Up to 50 detents queue on one preallocated timer callback. Inputs: { kind: 'key', key: 'cw'
 * | 'ccw', down: true } turns one detent; press/release closes SW to GND (no pull-up on the
 * module: the sketch needs INPUT_PULLUP). Pins from @wokwi/elements 1.9.2 ky-040-element.
 */

import { Strength } from '@benchtop/core';
import { definePart } from '../define.ts';

export const MAX_QUEUED_DETENTS = 50;

export const ky040 = definePart({
  type: 'ky-040',
  title: 'Rotary encoder (KY-040)',
  category: 'input',
  size: { w: 30.815, h: 18.63 },
  pins: [
    { name: 'CLK', x: 30.692, y: 2.09, role: 'digital' },
    { name: 'DT', x: 30.692, y: 4.604, role: 'digital' },
    { name: 'SW', x: 30.692, y: 7.144, role: 'digital' },
    { name: 'VCC', x: 30.692, y: 9.604, role: 'power' },
    { name: 'GND', x: 30.692, y: 12.039, role: 'ground' },
  ],
  links: [{ id: 'sw', a: 'SW', b: 'GND', kind: 'switch', closed: false }],
  defaults: { phaseUs: 1000 },
  createModel(ctx, props) {
    const clk = ctx.pin('CLK');
    const dt = ctx.pin('DT');
    const sw = ctx.link('sw');
    const phaseNs = Math.max(1, props.phaseUs) * 1000;
    // Ring of queued detents: +1 CW, −1 CCW.
    const queue = new Int8Array(MAX_QUEUED_DETENTS);
    let head = 0;
    let count = 0;
    let phase = 0;
    let busy = false;
    let pressed = false;
    const level = (pin: typeof clk, closed: boolean): void => {
      if (closed) pin.drive(0, Strength.strong);
      else pin.drive(1, Strength.weak);
    };
    const rest = (): void => {
      level(clk, false);
      level(dt, false);
    };
    // Phase n of a CW detent: 0 CLK falls, 1 DT falls, 2 CLK rises, 3 DT rises. CCW swaps pins.
    const step = (): void => {
      const cw = queue[head] > 0;
      const first = cw ? clk : dt;
      const second = cw ? dt : clk;
      if (phase === 0) level(first, true);
      else if (phase === 1) level(second, true);
      else if (phase === 2) level(first, false);
      else level(second, false);
      phase++;
      if (phase === 4) {
        phase = 0;
        head = (head + 1) % MAX_QUEUED_DETENTS;
        count--;
      }
      if (count > 0) ctx.schedule(phaseNs, step);
      else busy = false;
    };
    rest();
    return {
      input(event) {
        if (event.kind === 'press' || event.kind === 'release') {
          const down = event.kind === 'press';
          if (down !== pressed) {
            pressed = down;
            sw.setClosed(down);
            ctx.invalidate();
          }
          return;
        }
        if (event.kind !== 'key' || !event.down || (event.key !== 'cw' && event.key !== 'ccw')) return;
        if (count === MAX_QUEUED_DETENTS) return;
        queue[(head + count) % MAX_QUEUED_DETENTS] = event.key === 'cw' ? 1 : -1;
        count++;
        if (!busy) {
          busy = true;
          step();
        }
      },
      visual: () => ({ pressed }),
      reset() {
        head = 0;
        count = 0;
        phase = 0;
        busy = false;
        pressed = false;
        sw.setClosed(false);
        rest();
        ctx.invalidate();
      },
    };
  },
});
