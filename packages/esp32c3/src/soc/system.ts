/**
 * The ESP32-C3's SYSTEM registers and cache controller (BT92).
 *
 * SYSTEM (0x600C0000, system_reg.h): the CPU clock — SYSCLK_CONF.SOC_CLK_SEL (0 XTAL /
 * (PRE_DIV_CNT + 1), 1 PLL, 2 RC_FAST 17.5 MHz / (PRE_DIV_CNT + 1)) with CPU_PER_CONF.CPUPERIOD_SEL
 * under the PLL (0: 80 MHz, 1: 160 MHz); APB is 80 MHz under the PLL, the CPU clock otherwise —
 * `onClock` hears every change. CPU_INTR_FROM_CPU_0..3 bit 0 drive interrupt sources 50–53
 * (FreeRTOS yields through the first). The rest reads back as written.
 *
 * EXTMEM (0x600C4000, extmem_reg.h): cache operations the ROM's Cache_* functions start and wait
 * for — invalidate (ICACHE_SYNC_CTRL), preload, lock/unlock, autoload, freeze — complete at once,
 * their DONE bits set as the ENA bit is written. The cache itself isn't modeled (no timing).
 */

import type { Peripheral } from '@benchtop/esp32';
import { type SocContext, XTAL_HZ } from './context.ts';
import { SRC } from './intmatrix.ts';
import { registerDefault } from './periph.ts';

export const SYSTEM_BASE = 0x600c0000;
export const EXTMEM_BASE = 0x600c4000;

const CPU_PER_CONF = 0x008;
const FROM_CPU = 0x028;
const SYSCLK_CONF = 0x058;

export class SystemRegs implements Peripheral {
  private readonly ctx: SocContext;
  private readonly regs = new Uint32Array(1024);
  cpuHz = XTAL_HZ;
  apbHz = XTAL_HZ;
  onClock: ((cpuHz: number, apbHz: number) => void) | null = null;

  constructor(ctx: SocContext) {
    this.ctx = ctx;
    this.systemReset();
  }

  systemReset(): void {
    for (let i = 0; i < this.regs.length; i++) this.regs[i] = registerDefault(SYSTEM_BASE + i * 4);
    for (let n = 0; n < 4; n++) this.ctx.matrix.setSource(SRC.FROM_CPU0 + n, false);
    this.updateClock();
  }

  private updateClock(): void {
    const sysclk = this.regs[SYSCLK_CONF >>> 2];
    const sel = (sysclk >>> 10) & 3;
    const div = (sysclk & 0x3ff) + 1;
    let cpu: number;
    let apb: number;
    if (sel === 1) {
      cpu = (this.regs[CPU_PER_CONF >>> 2] & 3) === 1 ? 160_000_000 : 80_000_000;
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

  read32(offset: number): number {
    return this.regs[offset >>> 2];
  }

  write32(offset: number, value: number): void {
    this.regs[offset >>> 2] = value;
    if (offset === SYSCLK_CONF || offset === CPU_PER_CONF) this.updateClock();
    else if (offset >= FROM_CPU && offset < FROM_CPU + 16) this.ctx.matrix.setSource(SRC.FROM_CPU0 + ((offset - FROM_CPU) >>> 2), (value & 1) !== 0);
  }
}

/** [register, ENA bit, DONE bit] — written ENA completes at once. */
const OPERATIONS: readonly [number, number, number][] = [
  [0x01c, 0b11, 1 << 2], // ICACHE_LOCK_CTRL: LOCK_ENA, UNLOCK_ENA → LOCK_DONE
  [0x028, 1 << 0, 1 << 1], // ICACHE_SYNC_CTRL: INVALIDATE_ENA → SYNC_DONE
  [0x034, 1 << 0, 1 << 1], // ICACHE_PRELOAD_CTRL: PRELOAD_ENA → PRELOAD_DONE
  [0x040, 1 << 2, 1 << 3], // ICACHE_AUTOLOAD_CTRL: AUTOLOAD_ENA → AUTOLOAD_DONE
  [0x0cc, 1 << 0, 1 << 2], // ICACHE_FREEZE: FREEZE_ENA → FREEZE_DONE
];

export class Extmem implements Peripheral {
  private readonly regs = new Uint32Array(1024);

  constructor() {
    this.systemReset();
  }

  systemReset(): void {
    for (let i = 0; i < this.regs.length; i++) this.regs[i] = registerDefault(EXTMEM_BASE + i * 4);
    for (const [reg, , done] of OPERATIONS) if (reg !== 0x0cc) this.regs[reg >>> 2] |= done;
  }

  read32(offset: number): number {
    return this.regs[offset >>> 2];
  }

  write32(offset: number, value: number): void {
    for (const [reg, ena, done] of OPERATIONS) {
      if (offset !== reg) continue;
      if (reg === 0x0cc) {
        // Freeze: DONE follows ENA (the cache stops at once, and resumes at once).
        this.regs[reg >>> 2] = (value & ~done) | ((value & ena) !== 0 ? done : 0);
        return;
      }
      this.regs[reg >>> 2] = (value & ena) !== 0 ? (value & ~ena) | done : value | done;
      return;
    }
    this.regs[offset >>> 2] = value;
  }
}
