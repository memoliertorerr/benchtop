/**
 * HD44780 character-LCD controller, shared by every LCD part (parallel and I2C backpack).
 * DOM-free and allocation-free on the transfer path. From the Hitachi HD44780U datasheet:
 *
 * - DDRAM 80 bytes. With two lines (N=1) addresses are 0x00–0x27 (line 1) and 0x40–0x67
 *   (line 2); the address counter wraps 0x27→0x40 and 0x67→0x00. With one line, 0x00–0x4F.
 *   A 4-row display shows line 1 on rows 0 and 2 and line 2 on rows 1 and 3, so rows start at
 *   0x00, 0x40, 0x00+cols, 0x40+cols (0x14 and 0x54 on a 2004).
 * - CGRAM 64 bytes: eight 5×8 characters, codes 0–7 (and 8–15 mirror them).
 * - It powers up in 8-bit mode. A transfer latches on E's falling edge; `latch()` gets RS and
 *   the D7..D0 bus byte. In 4-bit mode only D7..D4 count and nibbles pair high-first.
 *   LiquidCrystal's init sends 0x3, 0x3, 0x3, 0x2 as single nibbles; in 8-bit mode those read
 *   as 0x30, 0x30, 0x30 (function set, 8-bit) and 0x20 (function set, 4-bit) with D3..D0
 *   unconnected (floating reads 0), so pairing starts right after the switch.
 *
 * Decided simplifications (in the plan's Later list): transfers with RW=1 (busy flag and DDRAM
 * reads) are ignored, and every instruction takes effect at once (no busy timing).
 */

const LINE = 40;
const DDRAM = 80;

export class Hd44780 {
  readonly cols: number;
  readonly rows: number;
  readonly ddram = new Uint8Array(DDRAM).fill(0x20);
  readonly cgram = new Uint8Array(64);
  /** Address counter: a DDRAM address (0x00–0x67) or, after Set CGRAM Address, 0x00–0x3F. */
  ac = 0;
  /** The address counter points into CGRAM. */
  cgramMode = false;
  /** Entry mode I/D: increment (true) or decrement. */
  increment = true;
  /** Entry mode S: the display shifts with each DDRAM write. */
  entryShift = false;
  displayOn = false;
  cursorOn = false;
  blinkOn = false;
  eightBit = true;
  twoLines = false;
  /** Display shift: positive = shifted left by that many columns (0..39). */
  shift = 0;
  /** Bumps whenever anything a view shows changes. */
  version = 0;
  private highNibble = -1;
  private highRs = false;

  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
  }

  /** Power-on state (datasheet "Initializing by Internal Reset Circuit"). */
  reset(): void {
    this.ddram.fill(0x20);
    this.cgram.fill(0);
    this.ac = 0;
    this.cgramMode = false;
    this.increment = true;
    this.entryShift = false;
    this.displayOn = false;
    this.cursorOn = false;
    this.blinkOn = false;
    this.eightBit = true;
    this.twoLines = false;
    this.shift = 0;
    this.highNibble = -1;
    this.version++;
  }

  /** E fell: RS (false = instruction, true = data) and the D7..D0 byte on the bus. */
  latch(rs: boolean, bus: number): void {
    if (this.eightBit) {
      this.execute(rs, bus & 0xff);
      return;
    }
    const nibble = (bus >> 4) & 0x0f;
    if (this.highNibble < 0) {
      this.highNibble = nibble;
      this.highRs = rs;
      return;
    }
    const byte = (this.highNibble << 4) | nibble;
    this.highNibble = -1;
    this.execute(this.highRs, byte);
  }

  /** One complete 8-bit instruction or data byte. */
  execute(rs: boolean, byte: number): void {
    if (rs) this.writeData(byte);
    else this.instruction(byte);
    this.version++;
  }

  private instruction(byte: number): void {
    if (byte & 0x80) {
      this.cgramMode = false;
      this.ac = byte & 0x7f;
    } else if (byte & 0x40) {
      this.cgramMode = true;
      this.ac = byte & 0x3f;
    } else if (byte & 0x20) {
      const eightBit = (byte & 0x10) !== 0;
      if (eightBit !== this.eightBit) this.highNibble = -1;
      this.eightBit = eightBit;
      this.twoLines = (byte & 0x08) !== 0;
    } else if (byte & 0x10) {
      const right = (byte & 0x04) !== 0;
      if (byte & 0x08) this.shiftDisplay(right ? -1 : 1);
      else this.moveAc(right);
    } else if (byte & 0x08) {
      this.displayOn = (byte & 0x04) !== 0;
      this.cursorOn = (byte & 0x02) !== 0;
      this.blinkOn = (byte & 0x01) !== 0;
    } else if (byte & 0x04) {
      this.increment = (byte & 0x02) !== 0;
      this.entryShift = (byte & 0x01) !== 0;
    } else if (byte & 0x02) {
      this.cgramMode = false;
      this.ac = 0;
      this.shift = 0;
    } else if (byte & 0x01) {
      this.ddram.fill(0x20);
      this.cgramMode = false;
      this.ac = 0;
      this.shift = 0;
      this.increment = true;
    }
  }

  private writeData(byte: number): void {
    if (this.cgramMode) {
      this.cgram[this.ac & 0x3f] = byte & 0x1f;
      this.ac = (this.ac + (this.increment ? 1 : -1)) & 0x3f;
      return;
    }
    this.ddram[this.index(this.ac)] = byte;
    this.moveAc(this.increment);
    // Entry shift: I/D=1 shifts the display left, I/D=0 right, so the cursor seems to stay.
    if (this.entryShift) this.shiftDisplay(this.increment ? 1 : -1);
  }

  private shiftDisplay(by: number): void {
    this.shift = (this.shift + by + LINE) % LINE;
  }

  /** Moves the address counter one step, wrapping as the datasheet describes. */
  private moveAc(up: boolean): void {
    if (this.cgramMode) {
      this.ac = (this.ac + (up ? 1 : -1)) & 0x3f;
      return;
    }
    if (!this.twoLines) {
      this.ac = (this.ac + (up ? 1 : DDRAM - 1)) % DDRAM;
      return;
    }
    const line2 = this.ac >= 0x40;
    const pos = (this.ac & 0x3f) % LINE;
    if (up) {
      if (pos < LINE - 1) this.ac = (line2 ? 0x40 : 0) + pos + 1;
      else this.ac = line2 ? 0x00 : 0x40;
    } else if (pos > 0) {
      this.ac = (line2 ? 0x40 : 0) + pos - 1;
    } else {
      this.ac = line2 ? 0x27 : 0x67;
    }
  }

  /** DDRAM byte index of an address. */
  private index(address: number): number {
    if (!this.twoLines) return address % DDRAM;
    return address >= 0x40 ? LINE + (((address - 0x40) % LINE) + LINE) % LINE : address % LINE;
  }

  /** The DDRAM address shown at (column, row) after display shift, or -1 if the row is dark. */
  addressAt(col: number, row: number): number {
    if (!this.twoLines) return row === 0 ? (col + this.shift) % DDRAM : -1;
    const base = row >= 2 ? this.cols : 0;
    const pos = (base + col + this.shift) % LINE;
    return (row & 1 ? 0x40 : 0) + pos;
  }

  /** Fills `out` (rows*cols) with the character codes shown, in display order. */
  characters(out: number[]): void {
    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        const address = this.addressAt(col, row);
        out[row * this.cols + col] = address < 0 ? 0x20 : this.ddram[this.index(address)];
      }
    }
  }

  /** Where the cursor is on screen, as [x, y]; [-1, -1] when off screen or in CGRAM mode. */
  cursorPosition(): [number, number] {
    if (!this.cgramMode) {
      for (let row = 0; row < this.rows; row++) {
        for (let col = 0; col < this.cols; col++) {
          if (this.addressAt(col, row) === this.ac) return [col, row];
        }
      }
    }
    return [-1, -1];
  }
}
