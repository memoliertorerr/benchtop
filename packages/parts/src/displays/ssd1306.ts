/**
 * SSD1306 128×64 OLED on I2C (Solomon Systech SSD1306 datasheet rev 1.1). An I2cDevice at
 * 0x3C or 0x3D (prop `address`); reads are NACKed (no read in serial mode).
 *
 * Each transaction is control byte(s) then payload: Co (bit 7) + D/C (bit 6). Co=0 → the rest
 * of the transaction is commands (D/C=0) or GDDRAM data (D/C=1); Co=1 → exactly one byte
 * follows, then another control byte. The command parser is driven by an argument-count table
 * and keeps its state across STOP/START, because Adafruit_SSD1306 sends a command and its
 * arguments in separate transmissions.
 *
 * Display mapping (decided in the plan): segment remap 0xA1 + COM scan 0xC8 (Adafruit's init) is
 * the identity — GDDRAM column 0, page 0, bit 0 is the top-left pixel; 0xA0 mirrors X, 0xC0
 * mirrors Y; start line and display offset rotate rows mod 64; rows past multiplex+1 are dark.
 * The panel is lit only while the display is on and the charge pump is enabled. Hardware
 * scrolling commands are parsed (their arguments consumed) but not performed.
 *
 * Visual state, sent only when something changed: `on`, `invert`, `allOn`, `contrast` and `fb`,
 * the displayed 128×64 image as 256 numbers, each packing 4 bytes of the page-major layout
 * (byte i at bits 8*(i%4)). The write path doesn't allocate; `visual()` repacks only when the
 * image changed. Pins from @wokwi/elements 1.9.2 ssd1306-element (DATA = SDA, CLK = SCL).
 */

import type { I2cDevice, PartContext } from '@benchtop/core';
import { definePart } from '../define.ts';

const WIDTH = 128;
const PAGES = 8;

/** Arguments each command takes; anything not listed takes none. */
const ARGS = new Uint8Array(256);
for (const [command, count] of [
  [0x81, 1], // contrast
  [0x8d, 1], // charge pump
  [0x20, 1], // memory addressing mode
  [0x21, 2], // column window
  [0x22, 2], // page window
  [0xd3, 1], // display offset
  [0xa8, 1], // multiplex ratio
  [0xda, 1], // COM pins
  [0xd5, 1], // clock divide / oscillator
  [0xd9, 1], // pre-charge
  [0xdb, 1], // VCOMH deselect
  [0x26, 6], // right horizontal scroll setup
  [0x27, 6], // left horizontal scroll setup
  [0x29, 5], // vertical + right scroll setup
  [0x2a, 5], // vertical + left scroll setup
  [0xa3, 2], // vertical scroll area
] as const) {
  ARGS[command] = count;
}

export class Ssd1306 implements I2cDevice {
  readonly address: number;
  /** GDDRAM, page-major: byte page*128 + column, bit 0 = the page's top row. */
  readonly ram = new Uint8Array(WIDTH * PAGES);
  displayOn = false;
  chargePump = false;
  invert = false;
  allOn = false;
  contrast = 0x7f;
  mode = 2;
  colStart = 0;
  colEnd = WIDTH - 1;
  pageStart = 0;
  pageEnd = PAGES - 1;
  col = 0;
  page = 0;
  segmentRemap = false;
  comReversed = false;
  startLine = 0;
  offset = 0;
  multiplex = 63;
  /** The displayed image needs repacking (RAM or mapping changed). */
  imageDirty = true;
  private expectControl = true;
  private single = false;
  private data = false;
  private command = -1;
  private readonly args = new Uint8Array(6);
  private argCount = 0;
  private argIndex = 0;
  private readonly changed: () => void;

  /** `changed` runs whenever something the view shows changed. */
  constructor(address: number, changed: () => void) {
    this.address = address;
    this.changed = changed;
  }

  get lit(): boolean {
    return this.displayOn && this.chargePump;
  }

  reset(): void {
    this.ram.fill(0);
    this.displayOn = false;
    this.chargePump = false;
    this.invert = false;
    this.allOn = false;
    this.contrast = 0x7f;
    this.mode = 2;
    this.colStart = 0;
    this.colEnd = WIDTH - 1;
    this.pageStart = 0;
    this.pageEnd = PAGES - 1;
    this.col = 0;
    this.page = 0;
    this.segmentRemap = false;
    this.comReversed = false;
    this.startLine = 0;
    this.offset = 0;
    this.multiplex = 63;
    this.expectControl = true;
    this.command = -1;
    this.imageDirty = true;
  }

  start(read: boolean): boolean {
    this.expectControl = true;
    return !read;
  }

  write(byte: number): boolean {
    if (this.expectControl) {
      this.single = (byte & 0x80) !== 0;
      this.data = (byte & 0x40) !== 0;
      this.expectControl = false;
      return true;
    }
    if (this.data) this.writeRam(byte);
    else this.writeCommand(byte);
    if (this.single) this.expectControl = true;
    return true;
  }

  read(): number {
    return 0xff;
  }

  stop(): void {
    this.expectControl = true;
  }

  private writeRam(byte: number): void {
    const index = this.page * WIDTH + this.col;
    if (this.ram[index] !== byte) {
      this.ram[index] = byte;
      this.imageDirty = true;
      this.changed();
    }
    if (this.mode === 0) {
      if (this.col < this.colEnd) this.col++;
      else {
        this.col = this.colStart;
        this.page = this.page < this.pageEnd ? this.page + 1 : this.pageStart;
      }
    } else if (this.mode === 1) {
      if (this.page < this.pageEnd) this.page++;
      else {
        this.page = this.pageStart;
        this.col = this.col < this.colEnd ? this.col + 1 : this.colStart;
      }
    } else {
      this.col = (this.col + 1) % WIDTH;
    }
  }

  private writeCommand(byte: number): void {
    if (this.command >= 0) {
      this.args[this.argIndex++] = byte;
      if (this.argIndex === this.argCount) {
        const command = this.command;
        this.command = -1;
        this.withArgs(command);
      }
      return;
    }
    const count = ARGS[byte];
    if (count > 0) {
      this.command = byte;
      this.argCount = count;
      this.argIndex = 0;
      return;
    }
    this.simple(byte);
  }

  /** A command without arguments. */
  private simple(byte: number): void {
    if (byte <= 0x0f) {
      this.col = (this.col & 0xf0) | byte;
    } else if (byte <= 0x1f) {
      this.col = ((byte & 0x07) << 4) | (this.col & 0x0f);
    } else if (byte >= 0x40 && byte <= 0x7f) {
      this.setMapping('startLine', byte & 0x3f);
    } else if (byte >= 0xb0 && byte <= 0xb7) {
      this.page = byte & 0x07;
    } else if (byte === 0xae || byte === 0xaf) {
      this.setView('displayOn', byte === 0xaf);
    } else if (byte === 0xa4 || byte === 0xa5) {
      this.setView('allOn', byte === 0xa5);
    } else if (byte === 0xa6 || byte === 0xa7) {
      this.setView('invert', byte === 0xa7);
    } else if (byte === 0xa0 || byte === 0xa1) {
      this.setMapping('segmentRemap', byte === 0xa1);
    } else if (byte >= 0xc0 && byte <= 0xcf) {
      this.setMapping('comReversed', (byte & 0x08) !== 0);
    }
    // 0x2E/0x2F scroll stop/start, 0xE3 nop and unknown bytes: no effect.
  }

  private withArgs(command: number): void {
    const a = this.args[0];
    const b = this.args[1];
    switch (command) {
      case 0x81:
        if (a !== this.contrast) {
          this.contrast = a;
          this.changed();
        }
        return;
      case 0x8d:
        this.setView('chargePump', (a & 0x04) !== 0);
        return;
      case 0x20:
        this.mode = a & 0x03;
        return;
      case 0x21:
        this.colStart = a & 0x7f;
        this.colEnd = b & 0x7f;
        this.col = this.colStart;
        return;
      case 0x22:
        this.pageStart = a & 0x07;
        this.pageEnd = b & 0x07;
        this.page = this.pageStart;
        return;
      case 0xd3:
        this.setMapping('offset', a & 0x3f);
        return;
      case 0xa8:
        this.setMapping('multiplex', Math.max(15, a & 0x3f));
        return;
      default:
      // 0xDA, 0xD5, 0xD9, 0xDB and the scroll setups: arguments consumed, no visible effect.
    }
  }

  private setView(key: 'displayOn' | 'chargePump' | 'allOn' | 'invert', value: boolean): void {
    if (this[key] === value) return;
    this[key] = value;
    this.changed();
  }

  private setMapping(key: 'startLine' | 'offset' | 'multiplex' | 'segmentRemap' | 'comReversed', value: number | boolean): void {
    if (this[key] === value) return;
    (this as Record<typeof key, number | boolean>)[key] = value;
    this.imageDirty = true;
    this.changed();
  }

  /** Packs the displayed image into `fb` (256 numbers, 4 page-major bytes each). */
  packImage(fb: number[]): void {
    fb.fill(0);
    for (let y = 0; y < 64; y++) {
      if (y > this.multiplex) continue;
      const com = this.comReversed ? y : 63 - y;
      const row = (com + this.startLine + this.offset) & 63;
      const sourceBase = (row >> 3) * WIDTH;
      const sourceBit = row & 7;
      const targetBase = (y >> 3) * WIDTH;
      const targetBit = y & 7;
      for (let x = 0; x < WIDTH; x++) {
        const source = this.segmentRemap ? x : WIDTH - 1 - x;
        if ((this.ram[sourceBase + source] >> sourceBit) & 1) {
          const i = targetBase + x;
          fb[i >> 2] |= 1 << (8 * (i & 3) + targetBit);
        }
      }
    }
    for (let i = 0; i < fb.length; i++) fb[i] >>>= 0;
    this.imageDirty = false;
  }
}

/** 0x3C or 0x3D. Accepts 60, "0x3C" or "60". */
export function parseOledAddress(value: string | number | boolean): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^(0x[0-9a-f]+|\d+)$/i.test(value.trim()) ? Number(value.trim()) : Number.NaN;
  if (n !== 0x3c && n !== 0x3d) throw new Error(`address must be 0x3C or 0x3D, got ${String(value)}`);
  return n;
}

function ssd1306Model(ctx: PartContext, address: string | number | boolean) {
  const oled = new Ssd1306(parseOledAddress(address), () => ctx.invalidate());
  ctx.attachI2c('DATA', 'CLK', oled);
  const fb: number[] = new Array<number>(256).fill(0);
  const visual = { on: false, invert: false, allOn: false, contrast: 0x7f, fb };
  return {
    visual() {
      if (oled.imageDirty) oled.packImage(fb);
      visual.on = oled.lit;
      visual.invert = oled.invert;
      visual.allOn = oled.allOn;
      visual.contrast = oled.contrast;
      return visual;
    },
    reset() {
      oled.reset();
      ctx.invalidate();
    },
  };
}

export const ssd1306 = definePart({
  type: 'ssd1306',
  title: 'OLED 128×64 (SSD1306, I2C)',
  category: 'displays',
  size: { w: 39.688, h: 30.692 },
  pins: [
    { name: 'DATA', x: 9.657, y: 3.307, role: 'digital' },
    { name: 'CLK', x: 12.039, y: 3.307, role: 'digital' },
    { name: 'DC', x: 14.420, y: 3.307, role: 'nc' },
    { name: 'RST', x: 17.066, y: 3.307, role: 'nc' },
    { name: 'CS', x: 19.711, y: 3.307, role: 'nc' },
    { name: '3V3', x: 22.093, y: 3.307, role: 'power' },
    { name: 'VIN', x: 24.739, y: 3.307, role: 'power' },
    { name: 'GND', x: 27.384, y: 3.175, role: 'ground' },
  ],
  defaults: { address: '0x3C' },
  createModel: (ctx, props) => ssd1306Model(ctx, props.address),
});
