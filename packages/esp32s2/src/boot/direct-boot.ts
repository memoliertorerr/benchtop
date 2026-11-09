/**
 * Direct boot of an ESP32-S2 app image (BT148): what the ROM bootstrap and IDF's second-stage
 * bootloader would leave, set up directly, then the core at the app's entry (call_start_cpu0). As
 * for the other chips:
 *   - flash: the partition table at 0x8000, the app at its partition (buildFlash, chip id 2);
 *   - ROM: code and its data view loaded, its RAM sections placed (rom.ts);
 *   - MMU: each IROM/DROM segment's 64 KB pages mapped (ACCESS_FLASH | the flash page) in the
 *     window holding it (IBUS0 entries 0–63 from 0x4000_0000, IBUS2 128–191 from 0x3F00_0000 —
 *     bus.ts); every other entry invalid;
 *   - RAM segments copied (IRAM, DRAM, RTC fast and slow memory);
 *   - the ROM's legacy flash descriptor (SPI_flashchip_data): the JEDEC id and the image's flash
 *     size, as the bootloader's esp_rom_spiflash_config_param leaves it;
 *   - RTC_CNTL STORE4 = 40 MHz XTAL (rtc_clk_xtal_freq_get), the reset cause in RESET_STATE;
 *   - the ROM's g_ticks_per_us = 40 (ets_delay_us counts CPU cycles by it), as its startup's
 *     ets_update_cpu_frequency leaves it on the crystal;
 *   - TIMG0/1 MWDT off (the bootloader's handover; the RTC watchdog isn't modeled);
 *   - the core as `callx8 entry` leaves it, sp at the top of the ROM's stack (0x3FFF_E710,
 *     `__stack`), on the 40 MHz crystal (esp_clk_init moves it to the PLL).
 */

import { buildFlash, type EspChip, type FlashLayout, type FlashTarget, type ImageRegions, SR } from '@benchtop/esp32';
import { s2MmuEntryOf } from '../soc/bus.ts';
import { S2_RESET_REASON } from '../soc/rtc-cntl.ts';
import { type Esp32s2Soc, MMU_ACCESS_FLASH, MMU_ENTRIES, MMU_INVALID, MMU_TABLE_BASE } from '../soc/soc.ts';
import type { S2Rom } from './rom.ts';

/** Where an S2 image's segments may load (soc.h). */
export const S2_IMAGE_REGIONS: ImageRegions = [
  { region: 'DROM', start: 0x3f000000, end: 0x3f3fffff },
  { region: 'DRAM', start: 0x3ffb0000, end: 0x3fffffff },
  { region: 'IRAM', start: 0x40020000, end: 0x4006ffff },
  { region: 'IROM', start: 0x40080000, end: 0x407fffff },
  { region: 'RTC_FAST', start: 0x3ff9e000, end: 0x3ff9ffff },
  { region: 'RTC_FAST', start: 0x40070000, end: 0x40071fff },
  { region: 'RTC_SLOW', start: 0x50000000, end: 0x50001fff },
];

export const ESP32S2_CHIP: EspChip = { name: 'ESP32-S2', chipId: 2, regions: S2_IMAGE_REGIONS };

/** The top of the ROM's stack (`__stack`, the end of .stack_pro). */
export const S2_ROM_STACK_TOP = 0x3fffe710;
/** PS as `callx8` into the entry leaves it: WOE | CALLINC = 2 | UM, INTLEVEL 0, EXCM 0. */
const ENTRY_PS = 0x00060020;
/** The root frame's return address: window increment 2 to PC 0 (returning faults "app returned"). */
const ROOT_RETURN = 0x80000000;
/** RTC_CNTL_STORE4 (0x3F40_80BC): the crystal in MHz, twice. */
const STORE4 = 0x3f4080bc;
const XTAL_STORE = 0x00280028;

export interface S2DirectBootOptions {
  app: Uint8Array;
  partitions?: Uint8Array;
  rom: S2Rom;
  /** The board's flash, kept across resets: the image is written into it as an upload would. */
  flash?: FlashTarget;
  /** Why it boots (RTC_CNTL's reset cause): power-on unless a system reset's. */
  reason?: number;
}

export type S2DirectBoot = { ok: true; layout: FlashLayout; entry: number } | { ok: false; error: string };

export function directBootS2(soc: Esp32s2Soc, options: S2DirectBootOptions): S2DirectBoot {
  const built = buildFlash(options.app, options.partitions, ESP32S2_CHIP, options.flash);
  if (!built.ok) return built;
  const layout = built.layout;
  // The flash holds what the image asks for; the chip's ID still says the module's size.
  if (layout.flash.length > soc.flash.data.length) soc.setFlash(layout.flash);
  // Plan the MMU first: every page of a flash segment, and no entry used twice for different pages.
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
      const entry = s2MmuEntryOf(page);
      const flashPage = ((flashAddress & ~0xffff) + (page - first)) >>> 16;
      if (entry < 0) return { ok: false, error: `segment at 0x${segment.loadAddress.toString(16)} is outside the flash windows` };
      const taken = plan.get(entry);
      if (taken !== undefined && taken !== flashPage) return { ok: false, error: `MMU entry ${entry} would map flash pages ${taken} and ${flashPage}` };
      plan.set(entry, flashPage);
    }
  }
  if (layout.flash !== soc.flash.data) {
    soc.flash.data.fill(0xff);
    soc.flash.data.set(layout.flash);
  }
  try {
    for (const section of options.rom.code) soc.memory.load(section.address, section.data);
    bootImage(soc, layout, options.rom, plan, options.reason ?? S2_RESET_REASON.POWERON);
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
  return { ok: true, layout, entry: layout.image.entry };
}

function bootImage(soc: Esp32s2Soc, layout: FlashLayout, rom: S2Rom, plan: Map<number, number>, reason: number): void {
  if (reason === S2_RESET_REASON.POWERON) soc.memory.clearRam();
  else soc.memory.sram.fill(0);
  for (const section of rom.ram) soc.memory.load(section.address, section.data);
  const ticksPerUs = rom.symbols.get('g_ticks_per_us');
  if (ticksPerUs !== undefined) soc.memory.load(ticksPerUs, Uint8Array.of(40, 0, 0, 0));
  for (const segment of layout.image.segments) {
    if (segment.region === 'DROM' || segment.region === 'IROM') continue;
    if (reason === S2_RESET_REASON.DEEPSLEEP && (segment.region === 'RTC_FAST' || segment.region === 'RTC_SLOW')) continue;
    try {
      soc.memory.load(segment.loadAddress, segment.data);
    } catch (error) {
      throw new Error(`segment at 0x${segment.loadAddress.toString(16)}: ${(error as Error).message}`);
    }
  }
  const bus = soc.bus;
  for (let entry = 0; entry < MMU_ENTRIES; entry++) {
    const page = plan.get(entry);
    bus.write32(MMU_TABLE_BASE + entry * 4, page === undefined ? MMU_INVALID : MMU_ACCESS_FLASH | page);
  }
  // The legacy flash descriptor: device_id (manufacturer high), chip_size, block, sector, page, status mask.
  const legacy = rom.symbols.get('SPI_flashchip_data');
  if (legacy !== undefined) {
    const id = soc.flash.jedecId();
    const words = [(id[0] << 16) | (id[1] << 8) | id[2], layout.flash.length, 0x10000, 0x1000, 0x100, 0xffff];
    words.forEach((w, i) => bus.write32(legacy + i * 4, w));
  }
  bus.write32(STORE4, XTAL_STORE);
  for (const base of [0x3f41f000, 0x3f420000]) {
    bus.write32(base + 0x64, 0x50d83aa1); // TIMGn WDTWPROTECT: unlock
    bus.write32(base + 0x48, 0); // WDTCONFIG0
  }
  soc.rtc.resetCause = reason;

  const core = soc.core;
  core.reset();
  core.pc = layout.image.entry;
  core.writeSpecial(SR.WINDOWBASE, 0);
  core.writeSpecial(SR.WINDOWSTART, 1);
  core.writeSpecial(SR.VECBASE, 0x40000000);
  core.writeSpecial(SR.PS, ENTRY_PS);
  core.setReg(1, S2_ROM_STACK_TOP);
  core.setReg(8, ROOT_RETURN);
  core.setReg(9, S2_ROM_STACK_TOP - 64);
  bus.write32(S2_ROM_STACK_TOP - 12, S2_ROM_STACK_TOP); // the root frame's caller SP, for its spill
}
