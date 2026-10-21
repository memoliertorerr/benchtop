/**
 * DPORT (0x3FF00000; dport_reg.h, TRM v5.8 ch. 12) beyond the cache and remap registers mmu.ts
 * owns: APP_CPU control, the CPU clock divider, peripheral clock/reset enables (storage),
 * CPU-to-CPU interrupts (CPU_INTR_FROM_CPU_0..3 drive matrix sources 24–27) and the interrupt
 * matrix's map and status registers, and the cache state in x_DCACHE_DBUG0 (always idle: IDF's
 * spi_flash_disable_cache waits for it). Everything else in the block stays a logged RegisterFile.
 *
 * APP_CPU (TRM §3.3 / IDF cpu_start.c start_other_core): it runs while APPCPU_CTRL_B CLKGATE_EN
 * is set, APPCPU_CTRL_C RUNSTALL is clear and APPCPU_CTRL_A RESETTING is clear (reset value 1);
 * clearing RESETTING restarts it at the ROM reset vector. CTRL_D holds the boot address
 * ets_set_appcpu_boot_addr stores (ROM 0x4000689c writes 0x3FF00038).
 */

import type { SocContext } from './context.ts';
import type { InterruptMatrix } from './intmatrix.ts';
import { SOURCE_COUNT } from './intmatrix.ts';
import { DportRegisters } from './mmu.ts';

export const DPORT = {
  APPCPU_CTRL_A: 0x02c,
  APPCPU_CTRL_B: 0x030,
  APPCPU_CTRL_C: 0x034,
  APPCPU_CTRL_D: 0x038,
  CPU_PER_CONF: 0x03c,
  PERIP_CLK_EN: 0x0c0,
  PERIP_RST_EN: 0x0c4,
  WIFI_CLK_EN: 0x0cc,
  CORE_RST_EN: 0x0d0,
  CPU_INTR_FROM_CPU_0: 0x0dc,
  PRO_INTR_STATUS_0: 0x0ec,
  APP_INTR_STATUS_0: 0x0f8,
  PRO_INTR_MAP: 0x104,
  APP_INTR_MAP: 0x218,
  PRO_DCACHE_DBUG0: 0x3f0,
  APP_DCACHE_DBUG0: 0x418,
} as const;
/** DCACHE_DBUG0 CACHE_STATE (bits 18:7) = 1: idle — the cache isn't modeled, so it never is busy. */
const CACHE_STATE_IDLE = 1 << 7;

export class Dport extends DportRegisters {
  private readonly matrix: InterruptMatrix;
  private readonly context: SocContext;
  /** APP_CPU leaves reset (true) or goes back into it / stalls (false). */
  onAppCpu: ((running: boolean) => void) | null = null;
  private appRunning = false;

  constructor(context: SocContext, matrix: InterruptMatrix) {
    super();
    this.context = context;
    this.matrix = matrix;
  }

  /** A chip reset: registers to reset values; APP_CPU back in reset (the SoC resets the matrix). */
  override systemReset(_rtcDomain: boolean): void {
    this.reset();
    this.appRunning = false;
  }

  /** Is APP_CPU out of reset, clocked and not stalled? */
  appCpuRunning(): boolean {
    const r = this.regs;
    return (r[DPORT.APPCPU_CTRL_A >>> 2] & 1) === 0 && (r[DPORT.APPCPU_CTRL_B >>> 2] & 1) !== 0 && (r[DPORT.APPCPU_CTRL_C >>> 2] & 1) === 0;
  }

  /** DPORT_CPU_PER_CONF CPUPERIOD_SEL (0: 80, 1: 160, 2: 240 MHz under the PLL). */
  cpuPeriodSel(): number {
    return this.regs[DPORT.CPU_PER_CONF >>> 2] & 3;
  }

  override implements(offset: number): boolean {
    if (super.implements(offset)) return true;
    if (offset >= DPORT.APPCPU_CTRL_A && offset <= DPORT.CPU_PER_CONF) return true;
    if (offset === DPORT.PERIP_CLK_EN || offset === DPORT.PERIP_RST_EN || offset === DPORT.WIFI_CLK_EN || offset === DPORT.CORE_RST_EN) return true;
    if (offset === DPORT.PRO_DCACHE_DBUG0 || offset === DPORT.APP_DCACHE_DBUG0) return true;
    return offset >= DPORT.CPU_INTR_FROM_CPU_0 && offset < DPORT.APP_INTR_MAP + SOURCE_COUNT * 4;
  }

  override read32(offset: number): number {
    if (offset === DPORT.PRO_DCACHE_DBUG0 || offset === DPORT.APP_DCACHE_DBUG0) return CACHE_STATE_IDLE;
    if (offset >= DPORT.PRO_INTR_STATUS_0 && offset < DPORT.PRO_INTR_STATUS_0 + 12) return this.matrix.status(0, (offset - DPORT.PRO_INTR_STATUS_0) >>> 2);
    if (offset >= DPORT.APP_INTR_STATUS_0 && offset < DPORT.APP_INTR_STATUS_0 + 12) return this.matrix.status(1, (offset - DPORT.APP_INTR_STATUS_0) >>> 2);
    return super.read32(offset);
  }

  override write32(offset: number, value: number): void {
    super.write32(offset, value);
    if (offset >= DPORT.APPCPU_CTRL_A && offset <= DPORT.APPCPU_CTRL_C) {
      const running = this.appCpuRunning();
      if (running !== this.appRunning) {
        this.appRunning = running;
        this.onAppCpu?.(running);
      }
    } else if (offset === DPORT.CPU_PER_CONF) {
      this.context.clockChanged();
    } else if (offset >= DPORT.CPU_INTR_FROM_CPU_0 && offset < DPORT.CPU_INTR_FROM_CPU_0 + 16) {
      this.matrix.setSource(24 + ((offset - DPORT.CPU_INTR_FROM_CPU_0) >>> 2), (value & 1) !== 0);
    } else if (offset >= DPORT.PRO_INTR_MAP && offset < DPORT.PRO_INTR_MAP + SOURCE_COUNT * 4) {
      this.matrix.setMap(0, (offset - DPORT.PRO_INTR_MAP) >>> 2, value);
    } else if (offset >= DPORT.APP_INTR_MAP && offset < DPORT.APP_INTR_MAP + SOURCE_COUNT * 4) {
      this.matrix.setMap(1, (offset - DPORT.APP_INTR_MAP) >>> 2, value);
    }
  }
}
