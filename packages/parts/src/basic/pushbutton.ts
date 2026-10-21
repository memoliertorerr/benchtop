/**
 * 12 mm pushbutton: legs 1.l/1.r are one side, 2.l/2.r the other (buses); a switch link joins
 * the sides while pressed. Inputs: press, release. Pins from @wokwi/elements 1.9.2
 * pushbutton-element.
 */

import { definePart } from '../define.ts';

export const pushbutton = definePart({
  type: 'pushbutton',
  title: 'Pushbutton',
  category: 'input',
  size: { w: 17.802, h: 12 },
  pins: [
    { name: '1.l', x: 0, y: 3.44, role: 'passive' },
    { name: '2.l', x: 0, y: 8.467, role: 'passive' },
    { name: '1.r', x: 17.727, y: 3.44, role: 'passive' },
    { name: '2.r', x: 17.727, y: 8.467, role: 'passive' },
  ],
  buses: [
    ['1.l', '1.r'],
    ['2.l', '2.r'],
  ],
  links: [{ id: 'contact', a: '1.l', b: '2.l', kind: 'switch', closed: false }],
  defaults: { color: 'red' },
  createModel(ctx) {
    const contact = ctx.link('contact');
    let pressed = false;
    const set = (value: boolean): void => {
      if (value === pressed) return;
      pressed = value;
      contact.setClosed(value);
      ctx.invalidate();
    };
    return {
      input(event) {
        if (event.kind === 'press') set(true);
        else if (event.kind === 'release') set(false);
      },
      visual: () => ({ pressed }),
      reset() {
        set(false);
      },
    };
  },
});
