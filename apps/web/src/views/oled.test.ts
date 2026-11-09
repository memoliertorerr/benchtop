import { CATALOG } from '@benchtop/parts';
import { describe, expect, it } from 'vitest';
import { OLED_VIEW_TYPES, oledOpacity, oledView, paintOled } from './oled.ts';
import { viewFor } from './registry.ts';

describe('OLED module views (BT181)', () => {
  it('draw the catalog’s OLED modules', () => {
    for (const type of OLED_VIEW_TYPES) {
      expect(CATALOG.get(type), type).toBeDefined();
      expect(viewFor(type)).toBe(oledView);
    }
  });

  it('unpack a packed framebuffer: page-major bytes, bit 0 the page’s top row; invert, all on, off', () => {
    // 128×32: pixel (0, 0) (byte 0 bit 0), (127, 31) (byte 3·128 + 127, bit 7), (5, 9) (byte 128 + 5, bit 1).
    const bytes = new Array<number>(512).fill(0);
    bytes[0] = 0x01;
    bytes[3 * 128 + 127] = 0x80;
    bytes[128 + 5] = 0x02;
    const fb = Array.from({ length: 128 }, (_, i) => (bytes[4 * i] | (bytes[4 * i + 1] << 8) | (bytes[4 * i + 2] << 16) | (bytes[4 * i + 3] << 24)) >>> 0);
    const data = new Uint8ClampedArray(128 * 32 * 4);
    const lit = (x: number, y: number): boolean => data[(y * 128 + x) * 4 + 3] === 0xff;
    paintOled(data, fb, 32, true, false, false);
    expect([lit(0, 0), lit(127, 31), lit(5, 9), lit(1, 0)]).toEqual([true, true, true, false]);
    expect(data.filter((_, i) => i % 4 === 3 && data[i] === 0xff)).toHaveLength(3);
    paintOled(data, fb, 32, true, true, false);
    expect([lit(0, 0), lit(1, 0)]).toEqual([false, true]);
    paintOled(data, fb, 32, true, false, true);
    expect(lit(1, 0)).toBe(true);
    paintOled(data, fb, 32, false, false, true);
    expect(lit(0, 0)).toBe(false);
  });

  it('show contrast as opacity: 0.35 at 0, 1 at 255', () => {
    expect(oledOpacity(0)).toBeCloseTo(0.35, 6);
    expect(oledOpacity(255)).toBeCloseTo(1, 6);
    expect(oledOpacity(undefined)).toBeCloseTo(0.35 + (0.65 * 0x7f) / 255, 6);
  });
});
