/**
 * SocBus: the ESP32 address space as one CPU sees it (TRM v5.8 §3.3), behind the XtensaBus
 * interface. A page table over the 4 GB space in 64 KB pages (`kind` + `base`), rebuilt when
 * the DPORT cache/remap registers or region protection change, lets aligned accesses to plain
 * memory take a fast path with no calls; everything else — peripherals, the inverted SRAM1
 * instruction alias, mixed pages, unaligned or sub-word accesses, unmapped addresses, pages
 * under a restrictive region-protection attribute — goes through `slow*`, which decides by
 * address. Flash pages start slow and are armed (kind + flash offset) on their first access;
 * any MMU table or cache-control write disarms them again. No allocation per access.
 *
 * Rules (TRM §3.3.1): addresses below 0x40000000 are on the data bus (any width, unaligned
 * allowed); 0x40000000–0x4FFFFFFF on the instruction bus, where data accesses must be aligned
 * 32-bit words — anything else raises LoadStoreError (EXCCAUSE 3), which IDF's handler for
 * CONFIG_ESP32_IRAM_AS_8BIT_ACCESSIBLE_MEMORY relies on; 0x50000000 and up (RTC SLOW) is shared.
 * Instruction fetch below 0x40000000 is an InstructionFetchError (2). RTC FAST memory answers
 * the PRO_CPU only (§3.3.2.7): an APP access reads 0 and reports a Problem. ROM0's first 32 KB
 * shows SRAM1's 0x400B0000–0x400B7FFF while DPORT_x_BOOT_REMAP_CTRL bit 0 is set (§3.3.2.1).
 * ROM1 is also on the instruction bus at 0x40060000–0x4006FFFF (soc.h's mask-ROM range is
 * 0x40000000–0x40070000; the ROM ELF's code runs to 0x40064EF2 and its .rodata sits at the data-bus
 * view 0x3FF96000). The SRAM0 cache pools (0x40070000/0x40078000, TRM Table 3.3-5) read 0 and report a Problem
 * while a cache that owns them is enabled. Writes to ROM or to flash through the cache are
 * ignored and reported. PSRAM isn't emulated: an access reports a Problem and faults the core.
 * Peripheral registers are words: a byte or halfword access reads (and for writes merges into)
 * the containing word — the TRM says nothing about sub-word register access, and IDF accesses
 * registers as words. Region protection (BT30's TLB attributes, core-matmap.h access-mode
 * lists): a fetch, load or store the region's attribute forbids raises InstFetchProhibited
 * (20), LoadProhibited (28) or StoreProhibited (29) with EXCVADDR = the address.
 *
 * Flash cache timing (BT33): each CPU's cache is 32 KB of 32-byte blocks, two-way
 * set-associative (TRM v5.8 §3.3.4) — 512 sets. Only its tags are modeled, by flash offset, with
 * LRU replacement: every load through the cache looks its block up, and a miss stalls the core
 * for one block fill over SPI (`missCycles`, set by the SoC from the image header's flash mode
 * and frequency and the CPU clock). An instruction fetch looks up the block of its first byte,
 * and of its last byte when the instruction runs into the next block (BT37: one rule for the
 * fetch fast path, the slow path and the predecode cache's `codeFetched`). Looking up the block
 * looked up last changes nothing (it is the most recent way of its set), so that case returns
 * at once. Data always comes straight from the flash array. A DPORT cache flush empties the tags.
 *
 * Predecode cache (BT37, xtensa/icache.ts): `codePage` tells a core's cache whether a 4 KB code
 * page may be predecoded — ROM, SRAM0, SRAM1's instruction alias and (PRO_CPU) RTC FAST as plain
 * bytes, IROM by its flash offset — and marks the physical page in `memory.code`; a store to a
 * marked page (data or instruction bus, fast or slow path) calls `memory.codeWritten`, which
 * the SoC turns into invalidations. Page-table rebuilds (remap, protection) drop this core's
 * cache, MMU and cache-control writes and cache flushes its flash pages.
 *
 * Peripheral order (BT33): before a peripheral access the bus asks the SoC whether it's this
 * CPU's turn (`peripheralTurn`); if the other core is behind in time it throws BUS_YIELD and the
 * access happens after the other core has caught up — so peripheral state is read and written
 * in time order across the two cores (see soc.ts).
 */

import { BUS_YIELD, type XtensaBus, XtensaBusError } from '../xtensa/bus.ts';
import type { XtensaCore } from '../xtensa/cpu.ts';
import * as dec from '../xtensa/decode.ts';
import * as exc from '../xtensa/exceptions.ts';
import { CODE_NONE, CODE_PLAIN } from '../xtensa/icache.ts';
import * as memory from './memory.ts';
import type { DportRegisters, FlashMmu } from './mmu.ts';
import { AHB_BASE, AHB_SIZE, AHB_TARGET, PERIPH_BASE, PERIPH_END, type PeripheralMap, type ProblemLog } from './periph.ts';

const EXCCAUSE = exc.EXCCAUSE;
const LOAD_STORE_ERROR = EXCCAUSE.LOAD_STORE_ERROR;
const FETCH_ERROR = EXCCAUSE.INSTRUCTION_FETCH_ERROR;
const ROM0 = memory.ROM0;
const ROM1 = memory.ROM1;
const SRAM0 = memory.SRAM0;
const SRAM1 = memory.SRAM1;
const SRAM2 = memory.SRAM2;
const RTC_FAST = memory.RTC_FAST;
const RTC_SLOW = memory.RTC_SLOW;
const ROM1_I_START = memory.ROM1_I_START;
const SRAM1_I_START = memory.SRAM1_I_START;
const RTC_FAST_I_START = memory.RTC_FAST_I_START;
const lengthOf = dec.lengthOf;

/** Page kinds. SLOW pages decide per access; the others are plain storage at `base`. */
export const PAGE = { SLOW: 0, DRAM: 1, DROM: 2, IRAM: 3, IROM: 4, FLASH_D: 5, FLASH_I: 6 } as const;
const K_DRAM = PAGE.DRAM;
const K_DROM = PAGE.DROM;
const K_IRAM = PAGE.IRAM;
const K_IROM = PAGE.IROM;
const K_FLASH_D = PAGE.FLASH_D;
const K_FLASH_I = PAGE.FLASH_I;
/** Flash cache: 512 sets of two 32-byte blocks. */
const CACHE_SETS = 512;
const SET_MASK = CACHE_SETS - 1;

/**
 * The APP_CPU's view of the ROM's per-CPU data and boot stack (inferred, not in the TRM): the ROM
 * runs the same code on both CPUs, yet keeps a copy of every per-CPU variable and stack for each —
 * esp32.rom.ld gives g_ticks_per_us_pro 0x3ffe01e0 / g_ticks_per_us_app 0x3ffe40f0 ("updates
 * g_ticks_per_us on the current CPU only"), __stack 0x3ffe3f20 / __stack_app 0x3ffe7e30, and the
 * ROM ELF's .data/.bss _pro and _app sections differ by exactly 0x3F10 — while the ROM's code
 * addresses only the _pro copies. So an APP_CPU data access to [0x3FFE0000, 0x3FFE3F20) lands
 * 0x3F10 higher. Without it the APP_CPU's ROM startup overwrites the PRO_CPU's ROM data and runs
 * on its stack.
 */
export const APP_ROM_WINDOW_START = 0x3ffe0000;
export const APP_ROM_WINDOW_END = 0x3ffe3f20;
export const APP_ROM_WINDOW_SHIFT = 0x3f10;

/** Region attributes (4 bits) that allow a fetch, and a load or store (core-matmap.h). */
const FETCH_OK = 0x007e; // 1–6
const DATA_OK = 0x4077; // 0, 1, 2, 4, 5, 6, 14

export const CODE = {
  ROM_WRITE: 'esp32-rom-write',
  FLASH_WRITE: 'esp32-flash-cache-write',
  RTC_FAST_APP: 'esp32-rtc-fast-app-cpu',
  CACHE_SRAM: 'esp32-cache-sram-access',
  PSRAM: 'esp32-psram',
} as const;

/** What a SocBus shares with the other CPU's bus. */
export interface SocParts {
  readonly memory: memory.EspMemory;
  readonly mmu: FlashMmu;
  readonly dport: DportRegisters;
  readonly periph: PeripheralMap;
  readonly problems: ProblemLog;
  /**
   * May CPU `cpu` touch a peripheral now? False while the other core is behind it in time
   * (BT33): the bus then yields (BUS_YIELD) so the other core catches up first.
   */
  peripheralTurn(cpu: number): boolean;
}

const hex = (v: number): string => `0x${(v >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;

export class SocBus implements XtensaBus {
  /** 0 = PRO_CPU, 1 = APP_CPU. */
  readonly cpu: number;
  readonly kind = new Uint8Array(65536);
  readonly base = new Int32Array(65536);
  /** The CPU on this bus (for the PC in Problems). */
  core: XtensaCore | null = null;
  private readonly parts: SocParts;
  private readonly memory: memory.EspMemory;
  private readonly bytes: Uint8Array;
  private readonly words: Uint32Array;
  /** memory.code: per 4 KB of the buffer, whether a predecode cache holds code from it. */
  private readonly code: Uint8Array;
  private flash: Uint8Array;
  private flashWords: Uint32Array;
  private readonly itlb = new Uint8Array(8).fill(2);
  private readonly dtlb = new Uint8Array(8).fill(2);
  /** Cache tags (block number = flash offset >> 5, −1 empty) per way, and the way to replace next. */
  private readonly way0 = new Int32Array(CACHE_SETS).fill(-1);
  private readonly way1 = new Int32Array(CACHE_SETS).fill(-1);
  private readonly victim = new Uint8Array(CACHE_SETS);
  /** The block looked up last (−1: none since the last flush). */
  private lastBlock = -1;
  /** What the predecode cache's non-flash pages depend on, as of the last rebuild (−1: never). */
  private codeKey = -1;
  /** CPU cycles a cache miss stalls the core (0: no flash timing). */
  missCycles = 0;
  /** Cache misses so far (reports). */
  misses = 0;

  constructor(parts: SocParts, cpu: number) {
    this.parts = parts;
    this.cpu = cpu;
    this.memory = parts.memory;
    this.bytes = parts.memory.bytes;
    this.words = parts.memory.words;
    this.code = parts.memory.code;
    this.flash = parts.memory.flash;
    this.flashWords = parts.memory.flashWords;
    this.rebuild();
  }

  // ── Fast paths ────────────────────────────────────────────────────────────────────────

  read8(addr: number): number {
    const a = addr >>> 0;
    const p = a >>> 16;
    const k = this.kind[p];
    if (k === K_DRAM || k === K_DROM) return this.bytes[this.base[p] + (a & 0xffff)];
    if (k === K_FLASH_D) {
      const o = this.base[p] + (a & 0xffff);
      this.cached(o);
      return this.flash[o];
    }
    return this.slowRead(a, 1);
  }

  read16(addr: number): number {
    const a = addr >>> 0;
    const p = a >>> 16;
    const k = this.kind[p];
    if ((a & 1) === 0) {
      if (k === K_DRAM || k === K_DROM) {
        const o = this.base[p] + (a & 0xffff);
        return this.bytes[o] | (this.bytes[o + 1] << 8);
      }
      if (k === K_FLASH_D) {
        const o = this.base[p] + (a & 0xffff);
        this.cached(o);
        return this.flash[o] | (this.flash[o + 1] << 8);
      }
    }
    return this.slowRead(a, 2);
  }

  read32(addr: number): number {
    const a = addr >>> 0;
    const p = a >>> 16;
    const k = this.kind[p];
    if ((a & 3) === 0 && k !== 0) {
      if (k <= K_IROM) return this.words[(this.base[p] + (a & 0xffff)) >>> 2];
      const o = this.base[p] + (a & 0xffff);
      this.cached(o);
      return this.flashWords[o >>> 2];
    }
    return this.slowRead(a, 4);
  }

  write8(addr: number, value: number): void {
    const a = addr >>> 0;
    const p = a >>> 16;
    if (this.kind[p] === K_DRAM) {
      const o = this.base[p] + (a & 0xffff);
      this.bytes[o] = value;
      if (this.code[o >>> 12] !== 0) this.memory.codeWritten(o);
    } else this.slowWrite(a, value, 1);
  }

  write16(addr: number, value: number): void {
    const a = addr >>> 0;
    const p = a >>> 16;
    if ((a & 1) === 0 && this.kind[p] === K_DRAM) {
      const o = this.base[p] + (a & 0xffff);
      this.bytes[o] = value;
      this.bytes[o + 1] = value >>> 8;
      if (this.code[o >>> 12] !== 0) this.memory.codeWritten(o);
    } else this.slowWrite(a, value, 2);
  }

  write32(addr: number, value: number): void {
    const a = addr >>> 0;
    const p = a >>> 16;
    const k = this.kind[p];
    if ((a & 3) === 0 && (k === K_DRAM || k === K_IRAM)) {
      const o = this.base[p] + (a & 0xffff);
      this.words[o >>> 2] = value;
      if (this.code[o >>> 12] !== 0) this.memory.codeWritten(o);
    } else this.slowWrite(a, value, 4);
  }

  fetch(addr: number): number {
    const a = addr >>> 0;
    const p = a >>> 16;
    const k = this.kind[p];
    const off = a & 0xffff;
    if (off <= 0xfffd) {
      if (k === K_IRAM || k === K_IROM) {
        const m = this.bytes;
        const o = this.base[p] + off;
        return m[o] | (m[o + 1] << 8) | (m[o + 2] << 16);
      }
      if (k === K_FLASH_I) {
        const m = this.flash;
        const o = this.base[p] + off;
        const b0 = m[o];
        this.codeFetched(o, lengthOf(b0));
        return b0 | (m[o + 1] << 8) | (m[o + 2] << 16);
      }
    }
    return this.slowFetch(a);
  }

  // ── The page table ────────────────────────────────────────────────────────────────────

  /** Recomputes every page (after a DPORT cache/remap change or a protection change). */
  rebuild(): void {
    const kind = this.kind;
    kind.fill(0);
    this.base.fill(0);
    this.setPages(ROM0.start, ROM0.size, K_IROM, ROM0.offset);
    if (this.parts.dport.bootRemap(this.cpu)) kind[0x4000] = 0; // first 32 KB remapped: decide per access
    this.setPages(ROM1.start, ROM1.size, K_DROM, ROM1.offset);
    this.setPages(ROM1_I_START, ROM1.size, K_IROM, ROM1.offset);
    this.setPages(0x40080000, 0x20000, K_IRAM, SRAM0.offset + 0x10000); // 0x40070000 (cache pools) stays slow
    this.setPages(SRAM1.start, SRAM1.size, K_DRAM, SRAM1.offset);
    this.setPages(0x3ffb0000, 0x30000, K_DRAM, SRAM2.offset + (0x3ffb0000 - SRAM2.start)); // 0x3FFA is a partial page
    if (this.cpu === 1) kind[0x3ffe] = 0; // APP_CPU: the ROM-data window is relocated (dataOffset)
    // Pages a region attribute restricts in any way stay slow, where the check is made.
    let key = this.parts.dport.bootRemap(this.cpu) ? 1 : 0;
    for (let r = 0; r < 8; r++) {
      const fetch = (FETCH_OK >>> this.itlb[r]) & 1;
      if (fetch === 0 || ((DATA_OK >>> this.dtlb[r]) & 1) === 0) kind.fill(0, r << 13, (r + 1) << 13);
      else key |= 2 << r;
      key |= fetch << (9 + r);
    }
    // The core's predecoded code: a remap or protection change can touch any page; anything
    // else here (cache enable, masks, the cache-pool mode) only the flash pages.
    if (key !== this.codeKey) this.core?.icache.invalidateAll();
    else this.core?.icache.invalidateFlash();
    this.codeKey = key;
  }

  private setPages(start: number, size: number, k: number, offset: number): void {
    for (let a = start; a < start + size; a += 0x10000) {
      const p = a >>> 16;
      this.kind[p] = k;
      this.base[p] = offset + (a - start);
    }
  }

  /** A flash access at offset `o` goes through the cache: a hit refreshes LRU, a miss fills a way and stalls the core. */
  private cached(o: number): void {
    const block = o >>> 5;
    if (block === this.lastBlock) return; // already its set's most recent way: nothing changes
    this.lastBlock = block;
    const set = block & SET_MASK;
    if (this.way0[set] === block) this.victim[set] = 1;
    else if (this.way1[set] === block) this.victim[set] = 0;
    else this.miss(block, set);
  }

  private miss(block: number, set: number): void {
    if (this.victim[set] === 0) {
      this.way0[set] = block;
      this.victim[set] = 1;
    } else {
      this.way1[set] = block;
      this.victim[set] = 0;
    }
    this.misses++;
    if (this.missCycles !== 0 && this.core !== null) this.core.stall(this.missCycles);
  }

  /**
   * The cache lookups of an instruction fetch at flash offset `o`: its first byte's block, and
   * its last byte's when that is the next block (within one 64 KB page: the callers see to it).
   */
  codeFetched(o: number, length: number): void {
    this.cached(o);
    if ((o & 31) + length > 32) this.cached(o + length - 1);
  }

  /** A cache flush (DPORT_x_CACHE_CTRL FLUSH_ENA): every block invalid; the core's predecoded flash pages too. */
  flushCache(): void {
    this.way0.fill(-1);
    this.way1.fill(-1);
    this.victim.fill(0);
    this.lastBlock = -1;
    this.core?.icache.invalidateFlash();
  }

  /**
   * MMU entry `entry` (0–255 map flash) of this CPU's table changed: the 64 KB page it maps is
   * disarmed and, for IROM, the core's predecoded code from it dropped.
   */
  mmuChanged(entry: number): void {
    if (entry < 64) this.kind[0x3f40 + entry] = 0;
    else if (entry < 256) {
      const p = 0x4000 + (entry - 64);
      if (p < 0x400c) return; // 0x40000000–0x400BFFFF: internal memories, never through the MMU
      this.kind[p] = 0;
      this.core?.icache.invalidateRange(p << 16, 0x10000);
    }
  }

  /** Disarms every flash page (a cache-control change, new flash contents), and drops the core's predecoded flash pages. */
  invalidateFlash(): void {
    this.kind.fill(0, 0x3f40, 0x3f80);
    this.kind.fill(0, 0x400c, 0x40c0);
    this.core?.icache.invalidateFlash();
  }

  /** The flash contents changed size (BT32 loads an image). */
  flashChanged(): void {
    this.flash = this.parts.memory.flash;
    this.flashWords = this.parts.memory.flashWords;
    this.invalidateFlash();
  }

  /** BT30's WITLB/WDTLB changed an attribute (XtensaCore calls this). */
  protectionChanged(itlb: Uint8Array, dtlb: Uint8Array): void {
    this.itlb.set(itlb);
    this.dtlb.set(dtlb);
    this.rebuild();
  }

  private regionAllowsAll(a: number): boolean {
    const r = a >>> 29;
    return ((FETCH_OK >>> this.itlb[r]) & 1) !== 0 && ((DATA_OK >>> this.dtlb[r]) & 1) !== 0;
  }

  // ── Slow paths ────────────────────────────────────────────────────────────────────────

  private pc(): number {
    return this.core?.pc ?? 0;
  }

  private slowRead(a: number, size: number): number {
    if (((DATA_OK >>> this.dtlb[a >>> 29]) & 1) === 0) throw new XtensaBusError('load prohibited', a, EXCCAUSE.LOAD_PROHIBITED);
    if (a >= 0x40000000 && a < 0x50000000) {
      if (size !== 4 || (a & 3) !== 0) throw new XtensaBusError(size !== 4 ? `${size * 8}-bit load from the instruction bus` : 'unaligned load from the instruction bus', a, LOAD_STORE_ERROR);
      return this.instructionWord(a, LOAD_STORE_ERROR);
    }
    if ((a & (size - 1)) !== 0) {
      let v = 0;
      for (let i = 0; i < size; i++) v |= this.dataRead((a + i) >>> 0, 1) << (8 * i);
      return v >>> 0;
    }
    return this.dataRead(a, size);
  }

  private slowWrite(a: number, value: number, size: number): void {
    if (((DATA_OK >>> this.dtlb[a >>> 29]) & 1) === 0) throw new XtensaBusError('store prohibited', a, EXCCAUSE.STORE_PROHIBITED);
    if (a >= 0x40000000 && a < 0x50000000) {
      if (size !== 4 || (a & 3) !== 0) throw new XtensaBusError(size !== 4 ? `${size * 8}-bit store to the instruction bus` : 'unaligned store to the instruction bus', a, LOAD_STORE_ERROR);
      this.instructionWrite(a, value);
      return;
    }
    if ((a & (size - 1)) !== 0) {
      for (let i = 0; i < size; i++) this.dataWrite((a + i) >>> 0, (value >>> (8 * i)) & 0xff, 1);
      return;
    }
    this.dataWrite(a, value, size);
  }

  private slowFetch(a: number): number {
    if (((FETCH_OK >>> this.itlb[a >>> 29]) & 1) === 0) throw new XtensaBusError('instruction fetch prohibited', a, EXCCAUSE.INST_FETCH_PROHIBITED);
    if (a === 0 && this.cpu === 0 && this.core !== null && this.core.windowBase === 0 && this.core.windowStart === 1) {
      // The direct boot's root frame returns to 0 (ROOT_RETURN): the app's entry point returned.
      throw new Error('the app returned from its entry point (PRO_CPU fetch from 0x00000000 in the root frame)');
    }
    if (a < 0x40000000) throw new XtensaBusError('instruction fetch from the data bus', a, FETCH_ERROR);
    if (a >= 0x50000000) {
      // RTC SLOW is on both buses.
      if (a + 2 < RTC_SLOW.start + RTC_SLOW.size && a >= RTC_SLOW.start) {
        const o = RTC_SLOW.offset + (a - RTC_SLOW.start);
        return this.bytes[o] | (this.bytes[o + 1] << 8) | (this.bytes[o + 2] << 16);
      }
      throw new XtensaBusError('unmapped fetch', a, FETCH_ERROR);
    }
    if (a >= 0x400c2000 && a < 0x40c00000) return this.flashFetch(a);
    const word = (a & ~3) >>> 0;
    const shift = (a & 3) * 8;
    let v = this.instructionWord(word, FETCH_ERROR) >>> shift;
    if ((a & 3) > 1) {
      // The instruction may continue into the next word; a 2-byte one doesn't need it.
      let next = 0;
      try {
        next = this.instructionWord(word + 4, FETCH_ERROR);
      } catch (error) {
        if (!(error instanceof XtensaBusError)) throw error;
      }
      v |= next << (32 - shift);
    }
    return v & 0xffffff;
  }

  /**
   * A fetch from IROM outside the fast path (an unarmed page, the mixed page 0x400C, or an
   * instruction running into the next 64 KB page): only the bytes the instruction has, each
   * through its own page's mapping; the cache lookups follow codeFetched's rule.
   */
  private flashFetch(a: number): number {
    const o = this.flashPage(a, K_FLASH_I) + (a & 0xffff);
    const b0 = this.flash[o];
    const length = lengthOf(b0);
    let v = b0;
    let last = o;
    for (let i = 1; i < length; i++) {
      const ai = (a + i) >>> 0;
      last = ai >>> 16 === a >>> 16 ? o + i : this.flashPage(ai, K_FLASH_I) + (ai & 0xffff);
      v |= this.flash[last] << (8 * i);
    }
    this.cached(o);
    if ((a & 31) + length > 32) this.cached(last);
    return v;
  }

  // ── Predecode cache support (BT37; xtensa/icache.ts) ──────────────────────────────────

  /** How the 4 KB code page at `address` may be cached: CODE_NONE, CODE_PLAIN or its flash offset. */
  codePage(address: number): number {
    const a = address >>> 0;
    if (((FETCH_OK >>> this.itlb[a >>> 29]) & 1) === 0) return CODE_NONE;
    const p = a >>> 16;
    const k = this.kind[p];
    if (k === K_IROM) return CODE_PLAIN; // ROM (ROM0's first page is slow while boot-remapped)
    if (k === K_IRAM) {
      this.code[(this.base[p] + (a & 0xffff)) >>> 12] = 1;
      return CODE_PLAIN;
    }
    if (a >= SRAM1_I_START && a < SRAM1_I_START + SRAM1.size) {
      if (a >= 0x400b0000 && a < 0x400b8000 && this.parts.dport.bootRemap(this.cpu)) return CODE_NONE;
      this.code[(this.sram1Instruction(a) << 2) >>> 12] = 1; // the inverted alias maps 4 KB pages onto 4 KB pages
      return CODE_PLAIN;
    }
    if (a >= RTC_FAST_I_START && a < RTC_FAST_I_START + RTC_FAST.size) {
      if (this.cpu !== 0) return CODE_NONE;
      this.code[(RTC_FAST.offset + (a - RTC_FAST_I_START)) >>> 12] = 1;
      return CODE_PLAIN;
    }
    if (a >= 0x400c2000 && a < 0x40c00000) {
      const off = this.parts.mmu.translate(this.cpu, a, this.flash.length);
      return off < 0 ? CODE_NONE : off + (a & 0xffff);
    }
    return CODE_NONE;
  }

  /** A byte of a page codePage accepted, without side effects. */
  codeByte(address: number): number {
    const a = address >>> 0;
    const p = a >>> 16;
    const k = this.kind[p];
    if (k === K_IROM || k === K_IRAM) return this.bytes[this.base[p] + (a & 0xffff)];
    if (k === K_FLASH_I) return this.flash[this.base[p] + (a & 0xffff)];
    if (a >= SRAM1_I_START && a < SRAM1_I_START + SRAM1.size) return (this.words[this.sram1Instruction(a)] >>> ((a & 3) * 8)) & 0xff;
    if (a >= RTC_FAST_I_START && a < RTC_FAST_I_START + RTC_FAST.size) return this.bytes[RTC_FAST.offset + (a - RTC_FAST_I_START)];
    return this.flash[this.parts.mmu.translate(this.cpu, a, this.flash.length) + (a & 0xffff)];
  }

  /**
   * BT73 (the debugger): one byte as this CPU would load or fetch it, without side effects — no
   * cache tags touched, no flash page armed, no Problem reported; peripheral registers, PSRAM
   * and unmapped addresses read 0.
   */
  peek8(address: number): number {
    const a = address >>> 0;
    const p = a >>> 16;
    const k = this.kind[p];
    if (k === K_DRAM || k === K_DROM || k === K_IRAM || k === K_IROM) return this.bytes[this.base[p] + (a & 0xffff)];
    if (k === K_FLASH_D || k === K_FLASH_I) return this.flash[this.base[p] + (a & 0xffff)];
    const flash = (): number => {
      const off = this.parts.mmu.translate(this.cpu, a, this.flash.length);
      return off < 0 ? 0 : (this.flash[off + (a & 0xffff)] ?? 0);
    };
    if ((a >= 0x3f400000 && a < 0x3f800000) || (a >= 0x400c2000 && a < 0x40c00000)) return flash();
    if (a >= 0x40000000 && a < 0x50000000) {
      if (a < 0x40070000) {
        if (a < 0x40008000 && this.parts.dport.bootRemap(this.cpu)) return (this.words[this.sram1Instruction(a - 0x40000000 + 0x400b0000)] >>> ((a & 3) * 8)) & 0xff;
        return this.bytes[ROM0.offset + (a - ROM0.start)];
      }
      if (a < SRAM1_I_START) return this.bytes[SRAM0.offset + (a - SRAM0.start)];
      if (a < SRAM1_I_START + SRAM1.size) return (this.words[this.sram1Instruction(a)] >>> ((a & 3) * 8)) & 0xff;
      if (a >= RTC_FAST_I_START && a < RTC_FAST_I_START + RTC_FAST.size) return this.cpu === 0 ? this.bytes[RTC_FAST.offset + (a - RTC_FAST_I_START)] : 0;
      return 0;
    }
    let d = a;
    if (this.cpu === 1 && d >= APP_ROM_WINDOW_START && d < APP_ROM_WINDOW_END) d += APP_ROM_WINDOW_SHIFT;
    if (d >= SRAM2.start && d < 0x40000000) return this.bytes[d < SRAM1.start ? SRAM2.offset + (d - SRAM2.start) : SRAM1.offset + (d - SRAM1.start)];
    if (d >= ROM1.start && d < ROM1.start + ROM1.size) return this.bytes[ROM1.offset + (d - ROM1.start)];
    if (d >= RTC_FAST.start && d < RTC_FAST.start + RTC_FAST.size) return this.cpu === 0 ? this.bytes[RTC_FAST.offset + (d - RTC_FAST.start)] : 0;
    if (d >= RTC_SLOW.start && d < RTC_SLOW.start + RTC_SLOW.size) return this.bytes[RTC_SLOW.offset + (d - RTC_SLOW.start)];
    return 0;
  }

  /** BT73: writes one byte of RAM (SRAM0–2, RTC FAST/SLOW) as the debugger does; false elsewhere. */
  poke8(address: number, value: number): boolean {
    const a = address >>> 0;
    let o = -1;
    if (a >= SRAM2.start && a < 0x40000000) o = a < SRAM1.start ? SRAM2.offset + (a - SRAM2.start) : SRAM1.offset + (a - SRAM1.start);
    else if (a >= SRAM0.start && a < SRAM1_I_START) o = SRAM0.offset + (a - SRAM0.start);
    else if (a >= RTC_FAST.start && a < RTC_FAST.start + RTC_FAST.size) o = RTC_FAST.offset + (a - RTC_FAST.start);
    else if (a >= RTC_SLOW.start && a < RTC_SLOW.start + RTC_SLOW.size) o = RTC_SLOW.offset + (a - RTC_SLOW.start);
    if (o < 0) return false;
    this.bytes[o] = value & 0xff;
    if (this.code[o >>> 12] !== 0) this.memory.codeWritten(o);
    return true;
  }

  /** An aligned word on the instruction bus (data load or fetch: `cause` on failure). */
  private instructionWord(a: number, cause: number): number {
    if (a < 0x40070000) {
      // ROM0, then ROM1's instruction-bus view at 0x40060000: contiguous in the buffer.
      if (a < 0x40008000 && this.parts.dport.bootRemap(this.cpu)) return this.words[this.sram1Instruction(a - 0x40000000 + 0x400b0000)];
      return this.words[(ROM0.offset + (a - ROM0.start)) >>> 2];
    }
    if (a < 0x400a0000) {
      if (a < 0x40080000 && this.cachePoolBusy(a)) return 0;
      return this.words[(SRAM0.offset + (a - SRAM0.start)) >>> 2];
    }
    if (a >= 0x400a0000 && a < 0x400c0000) {
      if (a >= 0x400b0000 && a < 0x400b8000 && this.parts.dport.bootRemap(this.cpu)) throw new XtensaBusError('SRAM1 remapped to ROM0', a, cause);
      return this.words[this.sram1Instruction(a)];
    }
    if (a >= 0x400c0000 && a < 0x400c2000) {
      if (!this.rtcFastAllowed(a)) return 0;
      return this.words[(RTC_FAST.offset + (a - 0x400c0000)) >>> 2];
    }
    if (a >= 0x400c2000 && a < 0x40c00000) {
      const o = this.flashPage(a, K_FLASH_I) + (a & 0xffff);
      this.cached(o);
      return this.flashWords[o >>> 2];
    }
    throw new XtensaBusError(cause === FETCH_ERROR ? 'unmapped fetch' : 'unmapped load', a, cause);
  }

  private instructionWrite(a: number, value: number): void {
    if (a < 0x40070000) {
      if (a < 0x40008000 && this.parts.dport.bootRemap(this.cpu)) {
        this.storeWord(this.sram1Instruction(a - 0x40000000 + 0x400b0000), value);
        return;
      }
      this.romWrite(a, value);
      return;
    }
    if (a < 0x400a0000) {
      if (a < 0x40080000 && this.cachePoolBusy(a)) return;
      this.storeWord((SRAM0.offset + (a - SRAM0.start)) >>> 2, value);
      return;
    }
    if (a >= 0x400a0000 && a < 0x400c0000) {
      if (a >= 0x400b0000 && a < 0x400b8000 && this.parts.dport.bootRemap(this.cpu)) throw new XtensaBusError('SRAM1 remapped to ROM0', a, LOAD_STORE_ERROR);
      this.storeWord(this.sram1Instruction(a), value);
      return;
    }
    if (a >= 0x400c0000 && a < 0x400c2000) {
      if (this.rtcFastAllowed(a)) this.storeWord((RTC_FAST.offset + (a - 0x400c0000)) >>> 2, value);
      return;
    }
    if (a >= 0x400c2000 && a < 0x40c00000) {
      this.flashPage(a, K_FLASH_I); // a fault if unmapped
      if (this.parts.problems.admit(CODE.FLASH_WRITE, a)) this.parts.problems.add('warning', CODE.FLASH_WRITE, a, `write ${hex(value)} to flash-mapped ${hex(a)} at PC ${hex(this.pc())} ignored (the cache is read-only)`);
      return;
    }
    throw new XtensaBusError('unmapped store', a, LOAD_STORE_ERROR);
  }

  /** Stores word `index` of the buffer (instruction-bus stores), invalidating predecoded code there. */
  private storeWord(index: number, value: number): void {
    this.words[index] = value;
    if (this.code[index >>> 10] !== 0) this.memory.codeWritten(index << 2);
  }

  /** Word index in `words` of SRAM1's instruction-bus address `a` (word-inverted, §3.3.2.4). */
  private sram1Instruction(a: number): number {
    const dataOffset = 0x20000 - ((a - memory.SRAM1_I_START) & ~3) - 4;
    return (SRAM1.offset + dataOffset) >>> 2;
  }

  /** An aligned data-bus (or RTC SLOW) access of 1, 2 or 4 bytes. */
  private dataRead(a: number, size: number): number {
    if (a >= PERIPH_BASE && a < PERIPH_END) return this.periphRead(a, size);
    if (a >= AHB_BASE && a < AHB_BASE + AHB_SIZE) return this.periphRead(AHB_TARGET + (a - AHB_BASE), size);
    if (a >= 0x3f400000 && a < 0x3f800000) {
      const off = this.flashPage(a, K_FLASH_D) + (a & 0xffff);
      this.cached(off);
      const f = this.flash;
      return size === 1 ? f[off] : size === 2 ? f[off] | (f[off + 1] << 8) : this.flashWords[off >>> 2];
    }
    const o = this.dataOffset(a, false);
    if (o < 0) return 0;
    const m = this.bytes;
    return size === 1 ? m[o] : size === 2 ? m[o] | (m[o + 1] << 8) : this.words[o >>> 2];
  }

  private dataWrite(a: number, value: number, size: number): void {
    if (a >= PERIPH_BASE && a < PERIPH_END) {
      this.periphWrite(a, value, size);
      return;
    }
    if (a >= AHB_BASE && a < AHB_BASE + AHB_SIZE) {
      this.periphWrite(AHB_TARGET + (a - AHB_BASE), value, size);
      return;
    }
    if (a >= 0x3f400000 && a < 0x3f800000) {
      this.flashPage(a, K_FLASH_D);
      if (this.parts.problems.admit(CODE.FLASH_WRITE, a)) this.parts.problems.add('warning', CODE.FLASH_WRITE, a, `write ${hex(value)} to flash-mapped ${hex(a)} at PC ${hex(this.pc())} ignored (the cache is read-only)`);
      return;
    }
    if (a >= ROM1.start && a < ROM1.start + ROM1.size) {
      this.romWrite(a, value);
      return;
    }
    const o = this.dataOffset(a, true);
    if (o < 0) return;
    const m = this.bytes;
    if (size === 1) m[o] = value;
    else if (size === 2) {
      m[o] = value;
      m[o + 1] = value >>> 8;
    } else this.words[o >>> 2] = value;
    if (this.code[o >>> 12] !== 0) this.memory.codeWritten(o);
  }

  /** The buffer offset of data-bus address `a`, −1 for an access that is dropped, or a throw. */
  private dataOffset(a: number, write: boolean): number {
    if (this.cpu === 1 && a >= APP_ROM_WINDOW_START && a < APP_ROM_WINDOW_END) a += APP_ROM_WINDOW_SHIFT;
    if (a >= SRAM2.start && a < 0x40000000) {
      if (a < SRAM1.start) return SRAM2.offset + (a - SRAM2.start);
      return SRAM1.offset + (a - SRAM1.start);
    }
    if (a >= ROM1.start && a < ROM1.start + ROM1.size) return ROM1.offset + (a - ROM1.start);
    if (a >= RTC_FAST.start && a < RTC_FAST.start + RTC_FAST.size) return this.rtcFastAllowed(a) ? RTC_FAST.offset + (a - RTC_FAST.start) : -1;
    if (a >= RTC_SLOW.start && a < RTC_SLOW.start + RTC_SLOW.size) return RTC_SLOW.offset + (a - RTC_SLOW.start);
    if (a >= 0x3f800000 && a < 0x3fc00000) {
      this.parts.problems.report('error', CODE.PSRAM, a, `PSRAM access at ${hex(a)} (PC ${hex(this.pc())}): external RAM is not emulated`);
      throw new Error(`PSRAM (0x3F800000–0x3FBFFFFF) is not emulated: ${write ? 'store to' : 'load from'} ${hex(a)}`);
    }
    throw new XtensaBusError(write ? 'unmapped store' : 'unmapped load', a, LOAD_STORE_ERROR);
  }

  private periphRead(a: number, size: number): number {
    if (!this.parts.peripheralTurn(this.cpu)) throw BUS_YIELD;
    const word = this.parts.periph.read32((a & ~3) >>> 0, this.pc());
    if (size === 4) return word;
    return (word >>> ((a & 3) * 8)) & (size === 1 ? 0xff : 0xffff);
  }

  private periphWrite(a: number, value: number, size: number): void {
    if (!this.parts.peripheralTurn(this.cpu)) throw BUS_YIELD;
    const w = (a & ~3) >>> 0;
    if (size === 4) {
      this.parts.periph.write32(w, value, this.pc());
      return;
    }
    const shift = (a & 3) * 8;
    const mask = (size === 1 ? 0xff : 0xffff) << shift;
    const old = this.parts.periph.read32(w, this.pc());
    this.parts.periph.write32(w, ((old & ~mask) | ((value << shift) & mask)) >>> 0, this.pc());
  }

  private romWrite(a: number, value: number): void {
    if (this.parts.problems.admit(CODE.ROM_WRITE, a)) this.parts.problems.add('warning', CODE.ROM_WRITE, a, `write ${hex(value)} to ROM at ${hex(a)} (PC ${hex(this.pc())}) ignored`);
  }

  private rtcFastAllowed(a: number): boolean {
    if (this.cpu === 0) return true;
    if (this.parts.problems.admit(CODE.RTC_FAST_APP, a)) this.parts.problems.add('warning', CODE.RTC_FAST_APP, a, `APP_CPU access to RTC FAST memory at ${hex(a)} (PC ${hex(this.pc())}): only the PRO_CPU can reach it; reads 0`);
    return false;
  }

  /** Is the SRAM0 cache pool holding `a` in use by an enabled cache (TRM Table 3.3-5)? */
  private cachePoolBusy(a: number): boolean {
    const pool = a < 0x40078000 ? 0 : 1;
    const dport = this.parts.dport;
    const mode = dport.cacheMuxMode();
    // Which CPUs' caches use this pool in each mode.
    const users = mode === 0 ? (pool === 0 ? 1 : 2) : mode === 1 ? (pool === 0 ? 3 : 0) : mode === 2 ? (pool === 1 ? 3 : 0) : pool === 0 ? 2 : 1;
    const busy = ((users & 1) !== 0 && dport.cacheEnabled(0)) || ((users & 2) !== 0 && dport.cacheEnabled(1));
    if (busy && this.parts.problems.admit(CODE.CACHE_SRAM, a)) {
      this.parts.problems.add('warning', CODE.CACHE_SRAM, a, `access to SRAM0 cache memory at ${hex(a)} (PC ${hex(this.pc())}) while a cache uses it; reads 0`);
    }
    return busy;
  }

  /** The flash offset of `a`'s 64 KB page, arming the page when it's wholly flash; faults the core otherwise. */
  private flashPage(a: number, k: number): number {
    const off = this.parts.mmu.translate(this.cpu, a, this.flash.length);
    if (off < 0) throw new Error(this.parts.mmu.describe(this.cpu, a, off));
    const p = a >>> 16;
    if (p !== 0x400c && this.regionAllowsAll(a)) {
      this.kind[p] = k;
      this.base[p] = off;
    }
    return off;
  }
}

