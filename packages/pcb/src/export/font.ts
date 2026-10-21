/**
 * A small stroke font for silkscreen text (BT58), our own: each glyph is polylines on a 4 × 6
 * grid (x right, y down, the baseline at 6), drawn with a line of the text's stroke width.
 * Upper-case letters, digits and a few signs — enough for reference designators and labels;
 * other characters draw as a box.
 */

type Glyph = readonly (readonly number[])[];

/** Polylines as flat [x0, y0, x1, y1, …] lists. */
const GLYPHS: Readonly<Record<string, Glyph>> = {
  A: [[0, 6, 0, 2, 2, 0, 4, 2, 4, 6], [0, 3.5, 4, 3.5]],
  B: [[0, 6, 0, 0, 3, 0, 4, 1, 4, 2, 3, 3, 0, 3], [3, 3, 4, 4, 4, 5, 3, 6, 0, 6]],
  C: [[4, 1, 3, 0, 1, 0, 0, 1, 0, 5, 1, 6, 3, 6, 4, 5]],
  D: [[0, 0, 0, 6, 2.5, 6, 4, 4.5, 4, 1.5, 2.5, 0, 0, 0]],
  E: [[4, 0, 0, 0, 0, 6, 4, 6], [0, 3, 3, 3]],
  F: [[4, 0, 0, 0, 0, 6], [0, 3, 3, 3]],
  G: [[4, 1, 3, 0, 1, 0, 0, 1, 0, 5, 1, 6, 3, 6, 4, 5, 4, 3, 2, 3]],
  H: [[0, 0, 0, 6], [4, 0, 4, 6], [0, 3, 4, 3]],
  I: [[1, 0, 3, 0], [2, 0, 2, 6], [1, 6, 3, 6]],
  J: [[4, 0, 4, 5, 3, 6, 1, 6, 0, 5]],
  K: [[0, 0, 0, 6], [4, 0, 0, 4], [1.5, 2.5, 4, 6]],
  L: [[0, 0, 0, 6, 4, 6]],
  M: [[0, 6, 0, 0, 2, 3, 4, 0, 4, 6]],
  N: [[0, 6, 0, 0, 4, 6, 4, 0]],
  O: [[1, 0, 3, 0, 4, 1, 4, 5, 3, 6, 1, 6, 0, 5, 0, 1, 1, 0]],
  P: [[0, 6, 0, 0, 3, 0, 4, 1, 4, 2, 3, 3, 0, 3]],
  Q: [[1, 0, 3, 0, 4, 1, 4, 5, 3, 6, 1, 6, 0, 5, 0, 1, 1, 0], [2.5, 4.5, 4, 6]],
  R: [[0, 6, 0, 0, 3, 0, 4, 1, 4, 2, 3, 3, 0, 3], [2, 3, 4, 6]],
  S: [[4, 1, 3, 0, 1, 0, 0, 1, 0, 2, 1, 3, 3, 3, 4, 4, 4, 5, 3, 6, 1, 6, 0, 5]],
  T: [[0, 0, 4, 0], [2, 0, 2, 6]],
  U: [[0, 0, 0, 5, 1, 6, 3, 6, 4, 5, 4, 0]],
  V: [[0, 0, 2, 6, 4, 0]],
  W: [[0, 0, 1, 6, 2, 3, 3, 6, 4, 0]],
  X: [[0, 0, 4, 6], [4, 0, 0, 6]],
  Y: [[0, 0, 2, 3, 4, 0], [2, 3, 2, 6]],
  Z: [[0, 0, 4, 0, 0, 6, 4, 6]],
  '0': [[1, 0, 3, 0, 4, 1, 4, 5, 3, 6, 1, 6, 0, 5, 0, 1, 1, 0], [4, 1, 0, 5]],
  '1': [[1, 1, 2, 0, 2, 6], [1, 6, 3, 6]],
  '2': [[0, 1, 1, 0, 3, 0, 4, 1, 4, 2, 0, 6, 4, 6]],
  '3': [[0, 1, 1, 0, 3, 0, 4, 1, 4, 2, 3, 3, 1.5, 3], [3, 3, 4, 4, 4, 5, 3, 6, 1, 6, 0, 5]],
  '4': [[3, 6, 3, 0, 0, 4, 4, 4]],
  '5': [[4, 0, 0, 0, 0, 3, 3, 3, 4, 4, 4, 5, 3, 6, 1, 6, 0, 5]],
  '6': [[4, 1, 3, 0, 1, 0, 0, 1, 0, 5, 1, 6, 3, 6, 4, 5, 4, 4, 3, 3, 0, 3]],
  '7': [[0, 0, 4, 0, 1.5, 6]],
  '8': [[1, 3, 0, 2, 0, 1, 1, 0, 3, 0, 4, 1, 4, 2, 3, 3, 1, 3, 0, 4, 0, 5, 1, 6, 3, 6, 4, 5, 4, 4, 3, 3]],
  '9': [[4, 3, 1, 3, 0, 2, 0, 1, 1, 0, 3, 0, 4, 1, 4, 5, 3, 6, 1, 6, 0, 5]],
  '-': [[0.5, 3, 3.5, 3]],
  '+': [[0.5, 3, 3.5, 3], [2, 1.5, 2, 4.5]],
  '.': [[1.8, 5.6, 2.2, 5.6, 2.2, 6, 1.8, 6, 1.8, 5.6]],
  _: [[0, 6.5, 4, 6.5]],
  '/': [[0, 6, 4, 0]],
  '(': [[3, 0, 2, 1, 2, 5, 3, 6]],
  ')': [[1, 0, 2, 1, 2, 5, 1, 6]],
  ' ': [],
};

const BOX: Glyph = [[0, 0, 4, 0, 4, 6, 0, 6, 0, 0]];

export interface Stroke {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * The strokes of `text` (upper-cased) with its top-left corner at (x, y) and capital height `h`
 * mm, in the drawing's own coordinates (y down). Characters advance 6/6 of the height apart.
 */
export function textStrokes(text: string, x: number, y: number, h: number): Stroke[] {
  const unit = h / 6;
  const out: Stroke[] = [];
  let cx = x;
  for (const ch of text.toUpperCase()) {
    const glyph = GLYPHS[ch] ?? BOX;
    for (const line of glyph) {
      for (let i = 0; i + 3 < line.length; i += 2) {
        out.push({ x1: cx + line[i] * unit, y1: y + line[i + 1] * unit, x2: cx + line[i + 2] * unit, y2: y + line[i + 3] * unit });
      }
    }
    cx += 6 * unit;
  }
  return out;
}

/** Width of `text` at capital height h (the last glyph's trailing gap excluded). */
export function textWidth(text: string, h: number): number {
  return text.length === 0 ? 0 : (text.length * 6 - 2) * (h / 6);
}
