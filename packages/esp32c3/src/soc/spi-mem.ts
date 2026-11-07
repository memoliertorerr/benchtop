/**
 * The ESP32-C3's SPI0/SPI1 memory controllers and the flash chip behind them (BT92;
 * spi_mem_reg.h). SPI0 (0x60003000) serves the cache: its registers only configure timing, so
 * they read back. SPI1 (0x60002000) runs the commands software issues:
 *   - user commands — CMD.USR: USER2's command (USER.USR_COMMAND), ADDR (USR_ADDR, right-aligned
 *     in USER1.USR_ADDR_BITLEN + 1 bits), MOSI_DLEN + 1 bits out of W0–W15 (USR_MOSI) or
 *     MISO_DLEN + 1 bits into them (USR_MISO);
 *   - the direct ones the ROM's esp_rom_spiflash_* use — CMD.FLASH_READ/WREN/WRDI/RDID/RDSR/WRSR/
 *     PP/SE/BE/CE/PE, with ADDR's low 24 bits as the address and, for PP, bits 31:24 as the
 *     length; RDSR answers in RD_STATUS.
 * Every command completes at once (its CMD bit reads 0). The flash: a 4 MB GigaDevice-style part
 * (JEDEC C8 40 16), three status registers (SR1's WEL — WIP never reads 1 —; SR2's QE, which
 * esp_flash sets for QIO and reads back; SR3), written by WRSR (one or two bytes), WRSR2 and
 * WRSR3 after a write enable, 256-byte pages, 4 KB sectors, 64 KB blocks;
 * program ANDs (bits only go 1 → 0), erase sets 0xFF; `onWrite` hears every change (the bus drops
 * predecoded code there).
 */

import type { Peripheral } from '@benchtop/esp32';
import { registerDefault } from './periph.ts';

export const SPI1_BASE = 0x60002000;
export const SPI0_BASE = 0x60003000;
export const JEDEC_ID = [0xc8, 0x40, 0x16] as const;

const CMD = 0x000;
const ADDR = 0x004;
const USER = 0x018;
const USER1 = 0x01c;
const USER2 = 0x020;
const MOSI_DLEN = 0x024;
const MISO_DLEN = 0x028;
const RD_STATUS = 0x02c;
const W0 = 0x058;

const FLASH_READ = 1 << 31;
const FLASH_WREN = 1 << 30;
const FLASH_WRDI = 1 << 29;
const FLASH_RDID = 1 << 28;
const FLASH_RDSR = 1 << 27;
const FLASH_WRSR = 1 << 26;
const FLASH_PP = 1 << 25;
const FLASH_SE = 1 << 24;
const FLASH_BE = 1 << 23;
const FLASH_CE = 1 << 22;
const USR = 1 << 18;
const FLASH_PE = 1 << 17;
const USR_COMMAND = 1 << 31;
const USR_ADDR = 1 << 30;
const USR_MISO = 1 << 28;
const USR_MOSI = 1 << 27;
const WEL = 2;

export class FlashChip {
  data: Uint8Array;
  /** SR1 (bits 7:0), SR2 (15:8), SR3 (23:16). */
  status = 0;
  onWrite: ((offset: number, length: number) => void) | null = null;

  constructor(size: number) {
    this.data = new Uint8Array(size).fill(0xff);
  }

  /** Whether a program/erase is allowed (WEL set), consuming WEL. */
  private take(): boolean {
    if ((this.status & WEL) === 0) return false;
    this.status &= ~WEL;
    return true;
  }

  program(address: number, bytes: Uint8Array): void {
    if (!this.take()) return;
    const page = address & ~0xff;
    for (let i = 0; i < bytes.length; i++) {
      const a = page + (((address & 0xff) + i) & 0xff); // wraps within the page, as the chip does
      if (a < this.data.length) this.data[a] &= bytes[i];
    }
    this.onWrite?.(page, 256);
  }

  erase(address: number, size: number): void {
    if (!this.take()) return;
    const start = address & ~(size - 1);
    if (start >= this.data.length) return;
    this.data.fill(0xff, start, Math.min(this.data.length, start + size));
    this.onWrite?.(start, size);
  }

  eraseAll(): void {
    if (!this.take()) return;
    this.data.fill(0xff);
    this.onWrite?.(0, this.data.length);
  }

  writeEnable(on: boolean): void {
    this.status = on ? this.status | WEL : this.status & ~WEL;
  }

  /** Writes status register `index` (0–2) — needs WEL, which it consumes; SR1's WIP/WEL aren't writable. */
  writeStatus(index: number, value: number): void {
    if (!this.take()) return;
    const shift = index * 8;
    const keep = index === 0 ? 3 : 0;
    const old = (this.status >>> shift) & 0xff;
    const byte = (value & ~keep & 0xff) | (old & keep);
    this.status = (this.status & ~(0xff << shift)) | (byte << shift);
  }
}

export class SpiMem implements Peripheral {
  private readonly regs = new Uint32Array(1024);
  private readonly base: number;
  private readonly flash: FlashChip | null;
  private readonly buffer = new Uint8Array(64);

  /** BT124: the chip's register defaults (the S3 passes its own). */
  private readonly defaults: (address: number) => number;

  /** `flash` null: SPI0 (the cache's controller — configuration only). */
  constructor(base: number, flash: FlashChip | null, defaults: (address: number) => number = registerDefault) {
    this.base = base;
    this.flash = flash;
    this.defaults = defaults;
    this.systemReset();
  }

  systemReset(): void {
    for (let i = 0; i < this.regs.length; i++) this.regs[i] = this.defaults(this.base + i * 4);
  }

  read32(offset: number): number {
    return this.regs[offset >>> 2];
  }

  write32(offset: number, value: number): void {
    this.regs[offset >>> 2] = value;
    if (offset !== CMD || this.flash === null) return;
    const flash = this.flash;
    const addr = this.regs[ADDR >>> 2];
    if ((value & USR) !== 0) this.user();
    else if ((value & FLASH_READ) !== 0) this.readInto(addr & 0xffffff, Math.min(64, (((this.regs[MISO_DLEN >>> 2] & 0x3ff) + 1) >>> 3) || 4));
    else if ((value & FLASH_WREN) !== 0) flash.writeEnable(true);
    else if ((value & FLASH_WRDI) !== 0) flash.writeEnable(false);
    else if ((value & FLASH_RDID) !== 0) this.regs[W0 >>> 2] = JEDEC_ID[0] | (JEDEC_ID[1] << 8) | (JEDEC_ID[2] << 16);
    else if ((value & FLASH_RDSR) !== 0) this.regs[RD_STATUS >>> 2] = (this.regs[RD_STATUS >>> 2] & ~0xffff) | flash.status;
    else if ((value & FLASH_WRSR) !== 0) {
      const v = this.regs[RD_STATUS >>> 2];
      flash.writeStatus(0, v & 0xff);
      flash.writeEnable(true);
      flash.writeStatus(1, (v >>> 8) & 0xff);
    }
    else if ((value & FLASH_PP) !== 0) this.programFrom(addr & 0xffffff, addr >>> 24);
    else if ((value & FLASH_SE) !== 0) flash.erase(addr & 0xffffff, 0x1000);
    else if ((value & FLASH_BE) !== 0) flash.erase(addr & 0xffffff, 0x10000);
    else if ((value & FLASH_CE) !== 0) flash.eraseAll();
    else if ((value & FLASH_PE) !== 0) flash.erase(addr & 0xffffff, 0x100);
    this.regs[CMD >>> 2] = 0;
  }

  /** W0–W15 as bytes (little-endian words). */
  private wBytes(count: number): Uint8Array {
    for (let i = 0; i < count; i++) this.buffer[i] = (this.regs[(W0 >>> 2) + (i >>> 2)] >>> ((i & 3) * 8)) & 0xff;
    return this.buffer.subarray(0, count);
  }

  private wStore(bytes: ArrayLike<number>, count: number): void {
    for (let w = 0; w < 16; w++) this.regs[(W0 >>> 2) + w] = 0;
    for (let i = 0; i < count; i++) this.regs[(W0 >>> 2) + (i >>> 2)] |= (bytes[i] ?? 0) << ((i & 3) * 8);
  }

  private readInto(address: number, count: number): void {
    const flash = this.flash as FlashChip;
    for (let i = 0; i < count; i++) this.buffer[i] = flash.data[(address + i) % flash.data.length];
    this.wStore(this.buffer, count);
  }

  private programFrom(address: number, count: number): void {
    (this.flash as FlashChip).program(address, this.wBytes(Math.min(count || 32, 64)).slice());
  }

  private user(): void {
    const flash = this.flash as FlashChip;
    const user = this.regs[USER >>> 2];
    const command = (user & USR_COMMAND) !== 0 ? this.regs[USER2 >>> 2] & 0xffff : -1;
    const addrBits = ((this.regs[USER1 >>> 2] >>> 26) & 0x3f) + 1;
    const rawAddr = (user & USR_ADDR) !== 0 ? this.regs[ADDR >>> 2] : 0;
    const address = addrBits >= 32 ? rawAddr >>> 0 : rawAddr & (2 ** addrBits - 1);
    const misoBytes = (user & USR_MISO) !== 0 ? Math.min(64, ((this.regs[MISO_DLEN >>> 2] & 0x3ff) + 8) >>> 3) : 0;
    const mosiBytes = (user & USR_MOSI) !== 0 ? Math.min(64, ((this.regs[MOSI_DLEN >>> 2] & 0x3ff) + 8) >>> 3) : 0;
    const out = this.buffer;
    switch (command) {
      case 0x9f: // RDID
        this.wStore(JEDEC_ID, 3);
        return;
      case 0x05: // RDSR
        this.wStore([flash.status & 0xff, 0, 0, 0], 4);
        return;
      case 0x35: // RDSR2
        this.wStore([(flash.status >>> 8) & 0xff, 0, 0, 0], 4);
        return;
      case 0x15: // RDSR3
        this.wStore([(flash.status >>> 16) & 0xff, 0, 0, 0], 4);
        return;
      case 0x06:
        flash.writeEnable(true);
        return;
      case 0x04:
        flash.writeEnable(false);
        return;
      case 0x01: {
        // WRSR: SR1, and SR2 when two bytes go out
        const data = this.wBytes(Math.max(1, mosiBytes));
        const two = mosiBytes >= 2;
        const sr2 = data[1];
        flash.writeStatus(0, data[0]);
        if (two) {
          flash.writeEnable(true);
          flash.writeStatus(1, sr2);
        }
        return;
      }
      case 0x31:
        flash.writeStatus(1, this.wBytes(1)[0]);
        return;
      case 0x11:
        flash.writeStatus(2, this.wBytes(1)[0]);
        return;
      case 0x03:
      case 0x0b:
      case 0x3b:
      case 0x6b:
      case 0xbb:
      case 0xeb:
        this.readInto(address & 0xffffff, misoBytes);
        return;
      case 0x02: // page program
        flash.program(address & 0xffffff, this.wBytes(mosiBytes).slice());
        return;
      case 0x20:
        flash.erase(address & 0xffffff, 0x1000);
        return;
      case 0x52:
        flash.erase(address & 0xffffff, 0x8000);
        return;
      case 0xd8:
        flash.erase(address & 0xffffff, 0x10000);
        return;
      case 0x60:
      case 0xc7:
        flash.eraseAll();
        return;
      case 0x4b: // unique ID
        for (let i = 0; i < 8; i++) out[i] = 0xc3 + i;
        this.wStore(out, misoBytes || 8);
        return;
      case 0xab: // release from power-down: answers the device ID
        this.wStore([JEDEC_ID[2] - 1, 0, 0, 0], 4);
        return;
      default:
        // SFDP, reset, suspend/resume, power-down…: no data (MISO reads 0xFF).
        if (misoBytes > 0) this.wStore(new Uint8Array(misoBytes).fill(0xff), misoBytes);
    }
  }
}
