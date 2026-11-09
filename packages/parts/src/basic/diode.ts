/**
 * BT167: a diode (`diode`): the analog layer's piecewise-linear diode from A (anode) to C
 * (cathode, the banded end), by its `model` prop (`DIODE_MODELS`, from the datasheets' forward
 * curves): a 1N4148 small-signal diode (knee 0.62 V, 3 Ω: 0.65 V at 10 mA, 0.92 V at 100 mA) or a
 * 1N4007 1 A rectifier (knee 0.65 V, 0.3 Ω: 0.95 V at 1 A). Without the analog layer it connects
 * nothing. Our own drawing (apps/web views/passives.ts); legs 10.16 mm apart, like a resistor's
 * bent for a breadboard.
 */

import { definePart } from '../define.ts';

export const DIODE_MODELS: Readonly<Record<string, { vf: number; rs: number }>> = {
  '1N4148': { vf: 0.62, rs: 3 },
  '1N4007': { vf: 0.65, rs: 0.3 },
};

export const diode = definePart({
  type: 'diode',
  title: 'Diode',
  category: 'basic',
  size: { w: 10.16, h: 2.6 },
  pins: [
    { name: 'A', x: 0, y: 1.3, role: 'passive' },
    { name: 'C', x: 10.16, y: 1.3, role: 'passive' },
  ],
  defaults: { model: '1N4148' },
});
