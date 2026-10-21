import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { ARDUINO_NANO_PIN_PX, CATALOG } from '@benchtop/parts';
import { describe, expect, it } from 'vitest';

// BT45: the Nano's pins in @benchtop/parts are copied by hand from the element's pinInfo
// (packages/* never import the DOM element). This reads the element's source and checks the copy:
// every header pin, in the same order, at the same position (px → mm × 25.4 / 96). The element's
// ICSP pins (`noBreadboard: true`) are left out on purpose — see arduino-nano.ts.

const require = createRequire(import.meta.url);
const ELEMENT = join(dirname(require.resolve('@wokwi/elements/package.json')), 'dist/esm/arduino-nano-element.js');

function elementPins(): { name: string; x: number; y: number; noBreadboard: boolean }[] {
  const source = readFileSync(ELEMENT, 'utf8');
  const table = /this\.pinInfo = \[([\s\S]*?)\n {8}\];/.exec(source);
  if (table === null) throw new Error(`no pinInfo in ${ELEMENT}`);
  // Entries are `{ name, x, y, signals, noBreadboard? }`, some spread over several lines.
  return table[1].split(/\n {12}\{/).flatMap((entry) => {
    const m = /name: '([^']+)',\s*x: ([\d.]+),\s*y: ([\d.]+)/.exec(entry);
    return m === null ? [] : [{ name: m[1], x: Number(m[2]), y: Number(m[3]), noBreadboard: /noBreadboard: true/.test(entry) }];
  });
}

describe('Arduino Nano pins vs @wokwi/elements', () => {
  it('copies every header pin: names, order and positions; leaves out exactly the ICSP pins', () => {
    const pins = elementPins();
    expect(pins).toHaveLength(36);
    expect(pins.filter((p) => p.noBreadboard).map((p) => p.name)).toEqual(['12.2', '5V.2', '13.2', '11.2', 'RESET.3', 'GND.3']);
    expect(ARDUINO_NANO_PIN_PX.map(([n, x, y]) => [n, x, y])).toEqual(pins.filter((p) => !p.noBreadboard).map((p) => [p.name, p.x, p.y]));
  });

  it('places the catalog pins at the element positions in mm, and maps D0–D13, A0–A7 to the ATmega328P', () => {
    const def = CATALOG.get('arduino-nano')!;
    const byName = new Map(def.pins.map((p) => [p.name, p]));
    for (const { name, x, y, noBreadboard } of elementPins()) {
      if (noBreadboard) continue;
      const pin = byName.get(name);
      expect(pin, name).toBeDefined();
      expect(pin!.x).toBeCloseTo((x * 25.4) / 96, 3);
      expect(pin!.y).toBeCloseTo((y * 25.4) / 96, 3);
    }
    expect(def.board?.mcu).toBe('atmega328p');
    expect(def.board?.pinMap).toMatchObject({ '0': 'PD0', '13': 'PB5', A0: 'PC0', A5: 'PC5', A6: 'ADC6', A7: 'ADC7' });
    expect(Object.keys(def.board?.pinMap ?? {})).toHaveLength(22);
  });
});
