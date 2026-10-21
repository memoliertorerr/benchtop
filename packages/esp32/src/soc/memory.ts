/**
 * The ESP32's memories (TRM v5.8 §3.3.2 "Embedded Memory", Table 3.3-2), held in one buffer so
 * the bus's fast path indexes a single Uint8Array/Uint32Array pair, plus the SPI flash behind
 * the cache (§3.3.3). Offsets are chosen so each memory's 64 KB pages map to contiguous buffer
 * ranges: page p of a region starts at `offset + (p << 16) − start`.
 *
 * The Uint32Array views assume a little-endian host, which every engine Benchtop runs on is
 * (x86-64, ARM64): the ESP32 is little-endian too, so a view word equals a bus word. The
 * constructor checks it.
 */

/** A memory: its data-bus (or only) address, size and offset in EspMemory.bytes. */
export interface SocMemory {
  readonly start: number;
  readonly size: number;
  readonly offset: number;
}

export const ROM0: SocMemory = { start: 0x40000000, size: 0x60000, offset: 0x000000 }; // 384 KB, I bus
export const ROM1: SocMemory = { start: 0x3ff90000, size: 0x10000, offset: 0x060000 }; // 64 KB, D bus
export const SRAM0: SocMemory = { start: 0x40070000, size: 0x30000, offset: 0x070000 }; // 192 KB, I bus
/** SRAM1 by its data-bus address; the instruction bus sees it word-inverted at 0x400A0000. */
export const SRAM1: SocMemory = { start: 0x3ffe0000, size: 0x20000, offset: 0x0a0000 }; // 128 KB
/** SRAM2 0x3FFAE000–0x3FFDFFFF; its page 0x3FFA starts at buffer offset 0x0C0000. */
export const SRAM2: SocMemory = { start: 0x3ffae000, size: 0x32000, offset: 0x0ce000 }; // 200 KB, D bus
/** RTC FAST by its data-bus address (PRO_CPU only); the instruction bus sees it at 0x400C0000. */
export const RTC_FAST: SocMemory = { start: 0x3ff80000, size: 0x2000, offset: 0x100000 }; // 8 KB
export const RTC_SLOW: SocMemory = { start: 0x50000000, size: 0x2000, offset: 0x102000 }; // 8 KB, shared
/** Buffer size, plus 4 bytes so a 3-byte fetch at the very end reads zeros. */
export const MEMORY_BYTES = 0x104000 + 4;

export const SRAM1_I_START = 0x400a0000;
/** ROM1's instruction-bus view (soc.h SOC_IROM_MASK_HIGH 0x40070000). */
export const ROM1_I_START = 0x40060000;
export const RTC_FAST_I_START = 0x400c0000;
export const FLASH_PAGE = 0x10000;
export const DEFAULT_FLASH_SIZE = 4 * 1024 * 1024;

export class EspMemory {
  readonly bytes = new Uint8Array(MEMORY_BYTES);
  readonly words = new Uint32Array(this.bytes.buffer, 0, MEMORY_BYTES >>> 2);
  /**
   * Per 4 KB of `bytes`: 1 while a core's predecode cache holds code from it (BT37). A store
   * there calls `codeWritten` (the SoC drops the cached pages), which clears the mark.
   */
  readonly code = new Uint8Array((MEMORY_BYTES >>> 12) + 1);
  codeWritten: (offset: number) => void = () => {};
  /** SPI flash; erased flash reads 0xFF. */
  flash: Uint8Array = new Uint8Array(0);
  flashWords: Uint32Array = new Uint32Array(0);

  constructor(flashSize = DEFAULT_FLASH_SIZE) {
    if (new Uint8Array(new Uint32Array([1]).buffer)[0] !== 1) throw new Error('EspMemory needs a little-endian host');
    this.setFlash(new Uint8Array(flashSize).fill(0xff));
  }

  /** Replaces the flash contents (a whole number of 64 KB pages). */
  setFlash(flash: Uint8Array): void {
    if (flash.length % FLASH_PAGE !== 0 || flash.length === 0) throw new Error(`flash size ${flash.length} is not a multiple of 64 KB`);
    this.flash = flash;
    this.flashWords = new Uint32Array(flash.buffer, flash.byteOffset, flash.length >>> 2);
  }

  /** Copies `data` to the memory at bus address `address` (data-bus addresses for D/I memories). */
  load(address: number, data: Uint8Array): void {
    if (address >= ROM1_I_START && address < ROM1_I_START + ROM1.size) address = address - ROM1_I_START + ROM1.start;
    for (const region of [ROM0, ROM1, SRAM0, SRAM1, SRAM2, RTC_FAST, RTC_SLOW]) {
      const o = address - region.start;
      if (o >= 0 && o + data.length <= region.size) {
        this.bytes.set(data, region.offset + o);
        for (let at = (region.offset + o) & ~0xfff; at < region.offset + o + data.length; at += 0x1000) if (this.code[at >>> 12] !== 0) this.codeWritten(at);
        return;
      }
    }
    throw new Error(`0x${address.toString(16)} (+${data.length}) is not inside one memory`);
  }
}
