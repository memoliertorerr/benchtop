import { describe, expect, it } from 'vitest';
import { Sh1106 } from './sh1106.ts';

/** One I2C write transaction: START, bytes, STOP. */
function tx(oled: Sh1106, bytes: number[]): void {
  expect(oled.start(false)).toBe(true);
  for (const b of bytes) expect(oled.write(b)).toBe(true);
  oled.stop();
}

const at = (page: number, col: number): number => page * 132 + col;

/** Displayed pixel (x, y) from a packed fb. */
function pixel(fb: number[], x: number, y: number): number {
  const i = (y >> 3) * 128 + x;
  return (((fb[i >> 2] >>> (8 * (i & 3))) & 0xff) >> (y & 7)) & 1;
}

describe('SH1106 (BT182)', () => {
  it('its DC-DC is on at reset: display on alone lights it; ADh 8Ah turns it off', () => {
    const oled = new Sh1106(0x3c, () => {});
    tx(oled, [0x00, 0xaf]);
    expect(oled.lit).toBe(true);
    tx(oled, [0x00, 0xad, 0x8a]);
    expect(oled.lit).toBe(false);
    tx(oled, [0x00, 0xad, 0x8b]);
    expect(oled.lit).toBe(true);
    expect(oled.contrast).toBe(0x80);
  });

  it('page addressing over 132 columns: the column counts up to 131 and stays; the page never moves', () => {
    const oled = new Sh1106(0x3c, () => {});
    tx(oled, [0x00, 0xb2, 0x02, 0x10]);
    tx(oled, [0x40, 0x11, 0x22]);
    expect([oled.ram[at(2, 2)], oled.ram[at(2, 3)]]).toEqual([0x11, 0x22]);
    tx(oled, [0x00, 0xb5, 0x01, 0x18]); // column 0x81 = 129
    tx(oled, [0x40, 1, 2, 3, 4, 5]);
    expect([oled.ram[at(5, 129)], oled.ram[at(5, 130)], oled.ram[at(5, 131)]]).toEqual([1, 2, 5]);
    expect(oled.page).toBe(5);
  });

  it('an SSD1306 command it lacks is ignored and its argument read as a command', () => {
    const oled = new Sh1106(0x3c, () => {});
    tx(oled, [0x00, 0x20, 0x00]); // 20h: not a command; 00h: column low nibble 0
    tx(oled, [0x00, 0x8d, 0x14]); // 8Dh: not a command; 14h: column high nibble 4
    expect(oled.col).toBe(0x40);
    tx(oled, [0x00, 0x21, 0x00, 0x7f]); // 21h: not a command; 7Fh: start line 63
    expect(oled.startLine).toBe(63);
  });

  it('read-modify-write: E0h … EEh returns the column', () => {
    const oled = new Sh1106(0x3c, () => {});
    tx(oled, [0x00, 0xb0, 0x0a, 0x10, 0xe0]);
    tx(oled, [0x40, 1, 2, 3]);
    expect(oled.col).toBe(13);
    tx(oled, [0x00, 0xee]);
    expect(oled.col).toBe(10);
  });

  it('the 1.3″ glass shows columns 2–129: Adafruit_SH110X’s init (A1h, C8h, DAh 12h) is the identity with its offset of 2', () => {
    const oled = new Sh1106(0x3c, () => {});
    tx(oled, [0x00, 0xae, 0xd5, 0x80, 0xa8, 0x3f, 0xd3, 0x00, 0x40, 0xad, 0x8b, 0xa1, 0xc8, 0xda, 0x12, 0x81, 0xff, 0xd9, 0x1f, 0xdb, 0x40, 0x33, 0xa6, 0x20, 0x10, 0xa4, 0xaf]);
    expect(Array.from(oled.rowMap)).toEqual(Array.from({ length: 64 }, (_, y) => y));
    oled.ram[at(0, 2)] = 0x01; // glass (0, 0)
    oled.ram[at(7, 129)] = 0x80; // glass (127, 63)
    oled.ram[at(3, 0)] = 0xff; // off the glass
    oled.ram[at(3, 131)] = 0xff;
    const fb = new Array<number>(256).fill(0);
    oled.packImage(fb);
    expect(pixel(fb, 0, 0)).toBe(1);
    expect(pixel(fb, 127, 63)).toBe(1);
    expect(fb.flatMap((n, i) => (n !== 0 ? [i] : []))).toEqual([0, 255]);
    // A0h mirrors: glass x shows column 129 − x.
    tx(oled, [0x00, 0xa0]);
    oled.packImage(fb);
    expect(pixel(fb, 127, 0)).toBe(1);
  });

  it('a write outside the glass’s columns changes nothing shown', () => {
    let changes = 0;
    const oled = new Sh1106(0x3c, () => changes++);
    tx(oled, [0x00, 0xb0, 0x00, 0x10]);
    const before = changes;
    tx(oled, [0x40, 0xff, 0xff]); // columns 0 and 1
    expect(changes).toBe(before);
  });
});
