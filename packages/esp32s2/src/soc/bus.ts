/**
 * The ESP32-S2's bus as its core sees it (BT148): XtensaBus for loads, stores and fetches, and
 * CodeBus for the predecode cache — the S3's bus (a table of 64 KB pages: SRAM, ROM, flash, or 0
 * for the slow path) over the S2's map (memory.ts), for one core.
 *
 * Flash: the MMU's six windows of 64 entries (cache_memory.h, mmu.h) — the ICache's IBUS0 (IRAM0,
 * 0x4000_0000), IBUS1 (IRAM1, 0x4040_0000) and IBUS2 (DROM0, 0x3F00_0000: the S2 reads constant
 * data through its instruction cache — SOC_MMU_DROM0_PAGES_START is IBUS2's entry 128), the
 * DCache's DBUS0 (DRAM0, 0x3FC0_0000), DBUS1 (DRAM1, 0x3F80_0000) and DBUS2 (DPORT, 0x3F40_0000);
 * flash in IBUS0 from 0x4008_0000, DBUS0 below 0x3FF8_0000 and DBUS2 from 0x3F50_0000 (around them
 * ROM, SRAM and the peripherals). A window page is armed on first touch through its entry and
 * disarmed when the entry changes.
 *
 * The slow path: RTC fast memory (0x3FF9_E000 data, 0x4007_0000 instruction) and slow memory
 * (0x5000_0000), the peripherals on either peripheral bus (sub-word accesses merge into their
 * word), EXTMEM and the MMU table (0x6180_0000–0x6180_1FFF), and unmapped addresses
 * (LoadStoreError / InstrFetchError).
 *
 * BT154: PSRAM — an MMU entry with ACCESS_SPIRAM arms its data-bus page (any window below
 * 0x4000_0000: IDF 4.4 maps the chip into DBUS0/DBUS1/DBUS2, 0x3F50_0000–0x3FF7_FFFF) on the PSRAM
 * chip's bytes (soc.ts), read and written like SRAM. An ACCESS_SPIRAM entry no chip answers (a
 * module without PSRAM, a page past its size) reads as unmapped with an `esp32s2-psram` Problem.
 * Instruction fetch from PSRAM isn't modeled (Arduino's builds don't place code there).
 * Not modeled: cache timing, memory protection.
 */

import { CODE_NONE, CODE_PLAIN, type CodeBus, EXCCAUSE, lengthOf, type Peripheral, type ProblemLog, type XtensaBus, XtensaBusError, type XtensaCore } from '@benchtop/esp32';
import {
  DRAM_BASE,
  DRAM_END,
  DROM_BASE,
  DROM_ROM_OFFSET,
  DROM_SIZE,
  IRAM_BASE,
  IRAM_END,
  PERIBUS1,
  PERIBUS2,
  PERIBUS_SIZE,
  ROM_BASE,
  ROM_SIZE,
  RTC_FAST_BASE,
  RTC_FAST_IBASE,
  RTC_FAST_SIZE,
  RTC_SLOW_BASE,
  RTC_SLOW_SIZE,
  type S2Memory,
} from './memory.ts';
import type { S2PeripheralMap } from './periph.ts';

const K_SRAM = 1;
const K_ROM = 2;
const K_FLASH = 3;
const K_PSRAM = 4;
const LOAD_STORE_ERROR = EXCCAUSE.LOAD_STORE_ERROR;
const FETCH_ERROR = EXCCAUSE.INSTRUCTION_FETCH_ERROR;
export const CODE_S2_PSRAM = 'esp32s2-psram';
export const CODE_S2_ROM_WRITE = 'esp32s2-rom-write';

/** EXTMEM and the MMU table: 0x6180_0000 and 0x6180_1000. */
export const CACHE_REGS = 0x61800000;
const CACHE_REGS_END = 0x61802000;

/** The flash windows: [start, end, first MMU entry]; addresses below `start` in a bus aren't the cache's. */
const WINDOWS: readonly (readonly [number, number, number])[] = [
  [0x40080000, 0x40400000, 0], // IBUS0, IRAM0 (entries from 0x4000_0000)
  [0x40400000, 0x40800000, 64], // IBUS1, IRAM1
  [0x3f000000, 0x3f400000, 128], // IBUS2, DROM0
  [0x3fc00000, 0x3ff80000, 192], // DBUS0, DRAM0
  [0x3f800000, 0x3fc00000, 256], // DBUS1, DRAM1
  [0x3f500000, 0x3f800000, 320], // DBUS2, DPORT (entries from 0x3F40_0000)
];
const WINDOW_ORIGIN = [0x40000000, 0x40400000, 0x3f000000, 0x3fc00000, 0x3f800000, 0x3f400000];

/** The MMU entry for a flash-window address, or −1. */
export function s2MmuEntryOf(address: number): number {
  const a = address >>> 0;
  for (let w = 0; w < WINDOWS.length; w++) {
    const [start, end, first] = WINDOWS[w];
    if (a >= start && a < end) return first + ((a - WINDOW_ORIGIN[w]) >>> 16);
  }
  return -1;
}

/** The window address of an MMU entry's page in its bus (for disarming), or −1 (an entry outside its window's flash part). */
function entryAddress(entry: number): number {
  for (let w = 0; w < WINDOWS.length; w++) {
    const [start, end, first] = WINDOWS[w];
    if (entry < first || entry >= first + 64) continue;
    const a = WINDOW_ORIGIN[w] + (entry - first) * 0x10000;
    return a >= start && a < end ? a : -1;
  }
  return -1;
}

/** What the bus shares with the SoC. */
export interface S2BusParts {
  readonly memory: S2Memory;
  readonly periph: S2PeripheralMap;
  readonly problems: ProblemLog;
  /** EXTMEM (offset 0x0000) and the MMU table (0x1000) as one block. */
  readonly cacheRegs: Peripheral;
  /** The flash chip's bytes (replaced when its size changes). */
  flashBytes(): Uint8Array;
  /** The flash offset MMU entry `entry` maps (−1: invalid, PSRAM or nothing). */
  mmuPage(entry: number): number;
  /** Whether MMU entry `entry` maps PSRAM. */
  mmuPsram(entry: number): boolean;
  /** BT154: the PSRAM offset MMU entry `entry` maps (−1: not PSRAM, no chip or past its size). */
  mmuPsramPage(entry: number): number;
  /** BT154: the PSRAM chip's bytes and words (allocated on first use). */
  psramBytes(): Uint8Array;
  psramWords(): Uint32Array;
  /** Called before a peripheral access: events due by now fire first. */
  peripheralTurn(): void;
  /** A store hit a 4 KB SRAM page holding predecoded code. */
  codeWritten(offset: number): void;
}

const hex = (v: number): string => `0x${(v >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;

export class S2Bus implements XtensaBus, CodeBus {
  readonly kind = new Uint8Array(65536);
  readonly base = new Int32Array(65536);
  core: XtensaCore | null = null;
  /** Per 4 KB of SRAM: a predecode cache holds code from it. */
  readonly code = new Uint8Array(80);
  private readonly parts: S2BusParts;
  private readonly sram: Uint8Array;
  private readonly sramWords: Uint32Array;
  private readonly rom: Uint8Array;
  private readonly romWords: Uint32Array;
  private flash: Uint8Array;

  constructor(parts: S2BusParts) {
    this.parts = parts;
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
    for (let a = DRAM_BASE; a < DRAM_END; a += 0x10000) this.setPage(a, K_SRAM, a - DRAM_BASE);
    for (let a = ROM_BASE; a < ROM_BASE + ROM_SIZE; a += 0x10000) this.setPage(a, K_ROM, a - ROM_BASE);
    for (let a = DROM_BASE; a < DROM_BASE + DROM_SIZE; a += 0x10000) this.setPage(a, K_ROM, DROM_ROM_OFFSET + (a - DROM_BASE));
    this.core?.icache.invalidateAll();
  }

  private setPage(a: number, k: number, offset: number): void {
    const p = a >>> 16;
    this.kind[p] = k;
    this.base[p] = offset;
  }

  /** MMU entry `entry` changed: its window page is disarmed, the core's predecoded code there dropped. */
  mmuChanged(entry: number): void {
    const a = entryAddress(entry);
    if (a < 0) return;
    this.kind[a >>> 16] = 0;
    if (a >= 0x40000000) this.core?.icache.invalidateRange(a, 0x10000);
  }

  /** Every flash page disarmed (new flash contents, an ICache invalidate). */
  invalidateFlash(): void {
    this.flash = this.parts.flashBytes();
    for (const [start, end] of WINDOWS) this.kind.fill(0, start >>> 16, end >>> 16);
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
    if (this.kind[p] === K_SRAM) {
      const o = this.base[p] + (a & 0xffff);
      this.sram[o] = value;
      if (this.code[o >>> 12] !== 0) this.parts.codeWritten(o);
    } else if (this.kind[p] === K_PSRAM) this.parts.psramBytes()[this.base[p] + (a & 0xffff)] = value;
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

  /** The flash offset of window address `a` (arming its page), or −1 when nothing maps it. */
  private flashOffset(a: number): number {
    const entry = s2MmuEntryOf(a);
    if (entry < 0) return -1;
    const page = this.parts.mmuPage(entry);
    if (page < 0 || page + 0x10000 > this.flash.length) return -1;
    const p = a >>> 16;
    this.kind[p] = K_FLASH;
    this.base[p] = page;
    return page + (a & 0xffff);
  }

  /** BT154: the PSRAM offset of data-bus address `a` (arming its page), or −1 (an unanswered SPIRAM entry is a Problem). */
  private psramOffset(a: number): number {
    if (a >= 0x40000000) return -1;
    const entry = s2MmuEntryOf(a);
    if (entry < 0) return -1;
    const page = this.parts.mmuPsramPage(entry);
    if (page < 0) {
      if (this.parts.mmuPsram(entry)) this.parts.problems.report('error', CODE_S2_PSRAM, a, `PSRAM access at ${hex(a)} (PC ${hex(this.pc())}): no PSRAM answers there (a module without PSRAM, or past its size)`);
      return -1;
    }
    const p = a >>> 16;
    this.kind[p] = K_PSRAM;
    this.base[p] = page;
    return page + (a & 0xffff);
  }

  /**
   * Byte `a` for the slow path: an armed page's (an unaligned or sub-word access to SRAM, ROM, flash
   * or PSRAM — BT157: the S2's core does unaligned loads in hardware, XCHAL_UNALIGNED_LOAD_HW),
   * RTC memory, a flash or PSRAM window page not armed yet, or −1.
   */
  private memoryByte(a: number): number {
    const p = a >>> 16;
    const k = this.kind[p];
    if (k === K_SRAM) return this.sram[this.base[p] + (a & 0xffff)];
    if (k === K_ROM) return this.rom[this.base[p] + (a & 0xffff)];
    if (k === K_FLASH) return this.flash[this.base[p] + (a & 0xffff)];
    if (k === K_PSRAM) return this.parts.psramBytes()[this.base[p] + (a & 0xffff)];
    if (a >= RTC_FAST_BASE && a < RTC_FAST_BASE + RTC_FAST_SIZE) return this.parts.memory.rtcFast[a - RTC_FAST_BASE];
    if (a >= RTC_FAST_IBASE && a < RTC_FAST_IBASE + RTC_FAST_SIZE) return this.parts.memory.rtcFast[a - RTC_FAST_IBASE];
    if (a >= RTC_SLOW_BASE && a < RTC_SLOW_BASE + RTC_SLOW_SIZE) return this.parts.memory.rtcSlow[a - RTC_SLOW_BASE];
    const o = this.flashOffset(a);
    if (o >= 0) return this.flash[o];
    const q = this.psramOffset(a);
    return q >= 0 ? this.parts.psramBytes()[q] : -1;
  }

  private isPeripheral(a: number): boolean {
    return (a >= PERIBUS1 && a < PERIBUS1 + PERIBUS_SIZE) || (a >= PERIBUS2 && a < PERIBUS2 + PERIBUS_SIZE);
  }

  private slowRead(a: number, size: number): number {
    if (this.isPeripheral(a)) return this.peripheralRead(a, size);
    if (a >= CACHE_REGS && a < CACHE_REGS_END) return this.cacheRead(a, size);
    let v = 0;
    for (let i = 0; i < size; i++) {
      const b = this.memoryByte((a + i) >>> 0);
      if (b < 0) throw new XtensaBusError('unmapped load', a, LOAD_STORE_ERROR);
      v |= b << (8 * i);
    }
    return v >>> 0;
  }

  private slowWrite(a: number, value: number, size: number): void {
    if (this.isPeripheral(a)) {
      this.peripheralWrite(a, value, size);
      return;
    }
    if (a >= CACHE_REGS && a < CACHE_REGS_END) {
      this.cacheWrite(a, value, size);
      return;
    }
    for (let i = 0; i < size; i++) {
      const b = (a + i) >>> 0;
      const byte = (value >>> (8 * i)) & 0xff;
      const page = b >>> 16;
      if (this.kind[page] === K_SRAM) {
        // BT157: an unaligned store to SRAM (XCHAL_UNALIGNED_STORE_HW), byte by byte.
        const o = this.base[page] + (b & 0xffff);
        this.sram[o] = byte;
        if (this.code[o >>> 12] !== 0) this.parts.codeWritten(o);
      } else if (b >= RTC_FAST_BASE && b < RTC_FAST_BASE + RTC_FAST_SIZE) this.parts.memory.rtcFast[b - RTC_FAST_BASE] = byte;
      else if (b >= RTC_FAST_IBASE && b < RTC_FAST_IBASE + RTC_FAST_SIZE) this.parts.memory.rtcFast[b - RTC_FAST_IBASE] = byte;
      else if (b >= RTC_SLOW_BASE && b < RTC_SLOW_BASE + RTC_SLOW_SIZE) this.parts.memory.rtcSlow[b - RTC_SLOW_BASE] = byte;
      else if (this.psramOffset(b) >= 0) this.parts.psramBytes()[this.base[b >>> 16] + (b & 0xffff)] = byte;
      else if ((b >= ROM_BASE && b < ROM_BASE + ROM_SIZE) || (b >= DROM_BASE && b < DROM_BASE + DROM_SIZE)) {
        if (this.parts.problems.admit(CODE_S2_ROM_WRITE, a)) this.parts.problems.add('warning', CODE_S2_ROM_WRITE, a, `write to ROM at ${hex(a)} (PC ${hex(this.pc())}) ignored`);
        return;
      } else throw new XtensaBusError('unmapped store', a, LOAD_STORE_ERROR);
    }
  }

  private cacheRead(a: number, size: number): number {
    const word = this.parts.cacheRegs.read32((a - CACHE_REGS) & ~3) >>> 0;
    const shift = (a & 3) * 8;
    return size === 4 && shift === 0 ? word : (word >>> shift) & (size === 1 ? 0xff : 0xffff);
  }

  private cacheWrite(a: number, value: number, size: number): void {
    const offset = (a - CACHE_REGS) & ~3;
    if (size === 4 && (a & 3) === 0) {
      this.parts.cacheRegs.write32(offset, value >>> 0);
      return;
    }
    const shift = (a & 3) * 8;
    const mask = (size === 1 ? 0xff : 0xffff) << shift;
    const old = this.parts.cacheRegs.read32(offset);
    this.parts.cacheRegs.write32(offset, ((old & ~mask) | ((value << shift) & mask)) >>> 0);
  }

  private peripheralRead(a: number, size: number): number {
    this.parts.peripheralTurn();
    const word = this.parts.periph.read32((a & ~3) >>> 0, this.pc());
    const shift = (a & 3) * 8;
    return size === 4 && shift === 0 ? word : (word >>> shift) & (size === 1 ? 0xff : size === 2 ? 0xffff : 0xffffffff);
  }

  private peripheralWrite(a: number, value: number, size: number): void {
    this.parts.peripheralTurn();
    const word = (a & ~3) >>> 0;
    if (size === 4 && (a & 3) === 0) {
      this.parts.periph.write32(word, value >>> 0, this.pc());
      return;
    }
    // Sub-word: merged into the word (as the ESP32's; the TRM is silent).
    const shift = (a & 3) * 8;
    const mask = (size === 1 ? 0xff : 0xffff) << shift;
    const old = this.parts.periph.blocks[(word & (PERIBUS_SIZE - 1)) >>> 12].read32(word & 0xffc);
    this.parts.periph.write32(word, ((old & ~mask) | ((value << shift) & mask)) >>> 0, this.pc());
  }

  private slowFetch(a: number): number {
    if (a === 0 && this.core !== null && this.core.windowBase === 0 && this.core.windowStart === 1) {
      throw new Error('the app returned from its entry point (fetch from 0x00000000 in the root frame)');
    }
    if (a < 0x40000000 || a >= 0x40800000) throw new XtensaBusError('instruction fetch from the data bus', a, FETCH_ERROR);
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
    if (a >= RTC_FAST_IBASE && a < RTC_FAST_IBASE + RTC_FAST_SIZE) return this.parts.memory.rtcFast[a - RTC_FAST_IBASE];
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
    if (a >= 0x40080000 && a < 0x40800000) {
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
    // No flash cache timing on the S2.
  }

  // ── The debugger ────────────────────────────────────────────────────────────────────

  /** A debugger's write: RAM only (SRAM through either bus, RTC fast and slow); false elsewhere. */
  poke8(address: number, value: number): boolean {
    const b = address >>> 0;
    const byte = value & 0xff;
    if (b >= RTC_FAST_BASE && b < RTC_FAST_BASE + RTC_FAST_SIZE) this.parts.memory.rtcFast[b - RTC_FAST_BASE] = byte;
    else if (b >= RTC_FAST_IBASE && b < RTC_FAST_IBASE + RTC_FAST_SIZE) this.parts.memory.rtcFast[b - RTC_FAST_IBASE] = byte;
    else if (b >= RTC_SLOW_BASE && b < RTC_SLOW_BASE + RTC_SLOW_SIZE) this.parts.memory.rtcSlow[b - RTC_SLOW_BASE] = byte;
    else if ((b >= DRAM_BASE && b < DRAM_END) || (b >= IRAM_BASE && b < IRAM_END)) {
      const o = b >= IRAM_BASE ? b - IRAM_BASE : b - DRAM_BASE;
      this.sram[o] = byte;
      if (this.code[o >>> 12] !== 0) this.parts.codeWritten(o);
    } else {
      // BT154: PSRAM through the MMU's SPIRAM pages.
      const entry = b < 0x40000000 ? s2MmuEntryOf(b) : -1;
      const page = entry < 0 ? -1 : this.parts.mmuPsramPage(entry);
      if (page < 0) return false;
      this.parts.psramBytes()[page + (b & 0xffff)] = byte;
    }
    return true;
  }

  /** One byte as the core would load or fetch it, without side effects (peripherals and unmapped read 0). */
  peek8(address: number): number {
    const a = address >>> 0;
    const p = a >>> 16;
    const k = this.kind[p];
    if (k === K_SRAM) return this.sram[this.base[p] + (a & 0xffff)];
    if (k === K_ROM) return this.rom[this.base[p] + (a & 0xffff)];
    if (k === K_FLASH) return this.flash[this.base[p] + (a & 0xffff)];
    if (k === K_PSRAM) return this.parts.psramBytes()[this.base[p] + (a & 0xffff)];
    if (a >= RTC_FAST_BASE && a < RTC_FAST_BASE + RTC_FAST_SIZE) return this.parts.memory.rtcFast[a - RTC_FAST_BASE];
    if (a >= RTC_FAST_IBASE && a < RTC_FAST_IBASE + RTC_FAST_SIZE) return this.parts.memory.rtcFast[a - RTC_FAST_IBASE];
    if (a >= RTC_SLOW_BASE && a < RTC_SLOW_BASE + RTC_SLOW_SIZE) return this.parts.memory.rtcSlow[a - RTC_SLOW_BASE];
    const entry = s2MmuEntryOf(a);
    const page = entry < 0 ? -1 : this.parts.mmuPage(entry);
    if (page >= 0) return this.flash[page + (a & 0xffff)] ?? 0;
    const ram = entry < 0 || a >= 0x40000000 ? -1 : this.parts.mmuPsramPage(entry);
    return ram < 0 ? 0 : this.parts.psramBytes()[ram + (a & 0xffff)];
  }
}
