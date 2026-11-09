/**
 * Touch pad (BT155): a copper electrode on a small board with one pin, PAD, for an MCU's
 * capacitive touch channel (the ESP32-S2's TOUCH1–14). It drives nothing: its model carries a
 * `touchLoad` (packages/core/src/bench/touch.ts) — the picofarads it adds to its pin's net, the
 * electrode's `padPf` plus `fingerPf` times the contact — which the bench sums for the touch pins
 * on that net. Inputs: press (a finger on it: contact 1), release (0), a value (the contact, 0–1:
 * a light touch, a finger through a thicker cover); prop `contact` is where a reset starts (BT157:
 * the Inspector's Contact slider sets it while stopped). Our own part (no element draws one); its
 * view is apps/web's views/touch-pad.ts.
 */

import { definePart } from '../define.ts';

export const touchPad = definePart({
  type: 'touch-pad',
  title: 'Touch pad',
  category: 'input',
  size: { w: 15.24, h: 17.78 },
  pins: [{ name: 'PAD', x: 7.62, y: 17.78, role: 'passive' }],
  defaults: { padPf: 2, fingerPf: 10, contact: 0 },
  createModel(ctx, props) {
    const padPf = Math.max(0, Number(props.padPf) || 0);
    const fingerPf = Math.max(0, Number(props.fingerPf) || 0);
    const initial = Math.min(1, Math.max(0, Number(props.contact) || 0));
    let contact = initial;
    const set = (value: number): void => {
      const next = Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
      if (next === contact) return;
      contact = next;
      ctx.invalidate();
    };
    return {
      touchLoad: { pf: () => padPf + fingerPf * contact },
      input(event) {
        if (event.kind === 'press') set(1);
        else if (event.kind === 'release') set(0);
        else if (event.kind === 'value') set(event.value);
      },
      visual: () => ({ contact, touched: contact > 0 }),
      reset() {
        set(initial);
      },
    };
  },
});
