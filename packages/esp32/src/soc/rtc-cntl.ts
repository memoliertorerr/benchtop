/**
 * RTC_CNTL (0x3FF48000; rtc_cntl_reg.h): the parts boot and reboot touch — STORE0–7 (retention
 * registers the bootloader and app share: STORE4 holds the XTAL frequency, STORE6 the reset hint;
 * they survive every reset but an RTC one), CLK_CONF (SOC_CLK_SEL picks the CPU clock source; a
 * write recomputes the clocks), RESET_STATE (reset causes per CPU: PROCPU bits 5:0, APPCPU 11:6),
 * TIME_UPDATE/TIME0/TIME1 (the RTC slow counter, from simulated time) and, since BT33:
 *   - OPTIONS0 SW_SYS_RST (31), SW_PROCPU_RST (5), SW_APPCPU_RST (4): resets (reset.ts); the bits
 *     read back 0.
 *   - CPU stall: a CPU is stalled while {SW_CPU_STALL C1, OPTIONS0 C0} = 0x86 — C1 (6 bits) at
 *     SW_CPU_STALL 31:26 for the PRO_CPU and 25:20 for the APP_CPU, C0 (2 bits) at OPTIONS0 3:2
 *     and 1:0 (soc_ll_stall_core). esp_restart_noos and the panic handler stall the other CPU.
 *   - The RTC watchdog (WDTCONFIG0 0x8C: EN 31, stage actions 30:28 / 27:25 / 24:22 / 21:19,
 *     EDGE_INT_EN 18, LEVEL_INT_EN 17; WDTCONFIG1–4 the stage lengths in RTC slow-clock ticks;
 *     WDTFEED bit 31; WDTWPROTECT key 0x50D83AA1) on wdt.ts: interrupt → INT_RAW WDT (bit 3,
 *     source 46 RTC_CORE while INT_ENA or LEVEL_INT_EN allows it), reset CPU → RTCWDT_CPU_RESET,
 *     reset system → RTCWDT_SYS_RESET, reset RTC → RTCWDT_RTC_RESET (clears the RTC domain).
 *     FLASHBOOT_MOD_EN isn't modeled (direct boot clears it).
 *   - INT_ENA (0x3C), INT_RAW (0x40), INT_ST (0x44), INT_CLR (0x48).
 * RTC IO (0x3FF48400–0x3FF484C8, the same 4 KB block) is rtcio.ts and SENS (0x3FF48800–0x3FF488FF)
 * sens.ts, both reached through here (BT34, BT35).
 * Brownout, power and the other configuration registers are storage.
 */

import type { SocContext } from './context.ts';
import { REF_HZ } from './context.ts';
import { RegisterFile } from './periph.ts';
import { RESET_REASON } from './reset.ts';
import { RTC_IO_END, RTC_IO_OFFSET, RtcIo } from './rtcio.ts';
import { Sens, SENS_END, SENS_OFFSET } from './sens.ts';
import { Watchdog } from './wdt.ts';

export const RTC_CNTL_BASE = 0x3ff48000;
export const RTC = {
  OPTIONS0: 0x00,
  TIME_UPDATE: 0x0c,
  TIME0: 0x10,
  TIME1: 0x14,
  RESET_STATE: 0x34,
  INT_ENA: 0x3c,
  INT_RAW: 0x40,
  INT_ST: 0x44,
  INT_CLR: 0x48,
  STORE0: 0x4c,
  CLK_CONF: 0x70,
  WDTCONFIG0: 0x8c,
  WDTCONFIG1: 0x90,
  WDTFEED: 0xa0,
  WDTWPROTECT: 0xa4,
  SW_CPU_STALL: 0xac,
  STORE4: 0xb0,
} as const;
/** The internal RC slow clock (CONFIG_ESP32_RTC_CLK_SRC_INT_RC), Hz. */
export const RTC_SLOW_HZ = 150_000;
const SW_SYS_RST = 1 << 31;
const SW_PROCPU_RST = 1 << 5;
const SW_APPCPU_RST = 1 << 4;
const RESET_BITS = SW_SYS_RST | SW_PROCPU_RST | SW_APPCPU_RST;
const WDT_KEY = 0x50d83aa1;
const WDT_EN = 1 << 31;
const WDT_LEVEL_INT_EN = 1 << 17;
const WDT_INT = 1 << 3;
const WDT_SOURCE = 46;
const STALL_C1 = 0x21;
const STALL_C0 = 2;

export class RtcCntl extends RegisterFile {
  readonly watchdog: Watchdog;
  readonly rtcio: RtcIo;
  readonly sens: Sens;
  private readonly context: SocContext;
  private sourceHigh = false;

  constructor(context: SocContext) {
    super(RTC_CNTL_BASE);
    this.context = context;
    this.rtcio = new RtcIo(this);
    this.sens = new Sens(context, this);
    this.watchdog = new Watchdog(
      context,
      {
        enabled: () => (this.regs[RTC.WDTCONFIG0 >>> 2] & WDT_EN) !== 0,
        action: (n) => (this.regs[RTC.WDTCONFIG0 >>> 2] >>> (28 - 3 * n)) & 7,
        hold: (n) => this.regs[(RTC.WDTCONFIG1 >>> 2) + n],
        tickCycles: () => REF_HZ / RTC_SLOW_HZ,
      },
      (action) => this.watchdogAction(action),
    );
  }

  implements(offset: number): boolean {
    if (offset >= RTC_IO_OFFSET && offset < RTC_IO_OFFSET + RTC_IO_END) return true;
    if (offset >= SENS_OFFSET && offset < SENS_OFFSET + SENS_END) return true;
    return (
      offset === RTC.OPTIONS0 ||
      offset === RTC.TIME_UPDATE ||
      offset === RTC.TIME0 ||
      offset === RTC.TIME1 ||
      offset === RTC.RESET_STATE ||
      (offset >= RTC.INT_ENA && offset <= RTC.INT_CLR) ||
      (offset >= RTC.STORE0 && offset <= RTC.STORE0 + 12) ||
      offset === RTC.CLK_CONF ||
      (offset >= RTC.WDTCONFIG0 && offset <= RTC.WDTWPROTECT) ||
      offset === RTC.SW_CPU_STALL ||
      (offset >= RTC.STORE4 && offset <= RTC.STORE4 + 12)
    );
  }

  /**
   * A chip reset: every register back to its reset value but STORE0–7, which an RTC-domain reset
   * clears too. RESET_STATE is set by the boot that follows.
   */
  override systemReset(rtcDomain: boolean): void {
    const store = new Uint32Array(8);
    for (let i = 0; i < 4; i++) {
      store[i] = this.regs[(RTC.STORE0 >>> 2) + i];
      store[4 + i] = this.regs[(RTC.STORE4 >>> 2) + i];
    }
    this.reset();
    if (!rtcDomain) {
      for (let i = 0; i < 4; i++) {
        this.regs[(RTC.STORE0 >>> 2) + i] = store[i];
        this.regs[(RTC.STORE4 >>> 2) + i] = store[4 + i];
      }
    }
    this.watchdog.stop();
    this.updateInterrupt();
    if (rtcDomain) {
      this.rtcio.reset();
      this.rtcio.onChange?.();
      this.sens.reset();
    }
  }

  /** CLK_CONF SOC_CLK_SEL: 0 XTAL, 1 PLL, 2 8 MHz RC, 3 APLL. */
  socClockSelect(): number {
    return (this.regs[RTC.CLK_CONF >>> 2] >>> 27) & 3;
  }

  /** The RTC slow counter now (48 bits; a number is exact to 2^53). */
  slowTicks(): number {
    return Math.floor((this.context.now() / REF_HZ) * RTC_SLOW_HZ);
  }

  /** Is CPU `cpu` (0 PRO, 1 APP) stalled through SW_CPU_STALL and OPTIONS0? */
  stalled(cpu: number): boolean {
    const c1 = (this.regs[RTC.SW_CPU_STALL >>> 2] >>> (cpu === 0 ? 26 : 20)) & 0x3f;
    const c0 = (this.regs[RTC.OPTIONS0 >>> 2] >>> (cpu === 0 ? 2 : 0)) & 3;
    return c1 === STALL_C1 && c0 === STALL_C0;
  }

  /** RESET_STATE for a boot after reset `reason` (both CPUs). */
  setResetCause(reason: number): void {
    this.regs[RTC.RESET_STATE >>> 2] = (this.regs[RTC.RESET_STATE >>> 2] & ~0xfff) | (reason & 0x3f) | ((reason & 0x3f) << 6);
  }

  override read32(offset: number): number {
    if (offset >= RTC_IO_OFFSET && offset < RTC_IO_OFFSET + RTC_IO_END) return this.rtcio.read32(offset - RTC_IO_OFFSET);
    if (offset >= SENS_OFFSET && offset < SENS_OFFSET + SENS_END) return this.sens.read32(offset - SENS_OFFSET);
    if (offset === RTC.INT_ST) return this.regs[RTC.INT_RAW >>> 2] & this.regs[RTC.INT_ENA >>> 2];
    return super.read32(offset);
  }

  override write32(offset: number, value: number): void {
    if (offset >= RTC_IO_OFFSET && offset < RTC_IO_OFFSET + RTC_IO_END) {
      this.rtcio.write32(offset - RTC_IO_OFFSET, value);
      return;
    }
    if (offset >= SENS_OFFSET && offset < SENS_OFFSET + SENS_END) {
      this.sens.write32(offset - SENS_OFFSET, value);
      return;
    }
    switch (offset) {
      case RTC.OPTIONS0: {
        const before = this.regs[offset >>> 2];
        super.write32(offset, value & ~RESET_BITS);
        if ((before & 0xf) !== (value & 0xf)) this.context.resets.stallChanged();
        if ((value & SW_SYS_RST) !== 0) this.context.resets.systemReset(RESET_REASON.SW);
        else {
          if ((value & SW_APPCPU_RST) !== 0) this.context.resets.appCpuReset();
          if ((value & SW_PROCPU_RST) !== 0) this.context.resets.proCpuReset();
        }
        return;
      }
      case RTC.SW_CPU_STALL:
        super.write32(offset, value);
        this.context.resets.stallChanged();
        return;
      case RTC.TIME_UPDATE:
        if ((value & (1 << 31)) !== 0) {
          const ticks = this.slowTicks();
          this.regs[RTC.TIME0 >>> 2] = ticks % 0x100000000;
          this.regs[RTC.TIME1 >>> 2] = Math.floor(ticks / 0x100000000) & 0xffff;
          this.regs[RTC.TIME_UPDATE >>> 2] = 1 << 30; // TIME_VALID
        }
        return;
      case RTC.RESET_STATE:
      case RTC.INT_RAW:
      case RTC.INT_ST:
        return; // read-only
      case RTC.INT_CLR:
        this.regs[RTC.INT_RAW >>> 2] &= ~value;
        this.updateInterrupt();
        return;
      case RTC.INT_ENA:
        super.write32(offset, value);
        this.updateInterrupt();
        return;
      case RTC.WDTFEED:
        if (this.regs[RTC.WDTWPROTECT >>> 2] === WDT_KEY && (value & (1 << 31)) !== 0) this.watchdog.feed();
        return;
      default:
        if (offset >= RTC.WDTCONFIG0 && offset < RTC.WDTFEED) {
          if (this.regs[RTC.WDTWPROTECT >>> 2] !== WDT_KEY) return; // write-protected
          super.write32(offset, value);
          this.watchdog.update();
          this.updateInterrupt();
          return;
        }
        super.write32(offset, value);
        if (offset === RTC.CLK_CONF) this.context.clockChanged();
    }
  }

  private watchdogAction(action: number): void {
    if (action === 1) {
      this.regs[RTC.INT_RAW >>> 2] |= WDT_INT;
      this.updateInterrupt();
    } else if (action === 2) this.context.resets.systemReset(RESET_REASON.RTCWDT_CPU);
    else if (action === 3) this.context.resets.systemReset(RESET_REASON.RTCWDT_SYS);
    else if (action === 4) this.context.resets.systemReset(RESET_REASON.RTCWDT_RTC, true);
  }

  private updateInterrupt(): void {
    const raw = (this.regs[RTC.INT_RAW >>> 2] & WDT_INT) !== 0;
    const enabled = (this.regs[RTC.INT_ENA >>> 2] & WDT_INT) !== 0 || (this.regs[RTC.WDTCONFIG0 >>> 2] & WDT_LEVEL_INT_EN) !== 0;
    const high = raw && enabled;
    if (high === this.sourceHigh) return;
    this.sourceHigh = high;
    this.context.interrupts.setSource(WDT_SOURCE, high);
  }
}
