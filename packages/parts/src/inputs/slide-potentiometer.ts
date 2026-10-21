/**
 * Slide potentiometer (10 kΩ): resistive links VCC–SIG and SIG–GND split by the position
 * (input { kind: 'value' }, 0..1) — SIG = VCC·position unloaded (potVolts in shared/transfer.ts);
 * the analog layer solves it with its load. Pins from @wokwi/elements 1.9.2
 * slide-potentiometer-element (travelLength 30 mm).
 */

import { definePart } from '../define.ts';
import { Divider } from '../shared/divider.ts';

export const SLIDE_POT_OHMS = 10_000;
const clamp = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export const slidePotentiometer = definePart({
  type: 'slide-potentiometer',
  title: 'Slide potentiometer',
  category: 'input',
  size: { w: 55, h: 29 },
  pins: [
    { name: 'VCC', x: 0.265, y: 11.377, role: 'power' },
    { name: 'SIG', x: 0.265, y: 16.669, role: 'analog' },
    { name: 'GND', x: 54.769, y: 11.377, role: 'ground' },
  ],
  links: [
    { id: 'top', a: 'VCC', b: 'SIG', kind: 'resistive', ohms: SLIDE_POT_OHMS },
    { id: 'bottom', a: 'SIG', b: 'GND', kind: 'resistive', ohms: 1 },
  ],
  defaults: { value: 0 },
  createModel(ctx, props) {
    const divider = new Divider(ctx, 'top', 'bottom');
    const initial = clamp(props.value);
    let value = initial;
    divider.setPosition(SLIDE_POT_OHMS, value);
    return {
      input(event) {
        if (event.kind !== 'value') return;
        value = clamp(event.value);
        divider.setPosition(SLIDE_POT_OHMS, value);
        ctx.invalidate();
      },
      visual: () => ({ value }),
      reset() {
        value = initial;
        divider.setPosition(SLIDE_POT_OHMS, value);
        ctx.invalidate();
      },
    };
  },
});
