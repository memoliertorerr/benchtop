/**
 * The ESP32-C3's memories (BT92; ESP32-C3 TRM v1.0 §3.3, "Address Mapping"):
 *
 *   ROM     384 KB  IBUS 0x4000_0000–0x4005_FFFF; its last 128 KB (ROM1) also on DBUS at
 *                   0x3FF0_0000–0x3FF1_FFFF
 *   SRAM0    16 KB  IBUS 0x4037_C000–0x4037_FFFF (the ICache's memory; usable as IRAM)
 *   SRAM1   384 KB  IBUS 0x4038_0000–0x403D_FFFF and DBUS 0x3FC8_0000–0x3FCD_FFFF: the same
 *                   bytes through both buses (IRAM = DRAM + 0x70_0000)
 *   RTC FAST  8 KB  0x5000_0000–0x5000_1FFF on both buses
 *   flash           through the cache: IBUS 0x4200_0000–0x427F_FFFF, DBUS 0x3C00_0000–0x3C7F_FFFF,
 *                   both mapped by one 128-entry MMU table (64 KB pages; mmu.ts)
 *
 * `region(address)` says which plain memory holds an address and at which index, so the bus can
 * dispatch with one call; flash and peripherals answer -1 there.
 */

export const ROM_BASE = 0x40000000;
export const ROM_SIZE = 0x60000;
/** ROM1 on the data bus. */
export const DROM_BASE = 0x3ff00000;
export const DROM_SIZE = 0x20000;
/** Where DROM_BASE lands in the ROM image. */
export const DROM_ROM_OFFSET = 0x40000;

/** SRAM0 + SRAM1 as one array: index 0 is IBUS 0x4037C000. */
export const IRAM_BASE = 0x4037c000;
export const SRAM_SIZE = 0x64000;
export const IRAM_END = IRAM_BASE + SRAM_SIZE;
/** SRAM1 on the data bus. */
export const DRAM_BASE = 0x3fc80000;
export const DRAM_END = 0x3fce0000;
/** DRAM address + this = the same byte's IRAM address. */
export const DRAM_TO_IRAM = 0x700000;
/** DRAM_BASE's index in the SRAM array (SRAM0 has no data-bus view). */
const DRAM_INDEX = DRAM_BASE + DRAM_TO_IRAM - IRAM_BASE;

export const RTC_FAST_BASE = 0x50000000;
export const RTC_FAST_SIZE = 0x2000;

export const IROM_BASE = 0x42000000;
export const DROM_FLASH_BASE = 0x3c000000;
export const FLASH_WINDOW = 0x800000;

export const PERIPH_BASE = 0x60000000;
export const PERIPH_END = 0x600d1000;

/** Which memory `region` found. */
export const MEM = { NONE: 0, ROM: 1, SRAM: 2, RTC: 3 } as const;

export class C3Memory {
  readonly rom = new Uint8Array(ROM_SIZE);
  readonly sram = new Uint8Array(SRAM_SIZE);
  readonly rtcFast = new Uint8Array(RTC_FAST_SIZE);
  /** Set by `region`: the array index of the address it was asked about. */
  index = 0;

  /** MEM.* for `address` (a plain memory), setting `index`; MEM.NONE otherwise. */
  region(address: number): number {
    if (address >= IRAM_BASE && address < IRAM_END) {
      this.index = address - IRAM_BASE;
      return MEM.SRAM;
    }
    if (address >= DRAM_BASE && address < DRAM_END) {
      this.index = address - DRAM_BASE + DRAM_INDEX;
      return MEM.SRAM;
    }
    if (address >= ROM_BASE && address < ROM_BASE + ROM_SIZE) {
      this.index = address - ROM_BASE;
      return MEM.ROM;
    }
    if (address >= DROM_BASE && address < DROM_BASE + DROM_SIZE) {
      this.index = address - DROM_BASE + DROM_ROM_OFFSET;
      return MEM.ROM;
    }
    if (address >= RTC_FAST_BASE && address < RTC_FAST_BASE + RTC_FAST_SIZE) {
      this.index = address - RTC_FAST_BASE;
      return MEM.RTC;
    }
    return MEM.NONE;
  }

  array(kind: number): Uint8Array {
    return kind === MEM.ROM ? this.rom : kind === MEM.SRAM ? this.sram : this.rtcFast;
  }

  /** Copies `data` to `address` (SRAM through either bus, RTC FAST, or ROM at load). */
  load(address: number, data: Uint8Array): void {
    const kind = this.region(address);
    if (kind === MEM.NONE) throw new Error(`0x${address.toString(16)} is not in a memory`);
    const target = this.array(kind);
    if (this.index + data.length > target.length) throw new Error(`${data.length} bytes at 0x${address.toString(16)} run past the memory`);
    target.set(data, this.index);
  }

  /** Power-on: RAM back to zeros (the ROM stays). */
  clearRam(): void {
    this.sram.fill(0);
    this.rtcFast.fill(0);
  }
}
