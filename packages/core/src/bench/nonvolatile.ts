/**
 * A board's non-volatile memory (BT118): the AVRs' EEPROM, the ESP32s' and Picos' SPI flash — what
 * the firmware keeps across resets and uploads, for the hosts to save with a project, show and
 * erase. Not a contract: an MCU that has such memory opts in with `nonVolatile()`, found by
 * `usesNonVolatile`, as `usesWifi` and `usesSymbols` find theirs.
 *
 * The memory behaves as the chip's does: every reset keeps it; a firmware load writes only what an
 * upload writes (the MCU's own business). Program sectors — those a load wrote since the memory
 * was made — are the program's, not the board's data: snapshots leave them out, `restore` and
 * `erase` don't touch them.
 */

export type NvKind = 'eeprom' | 'flash';

/** One sector's bytes at its offset in the memory. */
export interface NvSector {
  readonly offset: number;
  readonly bytes: Uint8Array;
}

export interface NvMemory {
  readonly kind: NvKind;
  /** Bytes in all. */
  readonly size: number;
  /** The unit snapshots and `restore` work in (4 KB for flash, smaller for an EEPROM). */
  readonly sectorSize: number;
  /** The data sectors holding anything but the erased value (0xFF), in address order: copies. */
  snapshot(): NvSector[];
  /**
   * Puts a saved snapshot back: every data sector erased, then `sectors` written. Untrusted input
   * (a host's store): a sector off the memory, misaligned or of the wrong size is skipped, as is one
   * over the program. Restore before the board runs, then reset it.
   */
  restore(sectors: readonly NvSector[]): number;
  /** Erases every data sector (the program stays). */
  erase(): void;
  /** A copy of `length` bytes from `offset` (clipped to the memory). */
  read(offset: number, length: number): Uint8Array;
}

/** An MCU with non-volatile memory; null while it has none to keep (a MicroPython sketch starts fresh). */
export interface NonVolatile {
  nonVolatile(): NvMemory | null;
}

export function usesNonVolatile(mcu: object): mcu is NonVolatile {
  return typeof (mcu as Partial<NonVolatile>).nonVolatile === 'function';
}

const ERASED = 0xff;

/**
 * NvMemory over a byte array the MCU owns (read through `bytes()`, since a chip may swap the
 * array it reads for a new one), with the program's sectors marked by the loads.
 */
export class SectorMemory implements NvMemory {
  readonly kind: NvKind;
  readonly sectorSize: number;
  private readonly bytes: () => Uint8Array;
  /** Sector indexes a load wrote: the program's. */
  private readonly program = new Set<number>();
  /** Runs after the bytes changed from outside the chip (`restore`, `erase`): caches to drop. */
  private readonly changed: () => void;

  constructor(kind: NvKind, sectorSize: number, bytes: () => Uint8Array, changed: () => void = () => {}) {
    this.kind = kind;
    this.sectorSize = sectorSize;
    this.bytes = bytes;
    this.changed = changed;
  }

  get size(): number {
    return this.bytes().length;
  }

  /** A load wrote [offset, offset + length): those sectors are the program's from now on. */
  markProgram(offset: number, length: number): void {
    if (length <= 0) return;
    const first = Math.floor(offset / this.sectorSize);
    const last = Math.floor((offset + length - 1) / this.sectorSize);
    for (let s = first; s <= last; s++) this.program.add(s);
  }

  /** Erases [offset, offset + length) rounded out to whole sectors, as a flash erase before programming. */
  eraseSectors(offset: number, length: number): void {
    if (length <= 0) return;
    const bytes = this.bytes();
    const start = Math.max(0, Math.floor(offset / this.sectorSize) * this.sectorSize);
    const end = Math.min(bytes.length, Math.ceil((offset + length) / this.sectorSize) * this.sectorSize);
    if (end > start) bytes.fill(ERASED, start, end);
  }

  isProgram(sector: number): boolean {
    return this.program.has(sector);
  }

  snapshot(): NvSector[] {
    const bytes = this.bytes();
    const out: NvSector[] = [];
    for (let offset = 0; offset < bytes.length; offset += this.sectorSize) {
      if (this.program.has(offset / this.sectorSize)) continue;
      const end = Math.min(bytes.length, offset + this.sectorSize);
      let blank = true;
      for (let i = offset; i < end; i++) {
        if (bytes[i] !== ERASED) {
          blank = false;
          break;
        }
      }
      if (!blank) out.push({ offset, bytes: bytes.slice(offset, end) });
    }
    return out;
  }

  restore(sectors: readonly NvSector[]): number {
    this.eraseData();
    const bytes = this.bytes();
    let written = 0;
    for (const sector of sectors) {
      const { offset, bytes: data } = sector;
      if (!Number.isInteger(offset) || offset < 0 || offset % this.sectorSize !== 0 || !(data instanceof Uint8Array)) continue;
      if (data.length !== Math.min(this.sectorSize, bytes.length - offset) || offset + data.length > bytes.length) continue;
      if (this.program.has(offset / this.sectorSize)) continue;
      bytes.set(data, offset);
      written++;
    }
    this.changed();
    return written;
  }

  erase(): void {
    this.eraseData();
    this.changed();
  }

  read(offset: number, length: number): Uint8Array {
    const bytes = this.bytes();
    const start = Math.max(0, Math.min(bytes.length, Math.floor(offset)));
    const end = Math.max(start, Math.min(bytes.length, start + Math.max(0, Math.floor(length))));
    return bytes.slice(start, end);
  }

  private eraseData(): void {
    const bytes = this.bytes();
    for (let offset = 0; offset < bytes.length; offset += this.sectorSize) {
      if (!this.program.has(offset / this.sectorSize)) bytes.fill(ERASED, offset, Math.min(bytes.length, offset + this.sectorSize));
    }
  }
}
