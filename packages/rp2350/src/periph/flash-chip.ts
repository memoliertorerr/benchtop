/**
 * The Pico 2's QSPI flash as QMI's direct mode talks to it (BT65): a W25Q32-class SPI NOR, 4 MB, in
 * the byte-level view the direct mode gives — each byte clocked out gets the byte the chip drives
 * back (single-line full duplex; on dual/quad lines a byte is either out or in, which the same
 * stream covers). A transaction runs from chip select asserted to released.
 *
 *   9F JEDEC ID (EF 40 16)   4B unique ID (4 dummy, 8 bytes)   AB release power-down (3 dummy, id)
 *   05/35/15 status 1/2/3    01 (1–2 bytes) / 31 / 11 write status (after 06 or 50)
 *   06 write enable          04 write disable                 50 volatile status write enable
 *   03 read                  0B fast read (1 dummy)           3B/6B dual/quad output (1 dummy)
 *   BB dual I/O (mode byte)  EB quad I/O (mode byte + 2 dummy; mode 0xAx: continuous read, the next
 *                            transaction starts at its address — until a 0xFF first byte)
 *   02/32 page program (ANDs bits, wraps in its 256-byte page)
 *   20/52/D8 4/32/64 KB erase, 60/C7 chip erase (0xFF), each after 06
 *   66 99 reset; B9 power down; FF exits continuous read; anything else is ignored
 *
 * Program and erase finish at once (status WIP never reads 1): their real durations would only
 * make the bootrom poll longer. `onChange(start, end)` tells the SoC which bytes changed.
 */

const CMD_NONE = -1;

export class FlashChip {
  readonly data: Uint8Array;
  onChange: ((start: number, end: number) => void) | null = null;
  private status1 = 0;
  private status2 = 0x02; // QE set: the Pico 2's flash runs quad reads
  private status3 = 0x60;
  private writeEnabled = false;
  private continuous = false;
  // The transaction in progress
  private selected = false;
  private cmd = CMD_NONE;
  private index = 0;
  private address = 0;
  private readonly page = new Uint8Array(256);
  private pageLength = 0;
  private readonly statusWrite: number[] = [];

  constructor(data: Uint8Array) {
    this.data = data;
  }

  reset(): void {
    this.status1 = 0;
    this.writeEnabled = false;
    this.continuous = false;
    this.selected = false;
    this.cmd = CMD_NONE;
  }

  /** Chip select asserted (a transaction in progress). */
  get isSelected(): boolean {
    return this.selected;
  }

  select(): void {
    if (this.selected) return;
    this.selected = true;
    this.cmd = this.continuous ? 0xeb : CMD_NONE;
    this.index = this.continuous ? 1 : 0; // continuous read: the address comes first
    this.address = 0;
    this.pageLength = 0;
    this.statusWrite.length = 0;
  }

  deselect(): void {
    if (!this.selected) return;
    this.selected = false;
    this.finish();
    this.cmd = CMD_NONE;
  }

  /** One byte clocked out by the host; returns the byte the chip drives meanwhile. */
  exchange(out: number): number {
    if (!this.selected) return 0xff;
    const b = out & 0xff;
    if (this.cmd === CMD_NONE) {
      this.cmd = b;
      this.index = 1;
      if (b === 0x06) this.writeEnabled = true;
      else if (b === 0x04) this.writeEnabled = false;
      else if (b === 0xff) this.continuous = false;
      return 0xff;
    }
    const i = this.index++;
    switch (this.cmd) {
      case 0x9f:
        return [0xef, 0x40, 0x16][i - 1] ?? 0xff;
      case 0x4b:
        return i <= 4 ? 0xff : [0xe6, 0x63, 0x5c, 0x01, 0x23, 0x45, 0x67, 0x89][(i - 5) & 7];
      case 0xab:
        return i <= 3 ? 0xff : 0x15;
      case 0x05:
        return this.status1 | (this.writeEnabled ? 2 : 0);
      case 0x35:
        return this.status2;
      case 0x15:
        return this.status3;
      case 0x01:
      case 0x31:
      case 0x11:
        this.statusWrite.push(b);
        return 0xff;
      case 0x03:
      case 0x0b:
      case 0x3b:
      case 0x6b:
        return this.readPhase(b, i, this.cmd === 0x03 ? 0 : 1);
      case 0xbb:
        return this.readPhase(b, i, 1, true);
      case 0xeb:
        return this.readPhase(b, i, 3, true);
      case 0x02:
      case 0x32:
        if (i <= 3) this.address = ((this.address << 8) | b) & 0xffffff;
        else if (this.pageLength < 256) this.page[this.pageLength++] = b;
        return 0xff;
      case 0x20:
      case 0x52:
      case 0xd8:
        if (i <= 3) this.address = ((this.address << 8) | b) & 0xffffff;
        return 0xff;
      default:
        return 0xff;
    }
  }

  /**
   * A read's address bytes, then `dummies` bytes (a mode byte first when `mode`), then data from
   * the address on (wrapping at the end of the chip).
   */
  private readPhase(b: number, i: number, dummies: number, mode = false): number {
    if (i <= 3) {
      this.address = ((this.address << 8) | b) & 0xffffff;
      return 0xff;
    }
    if (i <= 3 + dummies) {
      if (mode && i === 4) this.continuous = (b & 0xf0) === 0xa0;
      return 0xff;
    }
    const value = this.data[this.address % this.data.length];
    this.address = (this.address + 1) % this.data.length;
    return value;
  }

  /** At chip deselect: the command takes effect. */
  private finish(): void {
    switch (this.cmd) {
      case 0x01:
      case 0x31:
      case 0x11:
        if (this.writeEnabled || this.statusWrite.length > 0) {
          if (this.cmd === 0x01) {
            if (this.statusWrite.length > 1) this.status2 = this.statusWrite[1];
          } else if (this.cmd === 0x31) this.status2 = this.statusWrite[0] ?? this.status2;
          else this.status3 = this.statusWrite[0] ?? this.status3;
          this.writeEnabled = false;
        }
        break;
      case 0x02:
      case 0x32:
        if (this.writeEnabled && this.pageLength > 0) {
          const pageBase = this.address & ~0xff;
          let lo = Infinity;
          let hi = -1;
          for (let k = 0; k < this.pageLength; k++) {
            const at = (pageBase + (((this.address & 0xff) + k) & 0xff)) % this.data.length;
            this.data[at] &= this.page[k];
            lo = Math.min(lo, at);
            hi = Math.max(hi, at + 1);
          }
          this.onChange?.(lo, hi);
        }
        this.writeEnabled = false;
        break;
      case 0x20:
      case 0x52:
      case 0xd8:
      case 0x60:
      case 0xc7:
        if (this.writeEnabled) {
          const size = this.cmd === 0x20 ? 0x1000 : this.cmd === 0x52 ? 0x8000 : this.cmd === 0xd8 ? 0x10000 : this.data.length;
          const start = this.cmd === 0x60 || this.cmd === 0xc7 ? 0 : (this.address & ~(size - 1)) % this.data.length;
          this.data.fill(0xff, start, Math.min(this.data.length, start + size));
          this.onChange?.(start, Math.min(this.data.length, start + size));
        }
        this.writeEnabled = false;
        break;
      case 0x99:
        this.reset();
        break;
    }
  }
}
