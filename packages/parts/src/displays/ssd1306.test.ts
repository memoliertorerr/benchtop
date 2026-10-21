import { describe, expect, it } from 'vitest';
import { Ssd1306 } from './ssd1306.ts';

/** One I2C write transaction: START, bytes, STOP. */
function tx(oled: Ssd1306, bytes: number[]): void {
  expect(oled.start(false)).toBe(true);
  for (const b of bytes) expect(oled.write(b)).toBe(true);
  oled.stop();
}

const at = (page: number, col: number): number => page * 128 + col;

function fresh(): { oled: Ssd1306; changes: () => number } {
  let count = 0;
  const oled = new Ssd1306(0x3c, () => count++);
  return { oled, changes: () => count };
}

/** Displayed pixel (x, y) from a packed fb. */
function pixel(fb: number[], x: number, y: number): number {
  const i = (y >> 3) * 128 + x;
  return (((fb[i >> 2] >>> (8 * (i & 3))) & 0xff) >> (y & 7)) & 1;
}

describe('SSD1306 addressing', () => {
  it('horizontal mode wraps column → page inside the 0x21/0x22 windows', () => {
    const { oled } = fresh();
    tx(oled, [0x00, 0x20, 0x00, 0x21, 10, 12, 0x22, 2, 3]);
    tx(oled, [0x40, 1, 2, 3, 4, 5, 6, 7]);
    expect([oled.ram[at(2, 10)], oled.ram[at(2, 11)], oled.ram[at(2, 12)]]).toEqual([7, 2, 3]);
    expect([oled.ram[at(3, 10)], oled.ram[at(3, 11)], oled.ram[at(3, 12)]]).toEqual([4, 5, 6]);
    expect(oled.ram[at(2, 13)]).toBe(0);
  });

  it('vertical mode wraps page → column', () => {
    const { oled } = fresh();
    tx(oled, [0x00, 0x20, 0x01, 0x21, 5, 6, 0x22, 1, 2]);
    tx(oled, [0x40, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5]);
    expect([oled.ram[at(1, 5)], oled.ram[at(2, 5)], oled.ram[at(1, 6)], oled.ram[at(2, 6)]]).toEqual([0xa5, 0xa2, 0xa3, 0xa4]);
  });

  it('page mode: 0xB0–0xB7 and 0x00–0x0F / 0x10–0x1F set the pointer; the column wraps alone', () => {
    const { oled } = fresh();
    tx(oled, [0x00, 0x20, 0x02, 0xb3, 0x0a, 0x11]);
    tx(oled, [0x40, 0x11, 0x22]);
    expect([oled.ram[at(3, 26)], oled.ram[at(3, 27)]]).toEqual([0x11, 0x22]);
    tx(oled, [0x00, 0xb7, 0x0f, 0x17]);
    tx(oled, [0x40, 0x33, 0x44]);
    expect([oled.ram[at(7, 127)], oled.ram[at(7, 0)]]).toEqual([0x33, 0x44]);
    expect(oled.page).toBe(7);
  });

  it('Co=1 control bytes carry exactly one byte each, commands and data mixed', () => {
    const { oled } = fresh();
    tx(oled, [0x80, 0xb1, 0x80, 0x02, 0x80, 0x10, 0xc0, 0x55, 0xc0, 0x66, 0x80, 0xaf]);
    expect([oled.ram[at(1, 2)], oled.ram[at(1, 3)]]).toEqual([0x55, 0x66]);
    expect(oled.displayOn).toBe(true);
  });

  it.each([
    [0x81, 1],
    [0x8d, 1],
    [0x20, 1],
    [0x21, 2],
    [0x22, 2],
    [0xd3, 1],
    [0xa8, 1],
    [0xda, 1],
    [0xd5, 1],
    [0xd9, 1],
    [0xdb, 1],
    [0x26, 6],
    [0x27, 6],
    [0x29, 5],
    [0x2a, 5],
    [0xa3, 2],
  ])('command 0x%s takes %i argument(s): the next command and data land where expected', (command, count) => {
    const { oled } = fresh();
    tx(oled, [0x00, 0x20, 0x02, 0xb0, 0x00, 0x10]);
    // Arguments of 0xB5 would move the pointer to page 5 if read as commands; 0xB6 after them
    // must be read as a command (page 6), not swallowed as an argument.
    tx(oled, [0x00, command, ...new Array<number>(count).fill(0xb5), 0xb6]);
    tx(oled, [0x40, 0x99]);
    const col = command === 0x21 ? 0x35 : 0;
    expect(oled.ram[at(6, col)]).toBe(0x99);
    expect(oled.ram.filter((b) => b !== 0)).toHaveLength(1);
  });

  it('honors arguments split across transactions (Adafruit sends one byte per transmission)', () => {
    const { oled } = fresh();
    tx(oled, [0x00, 0xa8]);
    tx(oled, [0x00, 0x1f]);
    expect(oled.multiplex).toBe(31);
    tx(oled, [0x00, 0x22]);
    tx(oled, [0x00, 0x00]);
    tx(oled, [0x00, 0xff]);
    expect([oled.pageStart, oled.pageEnd]).toEqual([0, 7]);
    tx(oled, [0x00, 0x21]);
    tx(oled, [0x00, 0x00]);
    tx(oled, [0x00, 0x7f]);
    expect([oled.colStart, oled.colEnd]).toEqual([0, 127]);
  });

  it('is lit only while on with the charge pump enabled; reads are NACKed', () => {
    const { oled } = fresh();
    tx(oled, [0x00, 0xaf]);
    expect(oled.lit).toBe(false);
    tx(oled, [0x00, 0x8d, 0x14]);
    expect(oled.lit).toBe(true);
    tx(oled, [0x00, 0x8d, 0x10]);
    expect(oled.lit).toBe(false);
    expect(oled.start(true)).toBe(false);
  });

  it('reports a change only when something shown changed', () => {
    const { oled, changes } = fresh();
    tx(oled, [0x00, 0x20, 0x00]);
    tx(oled, [0x40, 0x01, 0x02]);
    const after = changes();
    tx(oled, [0x00, 0x21, 0, 127, 0x22, 0, 7]);
    tx(oled, [0x40, 0x01, 0x02]);
    expect(changes()).toBe(after);
    tx(oled, [0x00, 0xa7]);
    expect(changes()).toBe(after + 1);
  });
});

describe('SSD1306 display mapping', () => {
  function withPixels(commands: number[]) {
    const { oled } = fresh();
    tx(oled, [0x00, 0x20, 0x00, ...commands]);
    oled.ram[at(0, 0)] = 0x01; // RAM column 0, row 0
    oled.ram[at(7, 127)] = 0x80; // RAM column 127, row 63
    const fb = new Array<number>(256).fill(0);
    oled.packImage(fb);
    return fb;
  }

  it('A1 + C8 (Adafruit) is the identity', () => {
    const fb = withPixels([0xa1, 0xc8]);
    expect(pixel(fb, 0, 0)).toBe(1);
    expect(pixel(fb, 127, 63)).toBe(1);
    expect(fb.flatMap((n, i) => (n !== 0 ? [i] : []))).toEqual([0, 255]);
  });

  it('A0 mirrors X and C0 mirrors Y', () => {
    expect(pixel(withPixels([0xa0, 0xc8]), 127, 0)).toBe(1);
    expect(pixel(withPixels([0xa1, 0xc0]), 0, 63)).toBe(1);
    expect(pixel(withPixels([0xa0, 0xc0]), 127, 63)).toBe(1);
  });

  it('start line and offset rotate rows; rows past the multiplex ratio are dark', () => {
    expect(pixel(withPixels([0xa1, 0xc8, 0x41]), 0, 63)).toBe(1); // start line 1: RAM row 0 on row 63
    expect(pixel(withPixels([0xa1, 0xc8, 0xd3, 0x02]), 0, 62)).toBe(1);
    const fb = withPixels([0xa1, 0xc8, 0xa8, 0x1f]);
    expect(pixel(fb, 0, 0)).toBe(1);
    expect(pixel(fb, 127, 63)).toBe(0);
  });
});
