/**
 * The ESP32-S3's buses as each core sees them (BT124): XtensaBus for loads, stores and fetches,
 * and CodeBus for the predecode cache. As the ESP32's SocBus: a table of 64 KB pages, each a kind
 * (SRAM, ROM, flash — or 0: the slow path decides) and a base offset into its array, so a RAM,
 * ROM or mapped flash access is one lookup. Flash pages are armed on first touch through the MMU
 * table (extmem.ts) and disarmed when an entry changes.
 *
 * The slow path: RTC fast memory (0x600F_E000, both buses) and RTC slow memory (0x5000_0000),
 * SRAM1's first data page (0x3FC8_8000 starts mid-page), peripherals (a core yields — BUS_YIELD —
 * when the other core is behind it in time, so peripherals see accesses in time order; sub-word
 * accesses merge into their word), and unmapped addresses (LoadStoreError / InstrFetchError).
 *
 * BT130: PSRAM — an MMU entry with SPIRAM (bit 15) set arms its data-bus page (0x3C00_0000–
 * 0x3DFF_FFFF) on the PSRAM chip's bytes (psram.ts), read and written like SRAM. A data access in
 * 0x3D00_0000–0x3DFF_FFFF that no entry maps still reports `esp32s3-psram`. Instruction fetch from
 * PSRAM isn't modeled (Arduino's builds don't place code there).
 *
 * Not modeled (Deferred follow-ups): flash and PSRAM cache timing (the ESP32 stalls a core per
 * miss), region protection.
 */

import { BUS_YIELD, CODE_NONE, CODE_PLAIN, type CodeBus, EXCCAUSE, lengthOf, type ProblemLog, type XtensaBus, XtensaBusError, type XtensaCore } from '@benchtop/esp32';
import {
  DRAM_BASE,
  DRAM_END,
  DRAM_ORIGIN,
  DROM_BASE,
  DROM_FLASH_BASE,
  DROM_ROM_OFFSET,
  DROM_SIZE,
  FLASH_WINDOW,
  IRAM_BASE,
  IRAM_END,
  IROM_BASE,
  PERIPH_BASE,
  PERIPH_END,
  ROM_BASE,
  ROM_SIZE,
  RTC_FAST_BASE,
  RTC_FAST_SIZE,
  RTC_SLOW_BASE,
  RTC_SLOW_SIZE,
  type S3Memory,
} from './memory.ts';
import type { S3PeripheralMap } from './periph.ts';

const K_SRAM = 1;
const K_ROM = 2;
const K_FLASH = 3;
/** BT130: a PSRAM page on the data bus (an MMU entry with SPIRAM set). */
const K_PSRAM = 4;
const LOAD_STORE_ERROR = EXCCAUSE.LOAD_STORE_ERROR;
const FETCH_ERROR = EXCCAUSE.INSTRUCTION_FETCH_ERROR;
export const CODE_S3_PSRAM = 'esp32s3-psram';
export const CODE_S3_ROM_WRITE = 'esp32s3-rom-write';

/** What a bus shares with the SoC and the other core's bus. */
export interface S3BusParts {
  readonly memory: S3Memory;
  readonly periph: S3PeripheralMap;
  readonly problems: ProblemLog;
  /** The flash chip's bytes (replaced when its size changes). */
  flashBytes(): Uint8Array;
  /** The flash offset MMU entry `entry` maps (−1: invalid or PSRAM). */
  mmuPage(entry: number): number;
  /** BT130: the PSRAM offset MMU entry `entry` maps (−1: invalid or flash). */
  mmuPsramPage(entry: number): number;
  /** BT130: the PSRAM chip's bytes and words (allocated on first use). */
  psramBytes(): Uint8Array;
  psramWords(): Uint32Array;
  /** May CPU `cpu` touch a peripheral now (the other core isn't behind it)? */
  peripheralTurn(cpu: number): boolean;
  /** A store hit a 4 KB SRAM page holding predecoded code. */
  codeWritten(offset: number): void;
}

const hex = (v: number): string => `0x${(v >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;

export class S3Bus implements XtensaBus, CodeBus {
  readonly cpu: number;
  readonly kind = new Uint8Array(65536);
  readonly base = new Int32Array(65536);
  core: XtensaCore | null = null;
  /** Per 4 KB of SRAM: a predecode cache holds code from it. */
  readonly code = new Uint8Array(128);
  private readonly parts: S3BusParts;
  private readonly sram: Uint8Array;
  private readonly sramWords: Uint32Array;
  private readonly rom: Uint8Array;
  private readonly romWords: Uint32Array;
  private flash: Uint8Array;

  constructor(parts: S3BusParts, cpu: number) {
    this.parts = parts;
    this.cpu = cpu;
    this.sram = parts.memory.sram;
    this.sramWords = new Uint32Array(this.sram.buffer, this.sram.byteOffset, this.sram.length >>> 2);
    this.rom = parts.memory.rom;
    this.romWords = new Uint32Array(this.rom.buffer, this.rom.byteOffset, this.rom.length >>> 2);
    this.flash = parts.flashBytes();
    this.rebuild();
  }

  /** The static pages: SRAM on both buses, the ROM and its data view. Flash pages arm on use. */
  rebuild(): void {
    this.kind.fill(0);
    this.base.fill(0);
    for (let a = IRAM_BASE; a < IRAM_END; a += 0x10000) this.setPage(a, K_SRAM, a - IRAM_BASE);
    for (let a = DRAM_ORIGIN + 0x10000; a < DRAM_END; a += 0x10000) this.setPage(a, K_SRAM, a - DRAM_ORIGIN);
    for (let a = ROM_BASE; a < ROM_BASE + ROM_SIZE; a += 0x10000) this.setPage(a, K_ROM, a - ROM_BASE);
    for (let a = DROM_BASE; a < DROM_BASE + DROM_SIZE; a += 0x10000) this.setPage(a, K_ROM, DROM_ROM_OFFSET + (a - DROM_BASE));
    this.core?.icache.invalidateAll();
  }

  private setPage(a: number, k: number, offset: number): void {
    const p = a >>> 16;
    this.kind[p] = k;
    this.base[p] = offset;
  }

  /** MMU entry `entry` changed: both windows' pages for it are disarmed, the core's predecoded code there dropped. */
  mmuChanged(entry: number): void {
    this.kind[(IROM_BASE >>> 16) + entry] = 0;
    this.kind[(DROM_FLASH_BASE >>> 16) + entry] = 0;
    this.core?.icache.invalidateRange(IROM_BASE + entry * 0x10000, 0x10000);
  }

  /** Every flash page disarmed (new flash contents, an ICache invalidate). */
  invalidateFlash(): void {
    this.flash = this.parts.flashBytes();
    this.kind.fill(0, DROM_FLASH_BASE >>> 16, (DROM_FLASH_BASE + FLASH_WINDOW) >>> 16);
    this.kind.fill(0, IROM_BASE >>> 16, (IROM_BASE + FLASH_WINDOW) >>> 16);
    this.core?.icache.invalidateFlash();
  }

  // ── Fast paths ────────────────────────────────────────────────────────────────────────

  read8(addr: number): number {
    const a = addr >>> 0;
    const p = a >>> 16;
    const k = this.kind[p];
    if (k === K_SRAM) return this.sram[this.base[p] + (a & 0xffff)];
    if (k === K_ROM) return this.rom[this.base[p] + (a & 0xffff)];
    if (k === K_FLASH) return this.flash[this.base[p] + (a & 0xffff)];
    if (k === K_PSRAM) return this.parts.psramBytes()[this.base[p] + (a & 0xffff)];
    return this.slowRead(a, 1);
  }

  read16(addr: number): number {
    const a = addr >>> 0;
    const p = a >>> 16;
    const k = this.kind[p];
    if ((a & 1) === 0 && k !== 0) {
      const o = this.base[p] + (a & 0xffff);
      const m = k === K_SRAM ? this.sram : k === K_ROM ? this.rom : k === K_PSRAM ? this.parts.psramBytes() : this.flash;
      return m[o] | (m[o + 1] << 8);
    }
    return this.slowRead(a, 2);
  }

  read32(addr: number): number {
    const a = addr >>> 0;
    const p = a >>> 16;
    const k = this.kind[p];
    if ((a & 3) === 0 && k !== 0) {
      const o = this.base[p] + (a & 0xffff);
      if (k === K_SRAM) return this.sramWords[o >>> 2];
      if (k === K_ROM) return this.romWords[o >>> 2];
      if (k === K_PSRAM) return this.parts.psramWords()[o >>> 2];
      const m = this.flash;
      return (m[o] | (m[o + 1] << 8) | (m[o + 2] << 16) | (m[o + 3] << 24)) >>> 0;
    }
    return this.slowRead(a, 4);
  }

  write8(addr: number, value: number): void {
    const a = addr >>> 0;
    const p = a >>> 16;
    const k = this.kind[p];
    if (k === K_SRAM) {
      const o = this.base[p] + (a & 0xffff);
      this.sram[o] = value;
      if (this.code[o >>> 12] !== 0) this.parts.codeWritten(o);
    } else if (k === K_PSRAM) this.parts.psramBytes()[this.base[p] + (a & 0xffff)] = value;
    else this.slowWrite(a, value, 1);
  }

  write16(addr: number, value: number): void {
    const a = addr >>> 0;
    const p = a >>> 16;
    if ((a & 1) === 0 && this.kind[p] === K_SRAM) {
      const o = this.base[p] + (a & 0xffff);
      this.sram[o] = value;
      this.sram[o + 1] = value >>> 8;
      if (this.code[o >>> 12] !== 0) this.parts.codeWritten(o);
    } else if ((a & 1) === 0 && this.kind[p] === K_PSRAM) {
      const m = this.parts.psramBytes();
      const o = this.base[p] + (a & 0xffff);
      m[o] = value;
      m[o + 1] = value >>> 8;
    } else this.slowWrite(a, value, 2);
  }

  write32(addr: number, value: number): void {
    const a = addr >>> 0;
    const p = a >>> 16;
    if ((a & 3) === 0 && this.kind[p] === K_SRAM) {
      const o = this.base[p] + (a & 0xffff);
      this.sramWords[o >>> 2] = value;
      if (this.code[o >>> 12] !== 0) this.parts.codeWritten(o);
    } else if ((a & 3) === 0 && this.kind[p] === K_PSRAM) this.parts.psramWords()[(this.base[p] + (a & 0xffff)) >>> 2] = value;
    else this.slowWrite(a, value, 4);
  }

  fetch(addr: number): number {
    const a = addr >>> 0;
    const p = a >>> 16;
    const k = this.kind[p];
    const off = a & 0xffff;
    if (a >= 0x40000000 && k !== 0 && off <= 0xfffd) {
      const m = k === K_SRAM ? this.sram : k === K_ROM ? this.rom : this.flash;
      const o = this.base[p] + off;
      return m[o] | (m[o + 1] << 8) | (m[o + 2] << 16);
    }
    return this.slowFetch(a);
  }

  // ── Slow paths ────────────────────────────────────────────────────────────────────────

  private pc(): number {
    return this.core?.pc ?? 0;
  }

  /** The flash offset of window address `a` (arming its page), or −1 when its MMU entry is invalid. */
  private flashOffset(a: number): number {
    let window: number;
    if (a >= IROM_BASE && a < IROM_BASE + FLASH_WINDOW) window = IROM_BASE;
    else if (a >= DROM_FLASH_BASE && a < DROM_FLASH_BASE + FLASH_WINDOW) window = DROM_FLASH_BASE;
    else return -1;
    const entry = (a - window) >>> 16;
    const page = this.parts.mmuPage(entry);
    if (page < 0 || page + 0x10000 > this.flash.length) return -1;
    const p = a >>> 16;
    this.kind[p] = K_FLASH;
    this.base[p] = page;
    return page + (a & 0xffff);
  }

  /** BT130: the PSRAM offset of data-bus address `a` (arming its page), or −1. */
  private psramOffset(a: number): number {
    if (a < DROM_FLASH_BASE || a >= DROM_FLASH_BASE + FLASH_WINDOW) return -1;
    const page = this.parts.mmuPsramPage((a - DROM_FLASH_BASE) >>> 16);
    if (page < 0) return -1;
    const p = a >>> 16;
    this.kind[p] = K_PSRAM;
    this.base[p] = page;
    return page + (a & 0xffff);
  }

  /** Byte `a` outside the fast pages: RTC memory, SRAM1's first data page, flash, or −1. */
  private memoryByte(a: number): number {
    if (a >= RTC_FAST_BASE && a < RTC_FAST_BASE + RTC_FAST_SIZE) return this.parts.memory.rtcFast[a - RTC_FAST_BASE];
    if (a >= RTC_SLOW_BASE && a < RTC_SLOW_BASE + RTC_SLOW_SIZE) return this.parts.memory.rtcSlow[a - RTC_SLOW_BASE];
    if (a >= DRAM_BASE && a < DRAM_END) return this.sram[a - DRAM_ORIGIN];
    const o = this.flashOffset(a);
    if (o >= 0) return this.flash[o];
    const q = this.psramOffset(a);
    return q >= 0 ? this.parts.psramBytes()[q] : -1;
  }

  private slowRead(a: number, size: number): number {
    if (a >= PERIPH_BASE && a < PERIPH_END) return this.peripheralRead(a, size);
    let v = 0;
    for (let i = 0; i < size; i++) {
      const b = this.memoryByte((a + i) >>> 0);
      if (b < 0) {
        if (a >= 0x3d000000 && a < 0x3e000000) this.parts.problems.report('error', CODE_S3_PSRAM, a, `PSRAM access at ${hex(a)} (PC ${hex(this.pc())}): no PSRAM page is mapped there (a build without PSRAM, or past its size)`);
        throw new XtensaBusError('unmapped load', a, LOAD_STORE_ERROR);
      }
      v |= b << (8 * i);
    }
    return v >>> 0;
  }

  private slowWrite(a: number, value: number, size: number): void {
    if (a >= PERIPH_BASE && a < PERIPH_END) {
      this.peripheralWrite(a, value, size);
      return;
    }
    for (let i = 0; i < size; i++) {
      const b = (a + i) >>> 0;
      const byte = (value >>> (8 * i)) & 0xff;
      if (b >= RTC_FAST_BASE && b < RTC_FAST_BASE + RTC_FAST_SIZE) this.parts.memory.rtcFast[b - RTC_FAST_BASE] = byte;
      else if (b >= RTC_SLOW_BASE && b < RTC_SLOW_BASE + RTC_SLOW_SIZE) this.parts.memory.rtcSlow[b - RTC_SLOW_BASE] = byte;
      else if ((b >= DRAM_BASE && b < DRAM_END) || (b >= IRAM_BASE && b < IRAM_END)) {
        const o = b >= IRAM_BASE ? b - IRAM_BASE : b - DRAM_ORIGIN;
        this.sram[o] = byte;
        if (this.code[o >>> 12] !== 0) this.parts.codeWritten(o);
      } else if (this.psramOffset(b) >= 0) {
        this.parts.psramBytes()[this.base[b >>> 16] + (b & 0xffff)] = byte;
      } else if ((b >= ROM_BASE && b < ROM_BASE + ROM_SIZE) || (b >= DROM_BASE && b < DROM_BASE + DROM_SIZE)) {
        if (this.parts.problems.admit(CODE_S3_ROM_WRITE, a)) this.parts.problems.add('warning', CODE_S3_ROM_WRITE, a, `write to ROM at ${hex(a)} (PC ${hex(this.pc())}) ignored`);
        return;
      } else throw new XtensaBusError('unmapped store', a, LOAD_STORE_ERROR);
    }
  }

  private peripheralRead(a: number, size: number): number {
    if (!this.parts.peripheralTurn(this.cpu)) throw BUS_YIELD;
    const word = this.parts.periph.read32((a & ~3) >>> 0, this.pc());
    const shift = (a & 3) * 8;
    return size === 4 && shift === 0 ? word : (word >>> shift) & (size === 1 ? 0xff : size === 2 ? 0xffff : 0xffffffff);
  }

  private peripheralWrite(a: number, value: number, size: number): void {
    if (!this.parts.peripheralTurn(this.cpu)) throw BUS_YIELD;
    const word = (a & ~3) >>> 0;
    if (size === 4 && (a & 3) === 0) {
      this.parts.periph.write32(word, value >>> 0, this.pc());
      return;
    }
    // Sub-word: merged into the word (as the ESP32's; the TRM is silent).
    const shift = (a & 3) * 8;
    const mask = (size === 1 ? 0xff : 0xffff) << shift;
    const old = this.parts.periph.blocks[(word - PERIPH_BASE) >>> 12].read32(word & 0xffc);
    this.parts.periph.write32(word, ((old & ~mask) | ((value << shift) & mask)) >>> 0, this.pc());
  }

  private slowFetch(a: number): number {
    if (a === 0 && this.cpu === 0 && this.core !== null && this.core.windowBase === 0 && this.core.windowStart === 1) {
      throw new Error('the app returned from its entry point (PRO_CPU fetch from 0x00000000 in the root frame)');
    }
    const instruction = (a >= 0x40000000 && a < 0x44000000) || (a >= RTC_FAST_BASE && a < RTC_FAST_BASE + RTC_FAST_SIZE);
    if (!instruction) throw new XtensaBusError('instruction fetch from the data bus', a, FETCH_ERROR);
    const b0 = this.fetchByte(a);
    if (b0 < 0) throw new XtensaBusError('unmapped fetch', a, FETCH_ERROR);
    let v = b0;
    for (let i = 1; i < lengthOf(b0); i++) {
      const b = this.fetchByte((a + i) >>> 0);
      v |= (b < 0 ? 0 : b) << (8 * i);
    }
    return v;
  }

  private fetchByte(a: number): number {
    const p = a >>> 16;
    const k = this.kind[p];
    if (k === K_SRAM) return this.sram[this.base[p] + (a & 0xffff)];
    if (k === K_ROM) return this.rom[this.base[p] + (a & 0xffff)];
    if (k === K_FLASH) return this.flash[this.base[p] + (a & 0xffff)];
    if (k === K_PSRAM) return this.parts.psramBytes()[this.base[p] + (a & 0xffff)];
    if (a >= RTC_FAST_BASE && a < RTC_FAST_BASE + RTC_FAST_SIZE) return this.parts.memory.rtcFast[a - RTC_FAST_BASE];
    const o = this.flashOffset(a);
    return o >= 0 ? this.flash[o] : -1;
  }

  // ── Predecode cache support ──────────────────────────────────────────────────────────

  codePage(address: number): number {
    const a = address >>> 0;
    if (a >= IRAM_BASE && a < IRAM_END) {
      this.code[(a - IRAM_BASE) >>> 12] = 1;
      return CODE_PLAIN;
    }
    if (a >= ROM_BASE && a < ROM_BASE + ROM_SIZE) return CODE_PLAIN;
    if (a >= IROM_BASE && a < IROM_BASE + FLASH_WINDOW) {
      const o = this.flashOffset(a);
      return o < 0 ? CODE_NONE : o;
    }
    return CODE_NONE;
  }

  codeByte(address: number): number {
    const b = this.fetchByte(address >>> 0);
    return b < 0 ? 0 : b;
  }

  codeFetched(_offset: number, _length: number): void {
    // No flash cache timing on the S3 yet.
  }

  // ── The debugger (BT125) ────────────────────────────────────────────────────────────

  /** A debugger's write: RAM only (SRAM through either bus, RTC fast and slow); false elsewhere. */
  poke8(address: number, value: number): boolean {
    const b = address >>> 0;
    const byte = value & 0xff;
    if (b >= RTC_FAST_BASE && b < RTC_FAST_BASE + RTC_FAST_SIZE) this.parts.memory.rtcFast[b - RTC_FAST_BASE] = byte;
    else if (b >= RTC_SLOW_BASE && b < RTC_SLOW_BASE + RTC_SLOW_SIZE) this.parts.memory.rtcSlow[b - RTC_SLOW_BASE] = byte;
    else if ((b >= DRAM_BASE && b < DRAM_END) || (b >= IRAM_BASE && b < IRAM_END)) {
      const o = b >= IRAM_BASE ? b - IRAM_BASE : b - DRAM_ORIGIN;
      this.sram[o] = byte;
      if (this.code[o >>> 12] !== 0) this.parts.codeWritten(o);
    } else {
      // BT130: PSRAM through the MMU's SPIRAM pages.
      const page = b >= DROM_FLASH_BASE && b < DROM_FLASH_BASE + FLASH_WINDOW ? this.parts.mmuPsramPage((b - DROM_FLASH_BASE) >>> 16) : -1;
      if (page < 0) return false;
      this.parts.psramBytes()[page + (b & 0xffff)] = byte;
    }
    return true;
  }

  /** One byte as this CPU would load or fetch it, without side effects (peripherals and unmapped read 0). */
  peek8(address: number): number {
    const a = address >>> 0;
    const p = a >>> 16;
    const k = this.kind[p];
    if (k === K_SRAM) return this.sram[this.base[p] + (a & 0xffff)];
    if (k === K_ROM) return this.rom[this.base[p] + (a & 0xffff)];
    if (k === K_FLASH) return this.flash[this.base[p] + (a & 0xffff)];
    if (a >= RTC_FAST_BASE && a < RTC_FAST_BASE + RTC_FAST_SIZE) return this.parts.memory.rtcFast[a - RTC_FAST_BASE];
    if (a >= RTC_SLOW_BASE && a < RTC_SLOW_BASE + RTC_SLOW_SIZE) return this.parts.memory.rtcSlow[a - RTC_SLOW_BASE];
    if (a >= DRAM_BASE && a < DRAM_END) return this.sram[a - DRAM_ORIGIN];
    let window = -1;
    if (a >= IROM_BASE && a < IROM_BASE + FLASH_WINDOW) window = IROM_BASE;
    else if (a >= DROM_FLASH_BASE && a < DROM_FLASH_BASE + FLASH_WINDOW) window = DROM_FLASH_BASE;
    if (window < 0) return 0;
    const entry = (a - window) >>> 16;
    const page = this.parts.mmuPage(entry);
    if (page >= 0) return this.flash[page + (a & 0xffff)] ?? 0;
    const ram = window === DROM_FLASH_BASE ? this.parts.mmuPsramPage(entry) : -1;
    return ram < 0 ? 0 : this.parts.psramBytes()[ram + (a & 0xffff)];
  }
}
