/**
 * An OLED's visual state as text an agent can read (BT183): the image in braille, one character a
 * 2 × 4 block of pixels (U+2800 + its dots), so a 128×64 panel is 16 lines of 64 characters and a
 * 128×32 one 8 lines. The same rules as the views: dark while `on` is false, `allOn` lights every
 * pixel, `invert` swaps them. `oledPixel` reads one pixel the same way (the runner's `oled`
 * assertion).
 */

import type { VisualState } from '@benchtop/core';

/** Braille dot bits by (column 0–1, row 0–3) inside a character. */
const DOTS = [
  [0x01, 0x02, 0x04, 0x40],
  [0x08, 0x10, 0x20, 0x80],
] as const;

/** Whether a visual state is an OLED's (a packed `fb` and a `contrast`). */
export function isOledVisual(visual: VisualState | undefined): boolean {
  return visual !== undefined && Array.isArray(visual.fb) && typeof visual.contrast === 'number';
}

/** The glass's rows: the packed `fb` holds 4 numbers per row. */
export function oledRows(visual: VisualState): number {
  return Array.isArray(visual.fb) ? (visual.fb as unknown[]).length / 4 : 0;
}

/** Pixel (x, y) as shown: lit (true) or dark. Out of range is dark. */
export function oledPixel(visual: VisualState, x: number, y: number): boolean {
  const rows = oledRows(visual);
  if (visual.on !== true || x < 0 || x >= 128 || y < 0 || y >= rows) return false;
  if (visual.allOn === true) return true;
  const fb = visual.fb as readonly number[];
  const i = (y >> 3) * 128 + x;
  const set = ((((fb[i >> 2] ?? 0) >>> (8 * (i & 3))) & 0xff) >> (y & 7)) & 1;
  return (set === 1) !== (visual.invert === true);
}

/** The image as braille lines (rows / 4 lines of 64 characters). */
export function oledScreenText(visual: VisualState): string[] {
  const rows = oledRows(visual);
  const lines: string[] = [];
  for (let y = 0; y < rows; y += 4) {
    let line = '';
    for (let x = 0; x < 128; x += 2) {
      let dots = 0;
      for (let dx = 0; dx < 2; dx++) for (let dy = 0; dy < 4; dy++) if (oledPixel(visual, x + dx, y + dy)) dots |= DOTS[dx][dy];
      line += String.fromCharCode(0x2800 + dots);
    }
    lines.push(line);
  }
  return lines;
}
