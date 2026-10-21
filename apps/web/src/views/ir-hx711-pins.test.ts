import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { CATALOG, FLAME_PIN_PX, GAS_PIN_PX, HX711_PIN_PX, IR_RECEIVER_PIN_PX } from '@benchtop/parts';
import { describe, expect, it } from 'vitest';

// BT52: the IR receiver's and HX711's pins in @benchtop/parts are copied from the elements'
// pinInfo (some list y before x); this reads the elements' source and checks the copies.

const require = createRequire(import.meta.url);
const root = dirname(require.resolve('@wokwi/elements/package.json'));

function elementPins(element: string): [string, number, number][] {
  const source = readFileSync(join(root, 'dist/esm', `${element}-element.js`), 'utf8');
  const table = /this\.pinInfo = \[([\s\S]*?)\n {8}\];/.exec(source);
  if (table === null) throw new Error(`no pinInfo in ${element}`);
  return table[1]
    .split('\n')
    .map((line) => [/name: '([^']+)'/.exec(line), /\bx: ([\d.]+)/.exec(line), /\by: ([\d.]+)/.exec(line)] as const)
    .filter(([n, x, y]) => n !== null && x !== null && y !== null)
    .map(([n, x, y]) => [n![1], Number(x![1]), Number(y![1])]);
}

describe('IR receiver, HX711, flame and gas sensor pins vs @wokwi/elements', () => {
  it.each([
    ['ir-receiver', 'ir-receiver', IR_RECEIVER_PIN_PX],
    ['hx711', 'hx711', HX711_PIN_PX],
    ['flame-sensor', 'flame-sensor', FLAME_PIN_PX], // BT53
    ['gas-sensor', 'gas-sensor', GAS_PIN_PX],
  ] as const)('%s copies every pinInfo entry, placed in mm', (type, element, copy) => {
    const pins = elementPins(element);
    expect(copy.map(([n, x, y]) => [n, x, y])).toEqual(pins);
    const byName = new Map(CATALOG.get(type)!.pins.map((p) => [p.name, p]));
    for (const [name, x, y] of pins) {
      expect(Math.abs(byName.get(name)!.x - (x * 25.4) / 96), name).toBeLessThanOrEqual(0.0005 + 1e-9);
      expect(Math.abs(byName.get(name)!.y - (y * 25.4) / 96), name).toBeLessThanOrEqual(0.0005 + 1e-9);
    }
  });
});
