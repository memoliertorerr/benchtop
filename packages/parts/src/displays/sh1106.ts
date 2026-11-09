/**
 * SH1106 132×64 OLED controller (BT182; Sino Wealth SH1106 datasheet V2.2) behind the same I2C
 * framing as the SSD1306 (control bytes Co + D/C), on the 1.3″ module's 128×64 glass.
 *
 * What differs from the SSD1306 (`ssd1306.ts`):
 * - A 132×64 RAM; the glass shows columns 2–129 (SEG2–SEG129), so glass x is column x + 2 with
 *   A1h (Adafruit_SH110X's `_page_start_offset` of 2) and 129 − x with A0h.
 * - Page addressing only: B0h–B7h pick the page, 00h–0Fh / 10h–1Fh the column; the column counts up
 *   to 131 and stays there ("incremented … until address 131 is accessed"); the page never moves.
 *   No 20h/21h/22h, no scroll: a byte the command table doesn't list is ignored on its own, so an
 *   SSD1306 command's argument is read as a command of its own, as on the chip.
 * - The panel's supply is the DC-DC converter (ADh + 8Ah/8Bh), on at reset (8Bh): lit while the
 *   display is on and the DC-DC is (Table 8: off needs an external VPP, which the module lacks).
 *   No 8Dh charge pump; 30h–33h set the pump's voltage (no visible effect).
 * - Read-modify-write (E0h) … End (EEh) returns the column to where E0h found it.
 * - Reset values: contrast 80h, D5h 50h; start line, offset, MUX, scan, COM pads (DAh 02h/12h —
 *   the same sequential/alternative pads as the SSD1306, no left/right remap) as the SSD1306.
 * The 1.3″ glass is wired for the alternative pads as the 0.96″ SSD1306's is: Adafruit_SH110X's init
 * (A1h, C8h, DAh 12h) is the identity.
 */

import type { I2cDevice } from '@benchtop/core';
import { type OledController, scanIndex, scanSlot } from './ssd1306.ts';

const COLUMNS = 132;
const PAGES = 8;
/** The first RAM column on the 128-wide glass. */
const FIRST = 2;

/** Arguments each command takes; anything not listed takes none. */
const ARGS = new Uint8Array(256);
for (const command of [0x81, 0xa8, 0xad, 0xd3, 0xd5, 0xd9, 0xda, 0xdb]) ARGS[command] = 1;

export class Sh1106 implements I2cDevice, OledController {
  readonly address: number;
  readonly glass = 64 as const;
  /** Display RAM, page-major: byte page*132 + column, bit 0 = the page's top row. */
  readonly ram = new Uint8Array(COLUMNS * PAGES);
  /** Glass row (from the top) → the RAM row it shows, −1 dark. */
  readonly rowMap = new Int8Array(64);
  displayOn = false;
  dcdc = true;
  invert = false;
  allOn = false;
  contrast = 0x80;
  col = 0;
  page = 0;
  segmentRemap = false;
  comReversed = false;
  startLine = 0;
  offset = 0;
  multiplex = 63;
  comAlternative = true;
  /** Read-modify-write's column, −1 outside it. */
  rmwColumn = -1;
  imageDirty = true;
  private expectControl = true;
  private single = false;
  private data = false;
  private command = -1;
  private readonly changed: () => void;

  constructor(address: number, changed: () => void) {
    this.address = address;
    this.changed = changed;
    this.remap();
  }

  get lit(): boolean {
    return this.displayOn && this.dcdc;
  }

  reset(): void {
    this.ram.fill(0);
    this.displayOn = false;
    this.dcdc = true;
    this.invert = false;
    this.allOn = false;
    this.contrast = 0x80;
    this.col = 0;
    this.page = 0;
    this.segmentRemap = false;
    this.comReversed = false;
    this.startLine = 0;
    this.offset = 0;
    this.multiplex = 63;
    this.comAlternative = true;
    this.rmwColumn = -1;
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

  /** One RAM byte at the page and column; the column counts up to 131 and stays. */
  dataByte(byte: number): void {
    const index = this.page * COLUMNS + this.col;
    if (this.ram[index] !== byte) {
      this.ram[index] = byte;
      if (this.col >= FIRST && this.col < FIRST + 128) {
        this.imageDirty = true;
        this.changed();
      }
    }
    if (this.col < COLUMNS - 1) this.col++;
  }

  /** One command byte: a command or the argument of one. */
  commandByte(byte: number): void {
    if (this.command >= 0) {
      const command = this.command;
      this.command = -1;
      this.withArg(command, byte);
      return;
    }
    if (ARGS[byte] > 0) {
      this.command = byte;
      return;
    }
    if (byte <= 0x0f) this.col = Math.min(COLUMNS - 1, (this.col & 0xf0) | byte);
    else if (byte <= 0x1f) this.col = Math.min(COLUMNS - 1, ((byte & 0x0f) << 4) | (this.col & 0x0f));
    else if (byte >= 0x40 && byte <= 0x7f) this.setMapping('startLine', byte & 0x3f);
    else if (byte >= 0xb0 && byte <= 0xb7) this.page = byte & 0x07;
    else if (byte === 0xae || byte === 0xaf) this.setView('displayOn', byte === 0xaf);
    else if (byte === 0xa4 || byte === 0xa5) this.setView('allOn', byte === 0xa5);
    else if (byte === 0xa6 || byte === 0xa7) this.setView('invert', byte === 0xa7);
    else if (byte === 0xa0 || byte === 0xa1) this.setMapping('segmentRemap', byte === 0xa1);
    else if (byte >= 0xc0 && byte <= 0xcf) this.setMapping('comReversed', (byte & 0x08) !== 0);
    else if (byte === 0xe0) this.rmwColumn = this.col;
    else if (byte === 0xee) {
      if (this.rmwColumn >= 0) this.col = this.rmwColumn;
      this.rmwColumn = -1;
    }
    // 30h–33h (pump voltage), E3h (NOP) and anything unlisted: no visible effect.
  }

  private withArg(command: number, a: number): void {
    switch (command) {
      case 0x81:
        if (a !== this.contrast) {
          this.contrast = a;
          this.changed();
        }
        return;
      case 0xad:
        if ((a & 0xfe) === 0x8a) this.setView('dcdc', (a & 1) === 1);
        return;
      case 0xd3:
        this.setMapping('offset', a & 0x3f);
        return;
      case 0xa8:
        this.setMapping('multiplex', a & 0x3f);
        return;
      case 0xda:
        this.setMapping('comAlternative', (a & 0x10) !== 0);
        return;
      default:
      // D5h, D9h, DBh: timing and levels, no visible effect.
    }
  }

  private setView(key: 'displayOn' | 'dcdc' | 'allOn' | 'invert', value: boolean): void {
    if (this[key] === value) return;
    this[key] = value;
    this.changed();
  }

  private setMapping(key: 'startLine' | 'offset' | 'multiplex' | 'segmentRemap' | 'comReversed' | 'comAlternative', value: number | boolean): void {
    if (this[key] === value) return;
    (this as Record<typeof key, number | boolean>)[key] = value;
    this.remap();
    this.changed();
  }

  /** Rebuilds `rowMap` as the SSD1306 does (the same pads, no left/right remap). */
  private remap(): void {
    const n = this.multiplex + 1;
    for (let y = 0; y < 64; y++) {
      const line = 63 - y;
      const pad = (line & 1) === 0 ? line >> 1 : 32 + (line >> 1);
      const slot = scanSlot(scanIndex(pad, this.comAlternative, false), this.comReversed, this.offset, n);
      this.rowMap[y] = slot < 0 ? -1 : (slot + this.startLine) & 63;
    }
    this.imageDirty = true;
  }

  /** Packs the 128×64 glass into `fb` (256 numbers, 4 page-major bytes each). */
  packImage(fb: number[]): void {
    fb.fill(0);
    for (let y = 0; y < 64; y++) {
      const row = this.rowMap[y];
      if (row < 0) continue;
      const sourceBase = (row >> 3) * COLUMNS;
      const sourceBit = row & 7;
      const targetBase = (y >> 3) * 128;
      const targetBit = y & 7;
      for (let x = 0; x < 128; x++) {
        const source = this.segmentRemap ? x + FIRST : FIRST + 127 - x;
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
