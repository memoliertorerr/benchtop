/**
 * The ESP32-C3's interrupt matrix and CPU interrupt controller (BT92; TRM §8, interrupt_core0_reg.h),
 * at 0x600C2000:
 *   +0x000 + 4·s  source s's map: the CPU line (1–31) it drives, 0 = not connected (62 sources)
 *   +0x0F8/0x0FC  INTR_STATUS_0/1: the sources' raw levels
 *   +0x104 CPU_INT_ENABLE, +0x108 CPU_INT_TYPE (1 = edge), +0x10C CPU_INT_CLEAR (write 1: drop an
 *          edge line's latch), +0x110 CPU_INT_EIP_STATUS (the pending lines)
 *   +0x114 + 4·n  CPU_INT_PRI_n (1–15; 0 never interrupts), +0x194 CPU_INT_THRESH
 * A line is pending while a source mapped to it is high (level), or from a rising edge until it
 * is cleared (edge). The controller presents the enabled pending line with the highest priority
 * at or above the threshold (the lowest number on a tie) to the core as its cause; mstatus.MIE decides
 * whether the core takes it. Sources raise and drop levels through `setSource`; nothing here
 * allocates.
 */

import type { Peripheral } from '@benchtop/esp32';

export const INTMATRIX_BASE = 0x600c2000;
export const SOURCE_COUNT = 62;

/** Interrupt sources (periph_defs.h). */
export const SRC = {
  GPIO: 16,
  SPI2: 19,
  UART0: 21,
  UART1: 22,
  LEDC: 23,
  USB_SERIAL_JTAG: 26,
  RTC_CORE: 27,
  RMT: 28,
  I2C0: 29,
  TG0_T0: 32,
  TG0_WDT: 33,
  TG1_T0: 34,
  TG1_WDT: 35,
  SYSTIMER_TARGET0: 37,
  SYSTIMER_TARGET1: 38,
  SYSTIMER_TARGET2: 39,
  APB_ADC: 43,
  FROM_CPU0: 50,
} as const;

const ENABLE = 0x104;
const TYPE = 0x108;
const CLEAR = 0x10c;
const EIP = 0x110;
const PRI = 0x114;
const THRESH = 0x194;
const STATUS0 = 0x0f8;
const STATUS1 = 0x0fc;

export class InterruptMatrix implements Peripheral {
  readonly map = new Uint8Array(SOURCE_COUNT);
  readonly level = new Uint8Array(SOURCE_COUNT);
  readonly priority = new Uint8Array(32);
  enable = 0;
  type = 0;
  threshold = 0;
  /** Edge lines latched since their last clear. */
  latched = 0;
  /** Lines with at least one high source. */
  private lines = 0;
  private clockGate = 1;
  private readonly other = new Uint32Array(1024);
  /** Told the cause to present (0 = none) whenever it may have changed. */
  onCause: (cause: number) => void = () => {};
  private cause = 0;

  systemReset(): void {
    this.map.fill(0);
    this.level.fill(0);
    this.priority.fill(0);
    this.enable = this.type = this.threshold = this.latched = this.lines = 0;
    this.other.fill(0);
    this.clockGate = 1;
    this.update();
  }

  /** A source's level (0/1). */
  setSource(source: number, high: boolean): void {
    const v = high ? 1 : 0;
    if (this.level[source] === v) return;
    this.level[source] = v;
    this.recomputeLines();
  }

  /** The cause presented now (0 = none). */
  get current(): number {
    return this.cause;
  }

  private recomputeLines(): void {
    let lines = 0;
    for (let s = 0; s < SOURCE_COUNT; s++) if (this.level[s] !== 0 && this.map[s] !== 0) lines |= 1 << this.map[s];
    const rising = lines & ~this.lines;
    this.latched |= rising & this.type;
    this.lines = lines;
    this.update();
  }

  /** Pending lines: level lines while high, edge lines while latched. */
  get pending(): number {
    return ((this.lines & ~this.type) | (this.latched & this.type)) >>> 0;
  }

  private update(): void {
    const ready = this.pending & this.enable;
    let best = 0;
    // Lines below the threshold are masked (TRM 8.4.2); priority 0 never interrupts.
    let bestPriority = Math.max(this.threshold, 1) - 1;
    for (let n = 1; n < 32; n++) {
      if ((ready & (1 << n)) === 0) continue;
      const p = this.priority[n];
      if (p > bestPriority) {
        best = n;
        bestPriority = p;
      }
    }
    if (best !== this.cause) {
      this.cause = best;
      this.onCause(best);
    }
  }

  read32(offset: number): number {
    if (offset < SOURCE_COUNT * 4) return this.map[offset >>> 2];
    switch (offset) {
      case STATUS0:
      case STATUS1: {
        let bits = 0;
        const first = offset === STATUS0 ? 0 : 32;
        for (let s = first; s < Math.min(first + 32, SOURCE_COUNT); s++) if (this.level[s] !== 0) bits |= 1 << (s - first);
        return bits >>> 0;
      }
      case 0x100:
        return this.clockGate;
      case ENABLE:
        return this.enable >>> 0;
      case TYPE:
        return this.type >>> 0;
      case CLEAR:
        return 0;
      case EIP:
        return this.pending;
      case THRESH:
        return this.threshold;
    }
    if (offset >= PRI && offset < PRI + 32 * 4) return this.priority[(offset - PRI) >>> 2];
    return this.other[offset >>> 2];
  }

  write32(offset: number, value: number): void {
    if (offset < SOURCE_COUNT * 4) {
      this.map[offset >>> 2] = value & 0x1f;
      this.recomputeLines();
      return;
    }
    switch (offset) {
      case 0x100:
        this.clockGate = value & 1;
        return;
      case ENABLE:
        this.enable = value & ~1;
        this.update();
        return;
      case TYPE:
        this.type = value & ~1;
        this.latched &= this.type;
        this.update();
        return;
      case CLEAR:
        this.latched &= ~value;
        this.update();
        return;
      case THRESH:
        this.threshold = value & 0xf;
        this.update();
        return;
    }
    if (offset >= PRI && offset < PRI + 32 * 4) {
      this.priority[(offset - PRI) >>> 2] = value & 0xf;
      this.update();
      return;
    }
    this.other[offset >>> 2] = value;
  }
}
