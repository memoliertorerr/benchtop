/**
 * The flash cache MMU (TRM v5.8 §4.3.2.2 "External Memory", Tables 4.3-9 to 4.3-11; IDF's
 * mmu.h, dport_reg.h and cache_ll.h). Each CPU has its own table of 32-bit entries — PRO at
 * 0x3FF10000, APP at 0x3FF12000 (APP entry numbers are PRO's + 2048) — whose value is a 64 KB
 * flash page number, with bit 8 marking it invalid. For PID 0/1 (the only PIDs modeled):
 *   entries 0–63    VAddr0 0x3F400000–0x3F7FFFFF  data bus (DROM0, mask bit 4)
 *   entries 64–127  VAddr1 0x40000000–0x403FFFFF  instruction bus (IRAM0, mask bit 0); below
 *                   0x400C2000 the addresses reach on-chip memory instead, so IROM starts at
 *                   entry 77 = 0x400D0000 in practice
 *   entries 128–191 VAddr2 0x40400000–0x407FFFFF  (IRAM1, mask bit 1)
 *   entries 192–255 VAddr3 0x40800000–0x40BFFFFF  (IROM0, mask bit 2)
 * A CPU reaches flash only while its cache is enabled (DPORT_x_CACHE_CTRL bit 3) and the
 * region's mask bit in DPORT_x_CACHE_CTRL1 is clear (cache_ll.h maps IBUS0/1/2 and DBUS0 to
 * IRAM0/IRAM1/IROM0 and DROM0). The cache's contents aren't modeled — a mapped access reads
 * flash — but its timing is (BT33: tags and miss stalls in bus.ts).
 *
 * The DPORT registers that matter here (boot remap, cache control and mux) live in
 * DportRegisters, which tells the buses when they change; the buses cache translations per
 * 64 KB page and drop them on any table or control write.
 */

import { type Peripheral, RegisterFile } from './periph.ts';

export const PRO_TABLE = 0x3ff10000;
export const APP_TABLE = 0x3ff12000;
export const MMU_TABLE_END = 0x3ff14000;
export const MMU_INVALID = 0x100;
const APP_ENTRY_OFFSET = 2048;

/** DPORT register offsets this file owns. */
export const DPORT_REG = {
  PRO_BOOT_REMAP_CTRL: 0x000,
  APP_BOOT_REMAP_CTRL: 0x004,
  PRO_CACHE_CTRL: 0x040,
  PRO_CACHE_CTRL1: 0x044,
  APP_CACHE_CTRL: 0x058,
  APP_CACHE_CTRL1: 0x05c,
  CACHE_MUX_MODE: 0x07c,
} as const;
export const CACHE_ENABLE = 1 << 3;
export const CACHE_FLUSH_ENA = 1 << 4;
export const CACHE_FLUSH_DONE = 1 << 5;
export const CACHE_MASK = { IRAM0: 1 << 0, IRAM1: 1 << 1, IROM0: 1 << 2, DRAM1: 1 << 3, DROM0: 1 << 4, OPSDRAM: 1 << 5 } as const;

/** Why a flash access can't be served (translate's negative results). */
export const MMU_FAULT = { DISABLED: -1, MASKED: -2, INVALID: -3, BEYOND_FLASH: -4, UNMAPPED: -5 } as const;

/** DPORT's register file, telling listeners when a cache, MMU-related or remap register changes. */
export class DportRegisters extends RegisterFile {
  /** Called with the CPU affected (0 PRO, 1 APP, −1 both). */
  onChange: ((cpu: number) => void) | null = null;
  /** A cache flush was requested on CPU `cpu` (BT33: the bus empties its cache tags). */
  onFlush: ((cpu: number) => void) | null = null;

  constructor() {
    super(0x3ff00000);
  }

  /** The offsets modeled here; other DPORT registers stay plain (and are logged as unknown). */
  implements(offset: number): boolean {
    return (
      offset === DPORT_REG.PRO_BOOT_REMAP_CTRL ||
      offset === DPORT_REG.APP_BOOT_REMAP_CTRL ||
      offset === DPORT_REG.PRO_CACHE_CTRL ||
      offset === DPORT_REG.PRO_CACHE_CTRL1 ||
      offset === DPORT_REG.APP_CACHE_CTRL ||
      offset === DPORT_REG.APP_CACHE_CTRL1 ||
      offset === DPORT_REG.CACHE_MUX_MODE
    );
  }

  override write32(offset: number, value: number): void {
    if (offset === DPORT_REG.PRO_CACHE_CTRL || offset === DPORT_REG.APP_CACHE_CTRL) {
      // CACHE_FLUSH_ENA (bit 4) set: the flush completes at once — FLUSH_DONE (bit 5, read-only)
      // follows it (TRM v5.8 §3.3.4: clear FLUSH_ENA, set it, wait for FLUSH_DONE).
      value = (value & ~CACHE_FLUSH_DONE) | ((value & CACHE_FLUSH_ENA) !== 0 ? CACHE_FLUSH_DONE : 0);
      if ((value & CACHE_FLUSH_ENA) !== 0) this.onFlush?.(offset === DPORT_REG.PRO_CACHE_CTRL ? 0 : 1);
    }
    super.write32(offset, value);
    if (offset === DPORT_REG.PRO_BOOT_REMAP_CTRL || offset === DPORT_REG.PRO_CACHE_CTRL || offset === DPORT_REG.PRO_CACHE_CTRL1) this.onChange?.(0);
    else if (offset === DPORT_REG.APP_BOOT_REMAP_CTRL || offset === DPORT_REG.APP_CACHE_CTRL || offset === DPORT_REG.APP_CACHE_CTRL1) this.onChange?.(1);
    else if (offset === DPORT_REG.CACHE_MUX_MODE) this.onChange?.(-1);
  }

  cacheEnabled(cpu: number): boolean {
    return (this.regs[(cpu === 0 ? DPORT_REG.PRO_CACHE_CTRL : DPORT_REG.APP_CACHE_CTRL) >>> 2] & CACHE_ENABLE) !== 0;
  }

  cacheMask(cpu: number): number {
    return this.regs[(cpu === 0 ? DPORT_REG.PRO_CACHE_CTRL1 : DPORT_REG.APP_CACHE_CTRL1) >>> 2];
  }

  bootRemap(cpu: number): boolean {
    return (this.regs[(cpu === 0 ? DPORT_REG.PRO_BOOT_REMAP_CTRL : DPORT_REG.APP_BOOT_REMAP_CTRL) >>> 2] & 1) !== 0;
  }

  /** DPORT_CACHE_MUX_MODE[1:0] (TRM Table 3.3-5). */
  cacheMuxMode(): number {
    return this.regs[DPORT_REG.CACHE_MUX_MODE >>> 2] & 3;
  }
}

export class FlashMmu {
  /** Entries 0–2047 are PRO's table, 2048–4095 APP's (only the first 256 of each map flash). */
  readonly table = new Uint32Array(4096).fill(MMU_INVALID);
  readonly dport: DportRegisters;
  /** Called with the CPU whose table changed and the entry (0–2047) that did. */
  onChange: ((cpu: number, entry: number) => void) | null = null;

  constructor(dport: DportRegisters) {
    this.dport = dport;
  }

  /** The MMU entry index (0–255) for virtual address `v`, or −1 outside the flash windows. */
  static entryOf(v: number): number {
    if (v >= 0x3f400000 && v < 0x3f800000) return (v - 0x3f400000) >>> 16;
    if (v >= 0x40000000 && v < 0x40c00000) return 64 + ((v - 0x40000000) >>> 16);
    return -1;
  }

  /** The DPORT_x_CACHE_CTRL1 mask bit governing entry `i`. */
  static maskOf(entry: number): number {
    return entry < 64 ? CACHE_MASK.DROM0 : entry < 128 ? CACHE_MASK.IRAM0 : entry < 192 ? CACHE_MASK.IRAM1 : CACHE_MASK.IROM0;
  }

  /**
   * The flash byte offset of the 64 KB page holding virtual address `v` for CPU `cpu`, or an
   * MMU_FAULT value. `flashSize` bounds the page.
   */
  translate(cpu: number, v: number, flashSize: number): number {
    const entry = FlashMmu.entryOf(v);
    if (entry < 0) return MMU_FAULT.UNMAPPED;
    if (!this.dport.cacheEnabled(cpu)) return MMU_FAULT.DISABLED;
    if ((this.dport.cacheMask(cpu) & FlashMmu.maskOf(entry)) !== 0) return MMU_FAULT.MASKED;
    const value = this.table[entry + (cpu === 0 ? 0 : APP_ENTRY_OFFSET)];
    if ((value & MMU_INVALID) !== 0) return MMU_FAULT.INVALID;
    const offset = (value & 0xff) * 0x10000;
    return offset + 0x10000 <= flashSize ? offset : MMU_FAULT.BEYOND_FLASH;
  }

  /** A sentence naming why `translate` failed (for the fault message). */
  describe(cpu: number, v: number, fault: number): string {
    const entry = FlashMmu.entryOf(v);
    const who = cpu === 0 ? 'PRO' : 'APP';
    const at = `0x${(v >>> 0).toString(16).padStart(8, '0')}`;
    switch (fault) {
      case MMU_FAULT.DISABLED:
        return `flash cache access to ${at} with the ${who} cache disabled (DPORT_${who}_CACHE_CTRL bit 3 clear)`;
      case MMU_FAULT.MASKED:
        return `flash cache access to ${at}: region masked in DPORT_${who}_CACHE_CTRL1 (bit ${Math.log2(FlashMmu.maskOf(entry))})`;
      case MMU_FAULT.INVALID:
        return `flash cache access to ${at}: ${who} MMU entry ${entry} is invalid (0x${this.table[entry + (cpu === 0 ? 0 : APP_ENTRY_OFFSET)].toString(16)})`;
      case MMU_FAULT.BEYOND_FLASH:
        return `flash cache access to ${at}: ${who} MMU entry ${entry} maps past the end of flash`;
      default:
        return `${at} is outside the flash windows`;
    }
  }

  /** The MMU tables' 16 KB as four peripheral blocks. */
  block(base: number): Peripheral {
    const first = (base - PRO_TABLE) >>> 2;
    return {
      read32: (offset: number): number => this.table[first + (offset >>> 2)],
      write32: (offset: number, value: number): void => {
        const index = first + (offset >>> 2);
        const entry = value & 0x1ff; // 8-bit page + invalid bit
        if (this.table[index] === entry) return;
        this.table[index] = entry;
        this.onChange?.(index < APP_ENTRY_OFFSET ? 0 : 1, index % APP_ENTRY_OFFSET);
      },
    };
  }
}
