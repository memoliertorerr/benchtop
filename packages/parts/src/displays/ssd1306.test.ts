import { describe, expect, it } from 'vitest';
import { oscillatorHz, scanIndex, scanSlot, Ssd1306 } from './ssd1306.ts';

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
    // BT180: a remapped scan (C8h) runs COM[N−1] → COM0, and this glass's top row is on the pad
    // COM63 reaches: with MUX 32 the top half is the dark one, RAM row 0 on glass row 32.
    const fb = withPixels([0xa1, 0xc8, 0xa8, 0x1f]);
    expect(pixel(fb, 0, 0)).toBe(0);
    expect(pixel(fb, 0, 32)).toBe(1);
    expect(fb.slice(0, 128).every((n) => n === 0)).toBe(true);
    // The MUX picks the scanned pads, not the direction: a normal scan (C0h) lights the same bottom
    // half, upside down — glass row 63 shows RAM row 0.
    const normal = withPixels([0xa1, 0xc0, 0xa8, 0x1f]);
    expect(pixel(normal, 0, 63)).toBe(1);
    expect(normal.slice(0, 128).every((n) => n === 0)).toBe(true);
  });
});

describe('SSD1306 rows (BT180)', () => {
  it('COM pins: the datasheet’s Table 10-3', () => {
    // Sequential, no remap: ROW r on COM r; with remap the halves swap.
    expect([0, 31, 32, 63].map((p) => scanIndex(p, false, false))).toEqual([0, 31, 32, 63]);
    expect([32, 63, 0, 31].map((p) => scanIndex(p, false, true))).toEqual([0, 31, 32, 63]);
    // Alternative (case 5): ROW0 COM0, ROW1 COM32, ROW2 COM1, ROW62 COM31, ROW63 COM63.
    expect([0, 32, 1, 31, 63].map((p) => scanIndex(p, true, false))).toEqual([0, 1, 2, 62, 63]);
    // Alternative with remap (case 6): ROW0 COM32, ROW1 COM0.
    expect([32, 0].map((p) => scanIndex(p, true, true))).toEqual([0, 1]);
  });

  it('scan direction, offset and MUX: the datasheet’s Tables 10-1 and 10-2', () => {
    // Table 10-1 (e): MUX 56, offset 8, normal.
    expect([0, 47, 48, 55, 56, 63].map((k) => scanSlot(k, false, 8, 56))).toEqual([8, 55, -1, -1, 0, 7]);
    // Table 10-1 (d): MUX 56, offset 0.
    expect([0, 55, 56].map((k) => scanSlot(k, false, 0, 56))).toEqual([0, 55, -1]);
    // Table 10-2 (a), (b): MUX 64 remapped, offset 0 and 8.
    expect([0, 63].map((k) => scanSlot(k, true, 0, 64))).toEqual([63, 0]);
    expect([0, 7, 8, 63].map((k) => scanSlot(k, true, 8, 64))).toEqual([7, 0, 63, 8]);
    // Table 10-2 (d), (e): MUX 48 remapped, offset 0 and 8.
    expect([0, 47, 48].map((k) => scanSlot(k, true, 0, 48))).toEqual([47, 0, -1]);
    expect([0, 7, 8, 55, 56].map((k) => scanSlot(k, true, 8, 48))).toEqual([-1, -1, 47, 0, -1]);
  });

  /** The row map after Adafruit_SSD1306's init for `height` (MUX, DAh) on `glass`. */
  function adafruitRows(glass: 64 | 32, height: 64 | 32): number[] {
    const oled = new Ssd1306(0x3c, () => {}, { glass });
    tx(oled, [0x00, 0xa8, height - 1, 0xd3, 0x00, 0x40, 0xa1, 0xc8, 0xda, height === 64 ? 0x12 : 0x02]);
    return Array.from(oled.rowMap.slice(0, glass));
  }

  it('Adafruit’s 128×64 and 128×32 inits are the identity on their own glass', () => {
    expect(adafruitRows(64, 64)).toEqual(Array.from({ length: 64 }, (_, y) => y));
    expect(adafruitRows(32, 32)).toEqual(Array.from({ length: 32 }, (_, y) => y));
  });

  it('the other module’s init draws every other row: 128×32 on the 128×64 glass, 128×64 on the 128×32', () => {
    // MUX 32, sequential, on glass wired for the alternative pins: RAM rows 0–31 on the odd rows.
    expect(adafruitRows(64, 32)).toEqual(Array.from({ length: 64 }, (_, y) => ((y & 1) === 1 ? (y - 1) / 2 : -1)));
    // MUX 64, alternative, on glass wired to pads 0–31: every other RAM row.
    expect(adafruitRows(32, 64)).toEqual(Array.from({ length: 32 }, (_, y) => 2 * y + 1));
  });
});

describe('SSD1306 scrolling (BT180)', () => {
  /** An SSD1306 on a fake clock: `run(ns)` fires the steps due. */
  function scrolling() {
    let now = 0;
    const timers = new Map<number, { at: number; callback: () => void }>();
    let next = 1;
    const clock = {
      schedule(delay: number, callback: () => void): number {
        timers.set(next, { at: now + delay, callback });
        return next++;
      },
      cancel(id: number): void {
        timers.delete(id);
      },
    };
    const oled = new Ssd1306(0x3c, () => {}, { clock });
    // Adafruit's init: D5h 80h, D9h F1h, MUX 64, A1h, C8h, DAh 12h, charge pump, on.
    tx(oled, [0x00, 0xd5, 0x80, 0xa8, 0x3f, 0x8d, 0x14, 0x20, 0x00, 0xa1, 0xc8, 0xda, 0x12, 0xd9, 0xf1, 0xaf]);
    const run = (ns: number): void => {
      const until = now + ns;
      for (;;) {
        let due: [number, { at: number; callback: () => void }] | undefined;
        for (const entry of timers) if (entry[1].at <= until && (due === undefined || entry[1].at < due[1].at)) due = entry;
        if (due === undefined) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].callback();
      }
      now = until;
    };
    return { oled, run, pending: () => timers.size };
  }

  const FRAME_NS = (66 * 64 * 1e9) / 370_000; // D = 1, K = 1 + 15 + 50, 64 MUX, 370 kHz

  it('frames: Fosc 370 kHz at the default setting; Adafruit’s init steps every 5 frames (≈ 57 ms)', () => {
    expect(oscillatorHz(8)).toBeCloseTo(369_667, -3);
    const { oled } = scrolling();
    tx(oled, [0x00, 0x26, 0x00, 0x00, 0x00, 0x07, 0x00, 0xff]);
    expect(oled.stepNs()).toBe(Math.round(5 * FRAME_NS * (370_000 / oscillatorHz(8))));
    expect(oled.stepNs() / 1e6).toBeCloseTo(57.1, 0);
  });

  it('26h moves pages B–D one column right a step (column 127 wraps to 0); 2Eh leaves it there', () => {
    const { oled, run, pending } = scrolling();
    oled.ram[0 * 128 + 126] = 0x01; // page 0, column 126
    oled.ram[4 * 128 + 10] = 0x10; // page 4: outside pages 0–3
    tx(oled, [0x00, 0x26, 0x00, 0x00, 0x00, 0x03, 0x00, 0xff, 0x2f]);
    const step = oled.stepNs();
    run(step - 1);
    expect(oled.ram[126]).toBe(0x01);
    run(1);
    expect(oled.ram[127]).toBe(0x01);
    run(step);
    expect(oled.ram[0]).toBe(0x01); // wrapped
    expect(oled.ram[4 * 128 + 10]).toBe(0x10);
    tx(oled, [0x00, 0x2e]);
    expect(pending()).toBe(0);
    run(10 * step);
    expect(oled.ram[0]).toBe(0x01); // stopped where it was
  });

  it('27h moves left; C[2:0] = 7 steps every 2 frames', () => {
    const { oled, run } = scrolling();
    oled.ram[7 * 128 + 0] = 0x80;
    tx(oled, [0x00, 0x27, 0x00, 0x07, 0x07, 0x07, 0x00, 0xff, 0x2f]);
    expect(oled.stepNs()).toBe(Math.round(2 * FRAME_NS * (370_000 / oscillatorHz(8))));
    run(oled.stepNs());
    expect(oled.ram[7 * 128 + 127]).toBe(0x80);
  });

  it('29h (Adafruit’s diagonal): one column right and one row up a step inside the A3h area; 2Eh clears the vertical offset', () => {
    const { oled, run } = scrolling();
    oled.ram[1 * 128 + 5] = 0x01; // RAM row 8, column 5
    tx(oled, [0x00, 0xa3, 0x00, 64, 0x29, 0x00, 0x00, 0x00, 0x07, 0x01, 0x2f]);
    const fb = new Array<number>(256).fill(0);
    run(oled.stepNs());
    oled.packImage(fb);
    expect(pixel(fb, 6, 7)).toBe(1); // right one, up one
    run(oled.stepNs() * 3);
    oled.packImage(fb);
    expect(pixel(fb, 9, 4)).toBe(1);
    tx(oled, [0x00, 0x2e]);
    oled.packImage(fb);
    expect(pixel(fb, 9, 8)).toBe(1); // the vertical offset is gone; the columns stay moved
  });

  it('reset stops a scroll', () => {
    const { oled, pending } = scrolling();
    tx(oled, [0x00, 0x26, 0x00, 0x00, 0x00, 0x07, 0x00, 0xff, 0x2f]);
    expect(pending()).toBe(1);
    oled.reset();
    expect(pending()).toBe(0);
    expect(oled.scrolling).toBe(false);
  });
});
