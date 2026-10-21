/**
 * SPDT slide switch: the middle pin '2' connects to '1' at value 0 and to '3' at value 1.
 * Inputs: press toggles; { kind: 'value', value } sets (≥ 0.5 → 1). Pins from @wokwi/elements
 * 1.9.2 slide-switch-element.
 */

import { definePart } from '../define.ts';

export const slideSwitch = definePart({
  type: 'slide-switch',
  title: 'Slide switch',
  category: 'input',
  size: { w: 8.5, h: 9.23 },
  pins: [
    { name: '1', x: 1.72, y: 8.996, role: 'passive' },
    { name: '2', x: 4.233, y: 8.996, role: 'passive' },
    { name: '3', x: 6.747, y: 8.996, role: 'passive' },
  ],
  links: [
    { id: 'left', a: '1', b: '2', kind: 'switch', closed: true },
    { id: 'right', a: '2', b: '3', kind: 'switch', closed: false },
  ],
  defaults: { value: 0 },
  createModel(ctx, props) {
    const left = ctx.link('left');
    const right = ctx.link('right');
    const initial = props.value >= 0.5 ? 1 : 0;
    let value = initial;
    const apply = (next: number): void => {
      value = next;
      left.setClosed(value === 0);
      right.setClosed(value === 1);
      ctx.invalidate();
    };
    apply(initial);
    return {
      input(event) {
        if (event.kind === 'press') apply(value === 0 ? 1 : 0);
        else if (event.kind === 'value') apply(event.value >= 0.5 ? 1 : 0);
      },
      visual: () => ({ value }),
      reset() {
        apply(initial);
      },
    };
  },
});
