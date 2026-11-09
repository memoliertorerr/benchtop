/**
 * SSD1306 128×64 OLED controller (Solomon Systech SSD1306 datasheet rev 1.1) behind its I2C
 * framing: an I2cDevice at 0x3C or 0x3D (prop `address`); reads are NACKed (no read in serial
 * mode). `command()` and `data()` are the controller itself, which BT181's SPI module drives with its
 * D/C pin.
 *
 * Each I2C transaction is control byte(s) then payload: Co (bit 7) + D/C (bit 6). Co=0 → the rest
 * of the transaction is commands (D/C=0) or GDDRAM data (D/C=1); Co=1 → exactly one byte
 * follows, then another control byte. The command parser is driven by an argument-count table
 * and keeps its state across STOP/START, because Adafruit_SSD1306 sends a command and its
 * arguments in separate transmissions.
 *
 * Rows (BT180; the datasheet's Tables 10-1, 10-2, 10-3). Each glass row is wired to a COM pad. Pad
 * p (with COM left/right remap, DAh A[5], p ^ 32) is scan index k = p (sequential COM pins, DAh
 * A[4]=0) or 2p / 2(p − 32) + 1 (alternative, the reset); a normal scan (C0h) shows slot
 * (k + offset) mod 64 on it, a remapped one (C8h) N − 1 − ((k − offset) mod 64), dark when that is ≥
 * N, the MUX ratio; slot s shows RAM row (s + start line) mod 64. The glass: the 0.96″ 128×64 is
 * wired for the alternative configuration (row y from the top on the pad that k = 63 − y reaches),
 * the 0.91″ 128×32 for the sequential one (pads 0–31, row y on pad 31 − y), so Adafruit's inits
 * (A1h, C8h, DAh 12h / 02h) are the identity on their own glass and the other's init draws every
 * other row, as on a board. `rowMap` holds the result (glass row → RAM row, −1 dark), rebuilt when
 * the mapping changes. Segment remap A0h mirrors X (A1h + C8h is the identity).
 *
 * Scrolling (BT180; §10.2). 26h/27h set up a right/left scroll of pages B–D by one column a step;
 * 29h/2Ah the same plus a vertical offset of E rows a step inside the A3h area (top fixed rows,
 * rows in the area); 2Fh starts the last setup, 2Eh stops it. A step comes every 5, 64, 128, 256,
 * 3, 4, 25 or 2 frames (C[2:0]); a frame is D·K·N oscillator clocks (§8.3): D and the oscillator
 * setting from D5h, K = phase 1 + phase 2 + 50 from D9h, Fosc 370 kHz at the default setting (Table
 * 13-1), assumed linear from 175 kHz (0000b) to 540 kHz (1111b). The horizontal step rotates the
 * RAM itself (after 2Eh "the ram data needs to be rewritten"), so a stopped scroll stays where it
 * stopped; it moves in RAM column order (26h: column c's byte to c + 1), so Adafruit's A1h module
 * scrolls right on 26h. The vertical offset is the display's: 2Eh clears it. Each step is a timer
 * on the bench clock — nothing runs while nothing scrolls. Writing RAM while scrolling (which the
 * datasheet prohibits) writes it.
 *
 * The panel is lit only while the display is on and the charge pump is enabled.
 *
 * Visual state, sent only when something changed: `on`, `invert`, `allOn`, `contrast` and `fb`,
 * the displayed image (glass rows × 128) as rows·4 numbers, each packing 4 bytes of the page-major
 * layout (byte i at bits 8*(i%4)). The write path doesn't allocate; `visual()` repacks only when
 * the image changed. Pins from @wokwi/elements 1.9.2 ssd1306-element (DATA = SDA, CLK = SCL).
 */

import type { I2cDevice, Nanos, PartContext } from '@benchtop/core';
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

/** Frames between scroll steps, by C[2:0] of 26h/27h/29h/2Ah. */
const STEP_FRAMES = [5, 64, 128, 256, 3, 4, 25, 2] as const;

/** The oscillator (Hz) at D5h's A[7:4] setting: 370 kHz at the default 1000b (Table 13-1), assumed linear. */
export function oscillatorHz(setting: number): number {
  return 175_000 + ((540_000 - 175_000) * (setting & 0x0f)) / 15;
}

/**
 * The scan index COM pad `pad` (0–63) carries under DAh: sequential (A[4]=0) or alternative
 * (A[4]=1, ROW0 on COM0, ROW1 on COM32, ROW2 on COM1…), with left/right remap (A[5]) swapping the
 * halves first (Table 10-3).
 */
export function scanIndex(pad: number, alternative: boolean, remap: boolean): number {
  const p = remap ? pad ^ 32 : pad;
  return alternative ? (p < 32 ? 2 * p : 2 * (p - 32) + 1) : p;
}

/**
 * The scan slot (the ROW of Tables 10-1/10-2) shown on scan index `k`, −1 when dark: a normal scan
 * (C0h) shows (k + offset) mod 64, a remapped one (C8h) N − 1 − ((k − offset) mod 64); a slot ≥ N
 * (the MUX ratio, `n`) isn't scanned.
 */
export function scanSlot(k: number, reversed: boolean, offset: number, n: number): number {
  if (reversed) {
    const u = (k - offset) & 63;
    return u < n ? n - 1 - u : -1;
  }
  const slot = (k + offset) & 63;
  return slot < n ? slot : -1;
}

/** Which glass the controller drives: the 0.96″ 128×64 (alternative COM wiring) or the 0.91″ 128×32 (sequential). */
export type OledGlass = 64 | 32;

/** The bench's clock, for scroll steps (a PartContext is one). */
export interface OledClock {
  schedule(delay: Nanos, callback: () => void): number;
  cancel(timerId: number): void;
}

export class Ssd1306 implements I2cDevice, OledController {
  readonly address: number;
  /** Glass rows: 64 or 32. */
  readonly glass: OledGlass;
  /** GDDRAM, page-major: byte page*128 + column, bit 0 = the page's top row. */
  readonly ram = new Uint8Array(WIDTH * PAGES);
  /** Glass row (from the top) → the RAM row it shows, −1 dark. */
  readonly rowMap = new Int8Array(64);
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
  /** DAh A[4]: alternative COM pin configuration (the reset). */
  comAlternative = true;
  /** DAh A[5]: COM left/right remap. */
  comRemap = false;
  /** D5h: clock divide ratio − 1 (A[3:0]) and oscillator setting (A[7:4]). */
  clockDiv = 0x80;
  /** D9h: phase 1 (A[3:0]) and phase 2 (A[7:4]) in DCLKs. */
  precharge = 0x22;
  /** The scroll setup (26h/27h/29h/2Ah): 0 none, else that command. */
  scrollCommand = 0;
  scrollStartPage = 0;
  scrollEndPage = 0;
  scrollInterval = 0;
  /** Rows the vertical offset moves a step (29h/2Ah's E). */
  scrollRows = 0;
  /** A3h: rows in the top fixed area, rows in the scroll area. */
  areaTop = 0;
  areaRows = 64;
  /** Scrolling (2Fh) and the vertical offset it has reached. */
  scrolling = false;
  verticalOffset = 0;
  /** The displayed image needs repacking (RAM or mapping changed). */
  imageDirty = true;
  private expectControl = true;
  private single = false;
  private data = false;
  private command = -1;
  private readonly args = new Uint8Array(6);
  private argCount = 0;
  private argIndex = 0;
  private timer = -1;
  private readonly changed: () => void;
  private readonly clock: OledClock | undefined;
  private readonly onStep = (): void => {
    this.timer = -1;
    this.scrollStep();
    if (this.scrolling) this.timer = this.clock?.schedule(this.stepNs(), this.onStep) ?? -1;
  };

  /** `changed` runs whenever something the view shows changed; `clock` times the scroll steps. */
  constructor(address: number, changed: () => void, options: { glass?: OledGlass; clock?: OledClock } = {}) {
    this.address = address;
    this.changed = changed;
    this.glass = options.glass ?? 64;
    this.clock = options.clock;
    this.remap();
  }

  get lit(): boolean {
    return this.displayOn && this.chargePump;
  }

  reset(): void {
    this.stopScroll();
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
    this.comAlternative = true;
    this.comRemap = false;
    this.clockDiv = 0x80;
    this.precharge = 0x22;
    this.scrollCommand = 0;
    this.areaTop = 0;
    this.areaRows = 64;
    this.expectControl = true;
    this.command = -1;
    this.remap();
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
    if (this.data) this.dataByte(byte);
    else this.commandByte(byte);
    if (this.single) this.expectControl = true;
    return true;
  }

  read(): number {
    return 0xff;
  }

  stop(): void {
    this.expectControl = true;
  }

  /** One GDDRAM byte (D/C high). */
  dataByte(byte: number): void {
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

  /** One command byte (D/C low): a command or the next argument of one. */
  commandByte(byte: number): void {
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

  /** The time between scroll steps (ns): its frames × D·K·N oscillator clocks. */
  stepNs(): number {
    const d = (this.clockDiv & 0x0f) + 1;
    const k = (this.precharge & 0x0f) + ((this.precharge >> 4) & 0x0f) + 50;
    const frameS = (d * k * (this.multiplex + 1)) / oscillatorHz(this.clockDiv >> 4);
    return Math.max(1, Math.round(STEP_FRAMES[this.scrollInterval] * frameS * 1e9));
  }

  /** One scroll step: the pages' RAM one column over, the vertical offset on. */
  scrollStep(): void {
    if (!this.scrolling) return;
    const right = this.scrollCommand === 0x26 || this.scrollCommand === 0x29;
    if (this.scrollEndPage >= this.scrollStartPage) {
      for (let page = this.scrollStartPage; page <= this.scrollEndPage; page++) {
        const base = page * WIDTH;
        if (right) {
          const last = this.ram[base + WIDTH - 1];
          this.ram.copyWithin(base + 1, base, base + WIDTH - 1);
          this.ram[base] = last;
        } else {
          const first = this.ram[base];
          this.ram.copyWithin(base, base + 1, base + WIDTH);
          this.ram[base + WIDTH - 1] = first;
        }
      }
    }
    if (this.scrollRows > 0 && this.areaRows > 0) {
      this.verticalOffset = (this.verticalOffset + this.scrollRows) % this.areaRows;
      this.remap();
    }
    this.imageDirty = true;
    this.changed();
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
    } else if (byte === 0x2f) {
      this.startScroll();
    } else if (byte === 0x2e) {
      this.stopScroll();
    }
    // 0xE3 nop and unknown bytes: no effect.
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
      case 0xda:
        this.setMapping('comAlternative', (a & 0x10) !== 0);
        this.setMapping('comRemap', (a & 0x20) !== 0);
        return;
      case 0xd5:
        this.clockDiv = a;
        return;
      case 0xd9:
        this.precharge = a;
        return;
      case 0x26:
      case 0x27:
      case 0x29:
      case 0x2a:
        this.scrollCommand = command;
        this.scrollStartPage = b & 0x07;
        this.scrollInterval = this.args[2] & 0x07;
        this.scrollEndPage = this.args[3] & 0x07;
        this.scrollRows = command >= 0x29 ? this.args[4] & 0x3f : 0;
        return;
      case 0xa3:
        this.areaTop = a & 0x3f;
        this.areaRows = b & 0x7f;
        if (this.scrolling) this.remap();
        return;
      default:
      // 0xDB: the argument consumed, no visible effect.
    }
  }

  private startScroll(): void {
    if (this.scrollCommand === 0) return;
    this.stopTimer();
    this.scrolling = true;
    this.timer = this.clock?.schedule(this.stepNs(), this.onStep) ?? -1;
  }

  private stopScroll(): void {
    this.stopTimer();
    this.scrolling = false;
    if (this.verticalOffset !== 0) {
      this.verticalOffset = 0;
      this.remap();
      this.changed();
    }
  }

  private stopTimer(): void {
    if (this.timer >= 0) this.clock?.cancel(this.timer);
    this.timer = -1;
  }

  private setView(key: 'displayOn' | 'chargePump' | 'allOn' | 'invert', value: boolean): void {
    if (this[key] === value) return;
    this[key] = value;
    this.changed();
  }

  private setMapping(key: 'startLine' | 'offset' | 'multiplex' | 'segmentRemap' | 'comReversed' | 'comAlternative' | 'comRemap', value: number | boolean): void {
    if (this[key] === value) return;
    (this as Record<typeof key, number | boolean>)[key] = value;
    this.remap();
    this.changed();
  }

  /** Rebuilds `rowMap` from the glass, the COM configuration, scan, offset, MUX, start line and scroll. */
  private remap(): void {
    const n = this.multiplex + 1;
    const vertical = this.scrolling && this.verticalOffset > 0 && this.areaRows > 0;
    for (let y = 0; y < 64; y++) {
      if (y >= this.glass) {
        this.rowMap[y] = -1;
        continue;
      }
      // The pad the glass row is wired to: the line the alternative scan reaches as k = 63 − y
      // (128×64), or pad 31 − y (128×32).
      const line = 63 - y;
      const pad = this.glass === 64 ? ((line & 1) === 0 ? line >> 1 : 32 + (line >> 1)) : 31 - y;
      const slot = scanSlot(scanIndex(pad, this.comAlternative, this.comRemap), this.comReversed, this.offset, n);
      if (slot < 0) {
        this.rowMap[y] = -1;
        continue;
      }
      let row = (slot + this.startLine) & 63;
      if (vertical && row >= this.areaTop && row < this.areaTop + this.areaRows) row = this.areaTop + ((row - this.areaTop + this.verticalOffset) % this.areaRows);
      this.rowMap[y] = row & 63;
    }
    this.imageDirty = true;
  }

  /** Packs the displayed image into `fb` (glass rows × 4 numbers, 4 page-major bytes each). */
  packImage(fb: number[]): void {
    fb.fill(0);
    for (let y = 0; y < this.glass; y++) {
      const row = this.rowMap[y];
      if (row < 0) continue;
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

/** The model of an SSD1306 module on I2C: `sda`/`scl` its pin names, `glass` its rows. */
export function ssd1306Model(ctx: PartContext, address: string | number | boolean, sda = 'DATA', scl = 'CLK', glass: OledGlass = 64) {
  const oled = new Ssd1306(parseOledAddress(address), () => ctx.invalidate(), { glass, clock: ctx });
  ctx.attachI2c(sda, scl, oled);
  return oledModel(ctx, oled);
}

/** What the visual side needs of an OLED controller (the SSD1306, BT182's SH1106). */
export interface OledController {
  readonly glass: OledGlass;
  readonly lit: boolean;
  readonly invert: boolean;
  readonly allOn: boolean;
  readonly contrast: number;
  readonly imageDirty: boolean;
  packImage(fb: number[]): void;
  reset(): void;
}

/** The visual side of any OLED module: its packed image (`glass` × 4 numbers) and flags. */
export function oledModel(ctx: PartContext, oled: OledController) {
  const fb: number[] = new Array<number>(oled.glass * 4).fill(0);
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
