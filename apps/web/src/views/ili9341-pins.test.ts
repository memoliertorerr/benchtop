import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { CATALOG, ILI9341_PIN_PX } from '@benchtop/parts';
import { describe, expect, it } from 'vitest';

// BT51: the ILI9341's pins in @benchtop/parts are copied from the element's pinInfo; this reads
// the element's source and checks the copy.

const require = createRequire(import.meta.url);
const ELEMENT = join(dirname(require.resolve('@wokwi/elements/package.json')), 'dist/esm/ili9341-element.js');

function elementPins(): [string, number, number][] {
  const source = readFileSync(ELEMENT, 'utf8');
  const table = /this\.pinInfo = \[([\s\S]*?)\n {8}\];/.exec(source);
  if (table === null) throw new Error(`no pinInfo in ${ELEMENT}`);
  return [...table[1].matchAll(/name: '([^']+)',\s*x: ([\d.]+),\s*y: ([\d.]+)/g)].map((m) => [m[1], Number(m[2]), Number(m[3])]);
}

describe('ILI9341 pins vs @wokwi/elements', () => {
  it('copies every pinInfo entry, placed in mm', () => {
    const pins = elementPins();
    expect(pins).toHaveLength(9);
    expect(ILI9341_PIN_PX.map(([n, x, y]) => [n, x, y])).toEqual(pins);
    const byName = new Map(CATALOG.get('ili9341')!.pins.map((p) => [p.name, p]));
    for (const [name, x, y] of pins) {
      expect(Math.abs(byName.get(name)!.x - (x * 25.4) / 96), name).toBeLessThanOrEqual(0.0005 + 1e-9);
      expect(Math.abs(byName.get(name)!.y - (y * 25.4) / 96), name).toBeLessThanOrEqual(0.0005 + 1e-9);
    }
  });
});
