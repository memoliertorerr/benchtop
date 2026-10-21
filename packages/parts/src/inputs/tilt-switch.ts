/**
 * Tilt switch module (SW-520D-like, decided): the ball contact is closed while upright, so OUT
 * is a strong 0; tilted, it opens and the module's pull-up gives a weak 1. Prop `tilted`
 * (initial); press toggles. Pins from @wokwi/elements 1.9.2 tilt-switch-element (a VCC/GND/OUT
 * module).
 */

import { Strength } from '@benchtop/core';
import { definePart } from '../define.ts';

export const tiltSwitch = definePart({
  type: 'tilt-switch',
  title: 'Tilt switch',
  category: 'input',
  size: { w: 23.4, h: 14.7 },
  pins: [
    { name: 'GND', x: 23.283, y: 4.763, role: 'ground' },
    { name: 'VCC', x: 23.283, y: 7.355, role: 'power' },
    { name: 'OUT', x: 23.283, y: 9.922, role: 'digital' },
  ],
  defaults: { tilted: false },
  createModel(ctx, props) {
    const out = ctx.pin('OUT');
    let tilted: boolean = props.tilted;
    const apply = (): void => {
      if (tilted) out.drive(1, Strength.weak);
      else out.drive(0, Strength.strong);
      ctx.invalidate();
    };
    apply();
    return {
      input(event) {
        if (event.kind === 'press') {
          tilted = !tilted;
          apply();
        } else if (event.kind === 'value') {
          tilted = event.value >= 0.5;
          apply();
        }
      },
      visual: () => ({ tilted }),
      reset() {
        tilted = props.tilted;
        apply();
      },
    };
  },
});
