/**
 * 4×4 membrane keypad ("123A / 456B / 789C / *0#D"): 16 switch links, row Rr ↔ column Cc, and
 * nothing else — ghosting (three keys at the corners of a rectangle reading a fourth) comes out
 * of the resolver, as on the real matrix. Input { kind: 'key', key, down }. Pins from
 * @wokwi/elements 1.9.2 membrane-keypad-element (4 columns, connector shown).
 */

import type { LinkDef, PinDef } from '@benchtop/core';
import { definePart } from '../define.ts';

export const KEYPAD_KEYS = ['1', '2', '3', 'A', '4', '5', '6', 'B', '7', '8', '9', 'C', '*', '0', '#', 'D'] as const;

const ROW_X = [26.458, 29.104, 31.618, 34.131];
const COL_X = [36.645, 39.158, 41.738, 44.318];

const pins: PinDef[] = [
  ...ROW_X.map((x, i): PinDef => ({ name: `R${i + 1}`, x, y: 89.429, role: 'digital' })),
  ...COL_X.map((x, i): PinDef => ({ name: `C${i + 1}`, x, y: 89.429, role: 'digital' })),
];

const links: LinkDef[] = KEYPAD_KEYS.map((_, i) => ({ id: `k${i}`, a: `R${Math.floor(i / 4) + 1}`, b: `C${(i % 4) + 1}`, kind: 'switch', closed: false }));

export const membraneKeypad = definePart({
  type: 'membrane-keypad',
  title: 'Keypad 4×4',
  category: 'input',
  size: { w: 70.336, h: 91 },
  pins,
  links,
  defaults: {},
  createModel(ctx) {
    const contacts = KEYPAD_KEYS.map((_, i) => ctx.link(`k${i}`));
    const down = new Uint8Array(KEYPAD_KEYS.length);
    return {
      input(event) {
        if (event.kind !== 'key') return;
        const index = (KEYPAD_KEYS as readonly string[]).indexOf(event.key);
        if (index < 0) return;
        const value = event.down ? 1 : 0;
        if (down[index] === value) return;
        down[index] = value;
        contacts[index].setClosed(event.down);
      },
      reset() {
        down.fill(0);
        for (const contact of contacts) contact.setClosed(false);
      },
    };
  },
});
