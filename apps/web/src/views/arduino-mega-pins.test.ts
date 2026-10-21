import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { ARDUINO_MEGA_PIN_PX, CATALOG } from '@benchtop/parts';
import { describe, expect, it } from 'vitest';

// BT47: the Mega's pins in @benchtop/parts are copied by hand from the element's pinInfo
// (packages/* never import the DOM element). This reads the element's source and checks the copy:
// every name, in the same order, at the same position (px → mm × 25.4 / 96).

const require = createRequire(import.meta.url);
const ELEMENT = join(dirname(require.resolve('@wokwi/elements/package.json')), 'dist/esm/arduino-mega-element.js');

function elementPins(): [string, number, number][] {
  const source = readFileSync(ELEMENT, 'utf8');
  const table = /this\.pinInfo = \[([\s\S]*?)\n {8}\];/.exec(source);
  if (table === null) throw new Error(`no pinInfo in ${ELEMENT}`);
  return [...table[1].matchAll(/name: '([^']+)',\s*x: ([\d.]+),\s*y: ([\d.]+)/g)].map((m) => [m[1], Number(m[2]), Number(m[3])]);
}

describe('Arduino Mega 2560 pins vs @wokwi/elements', () => {
  it('copies every pinInfo entry: names, order and positions', () => {
    const pins = elementPins();
    expect(pins).toHaveLength(85);
    expect(ARDUINO_MEGA_PIN_PX.map(([n, x, y]) => [n, x, y])).toEqual(pins);
  });

  it('places the catalog pins at the element positions in mm, and maps D0–D53, A0–A15 like the core', () => {
    const def = CATALOG.get('arduino-mega')!;
    const byName = new Map(def.pins.map((p) => [p.name, p]));
    for (const [name, x, y] of elementPins()) {
      const pin = byName.get(name);
      expect(pin, name).toBeDefined();
      // Positions are rounded to the micrometre: at most half of one off.
      expect(Math.abs(pin!.x - (x * 25.4) / 96), name).toBeLessThanOrEqual(0.0005 + 1e-9);
      expect(Math.abs(pin!.y - (y * 25.4) / 96), name).toBeLessThanOrEqual(0.0005 + 1e-9);
    }
    expect(def.board?.mcu).toBe('atmega2560');
    expect(def.board?.pinMap).toMatchObject({
      '0': 'PE0',
      '1': 'PE1',
      '2': 'PE4',
      '13': 'PB7',
      '14': 'PJ1',
      '19': 'PD2',
      '21': 'PD0',
      '22': 'PA0',
      '37': 'PC0',
      '46': 'PL3',
      '53': 'PB0',
      A0: 'PF0',
      A8: 'PK0',
      A15: 'PK7',
    });
    expect(Object.keys(def.board?.pinMap ?? {})).toHaveLength(70);
    // Every port pin appears once: no two header pins share an MCU pin.
    expect(new Set(Object.values(def.board?.pinMap ?? {})).size).toBe(70);
  });
});
