/**
 * ILI9341 240×320 TFT on SPI (BT51; ILITEK ILI9341 datasheet V1.11, §8 "Command"). An SpiDevice
 * selected by CS (low); D/C low = command byte, high = parameter or pixel data. RST low resets
 * (an unwired RST counts as high: modules pull it up).
 *
 * Commands: SWRESET 0x01, SLPIN/SLPOUT 0x10/0x11, INVOFF/INVON 0x20/0x21, DISPOFF/DISPON
 * 0x28/0x29, CASET 0x2A (SC, EC: 2 bytes each, big-endian), PASET 0x2B (SP, EP), RAMWR 0x2C and
 * RAMWRC 0x3C (pixels), MADCTL 0x36 (MY 0x80, MX 0x40, MV 0x20, BGR 0x08), COLMOD 0x3A (0x55 =
 * 16-bit RGB565, two bytes a pixel MSB first; 0x66 = 18-bit, three bytes, 6 bits each in the high
 * bits). Anything else consumes its parameters and is ignored (no reads: MISO stays 0xFF).
 * Writing walks the CASET/PASET window column first and wraps to its start.
 *
 * Panel mapping (decided, matching the element's portrait canvas and Adafruit_ILI9341's
 * rotations 0–3 = MADCTL 0x48, 0x28, 0x88, 0xE8): the panel scans mirrored, so MX=1 is the
 * unmirrored canvas — canvas x = MX ? col : 239 − col, canvas y = MY ? 319 − row : row, where
 * (col, row) is the address after MV's exchange. BGR=1 (what every driver sets: the glass is BGR)
 * keeps RGB565 as sent; BGR=0 swaps red and blue.
 *
 * Visual state: `on` (display on, awake, backlight not driven low), `invert`, and the framebuffer
 * changes since the previous visual as one dirty rectangle in canvas coordinates: `tftX`,
 * `tftY`, `tftW`, `tftH`, `tftFull` (after a reset) and `tftPixels`, its RGB565 pixels row-major,
 * packed two to a number (`lo + hi·65536`, VisualState holds plain numbers). A stream like a
 * speaker's audio: it never goes through the frame ring, and the UI folds it into a packed
 * frame (`applyTftUpdate`). The write path doesn't allocate. Pins from @wokwi/elements 1.9.2
 * ili9341-element.
 */

import type { PartContext, SpiDevice, VisualState } from '@benchtop/core';
import { definePart } from '../define.ts';

export const TFT_WIDTH = 240;
export const TFT_HEIGHT = 320;
const PX = 25.4 / 96;

/** Numbers in a packed 240×320 frame (two RGB565 pixels each). */
export const TFT_PACKED = (TFT_WIDTH * TFT_HEIGHT) / 2;

/** Pixel `i` of a packed sequence. */
export function unpackPixel(packed: readonly number[], i: number): number {
  const v = packed[i >> 1] ?? 0;
  return (i & 1) === 0 ? v % 65536 : Math.floor(v / 65536);
}

/** Whether a visual state carries a TFT update. */
export function hasTftUpdate(visual: VisualState): boolean {
  return Array.isArray(visual.tftPixels);
}

/**
 * Folds a visual's update into a packed 240×320 frame (TFT_PACKED numbers, pixel i at
 * index i >> 1): the UI's accumulator and the tests'.
 */
export function applyTftUpdate(frame: number[], visual: VisualState): void {
  const pixels = visual.tftPixels;
  if (!Array.isArray(pixels)) return;
  const x0 = Number(visual.tftX);
  const y0 = Number(visual.tftY);
  const w = Number(visual.tftW);
  const h = Number(visual.tftH);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const value = unpackPixel(pixels, r * w + c);
      const i = (y0 + r) * TFT_WIDTH + x0 + c;
      const old = frame[i >> 1] ?? 0;
      frame[i >> 1] = (i & 1) === 0 ? old - (old % 65536) + value : (old % 65536) + value * 65536;
    }
  }
}

/** [name, x px, y px] from the element's pinInfo. */
const PIN_INFO: readonly (readonly [string, number, number])[] = [
  ['VCC', 48.3, 287.2],
  ['GND', 57.9012, 287.2],
  ['CS', 67.5024, 287.2],
  ['RST', 77.1036, 287.2],
  ['D/C', 86.7048, 287.2],
  ['MOSI', 96.306, 287.2],
  ['SCK', 105.9072, 287.2],
  ['LED', 115.5084, 287.2],
  ['MISO', 125.1096, 287.2],
];
/** The element's pinInfo as copied (px), for the sync test in apps/web. */
export const ILI9341_PIN_PX = PIN_INFO;

/** Parameter bytes of the commands that take a fixed number and aren't otherwise handled. */
const PARAMS = new Uint8Array(256);
for (const [command, count] of [
  [0x26, 1], // gamma set
  [0x2d, 128], // color set (LUT)
  [0x30, 4], // partial area
  [0x33, 6], // vertical scrolling definition
  [0x37, 2], // vertical scrolling start address
  [0x51, 1], // brightness
  [0x53, 1], // CTRL display
  [0x55, 1], // CABC
  [0xb1, 2], // frame rate control
  [0xb4, 1], // display inversion control
  [0xb6, 4], // display function control
  [0xb7, 1], // entry mode
  [0xc0, 1], // power control 1
  [0xc1, 1], // power control 2
  [0xc5, 2], // VCOM control 1
  [0xc7, 1], // VCOM control 2
  [0xcb, 5], // power control A
  [0xcf, 3], // power control B
  [0xe0, 15], // positive gamma
  [0xe1, 15], // negative gamma
  [0xe8, 3], // driver timing A
  [0xea, 2], // driver timing B
  [0xed, 4], // power on sequence
  [0xef, 3], // (undocumented, sent by common init sequences)
  [0xf2, 1], // enable 3G
  [0xf7, 1], // pump ratio
] as const) {
  PARAMS[command] = count;
}

export function ili9341Model(ctx: PartContext) {
  const frame = new Uint16Array(TFT_WIDTH * TFT_HEIGHT);
  const dc = ctx.pin('D/C');
  const rst = ctx.pin('RST');
  const led = ctx.pin('LED');

  let command = 0;
  /** Parameter bytes received for the current command (or pixel bytes collected). */
  let index = 0;
  let skip = 0;
  let madctl = 0;
  let colmod = 0x66;
  let awake = false;
  let displayOn = false;
  let invert = false;
  let sc = 0;
  let ec = TFT_WIDTH - 1;
  let sp = 0;
  let ep = TFT_HEIGHT - 1;
  let col = 0;
  let row = 0;
  let writing = false;
  /** Bytes of the pixel being assembled. */
  let b0 = 0;
  let b1 = 0;
  let pixelByte = 0;
  // Dirty rectangle since the last visual (canvas coordinates, inclusive), and a pending full frame.
  let dx0 = TFT_WIDTH;
  let dy0 = TFT_HEIGHT;
  let dx1 = -1;
  let dy1 = -1;
  let full = true;

  const hardReset = (): void => {
    frame.fill(0);
    command = 0;
    index = 0;
    skip = 0;
    madctl = 0;
    colmod = 0x66;
    awake = false;
    displayOn = false;
    invert = false;
    sc = 0;
    ec = TFT_WIDTH - 1;
    sp = 0;
    ep = TFT_HEIGHT - 1;
    writing = false;
    pixelByte = 0;
    full = true;
    ctx.invalidate();
  };

  /** Address limits after MADCTL's exchange: columns run to 319 with MV set. */
  const maxCol = (): number => ((madctl & 0x20) !== 0 ? TFT_HEIGHT : TFT_WIDTH) - 1;
  const maxRow = (): number => ((madctl & 0x20) !== 0 ? TFT_WIDTH : TFT_HEIGHT) - 1;

  const putPixel = (rgb565: number): void => {
    if (col <= maxCol() && row <= maxRow()) {
      const mv = (madctl & 0x20) !== 0;
      const c = mv ? row : col;
      const r = mv ? col : row;
      const x = (madctl & 0x40) !== 0 ? c : TFT_WIDTH - 1 - c;
      const y = (madctl & 0x80) !== 0 ? TFT_HEIGHT - 1 - r : r;
      // BGR=0: the glass is BGR, so swap red and blue to show what was meant.
      const color = (madctl & 0x08) !== 0 ? rgb565 : ((rgb565 & 0x1f) << 11) | (rgb565 & 0x07e0) | (rgb565 >> 11);
      frame[y * TFT_WIDTH + x] = color;
      if (x < dx0) dx0 = x;
      if (x > dx1) dx1 = x;
      if (y < dy0) dy0 = y;
      if (y > dy1) dy1 = y;
    }
    // Column first within the window, then the next page; wrap to the window's start.
    if (col >= ec) {
      col = sc;
      row = row >= ep ? sp : row + 1;
    } else col++;
  };

  const startCommand = (byte: number): void => {
    command = byte;
    index = 0;
    skip = 0;
    writing = false;
    switch (byte) {
      case 0x01: // SWRESET
        madctl = 0;
        colmod = 0x66;
        awake = false;
        displayOn = false;
        invert = false;
        sc = 0;
        ec = TFT_WIDTH - 1;
        sp = 0;
        ep = TFT_HEIGHT - 1;
        ctx.invalidate();
        break;
      case 0x10:
        awake = false;
        ctx.invalidate();
        break;
      case 0x11:
        awake = true;
        ctx.invalidate();
        break;
      case 0x20:
      case 0x21:
        invert = byte === 0x21;
        ctx.invalidate();
        break;
      case 0x28:
      case 0x29:
        displayOn = byte === 0x29;
        ctx.invalidate();
        break;
      case 0x2c: // RAMWR: from the window's start
        col = sc;
        row = sp;
        writing = true;
        pixelByte = 0;
        break;
      case 0x3c: // RAMWRC: carry on
        writing = true;
        pixelByte = 0;
        break;
      default:
        skip = PARAMS[byte];
    }
  };

  const data = (byte: number): void => {
    if (writing) {
      if (pixelByte === 0) b0 = byte;
      else if (pixelByte === 1) b1 = byte;
      pixelByte++;
      if (colmod === 0x55) {
        if (pixelByte === 2) {
          pixelByte = 0;
          putPixel((b0 << 8) | b1);
          ctx.invalidate();
        }
      } else if (pixelByte === 3) {
        // 18-bit: R, G, B in each byte's high 6 bits → RGB565.
        pixelByte = 0;
        putPixel(((b0 >> 3) << 11) | ((b1 >> 2) << 5) | (byte >> 3));
        ctx.invalidate();
      }
      return;
    }
    const i = index++;
    switch (command) {
      case 0x2a:
        if (i === 0) sc = byte << 8;
        else if (i === 1) sc |= byte;
        else if (i === 2) ec = byte << 8;
        else if (i === 3) ec |= byte;
        return;
      case 0x2b:
        if (i === 0) sp = byte << 8;
        else if (i === 1) sp |= byte;
        else if (i === 2) ep = byte << 8;
        else if (i === 3) ep |= byte;
        return;
      case 0x36:
        if (i === 0) madctl = byte;
        return;
      case 0x3a:
        if (i === 0) colmod = (byte & 0x77) === 0x55 ? 0x55 : 0x66;
        return;
      default:
        if (skip > 0) skip--;
    }
  };

  const device: SpiDevice = {
    transfer(mosi: number): number {
      if (dc.read().level === 0) startCommand(mosi);
      else data(mosi);
      return 0xff;
    },
  };
  ctx.attachSpi({ sck: 'SCK', mosi: 'MOSI', miso: 'MISO', cs: 'CS' }, device);

  rst.onChange((state) => {
    if (state.level === 0) hardReset();
  });
  led.onChange(() => ctx.invalidate());

  return {
    visual(): VisualState {
      const visual: VisualState = { on: awake && displayOn && led.read().level !== 0, invert };
      if (full) {
        dx0 = 0;
        dy0 = 0;
        dx1 = TFT_WIDTH - 1;
        dy1 = TFT_HEIGHT - 1;
      }
      if (dx1 >= dx0) {
        const w = dx1 - dx0 + 1;
        const h = dy1 - dy0 + 1;
        const pixels = new Array<number>(Math.ceil((w * h) / 2));
        for (let k = 0; k < pixels.length; k++) {
          const a = 2 * k;
          const lo = frame[(dy0 + Math.floor(a / w)) * TFT_WIDTH + dx0 + (a % w)];
          const hi = a + 1 < w * h ? frame[(dy0 + Math.floor((a + 1) / w)) * TFT_WIDTH + dx0 + ((a + 1) % w)] : 0;
          pixels[k] = lo + hi * 65536;
        }
        visual.tftX = dx0;
        visual.tftY = dy0;
        visual.tftW = w;
        visual.tftH = h;
        visual.tftFull = full;
        visual.tftPixels = pixels;
        full = false;
      }
      dx0 = TFT_WIDTH;
      dy0 = TFT_HEIGHT;
      dx1 = -1;
      dy1 = -1;
      return visual;
    },
    reset: hardReset,
  };
}

export const ili9341 = definePart({
  type: 'ili9341',
  title: 'TFT 240×320 (ILI9341, SPI)',
  category: 'displays',
  size: { w: 46.5, h: 77.6 },
  pins: PIN_INFO.map(([name, x, y]) => ({
    name,
    x: Math.round(x * PX * 1000) / 1000,
    y: Math.round(y * PX * 1000) / 1000,
    role: name === 'VCC' ? ('power' as const) : name === 'GND' ? ('ground' as const) : ('digital' as const),
  })),
  defaults: {},
  createModel: (ctx) => ili9341Model(ctx),
});
