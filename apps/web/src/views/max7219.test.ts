import { CATALOG } from '@benchtop/parts';
import { describe, expect, it } from 'vitest';
import { dotOpacity, MAX7219_VIEW_TYPES, matrixDots } from './max7219.ts';
import { viewFor } from './registry.ts';

describe('MAX7219 module views (BT185)', () => {
  it('draw the catalog’s three modules', () => {
    for (const type of MAX7219_VIEW_TYPES.keys()) {
      expect(CATALOG.get(type), type).toBeDefined();
      expect(viewFor(type)).toBe(viewFor('max7219-matrix'));
    }
  });

  it('put chip 0 on the right, digit d on row d, D7 on the left', () => {
    const rows = new Array<number>(32).fill(0);
    rows[0] = 0x80; // chip 0, row 0, leftmost column of the rightmost matrix
    rows[3 * 8 + 7] = 0x01; // chip 3, row 7, rightmost column of the leftmost matrix
    const dots = matrixDots(rows, 4);
    expect(dots.reduce((a, b) => a + b, 0)).toBe(2);
    expect(dots[0 * 32 + 24]).toBe(1);
    expect(dots[7 * 32 + 7]).toBe(1);
  });

  it('(BT186) draw the TM1637 module too', () => {
    expect(CATALOG.get('tm1637-4digit')).toBeDefined();
    expect(viewFor('tm1637-4digit')).not.toBe(viewFor('max7219-matrix'));
    expect(viewFor('tm1637-4digit')).not.toBe(viewFor('no-such-part'));
  });

  it('(BT191) draw the BME280 and BMP280 modules (BT192, BT193, BT196: and the DS3231, relay and RC522 modules)', () => {
    for (const type of ['bme280', 'bmp280', 'ds3231', 'relay-module', 'rc522']) {
      expect(CATALOG.get(type), type).toBeDefined();
      expect(viewFor(type)).not.toBe(viewFor('no-such-part'));
    }
  });

  it('keep a dim display plainly lit', () => {
    expect(dotOpacity(0)).toBe(0);
    expect(dotOpacity(1 / 32)).toBeGreaterThan(0.5);
    expect(dotOpacity(1)).toBe(1);
  });
});
