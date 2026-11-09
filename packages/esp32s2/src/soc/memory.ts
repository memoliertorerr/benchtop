/**
 * The ESP32-S2's memories (BT148; soc.h, cache_memory.h, the S2 TRM's address map):
 *
 *   ROM     128 KB at 0x4000_0000 (instruction bus); its second 64 KB also on the data bus at
 *           0x3FFA_0000 (`.rodata`).
 *   SRAM    320 KB seen on both buses: instruction 0x4002_0000–0x4006_FFFF, data
 *           0x3FFB_0000–0x3FFF_FFFF (SOC_I_D_OFFSET 0x7_0000). One buffer: an instruction address
 *           is `a − 0x4002_0000` into it, a data address `a − 0x3FFB_0000`. The bootloader gives
 *           the start of it to the caches (the build's 8 KB ICache and 8 KB DCache); the app
 *           doesn't place anything there, and nothing models the cache's use of it.
 *   RTC     fast memory 8 KB at 0x3FF9_E000 (data) / 0x4007_0000 (instruction); slow memory 8 KB
 *           at 0x5000_0000.
 *   Flash   through the cache and the MMU (soc.ts): IBUS0 0x4000_0000–0x403F_FFFF (flash from
 *           0x4008_0000), IBUS1 0x4040_0000, DBUS0 0x3F00_0000 (DROM), DBUS1 0x3F80_0000 and DBUS2
 *           0x3F40_0000 (flash from 0x3F50_0000) — 64 entries of 64 KB each.
 *   Periph  0x3F40_0000–0x3F4F_FFFF (PeriBus1) and 0x6000_0000–0x600F_FFFF (PeriBus2, the same
 *           registers), in 4 KB blocks (periph.ts); EXTMEM and the MMU table at 0x6180_0000.
 */

export const ROM_BASE = 0x40000000;
export const ROM_SIZE = 0x20000;
/** The ROM's data-bus view: 0x3FFA_0000 is ROM offset 0x1_0000. */
export const DROM_BASE = 0x3ffa0000;
export const DROM_SIZE = 0x10000;
export const DROM_ROM_OFFSET = 0x10000;

export const SRAM_SIZE = 0x50000;
export const IRAM_BASE = 0x40020000;
export const IRAM_END = 0x40070000;
export const DRAM_BASE = 0x3ffb0000;
export const DRAM_END = 0x40000000;

export const RTC_FAST_BASE = 0x3ff9e000;
export const RTC_FAST_IBASE = 0x40070000;
export const RTC_FAST_SIZE = 0x2000;
export const RTC_SLOW_BASE = 0x50000000;
export const RTC_SLOW_SIZE = 0x2000;

/** PeriBus1 (the data bus) and PeriBus2: the same peripherals, 1 MB each. */
export const PERIBUS1 = 0x3f400000;
export const PERIBUS2 = 0x60000000;
export const PERIBUS_SIZE = 0x100000;

export class S2Memory {
  readonly rom = new Uint8Array(ROM_SIZE);
  readonly sram = new Uint8Array(SRAM_SIZE);
  readonly rtcFast = new Uint8Array(RTC_FAST_SIZE);
  readonly rtcSlow = new Uint8Array(RTC_SLOW_SIZE);

  /** The array and offset behind a RAM or ROM address (either bus), or null. */
  locate(address: number): { array: Uint8Array; offset: number } | null {
    const a = address >>> 0;
    if (a >= IRAM_BASE && a < IRAM_END) return { array: this.sram, offset: a - IRAM_BASE };
    if (a >= DRAM_BASE && a < DRAM_END) return { array: this.sram, offset: a - DRAM_BASE };
    if (a >= ROM_BASE && a < ROM_BASE + ROM_SIZE) return { array: this.rom, offset: a - ROM_BASE };
    if (a >= DROM_BASE && a < DROM_BASE + DROM_SIZE) return { array: this.rom, offset: DROM_ROM_OFFSET + (a - DROM_BASE) };
    if (a >= RTC_FAST_BASE && a < RTC_FAST_BASE + RTC_FAST_SIZE) return { array: this.rtcFast, offset: a - RTC_FAST_BASE };
    if (a >= RTC_FAST_IBASE && a < RTC_FAST_IBASE + RTC_FAST_SIZE) return { array: this.rtcFast, offset: a - RTC_FAST_IBASE };
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
