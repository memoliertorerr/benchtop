import { type NetState, type PartContext, type SpiDevice, Strength, type VisualState } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { applyTftUpdate, ili9341Model, TFT_HEIGHT, TFT_PACKED, TFT_WIDTH, unpackPixel } from './ili9341.ts';

// BT51: the ILI9341 command set over SPI, on a stub context — D/C, RST and LED levels set by the
// test, the SPI device captured from attachSpi. Pixels are read from the accumulated frame.

function harness() {
  const levels: Record<string, 0 | 1 | null> = { 'D/C': 0, RST: null, LED: null };
  const listeners: Record<string, ((s: NetState) => void)[]> = {};
  let device: SpiDevice | null = null;
  const state = (name: string): NetState => ({ level: levels[name] ?? null, strength: levels[name] === null ? Strength.hiz : Strength.strong, conflict: false, volts: levels[name] === 1 ? 3.3 : 0 });
  const ctx = {
    pin: (name: string) => ({
      read: () => state(name),
      onChange: (fn: (s: NetState) => void) => (listeners[name] ??= []).push(fn),
    }),
    attachSpi: (_pins: unknown, d: SpiDevice) => {
      device = d;
    },
    invalidate: () => {},
    now: () => 0,
  } as unknown as PartContext;
  const model = ili9341Model(ctx);
  const frame = new Array<number>(TFT_PACKED).fill(0);
  const set = (name: string, level: 0 | 1 | null): void => {
    levels[name] = level;
    for (const fn of listeners[name] ?? []) fn(state(name));
  };
  const cmd = (c: number, ...params: number[]): void => {
    set('D/C', 0);
    device?.transfer(c);
    set('D/C', 1);
    for (const p of params) device?.transfer(p);
  };
  const bytes = (...data: number[]): void => {
    set('D/C', 1);
    for (const b of data) device?.transfer(b);
  };
  const pixels = (...colors: number[]): void => {
    set('D/C', 1);
    for (const c of colors) {
      device?.transfer(c >> 8);
      device?.transfer(c & 0xff);
    }
  };
  const window = (x0: number, y0: number, x1: number, y1: number): void => {
    cmd(0x2a, x0 >> 8, x0 & 0xff, x1 >> 8, x1 & 0xff);
    cmd(0x2b, y0 >> 8, y0 & 0xff, y1 >> 8, y1 & 0xff);
  };
  /** Collects the model's visual (as a frame would) and folds its update into `frame`. */
  const collect = (): VisualState => {
    const v = model.visual();
    applyTftUpdate(frame, v);
    return v;
  };
  const at = (x: number, y: number): number => unpackPixel(frame, y * TFT_WIDTH + x);
  const init = (madctl: number): void => {
    cmd(0x01);
    cmd(0x11);
    cmd(0x3a, 0x55);
    cmd(0x36, madctl);
    cmd(0x29);
  };
  return { model, cmd, bytes, pixels, window, collect, at, set, init };
}

const RED = 0xf800;
const GREEN = 0x07e0;
const BLUE = 0x001f;

describe('ILI9341 (BT51)', () => {
  it('starts with a full black frame, dark until SLPOUT and DISPON', () => {
    const t = harness();
    const v = t.collect();
    expect(v).toMatchObject({ on: false, tftX: 0, tftY: 0, tftW: TFT_WIDTH, tftH: TFT_HEIGHT, tftFull: true });
    expect((v.tftPixels as number[]).length).toBe(TFT_PACKED);
    t.cmd(0x11);
    t.cmd(0x29);
    expect(t.collect()).toEqual({ on: true, invert: false }); // nothing drawn: no update
    t.set('LED', 0);
    expect(t.collect().on).toBe(false); // backlight driven low
  });

  it('RAMWR walks the CASET/PASET window column first and wraps; only the dirty rectangle travels', () => {
    const t = harness();
    t.init(0x48); // Adafruit rotation 0
    t.collect();
    t.window(10, 20, 12, 21); // 3 × 2
    t.cmd(0x2c);
    t.pixels(RED, GREEN, BLUE, BLUE, GREEN, RED, 0xffff); // the 7th wraps to (10, 20)
    const v = t.collect();
    expect(v).toMatchObject({ tftX: 10, tftY: 20, tftW: 3, tftH: 2, tftFull: false });
    expect((v.tftPixels as number[]).length).toBe(3);
    expect([t.at(10, 20), t.at(11, 20), t.at(12, 20), t.at(10, 21), t.at(11, 21), t.at(12, 21)]).toEqual([0xffff, GREEN, BLUE, BLUE, GREEN, RED]);
    expect(t.at(13, 20)).toBe(0);
    t.cmd(0x3c); // RAMWRC carries on from (11, 20)
    t.pixels(RED);
    t.collect();
    expect(t.at(11, 20)).toBe(RED);
  });

  it.each([
    // [MADCTL, logical (x, y) → canvas (x, y)] for Adafruit's rotations 0–3.
    [0x48, [5, 7], [5, 7]],
    [0x28, [5, 7], [TFT_WIDTH - 1 - 7, 5]],
    [0x88, [5, 7], [TFT_WIDTH - 1 - 5, TFT_HEIGHT - 1 - 7]],
    [0xe8, [5, 7], [7, TFT_HEIGHT - 1 - 5]],
  ] as const)('MADCTL 0x%s maps a logical pixel onto the portrait canvas', (madctl, [lx, ly], [cx, cy]) => {
    const t = harness();
    t.init(madctl);
    t.window(lx, ly, lx, ly);
    t.cmd(0x2c);
    t.pixels(GREEN);
    t.collect();
    expect(t.at(cx, cy)).toBe(GREEN);
  });

  it('BGR=0 swaps red and blue; INVON flags inversion; 18-bit COLMOD takes three bytes a pixel', () => {
    const t = harness();
    t.init(0x40); // MX, no BGR
    t.window(0, 0, 0, 0);
    t.cmd(0x2c);
    t.pixels(RED);
    t.collect();
    expect(t.at(0, 0)).toBe(BLUE);
    t.cmd(0x21);
    expect(t.collect().invert).toBe(true);
    t.cmd(0x36, 0x48);
    t.cmd(0x3a, 0x66);
    t.window(1, 0, 2, 0);
    t.cmd(0x2c);
    t.bytes(0xfc, 0x00, 0xfc, 0x00, 0xfc, 0x00); // magenta, then green, in 6 bits a channel
    t.collect();
    expect([t.at(1, 0), t.at(2, 0)]).toEqual([0xf81f, 0x07e0]);
  });

  it('ignores parameters of commands it does not model, and RST low resets to a dark black frame', () => {
    const t = harness();
    t.init(0x48);
    t.cmd(0xcb, 0x39, 0x2c, 0x00, 0x34, 0x02); // power control A: 5 parameters
    t.cmd(0xe0, ...Array.from({ length: 15 }, (_, i) => i)); // positive gamma: 15
    t.window(0, 0, 0, 0);
    t.cmd(0x2c);
    t.pixels(RED);
    t.collect();
    expect(t.at(0, 0)).toBe(RED);
    t.set('RST', 0);
    const v = t.collect();
    expect(v).toMatchObject({ on: false, tftFull: true });
    expect(t.at(0, 0)).toBe(0);
  });
});
