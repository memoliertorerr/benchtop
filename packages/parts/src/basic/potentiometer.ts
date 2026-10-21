/**
 * Rotary potentiometer (10 kΩ): two resistive links, VCC–SIG and SIG–GND, split by the wiper
 * position (input { kind: 'value' }, 0..1). The analog layer solves SIG's true voltage, load
 * included; with it off, SIG is a weak tie at switch level. Pins from @wokwi/elements 1.9.2
 * potentiometer-element.
 */

import { definePart } from '../define.ts';
import { Divider } from '../shared/divider.ts';

export const POT_OHMS = 10_000;
const clamp = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export const potentiometer = definePart({
  type: 'potentiometer',
  title: 'Potentiometer',
  category: 'input',
  size: { w: 20, h: 20 },
  pins: [
    { name: 'GND', x: 7.673, y: 18.124, role: 'ground' },
    { name: 'SIG', x: 10.319, y: 18.124, role: 'analog' },
    { name: 'VCC', x: 12.965, y: 18.124, role: 'power' },
  ],
  links: [
    { id: 'top', a: 'VCC', b: 'SIG', kind: 'resistive', ohms: POT_OHMS / 2 },
    { id: 'bottom', a: 'SIG', b: 'GND', kind: 'resistive', ohms: POT_OHMS / 2 },
  ],
  defaults: { value: 0.5 },
  createModel(ctx, props) {
    const divider = new Divider(ctx, 'top', 'bottom');
    const initial = clamp(props.value);
    let value = initial;
    divider.setPosition(POT_OHMS, value);
    return {
      input(event) {
        if (event.kind !== 'value') return;
        value = clamp(event.value);
        divider.setPosition(POT_OHMS, value);
        ctx.invalidate();
      },
      visual: () => ({ value }),
      reset() {
        value = initial;
        divider.setPosition(POT_OHMS, value);
        ctx.invalidate();
      },
    };
  },
});
