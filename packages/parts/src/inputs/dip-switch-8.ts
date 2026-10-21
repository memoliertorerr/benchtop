/**
 * 8-way DIP switch: switch n joins pins na and nb while on. Prop `value` is the initial
 * bitmask (bit 0 = switch 1); input { kind: 'key', key: '1'..'8', down: true } toggles one.
 * Visual `values`: 8 numbers, 1 = on. Pins from @wokwi/elements 1.9.2 dip-switch-8-element.
 */

import type { LinkDef, PinDef } from '@benchtop/core';
import { definePart } from '../define.ts';

const X = [2.143, 4.683, 7.223, 9.763, 12.303, 14.843, 17.383, 19.923];

const pins: PinDef[] = X.flatMap((x, i): PinDef[] => [
  { name: `${i + 1}a`, x, y: 13.573, role: 'passive' },
  { name: `${i + 1}b`, x, y: 0.794, role: 'passive' },
]);

const links: LinkDef[] = X.map((_, i) => ({ id: `s${i + 1}`, a: `${i + 1}a`, b: `${i + 1}b`, kind: 'switch', closed: false }));

export const dipSwitch8 = definePart({
  type: 'dip-switch-8',
  title: 'DIP switch (8)',
  category: 'input',
  size: { w: 21.926, h: 14.646 },
  pins,
  links,
  defaults: { value: 0 },
  createModel(ctx, props) {
    const switches = X.map((_, i) => ctx.link(`s${i + 1}`));
    const values: number[] = new Array<number>(8).fill(0);
    const visual = { values };
    const set = (mask: number): void => {
      for (let i = 0; i < 8; i++) {
        values[i] = (mask >> i) & 1;
        switches[i].setClosed(values[i] === 1);
      }
      ctx.invalidate();
    };
    const initial = Math.trunc(props.value) & 0xff;
    set(initial);
    return {
      input(event) {
        if (event.kind !== 'key' || !event.down) return;
        const n = Number(event.key);
        if (!Number.isInteger(n) || n < 1 || n > 8) return;
        values[n - 1] ^= 1;
        switches[n - 1].setClosed(values[n - 1] === 1);
        ctx.invalidate();
      },
      visual: () => visual,
      reset() {
        set(initial);
      },
    };
  },
});
