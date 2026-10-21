/**
 * The SPI flash chip (BT32): a Winbond-style 4 MB part, JEDEC ID EF 40 16, over the bytes the
 * cache also reads (EspMemory.flash). Status register: WIP (bit 0), WEL (bit 1), QE (bit 9 —
 * status register 2 bit 1); program and erase need WEL and clear it. Program ANDs bits within one
 * 256-byte page (the address wraps inside the page, as the datasheet says); erase sets 4 KB
 * (0x20), 32 KB (0x52), 64 KB (0xD8) or the whole chip (0xC7/0x60) to 0xFF.
 *
 * Timing: every command completes at once — WIP never reads 1. Real erase and program times
 * (tens of ms) would stretch only flash-writing code (NVS formatting at first boot); nothing in
 * the fixtures depends on them. Recorded in ARCHITECTURE.md.
 */

import type { ProblemLog } from './periph.ts';

export const JEDEC_ID = [0xef, 0x40, 0x16] as const;

/**
 * Reference cycles (240 MHz) one 32-byte cache block fill takes over SPI (BT33), from the app
 * image header's flash mode (0 QIO, 1 QOUT, 2 DIO, 3 DOUT — esptool's numbering) and frequency
 * nibble (0: 40 MHz, 1: 26.7 MHz, 2: 20 MHz, 15: 80 MHz), counting SPI clocks of the standard
 * NOR read commands (Winbond W25Q32 datasheet): QIO 0xEB = 8 command + 6 address + 2 mode + 4
 * dummy + 64 data; QOUT 0x6B = 8 + 24 + 8 dummy + 64; DIO 0xBB = 8 + 12 + 4 mode + 128; DOUT 0x3B
 * = 8 + 24 + 8 + 128. Controller overhead isn't counted. Arduino's ESP32 builds are DIO at 80 MHz:
 * 152 clocks = 1.9 µs.
 */
export function cacheFillTime(mode: number, speed: number): number {
  const clocks = [84, 104, 152, 168][mode] ?? 152;
  const refPerClock = speed === 15 ? 3 : speed === 1 ? 9 : speed === 2 ? 12 : 6;
  return clocks * refPerClock;
}
const WIP = 1;
const WEL = 2;

export class FlashChip {
  status = 0;
  private readonly bytesOf: () => Uint8Array;
  private readonly problems: ProblemLog;
  /** Bytes written / erased since construction (for reports). */
  programmed = 0;
  erased = 0;
  /** Flash [start, end) changed (BT37: the SoC drops predecoded code mapped there). */
  onWrite: ((start: number, end: number) => void) | null = null;

  /** `bytes` returns the current flash array (the SoC may replace it). */
  constructor(bytes: () => Uint8Array, problems: ProblemLog) {
    this.bytesOf = bytes;
    this.problems = problems;
  }

  get size(): number {
    return this.bytesOf().length;
  }

  read(address: number, out: Uint8Array, length: number): void {
    const flash = this.bytesOf();
    for (let i = 0; i < length; i++) out[i] = flash[(address + i) % flash.length];
  }

  writeEnable(on: boolean): void {
    this.status = on ? this.status | WEL : this.status & ~WEL;
  }

  writeStatus(value: number, bits: number): void {
    if ((this.status & WEL) === 0) return;
    const mask = bits >= 16 ? 0xfffc : 0x00fc; // WIP and WEL are read-only
    this.status = ((this.status & ~mask) | (value & mask)) & ~WEL;
  }

  program(address: number, data: Uint8Array, length: number): void {
    if ((this.status & WEL) === 0) return;
    const flash = this.bytesOf();
    const page = address & ~0xff;
    for (let i = 0; i < length; i++) {
      const a = (page + ((address + i) & 0xff)) % flash.length;
      flash[a] &= data[i];
    }
    this.onWrite?.(page % flash.length, (page % flash.length) + 0x100);
    this.programmed += length;
    this.status &= ~(WEL | WIP);
  }

  erase(address: number, size: number): void {
    if ((this.status & WEL) === 0) return;
    const flash = this.bytesOf();
    const start = size >= flash.length ? 0 : (address & ~(size - 1)) % flash.length;
    flash.fill(0xff, start, Math.min(start + size, flash.length));
    this.onWrite?.(start, Math.min(start + size, flash.length));
    this.erased += size;
    this.status &= ~(WEL | WIP);
  }

  /**
   * A generic SPI transaction: `command`, the address phase's 24-bit address, the MOSI bytes;
   * fills `miso` (length `misoLength`). Returns false for an opcode the model doesn't know (the
   * MISO bytes are then 0xFF).
   */
  transaction(command: number, address: number, mosi: Uint8Array, mosiLength: number, miso: Uint8Array, misoLength: number): boolean {
    miso.fill(0xff, 0, misoLength);
    switch (command) {
      case 0x03: // READ
      case 0x0b: // FAST_READ
      case 0x3b: // dual output
      case 0xbb: // dual I/O
      case 0x6b: // quad output
      case 0xeb: // quad I/O
        this.read(address, miso, misoLength);
        return true;
      case 0x05: // RDSR
        for (let i = 0; i < misoLength; i++) miso[i] = this.status & 0xff;
        return true;
      case 0x35: // RDSR2
        for (let i = 0; i < misoLength; i++) miso[i] = (this.status >>> 8) & 0xff;
        return true;
      case 0x15: // RDSR3
        for (let i = 0; i < misoLength; i++) miso[i] = 0;
        return true;
      case 0x01: // WRSR (8 or 16 bits)
        this.writeStatus(mosi[0] | (mosiLength > 1 ? mosi[1] << 8 : this.status & 0xff00), mosiLength > 1 ? 16 : 8);
        return true;
      case 0x31: // WRSR2
        this.writeStatus((this.status & 0xff) | (mosi[0] << 8), 16);
        return true;
      case 0x06:
        this.writeEnable(true);
        return true;
      case 0x04:
        this.writeEnable(false);
        return true;
      case 0x9f: // RDID
        for (let i = 0; i < misoLength; i++) miso[i] = i < 3 ? JEDEC_ID[i] : 0;
        return true;
      case 0x02: // PP
        this.program(address, mosi, mosiLength);
        return true;
      case 0x20:
        this.erase(address, 0x1000);
        return true;
      case 0x52:
        this.erase(address, 0x8000);
        return true;
      case 0xd8:
        this.erase(address, 0x10000);
        return true;
      case 0xc7:
      case 0x60:
        this.erase(0, this.size);
        return true;
      case 0xab: // release power-down / device ID
        for (let i = 0; i < misoLength; i++) miso[i] = 0x15;
        return true;
      case 0x4b: // unique ID
        for (let i = 0; i < misoLength; i++) miso[i] = 0x42 + i;
        return true;
      case 0xb9: // power down
      case 0x66: // reset enable
      case 0x99: // reset
      case 0xa3: // high-performance mode
      case 0x75: // suspend
      case 0x7a: // resume
      case 0xff: // continuous-read reset
        return true;
      default:
        this.problems.report('warning', 'esp32-flash-command', command, `SPI flash command 0x${command.toString(16).padStart(2, '0')} is not modeled (reads 0xFF)`);
        return false;
    }
  }
}
