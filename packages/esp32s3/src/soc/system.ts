/**
 * The ESP32-S3's SYSTEM registers and cache controller (BT124; system_reg.h, extmem_reg.h).
 *
 * SYSTEM (0x600C_0000): the CPU clock — SYSCLK_CONF (0x60) SOC_CLK_SEL (11:10: 0 XTAL /
 * (PRE_DIV_CNT + 1), 1 PLL, 2 RC_FAST 17.5 MHz / (PRE_DIV_CNT + 1)) with CPU_PER_CONF (0x10)
 * CPUPERIOD_SEL under the PLL (0: 80 MHz, 1: 160 MHz, 2: 240 MHz); APB is 80 MHz under the PLL,
 * the CPU clock otherwise — `onClock` hears every change. CPU_INTR_FROM_CPU_0..3 (0x30–0x3C) bit 0
 * drive sources 79–82. CORE_1_CONTROL_0 (0x00): the APP_CPU runs while CLKGATE_EN (1) is set and
 * RUNSTALL (0) and RESETING (2) are clear — `onAppCpu` hears it start and stop; a RESETING pulse
 * restarts it at the reset vector. RTC_FASTMEM_CONFIG / CRC (0x50 / 0x54): the RTC fast memory
 * CRC unit, as the C3's (complete at once). The rest reads back as written.
 *
 * EXTMEM (0x600C_4000): the cache operations the ROM's Cache_* functions start and wait for — lock,
 * sync (invalidate, clean, writeback), occupy, preload, autoload, freeze, for the ICache and the
 * DCache — complete at once: their DONE bits set as the ENA bit is written; a freeze's DONE follows
 * its ENA (Cache_Freeze_*_Disable clears ENA and waits for DONE to clear). The cache itself isn't
 * modeled (no timing).
 */

import type { Peripheral } from '@benchtop/esp32';
import type { InterruptSource } from '@benchtop/esp32c3';
import { registerDefault } from './periph.ts';

export const SYSTEM_BASE = 0x600c0000;
export const EXTMEM_BASE = 0x600c4000;
export const XTAL_HZ = 40_000_000;
/** The S3's FROM_CPU_INTR0 source (periph_defs.h); 1–3 follow. */
const FROM_CPU_SOURCE = 79;

const CORE_1_CONTROL_0 = 0x000;
const CPU_PER_CONF = 0x010;
const FROM_CPU = 0x030;
const RTC_FASTMEM_CONFIG = 0x050;
const RTC_FASTMEM_CRC = 0x054;
const SYSCLK_CONF = 0x060;
const RUNSTALL = 1 << 0;
const CLKGATE_EN = 1 << 1;
const RESETING = 1 << 2;
const MEM_CRC_START = 1 << 8;
const MEM_CRC_FINISH = 1 << 31;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export class S3SystemRegs implements Peripheral {
  private readonly matrix: InterruptSource;
  private readonly rtcFast: Uint8Array;
  private readonly regs = new Uint32Array(1024);
  cpuHz = XTAL_HZ;
  apbHz = XTAL_HZ;
  onClock: ((cpuHz: number, apbHz: number) => void) | null = null;
  /** The APP_CPU starts (true) or stops (false); `onAppCpuReset` restarts it. */
  onAppCpu: ((running: boolean) => void) | null = null;
  onAppCpuReset: (() => void) | null = null;
  private appRunning = false;

  constructor(matrix: InterruptSource, rtcFast: Uint8Array) {
    this.matrix = matrix;
    this.rtcFast = rtcFast;
    this.systemReset();
  }

  systemReset(): void {
    for (let i = 0; i < this.regs.length; i++) this.regs[i] = registerDefault(SYSTEM_BASE + i * 4);
    for (let n = 0; n < 4; n++) this.matrix.setSource(FROM_CPU_SOURCE + n, false);
    this.appRunning = false;
    this.updateClock();
  }

  private updateClock(): void {
    const sysclk = this.regs[SYSCLK_CONF >>> 2];
    const sel = (sysclk >>> 10) & 3;
    const div = (sysclk & 0x3ff) + 1;
    let cpu: number;
    let apb: number;
    if (sel === 1) {
      const period = this.regs[CPU_PER_CONF >>> 2] & 3;
      cpu = period === 0 ? 80_000_000 : period === 1 ? 160_000_000 : 240_000_000;
      apb = 80_000_000;
    } else {
      cpu = (sel === 2 ? 17_500_000 : XTAL_HZ) / div;
      apb = cpu;
    }
    if (cpu === this.cpuHz && apb === this.apbHz) return;
    this.cpuHz = cpu;
    this.apbHz = apb;
    this.onClock?.(cpu, apb);
  }

  private updateAppCpu(before: number, value: number): void {
    const running = (value & CLKGATE_EN) !== 0 && (value & (RUNSTALL | RESETING)) === 0;
    if ((before & RESETING) !== 0 && (value & RESETING) === 0 && running && this.appRunning) this.onAppCpuReset?.();
    if (running !== this.appRunning) {
      this.appRunning = running;
      this.onAppCpu?.(running);
    }
  }

  read32(offset: number): number {
    return this.regs[offset >>> 2];
  }

  write32(offset: number, value: number): void {
    if (offset === RTC_FASTMEM_CONFIG) {
      this.memCrc(value);
      return;
    }
    if (offset === RTC_FASTMEM_CRC) return; // read-only
    const before = this.regs[offset >>> 2];
    this.regs[offset >>> 2] = value;
    if (offset === SYSCLK_CONF || offset === CPU_PER_CONF) this.updateClock();
    else if (offset === CORE_1_CONTROL_0) this.updateAppCpu(before, value);
    else if (offset >= FROM_CPU && offset < FROM_CPU + 16) this.matrix.setSource(FROM_CPU_SOURCE + ((offset - FROM_CPU) >>> 2), (value & 1) !== 0);
  }

  /** The CRC unit: bytes of RTC fast memory from word ADDR (19:9), LEN (30:20) words, CRC-32'd at once. */
  private memCrc(value: number): void {
    const conf = RTC_FASTMEM_CONFIG >>> 2;
    if ((value & MEM_CRC_START) === 0) {
      this.regs[conf] = value & ~MEM_CRC_FINISH;
      return;
    }
    const mem = this.rtcFast;
    const start = ((value >>> 9) & 0x7ff) * 4;
    const end = Math.min(mem.length, start + ((value >>> 20) & 0x7ff) * 4);
    let crc = 0xffffffff;
    for (let i = start; i < end; i++) crc = CRC_TABLE[(crc ^ mem[i]) & 0xff] ^ (crc >>> 8);
    this.regs[RTC_FASTMEM_CRC >>> 2] = ~crc >>> 0;
    this.regs[conf] = (value | MEM_CRC_FINISH) >>> 0;
  }
}

/** [register, ENA bits, DONE bit] — a written ENA completes at once (extmem_reg.h). */
const OPERATIONS: readonly [number, number, number][] = [
  [0x01c, 0b11, 1 << 2], // DCACHE_LOCK_CTRL: LOCK_ENA, UNLOCK_ENA → LOCK_DONE
  [0x028, 0b111, 1 << 3], // DCACHE_SYNC_CTRL: INVALIDATE, WRITEBACK, CLEAN → SYNC_DONE
  [0x034, 1 << 0, 1 << 1], // DCACHE_OCCUPY_CTRL
  [0x040, 1 << 0, 1 << 1], // DCACHE_PRELOAD_CTRL
  [0x04c, 1 << 2, 1 << 3], // DCACHE_AUTOLOAD_CTRL
  [0x07c, 0b11, 1 << 2], // ICACHE_LOCK_CTRL
  [0x088, 1 << 0, 1 << 1], // ICACHE_SYNC_CTRL: INVALIDATE_ENA → SYNC_DONE
  [0x094, 1 << 0, 1 << 1], // ICACHE_PRELOAD_CTRL
  [0x0a0, 1 << 2, 1 << 3], // ICACHE_AUTOLOAD_CTRL
];
/** DCACHE_FREEZE, ICACHE_FREEZE: ENA (0), DONE (2) = ENA. */
const FREEZES = [0x150, 0x154];

export class S3Extmem implements Peripheral {
  private readonly regs = new Uint32Array(1024);
  /** The ROM's "flush the instruction cache" (ICACHE_SYNC invalidate): the cores drop their predecoded flash pages. */
  onInvalidate: (() => void) | null = null;

  constructor() {
    this.systemReset();
  }

  systemReset(): void {
    for (let i = 0; i < this.regs.length; i++) this.regs[i] = registerDefault(EXTMEM_BASE + i * 4);
    // Every operation idle and done, nothing frozen, whatever the headers say.
    for (const [reg, ena, done] of OPERATIONS) this.regs[reg >>> 2] = (this.regs[reg >>> 2] & ~ena) | done;
    for (const reg of FREEZES) this.regs[reg >>> 2] &= ~0b101;
  }

  read32(offset: number): number {
    return this.regs[offset >>> 2];
  }

  write32(offset: number, value: number): void {
    if (offset === FREEZES[0] || offset === FREEZES[1]) {
      this.regs[offset >>> 2] = ((value & ~4) | ((value & 1) << 2)) >>> 0;
      return;
    }
    for (const [reg, ena, done] of OPERATIONS) {
      if (offset !== reg) continue;
      if ((value & ena) !== 0) {
        this.regs[reg >>> 2] = ((value & ~ena) | done) >>> 0;
        if (reg === 0x088) this.onInvalidate?.();
      } else this.regs[reg >>> 2] = value;
      return;
    }
    this.regs[offset >>> 2] = value;
  }
}
