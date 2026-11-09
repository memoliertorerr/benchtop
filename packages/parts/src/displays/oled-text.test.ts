import type { VisualState } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { isOledVisual, oledPixel, oledScreenText } from './oled-text.ts';

/** A visual with the given lit pixels on a `rows`-row glass. */
function visualWith(rows: number, lit: [number, number][], extra: Partial<VisualState> = {}): VisualState {
  const bytes = new Array<number>(rows * 16).fill(0);
  for (const [x, y] of lit) bytes[(y >> 3) * 128 + x] |= 1 << (y & 7);
  const fb = Array.from({ length: rows * 4 }, (_, i) => (bytes[4 * i] | (bytes[4 * i + 1] << 8) | (bytes[4 * i + 2] << 16) | (bytes[4 * i + 3] << 24)) >>> 0);
  return { on: true, invert: false, allOn: false, contrast: 0x7f, fb, ...extra };
}

describe('an OLED as text (BT183)', () => {
  it('reads pixels as shown: on, invert, all on', () => {
    const v = visualWith(64, [[3, 9]]);
    expect(isOledVisual(v)).toBe(true);
    expect(isOledVisual({ brightness: 1 })).toBe(false);
    expect([oledPixel(v, 3, 9), oledPixel(v, 3, 10), oledPixel(v, 200, 0)]).toEqual([true, false, false]);
    expect(oledPixel({ ...v, invert: true }, 3, 10)).toBe(true);
    expect(oledPixel({ ...v, allOn: true }, 0, 0)).toBe(true);
    expect(oledPixel({ ...v, on: false }, 3, 9)).toBe(false);
  });

  it('draws 2 × 4 pixels a braille character: 16 lines of 64 for 128×64, 8 for 128×32', () => {
    const v = visualWith(64, [
      [0, 0],
      [1, 3],
      [127, 63],
    ]);
    const lines = oledScreenText(v);
    expect(lines).toHaveLength(16);
    expect(lines.every((l) => l.length === 64)).toBe(true);
    expect(lines[0][0]).toBe(String.fromCharCode(0x2800 + 0x01 + 0x80)); // dots 1 and 8
    expect(lines[15][63]).toBe(String.fromCharCode(0x2800 + 0x80));
    expect(lines[7]).toBe('⠀'.repeat(64));
    expect(oledScreenText(visualWith(32, []))).toHaveLength(8);
  });
});
