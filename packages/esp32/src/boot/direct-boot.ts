/**
 * Direct boot (BT32): what the ROM bootstrap and IDF's second-stage bootloader would leave
 * behind, set up directly, then the PRO_CPU at the app's entry point. Every item is listed with
 * its source in docs/ARCHITECTURE.md ("ESP32 direct boot"). In short:
 *   - flash: partition table at 0x8000, app at its partition (flash-image.ts);
 *   - ROM: ROM0 loaded, its RAM data unpacked from _rom_store_table (rom.ts);
 *   - MMU: both CPUs' tables map each DROM/IROM segment's pages to the flash pages they occupy
 *     (vaddr − flash offset must agree mod 64 KB); every other entry invalid; the IRAM0 and DROM0
 *     masks cleared in both DPORT_x_CACHE_CTRL1; the PRO cache enabled, the APP cache disabled
 *     (call_start_cpu0 enables it with Cache_Read_Enable(1));
 *   - RAM segments copied to DRAM/IRAM/RTC memory;
 *   - g_rom_flashchip (0x3ffae270): JEDEC ID, size from the header, 64 KB blocks, 4 KB sectors,
 *     256-byte pages, status mask 0xFFFF;
 *   - RTC_CNTL_STORE4 = 0x00280028 (40 MHz XTAL), RESET_STATE = the reset cause for both CPUs;
 *   - TIMG0/1 MWDT and the RTC WDT off (flash-boot mode cleared);
 *   - CPU clock: the power-on XTAL configuration (esp_clk_init programs the PLL), and
 *     g_ticks_per_us = 40 as the ROM startup's ets_update_cpu_frequency leaves it;
 *   - PRO_CPU as the bootloader's `callx8 entry` leaves it; APP_CPU in reset.
 *
 * `directBoot` builds the flash and loads the ROM once, then boots; it also installs the boot as
 * the SoC's `bootLoader`, so a reboot (BT33) runs every step after the flash again — the flash
 * keeps what the firmware wrote (NVS), the image's RAM segments come from the loaded image.
 */

import { SR } from '../xtensa/regs.ts';
import type { Esp32Soc } from '../soc/soc.ts';
import { CACHE_ENABLE, CACHE_MASK, FlashMmu } from '../soc/mmu.ts';
import { JEDEC_ID } from '../soc/flash.ts';
import { RESET_REASON } from '../soc/reset.ts';
import { buildFlash, type FlashLayout } from './flash-image.ts';
import { type RomImage, unpackRomData } from './rom.ts';

export const ROM_STACK_TOP = 0x3ffe3f20; // ROM `__stack`
export const G_ROM_FLASHCHIP = 0x3ffae270;
export const G_TICKS_PER_US = 0x3ffe01e0;
/** PS as `callx8` into the entry leaves it: WOE | CALLINC = 2 | UM, INTLEVEL 0, EXCM 0. */
export const ENTRY_PS = 0x00060020;
/** The root frame's return address: window increment 2 to PC 0 (returning faults "app returned"). */
export const ROOT_RETURN = 0x80000000;

export interface DirectBootOptions {
  app: Uint8Array;
  /** The firmware's partition table (`.partitions.bin`); DEFAULT_PARTITIONS without one. */
  partitions?: Uint8Array;
  rom: RomImage;
}

export type DirectBoot = { ok: true; layout: FlashLayout; entry: number; romEntries: number } | { ok: false; error: string };

export function directBoot(soc: Esp32Soc, options: DirectBootOptions): DirectBoot {
  const built = buildFlash(options.app, options.partitions);
  if (!built.ok) return built;
  const layout = built.layout;
  // Check the segment ↔ flash page agreement before touching the SoC.
  for (const segment of layout.image.segments) {
    if (segment.region !== 'DROM' && segment.region !== 'IROM') continue;
    const flashAddress = layout.app.offset + segment.fileOffset;
    if (((segment.loadAddress - flashAddress) & 0xffff) !== 0) {
      return { ok: false, error: `segment at 0x${segment.loadAddress.toString(16)} and its flash offset 0x${flashAddress.toString(16)} differ by a non-multiple of 64 KB` };
    }
    const first = segment.loadAddress & ~0xffff;
    const last = (segment.loadAddress + Math.max(segment.data.length, 1) - 1) & ~0xffff;
    if (FlashMmu.entryOf(first) < 0 || FlashMmu.entryOf(last) < 0) return { ok: false, error: `segment at 0x${segment.loadAddress.toString(16)} is outside the flash windows` };
  }

  soc.setFlash(layout.flash);
  soc.setFlashTiming(layout.image.spiMode, layout.image.spiSpeed);
  soc.loadRom(options.rom);
  try {
    const romEntries = bootImage(soc, layout, RESET_REASON.POWERON);
    soc.bootLoader = (reason) => {
      bootImage(soc, layout, reason);
    };
    soc.boots = 1;
    soc.bootTime = soc.time;
    return { ok: true, layout, entry: layout.image.entry, romEntries };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

/**
 * One boot of the image already in flash: everything the ROM and the bootloader leave, with
 * `reason` as the reset cause. Returns the number of ROM data table entries.
 */
function bootImage(soc: Esp32Soc, layout: FlashLayout, reason: number): number {
  const { image, app } = layout;
  const bus = soc.buses[0];
  const romEntries = unpackRomData(bus);

  // MMU and cache.
  for (const segment of image.segments) {
    if (segment.region !== 'DROM' && segment.region !== 'IROM') continue;
    const flashAddress = app.offset + segment.fileOffset;
    const first = segment.loadAddress & ~0xffff;
    const last = (segment.loadAddress + Math.max(segment.data.length, 1) - 1) & ~0xffff;
    for (let page = first; page <= last; page += 0x10000) {
      const entry = FlashMmu.entryOf(page);
      const flashPage = ((flashAddress & ~0xffff) + (page - first)) >>> 16;
      bus.write32(0x3ff10000 + entry * 4, flashPage); // PRO table
      bus.write32(0x3ff12000 + entry * 4, flashPage); // APP table
    }
  }
  const masks = CACHE_MASK.IRAM0 | CACHE_MASK.DROM0;
  bus.write32(0x3ff00044, bus.read32(0x3ff00044) & ~masks); // DPORT_PRO_CACHE_CTRL1
  bus.write32(0x3ff0005c, bus.read32(0x3ff0005c) & ~masks); // DPORT_APP_CACHE_CTRL1
  bus.write32(0x3ff00040, bus.read32(0x3ff00040) | CACHE_ENABLE); // DPORT_PRO_CACHE_CTRL
  bus.write32(0x3ff00058, bus.read32(0x3ff00058) & ~CACHE_ENABLE); // DPORT_APP_CACHE_CTRL

  // RAM segments.
  for (const segment of image.segments) {
    if (segment.region === 'DROM' || segment.region === 'IROM') continue;
    try {
      soc.memory.load(segment.loadAddress, segment.data);
    } catch (error) {
      throw new Error(`segment at 0x${segment.loadAddress.toString(16)}: ${(error as Error).message}`);
    }
  }

  // g_rom_flashchip: device_id as bootloader_read_flash_id returns it (manufacturer high).
  const words = [(JEDEC_ID[0] << 16) | (JEDEC_ID[1] << 8) | JEDEC_ID[2], layout.flash.length, 0x10000, 0x1000, 0x100, 0xffff];
  words.forEach((w, i) => bus.write32(G_ROM_FLASHCHIP + i * 4, w));

  // The ROM's CPU-frequency variable (g_ticks_per_us, written by ets_update_cpu_frequency at
  // 0x40008550): its startup leaves the XTAL frequency in MHz; esp_rom_delay_us scales by it.
  bus.write32(G_TICKS_PER_US, 40);

  // RTC_CNTL: XTAL frequency, reset causes, watchdogs off.
  bus.write32(0x3ff480b0, 0x00280028); // STORE4
  soc.rtc.setResetCause(reason); // RESET_STATE (read-only to software)
  bus.write32(0x3ff4808c, bus.read32(0x3ff4808c) & ~((1 << 31) | (1 << 10))); // RTC WDTCONFIG0: WDT_EN, FLASHBOOT_MOD_EN
  for (const base of [0x3ff5f000, 0x3ff60000]) bus.write32(base + 0x48, 0); // TIMGn WDTCONFIG0

  // The PRO_CPU, as `callx8 entry` leaves it.
  const core = soc.cores[0];
  core.pc = image.entry;
  core.writeSpecial(SR.WINDOWBASE, 0);
  core.writeSpecial(SR.WINDOWSTART, 1);
  core.writeSpecial(SR.VECBASE, 0x40000000);
  core.writeSpecial(SR.PS, ENTRY_PS);
  core.setReg(1, ROM_STACK_TOP);
  core.setReg(8, ROOT_RETURN);
  core.setReg(9, ROM_STACK_TOP - 64);
  bus.write32(ROM_STACK_TOP - 12, ROM_STACK_TOP); // the root frame's caller SP, for its spill
  return romEntries;
}
