/**
 * The ESP32-S3's memories (BT124; soc.h, the S3 TRM's address map):
 *
 *   ROM     384 KB at 0x4000_0000 (instruction bus); its last 128 KB also on the data bus at
 *           0x3FF0_0000 (`.rodata`), as on the C3.
 *   SRAM    512 KB: SRAM0 32 KB (instruction bus only, 0x4037_0000), SRAM1 416 KB on both buses
 *           (0x4037_8000 / 0x3FC8_8000 — SOC_I_D_OFFSET 0x6F_0000), SRAM2 64 KB (data bus only,
 *           0x3FCF_0000). One buffer, in that order: an instruction address is `a − 0x4037_0000`
 *           into it, a data address `a − 0x3FC8_0000`.
 *   RTC     fast memory 8 KB at 0x600F_E000 (both buses), slow memory 8 KB at 0x5000_0000.
 *   Flash   through the cache: IBUS 0x4200_0000 and DBUS 0x3C00_0000, 32 MB each, 64 KB pages
 *           through one 512-entry MMU table (0x600C_5000; extmem.ts).
 *   Periph  0x6000_0000–0x600D_0FFF in 4 KB blocks (periph.ts).
 */

export const ROM_BASE = 0x40000000;
export const ROM_SIZE = 0x60000;
/** The ROM's data-bus view: 0x3FF0_0000 is ROM offset 0x4_0000. */
export const DROM_BASE = 0x3ff00000;
export const DROM_SIZE = 0x20000;
export const DROM_ROM_OFFSET = 0x40000;

export const SRAM_SIZE = 0x80000;
export const IRAM_BASE = 0x40370000;
export const IRAM_END = 0x403e0000;
export const DRAM_BASE = 0x3fc88000;
export const DRAM_END = 0x3fd00000;
/** Data address → SRAM buffer offset: a − DRAM_ORIGIN. */
export const DRAM_ORIGIN = 0x3fc80000;
/** SRAM1's data address minus its instruction address (soc.h SOC_I_D_OFFSET, negated). */
export const DRAM_TO_IRAM = 0x6f0000;

export const RTC_FAST_BASE = 0x600fe000;
export const RTC_FAST_SIZE = 0x2000;
export const RTC_SLOW_BASE = 0x50000000;
export const RTC_SLOW_SIZE = 0x2000;

export const IROM_BASE = 0x42000000;
export const DROM_FLASH_BASE = 0x3c000000;
/** 512 MMU entries × 64 KB. */
export const FLASH_WINDOW = 0x2000000;

export const PERIPH_BASE = 0x60000000;
export const PERIPH_END = 0x600d1000;

export class S3Memory {
  readonly rom = new Uint8Array(ROM_SIZE);
  readonly sram = new Uint8Array(SRAM_SIZE);
  readonly rtcFast = new Uint8Array(RTC_FAST_SIZE);
  readonly rtcSlow = new Uint8Array(RTC_SLOW_SIZE);

  /** The array and offset behind a RAM or ROM address (either bus), or null. */
  locate(address: number): { array: Uint8Array; offset: number } | null {
    const a = address >>> 0;
    if (a >= IRAM_BASE && a < IRAM_END) return { array: this.sram, offset: a - IRAM_BASE };
    if (a >= DRAM_BASE && a < DRAM_END) return { array: this.sram, offset: a - DRAM_ORIGIN };
    if (a >= ROM_BASE && a < ROM_BASE + ROM_SIZE) return { array: this.rom, offset: a - ROM_BASE };
    if (a >= DROM_BASE && a < DROM_BASE + DROM_SIZE) return { array: this.rom, offset: DROM_ROM_OFFSET + (a - DROM_BASE) };
    if (a >= RTC_FAST_BASE && a < RTC_FAST_BASE + RTC_FAST_SIZE) return { array: this.rtcFast, offset: a - RTC_FAST_BASE };
    if (a >= RTC_SLOW_BASE && a < RTC_SLOW_BASE + RTC_SLOW_SIZE) return { array: this.rtcSlow, offset: a - RTC_SLOW_BASE };
    return null;
  }

  /** Copies `data` to `address` (ROM, SRAM or RTC memory); throws when it doesn't fit one region. */
  load(address: number, data: Uint8Array): void {
    const at = this.locate(address);
    if (at === null || at.offset + data.length > at.array.length) throw new Error(`0x${(address >>> 0).toString(16)} (+${data.length}) is not ROM, SRAM or RTC memory`);
    at.array.set(data, at.offset);
  }

  /** SRAM and RTC memory to zero (a power-on). */
  clearRam(): void {
    this.sram.fill(0);
    this.rtcFast.fill(0);
    this.rtcSlow.fill(0);
  }
}
