/**
 * BT167: capacitors — a ceramic disc (`capacitor`, 100 nF) and an aluminium electrolytic
 * (`capacitor-electrolytic`, 10 µF, polarized: `+` and `-`). The capacitance is the analog
 * layer's (`analogSpecFor`: a capacitor between the legs, prop `farads`); without the analog
 * layer they connect nothing. The electrolytic reports `capacitor-reversed` while more than 1 V
 * sits across it backwards (an electrolytic in reverse heats up and fails); its visual
 * `reversed` says so. Our own drawings (apps/web views/passives.ts); legs 2.54 mm apart, at the
 * bottom edge.
 */

import { ANALOG_PROP, type PartProps } from '@benchtop/core';
import { definePart } from '../define.ts';

/** Reverse voltage an electrolytic takes before it is reported, volts. */
export const REVERSE_LIMIT_V = 1;

export const capacitor = definePart({
  type: 'capacitor',
  title: 'Capacitor (ceramic)',
  category: 'basic',
  size: { w: 5.08, h: 8.4 },
  pins: [
    { name: '1', x: 1.27, y: 8.4, role: 'passive' },
    { name: '2', x: 3.81, y: 8.4, role: 'passive' },
  ],
  defaults: { farads: 100e-9 },
});

export const capacitorElectrolytic = definePart({
  type: 'capacitor-electrolytic',
  title: 'Capacitor (electrolytic)',
  category: 'basic',
  size: { w: 6.35, h: 11.5 },
  pins: [
    { name: '+', x: 1.905, y: 11.5, role: 'passive' },
    { name: '-', x: 4.445, y: 11.5, role: 'passive' },
  ],
  defaults: { farads: 10e-6 },
  createModel(ctx, props) {
    if ((props as PartProps)[ANALOG_PROP] !== true) return {};
    const plus = ctx.pin('+');
    const minus = ctx.pin('-');
    let reversed = false;
    const update = (): void => {
      const backwards = minus.read().volts - plus.read().volts;
      const now = backwards > REVERSE_LIMIT_V;
      if (now === reversed) return;
      reversed = now;
      ctx.report({
        severity: 'warning',
        code: 'capacitor-reversed',
        // An empty message withdraws the problem (the bench's convention).
        message: now ? `${backwards.toFixed(1)} V across it backwards — an electrolytic's minus lead (the striped side) goes to the lower voltage.` : '',
        parts: [],
      });
      ctx.invalidate();
    };
    plus.onChange(update);
    minus.onChange(update);
    return {
      visual: () => ({ reversed }),
      reset() {
        reversed = false;
        update();
        ctx.invalidate();
      },
    };
  },
});
