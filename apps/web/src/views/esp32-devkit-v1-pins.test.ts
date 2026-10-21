import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { CATALOG, ESP32_DEVKIT_PIN_PX } from '@benchtop/parts';
import { describe, expect, it } from 'vitest';

// BT34: the DevKit V1's pins in @benchtop/parts are copied by hand from the element's pinInfo
// (packages/* never import the DOM element). This reads the element's source and checks the copy:
// every name, in the same order, at the same position (px → mm × 25.4 / 96).

const require = createRequire(import.meta.url);
const ELEMENT = join(dirname(require.resolve('@wokwi/elements/package.json')), 'dist/esm/esp32-devkit-v1-element.js');

function elementPins(): [string, number, number][] {
  const source = readFileSync(ELEMENT, 'utf8');
  const table = /this\.pinInfo = \[([\s\S]*?)\];/.exec(source);
  if (table === null) throw new Error(`no pinInfo in ${ELEMENT}`);
  return [...table[1].matchAll(/\{ name: '([^']+)', x: ([\d.]+), y: ([\d.]+)/g)].map((m) => [m[1], Number(m[2]), Number(m[3])]);
}

describe('ESP32 DevKit V1 pins vs @wokwi/elements', () => {
  it('copies every pinInfo entry: names, order and positions', () => {
    const pins = elementPins();
    expect(pins).toHaveLength(30);
    expect(ESP32_DEVKIT_PIN_PX.map(([n, x, y]) => [n, x, y])).toEqual(pins);
  });

  it('places the catalog pins at the element positions in mm, and maps every header GPIO to a pin that exists', () => {
    const def = CATALOG.get('esp32-devkit-v1')!;
    const byName = new Map(def.pins.map((p) => [p.name, p]));
    for (const [name, x, y] of elementPins()) {
      const pin = byName.get(name);
      expect(pin, name).toBeDefined();
      expect(pin!.x).toBeCloseTo((x * 25.4) / 96, 3);
      expect(pin!.y).toBeCloseTo((y * 25.4) / 96, 3);
    }
    expect(def.board?.mcu).toBe('esp32');
    expect(def.board?.pinMap).toMatchObject({ D2: 'GPIO2', TX0: 'GPIO1', RX0: 'GPIO3', TX2: 'GPIO17', RX2: 'GPIO16', VP: 'GPIO36', VN: 'GPIO39', D34: 'GPIO34', D23: 'GPIO23' });
    expect(Object.keys(def.board?.pinMap ?? {})).toHaveLength(25);
  });
});
