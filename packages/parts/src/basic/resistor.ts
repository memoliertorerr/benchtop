/**
 * Resistor: two leads joined by one resistive link (switch-level: what passes through arrives
 * weak). Pins from @wokwi/elements 1.9.2 resistor-element (px → mm).
 */

import { definePart } from '../define.ts';

export const resistor = definePart({
  type: 'resistor',
  title: 'Resistor',
  category: 'basic',
  size: { w: 15.645, h: 3 },
  pins: [
    { name: '1', x: 0, y: 1.495, role: 'passive' },
    { name: '2', x: 15.557, y: 1.495, role: 'passive' },
  ],
  links: [{ id: 'r', a: '1', b: '2', kind: 'resistive', ohms: 220 }],
  defaults: { ohms: 220 },
  createModel(ctx, props) {
    const link = ctx.link('r');
    link.setOhms(props.ohms);
    return {};
  },
});
