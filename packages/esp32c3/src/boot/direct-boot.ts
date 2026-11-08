/**
 * Direct boot of an ESP32-C3 app image (BT92): what the ROM bootstrap and IDF's second-stage
 * bootloader would leave, set up directly, then the core at the app's entry (call_start_cpu0).
 * As for the ESP32 (@benchtop/esp32's direct-boot.ts):
 *   - flash: the partition table at 0x8000, the app at its partition (buildFlash, chip id 5);
 *   - ROM: code and DROM data loaded, its RAM sections placed (rom.ts);
 *   - MMU: each IROM/DROM segment's 64 KB pages mapped to the flash pages they occupy (the C3's
 *     two windows share one table, so their page indexes must not collide — IDF's linker script
 *     keeps them apart); every other entry invalid;
 *   - RAM segments copied (IRAM, DRAM, RTC FAST);
 *   - RTC_CNTL STORE4 = 40 MHz XTAL (rtc_clk_xtal_freq_get), the reset cause in RESET_STATE;
 *   - the ROM's s_ticks_per_us = 40, as its startup's ets_update_cpu_frequency leaves it
 *     (ets_delay_us counts CPU cycles by it);
 *   - TIMG0/1 MWDT and the RTC WDT off (the bootloader leaves them off without
 *     CONFIG_BOOTLOADER_WDT_ENABLE's handover);
 *   - the core in machine mode at the entry, sp at the top of the ROM's stack (0x3FCDE710,
 *     .stack_pro's end — where the bootloader runs), the CPU on the 40 MHz crystal (esp_clk_init
 *     moves it to the 160 MHz PLL).
 */

import { buildFlash, type EspChip, type FlashLayout, type FlashTarget, type ImageRegions } from '@benchtop/esp32';
import { RESET_REASON } from '../soc/rtc-cntl.ts';
import { type Esp32c3Soc, MMU_ENTRIES } from '../soc/soc.ts';
import { DROM_FLASH_BASE, IROM_BASE } from '../soc/memory.ts';
import type { C3Rom } from './rom.ts';

/** Where a C3 image's segments may load. */
export const C3_IMAGE_REGIONS: ImageRegions = [
  { region: 'DROM', start: 0x3c000000, end: 0x3c7fffff },
  { region: 'DRAM', start: 0x3fc80000, end: 0x3fcdffff },
  { region: 'IRAM', start: 0x4037c000, end: 0x403dffff },
  { region: 'IROM', start: 0x42000000, end: 0x427fffff },
  { region: 'RTC_FAST', start: 0x50000000, end: 0x50001fff },
];

export const ESP32C3_CHIP: EspChip = { name: 'ESP32-C3', chipId: 5, regions: C3_IMAGE_REGIONS };

/** The top of the ROM's `.stack_pro`. */
export const ROM_STACK_TOP = 0x3fcde710;
/** RTC_CNTL_STORE4: the crystal in MHz, twice. */
const XTAL_STORE = 0x00280028;

export interface C3DirectBootOptions {
  app: Uint8Array;
  partitions?: Uint8Array;
  rom: C3Rom;
  /** BT118: the board's flash, kept across resets: the image is written into it as an upload would. */
  flash?: FlashTarget;
  /** BT118: why it boots (RTC_CNTL's reset cause): power-on unless a system reset's. */
  reason?: number;
}

export type C3DirectBoot = { ok: true; layout: FlashLayout; entry: number } | { ok: false; error: string };

/** The MMU entry for a flash-window address (IROM or DROM), or -1. */
export function mmuEntryOf(address: number): number {
  for (const base of [IROM_BASE, DROM_FLASH_BASE]) if (address >= base && address < base + MMU_ENTRIES * 0x10000) return (address - base) >>> 16;
  return -1;
}

export function directBoot(soc: Esp32c3Soc, options: C3DirectBootOptions): C3DirectBoot {
  const built = buildFlash(options.app, options.partitions, ESP32C3_CHIP, options.flash);
  if (!built.ok) return built;
  const layout = built.layout;
  // BT143: the flash holds what the image asks for (an 8 or 16 MB build).
  if (layout.flash.length > soc.flash.data.length) soc.flash.data = layout.flash;
  // Plan the MMU first: every page of a flash segment, and no index used twice for different pages.
  const plan = new Map<number, number>();
  for (const segment of layout.image.segments) {
    if (segment.region !== 'DROM' && segment.region !== 'IROM') continue;
    const flashAddress = layout.app.offset + segment.fileOffset;
    if (((segment.loadAddress - flashAddress) & 0xffff) !== 0) {
      return { ok: false, error: `segment at 0x${segment.loadAddress.toString(16)} and its flash offset 0x${flashAddress.toString(16)} differ by a non-multiple of 64 KB` };
    }
    const first = segment.loadAddress & ~0xffff;
    const last = (segment.loadAddress + Math.max(segment.data.length, 1) - 1) & ~0xffff;
    for (let page = first; page <= last; page += 0x10000) {
      const entry = mmuEntryOf(page);
      const flashPage = ((flashAddress & ~0xffff) + (page - first)) >>> 16;
      if (entry < 0) return { ok: false, error: `segment at 0x${segment.loadAddress.toString(16)} is outside the flash windows` };
      const taken = plan.get(entry);
      if (taken !== undefined && taken !== flashPage) return { ok: false, error: `MMU entry ${entry} would map flash pages ${taken} and ${flashPage}` };
      plan.set(entry, flashPage);
    }
  }
  // BT118: the board's own flash (the Mcu's, written by buildFlash) is the chip's as it is.
  if (layout.flash !== soc.flash.data) {
    soc.flash.data.fill(0xff);
    soc.flash.data.set(layout.flash);
  }
  try {
    for (const section of options.rom.code) soc.memory.load(section.address, section.data);
    bootImage(soc, layout, options.rom, plan, options.reason ?? RESET_REASON.POWERON);
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
  return { ok: true, layout, entry: layout.image.entry };
}

function bootImage(soc: Esp32c3Soc, layout: FlashLayout, rom: C3Rom, plan: Map<number, number>, reason: number): void {
  // RTC fast memory survives every reset but a power-on (the Mcu carries it into the chip a reset builds).
  if (reason === RESET_REASON.POWERON) soc.memory.clearRam();
  else soc.memory.sram.fill(0);
  for (const section of rom.ram) soc.memory.load(section.address, section.data);
  const ticksPerUs = rom.symbols.get('s_ticks_per_us');
  if (ticksPerUs !== undefined) soc.memory.load(ticksPerUs, Uint8Array.of(40, 0, 0, 0));
  soc.mmu.fill(0x100);
  for (const [entry, page] of plan) soc.mmu[entry] = page;
  for (const segment of layout.image.segments) {
    if (segment.region === 'DROM' || segment.region === 'IROM') continue;
    // BT122: a deep sleep's wake keeps RTC_DATA_ATTR as the sleep left it (the bootloader skips RTC segments).
    if (reason === RESET_REASON.DEEPSLEEP && segment.region === 'RTC_FAST') continue;
    try {
      soc.memory.load(segment.loadAddress, segment.data);
    } catch (error) {
      throw new Error(`segment at 0x${segment.loadAddress.toString(16)}: ${(error as Error).message}`);
    }
  }
  const bus = soc.bus;
  bus.exact = true;
  try {
    bus.write32(0x600080b8, XTAL_STORE); // RTC_CNTL_STORE4
    bus.write32(0x60008090, bus.read32(0x60008090) & ~((1 << 31) | (1 << 12))); // RTC WDTCONFIG0: WDT_EN, FLASHBOOT_MOD_EN
    for (const base of [0x6001f000, 0x60020000]) {
      bus.write32(base + 0x64, 0x50d83aa1); // WDTWPROTECT: unlock
      bus.write32(base + 0x48, 0); // WDTCONFIG0
    }
  } finally {
    bus.exact = false;
  }
  soc.rtc.resetCause = reason;
  const core = soc.core;
  core.reset();
  core.pc = layout.image.entry;
  core.x[2] = ROM_STACK_TOP; // sp
}
