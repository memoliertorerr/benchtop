/**
 * PIR motion sensor (HC-SR501). OUT drives 3.3 V (strong) while active, else a strong 0.
 * A motion event (press) makes it active for `holdMs`; with `retrigger` (default true) motion
 * while active restarts the hold, otherwise it is ignored; for `blockMs` after OUT falls every
 * trigger is ignored. No warm-up period is modelled. Pins from @wokwi/elements 1.9.2
 * pir-motion-sensor-element.
 */

import { NS_PER_MS, Strength } from '@benchtop/core';
import { definePart } from '../define.ts';

export const pirMotionSensor = definePart({
  type: 'pir-motion-sensor',
  title: 'PIR motion sensor',
  category: 'sensors',
  size: { w: 24, h: 24.448 },
  pins: [
    { name: 'VCC', x: 9.572, y: 24.342, role: 'power' },
    { name: 'OUT', x: 12.149, y: 24.342, role: 'digital' },
    { name: 'GND', x: 14.722, y: 24.342, role: 'ground' },
  ],
  defaults: { holdMs: 5000, retrigger: true, blockMs: 2500 },
  createModel(ctx, props) {
    const out = ctx.pin('OUT');
    const holdNs = Math.max(0, props.holdMs) * NS_PER_MS;
    const blockNs = Math.max(0, props.blockMs) * NS_PER_MS;
    let active = false;
    let timer = -1;
    let blockedUntil = Number.NEGATIVE_INFINITY;
    const drive = (): void => {
      if (active) out.driveVolts(3.3, Strength.strong);
      else out.drive(0, Strength.strong);
      ctx.invalidate();
    };
    const fall = (): void => {
      timer = -1;
      active = false;
      blockedUntil = ctx.now() + blockNs;
      drive();
    };
    const motion = (): void => {
      const now = ctx.now();
      if (active) {
        if (!props.retrigger) return;
        ctx.cancel(timer);
        timer = ctx.schedule(holdNs, fall);
        return;
      }
      if (now < blockedUntil) return;
      active = true;
      timer = ctx.schedule(holdNs, fall);
      drive();
    };
    drive();
    return {
      input(event) {
        if (event.kind === 'press') motion();
      },
      visual: () => ({ active }),
      reset() {
        active = false;
        timer = -1;
        blockedUntil = Number.NEGATIVE_INFINITY;
        drive();
      },
    };
  },
});
