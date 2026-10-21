/**
 * An NEC IR remote (BT52): no pins and no model — its view (@wokwi/elements 1.9.2 ir-remote) sends
 * each key to every `ir-receiver` in the document as `{ kind: 'key', key: 'ir:<command>', down }`
 * (apps/web/src/views/ir-remote.ts). In headless runs, steps send that input to a receiver.
 * The element's key commands (address 0x00):
 */

import { definePart } from '../define.ts';

/** The element's keys and their NEC commands (ir-remote-element `irKeyCodes`). */
export const IR_REMOTE_KEYS: Readonly<Record<string, number>> = {
  power: 0xa2,
  menu: 0xe2,
  test: 0x22,
  plus: 0x02,
  back: 0xc2,
  prev: 0xe0,
  play: 0xa8,
  next: 0x90,
  '0': 0x68,
  minus: 0x98,
  c: 0xb0,
  '1': 0x30,
  '2': 0x18,
  '3': 0x7a,
  '4': 0x10,
  '5': 0x38,
  '6': 0x5a,
  '7': 0x42,
  '8': 0x4a,
  '9': 0x52,
};

export const irRemote = definePart({
  type: 'ir-remote',
  title: 'IR remote (NEC)',
  category: 'input',
  size: { w: 40, h: 83.653 },
  pins: [],
  defaults: {},
});
