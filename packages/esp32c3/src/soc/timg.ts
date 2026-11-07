/**
 * The ESP32-C3's timer groups (BT92; TRM §11–12, timer_group_reg.h): TIMG0 at 0x6001F000, TIMG1
 * at 0x60020000, each with one 54-bit general-purpose timer, a main-system watchdog (MWDT) and —
 * TIMG0's only — the RTC slow clock calibration unit.
 *
 * Timer: counts (up, or down with INCREASE clear) at APB or XTAL (T0_USE_XTAL) / DIVIDER (0 means
 * 65536) while T0_EN; T0UPDATE latches the count into T0LO/HI; T0LOAD sets it from T0LOADLO/HI;
 * reaching T0ALARM with ALARM_EN sets INT_RAW.T0 and clears ALARM_EN (AUTORELOAD reloads).
 * MWDT: WDTCONFIG0.EN with four stages (CONFIG2–5 timeouts in prescaled ticks of the XTAL clock /
 * CONFIG1's prescaler ×… as written) — stage action 1 raises INT_RAW.WDT, 2/3 reset; a feed
 * restarts it. BT122: light sleep gates the APB clock — the MWDT's stage waits (`gate`/`ungate`).
 * Calibration: RTCCALICFG.START measures MAX slow-clock cycles in XTAL cycles
 * (RC_SLOW 136 kHz, RC_FAST/256 ≈ 68.4 kHz, XTAL32K 32.768 kHz) and sets RDY with the result in
 * RTCCALICFG1 after that many slow cycles; RTCCALICFG2's TIMEOUT (BT124) sets at once when a
 * threshold is written while START_CYCLING (12) runs (the S3 resets with it set). Sources: TG0_T0
 * 32, TG0_WDT 33, TG1_T0 34, TG1_WDT 35.
 */

import type { Peripheral } from '@benchtop/esp32';
import { type SocContext, XTAL_HZ } from './context.ts';

export const TIMG_BASES = [0x6001f000, 0x60020000] as const;

const T0CONFIG = 0x00;
const T0LO = 0x04;
const T0HI = 0x08;
const T0UPDATE = 0x0c;
const T0ALARMLO = 0x10;
const T0ALARMHI = 0x14;
const T0LOADLO = 0x18;
const T0LOADHI = 0x1c;
const T0LOAD = 0x20;
const WDTCONFIG0 = 0x48;
const WDTCONFIG1 = 0x4c;
const WDTFEED = 0x60;
const WDTWPROTECT = 0x64;
const RTCCALICFG = 0x68;
const RTCCALICFG1 = 0x6c;
const RTCCALICFG2 = 0x80;
const INT_ENA = 0x70;
const INT_RAW = 0x74;
const INT_ST = 0x78;
const INT_CLR = 0x7c;

const T0_EN = 1 << 31;
const INCREASE = 1 << 30;
const AUTORELOAD = 1 << 29;
const ALARM_EN = 1 << 10;
const USE_XTAL = 1 << 9;
const WDT_EN = 1 << 31;
const WDT_KEY = 0x50d83aa1;
const CALI_START = 1 << 31;
const CALI_RDY = 1 << 15;
const TWO32 = 2 ** 32;
const MASK54 = 2 ** 54;

/** Slow clocks the calibration can measure, Hz (RTCCALICFG.CLK_SEL 0–2). */
export const SLOW_CLOCK_HZ = [136_000, 17_500_000 / 256, 32_768];

export type WdtAction = 'interrupt' | 'reset';

export class Timg implements Peripheral {
  readonly index: number;
  private readonly ctx: SocContext;
  private readonly sources: [number, number];
  private readonly regs = new Uint32Array(1024);
  /** The timer's count at `since`. */
  private count = 0;
  private since = 0;
  private latched = 0;
  intRaw = 0;
  private readonly alarmSlot: number;
  private readonly wdtSlot: number;
  private readonly caliSlot: number;
  private wdtStage = 0;
  /** BT122: the MWDT's time left in its stage while the clock is gated (light sleep), or −1. */
  private wdtLeft = -1;

  /** BT122: light sleep: the MWDT's stage waits (the general timer is idle in Arduino; not gated). */
  gate(): void {
    if (this.wdtLeft >= 0) return;
    const at = this.ctx.events.timeOf(this.wdtSlot);
    if (at === Number.POSITIVE_INFINITY) return;
    this.wdtLeft = Math.max(0, at - this.ctx.now());
    this.ctx.events.cancel(this.wdtSlot);
  }

  /** BT122: the clock runs again: the stage goes on where it waited. */
  ungate(): void {
    if (this.wdtLeft < 0) return;
    this.ctx.events.schedule(this.wdtSlot, this.ctx.now() + this.wdtLeft);
    this.wdtLeft = -1;
  }
  /** A watchdog stage with a reset action expired. */
  onWdtReset: ((index: number) => void) | null = null;

  constructor(ctx: SocContext, index: number, sources: [number, number]) {
    this.ctx = ctx;
    this.index = index;
    this.sources = sources;
    this.alarmSlot = ctx.events.add(() => this.alarm());
    this.wdtSlot = ctx.events.add(() => this.wdtExpired());
    this.caliSlot = ctx.events.add(() => this.calibrated());
    this.systemReset();
  }

  systemReset(): void {
    const base = TIMG_BASES[this.index];
    for (let i = 0; i < this.regs.length; i++) this.regs[i] = this.ctx.regDefault(base + i * 4);
    this.count = this.since = this.latched = this.intRaw = 0;
    this.wdtStage = 0;
    this.wdtLeft = -1;
    for (const slot of [this.alarmSlot, this.wdtSlot, this.caliSlot]) this.ctx.events.cancel(slot);
    this.update();
  }

  /** Reference cycles per timer tick (0 when stopped). */
  private tick(): number {
    const config = this.regs[T0CONFIG >>> 2];
    if ((config & T0_EN) === 0) return 0;
    const clock = (config & USE_XTAL) !== 0 ? XTAL_HZ : this.ctx.apbHz;
    let divider = (config >>> 13) & 0xffff;
    if (divider === 0) divider = 65536;
    if (divider === 1) divider = 2;
    return (this.ctx.refHz / clock) * divider;
  }

  /** The count at reference time `t`. */
  value(t = this.ctx.now()): number {
    const tick = this.tick();
    if (tick === 0) return this.count;
    const ticks = Math.floor((t - this.since) / tick);
    const up = (this.regs[T0CONFIG >>> 2] & INCREASE) !== 0;
    return (((up ? this.count + ticks : this.count - ticks) % MASK54) + MASK54) % MASK54;
  }

  private rebase(t: number): void {
    this.count = this.value(t);
    this.since = t;
  }

  private armAlarm(): void {
    const config = this.regs[T0CONFIG >>> 2];
    const tick = this.tick();
    if (tick === 0 || (config & ALARM_EN) === 0) {
      this.ctx.events.cancel(this.alarmSlot);
      return;
    }
    const target = (this.regs[T0ALARMHI >>> 2] & 0x3fffff) * TWO32 + this.regs[T0ALARMLO >>> 2];
    const now = this.ctx.now();
    const current = this.value(now);
    const up = (config & INCREASE) !== 0;
    const ticks = up ? target - current : current - target;
    const when = ticks <= 0 ? now : this.since + (Math.floor((now - this.since) / tick) + ticks) * tick;
    this.ctx.events.schedule(this.alarmSlot, when);
    this.ctx.hurry(when);
  }

  private alarm(): void {
    const t = this.ctx.now();
    this.rebase(t);
    this.intRaw |= 1;
    let config = this.regs[T0CONFIG >>> 2];
    if ((config & AUTORELOAD) !== 0) {
      this.count = (this.regs[T0LOADHI >>> 2] & 0x3fffff) * TWO32 + this.regs[T0LOADLO >>> 2];
      this.since = t;
    }
    config &= ~ALARM_EN;
    this.regs[T0CONFIG >>> 2] = config;
    this.update();
  }

  /** The watchdog's stage timeouts in reference cycles (prescaler on the XTAL clock). */
  private stageTime(stage: number): number {
    const prescale = Math.max(1, this.regs[WDTCONFIG1 >>> 2] >>> 16);
    const ticks = this.regs[(0x50 + stage * 4) >>> 2];
    return (Math.max(1, ticks) * prescale * this.ctx.refHz) / XTAL_HZ;
  }

  private stageAction(stage: number): number {
    return (this.regs[WDTCONFIG0 >>> 2] >>> (29 - stage * 2)) & 3;
  }

  private armWdt(): void {
    const config = this.regs[WDTCONFIG0 >>> 2];
    if ((config & WDT_EN) === 0) {
      this.ctx.events.cancel(this.wdtSlot);
      return;
    }
    // The next stage with an action (stages with action 0 are skipped, as on the chip).
    while (this.wdtStage < 4 && this.stageAction(this.wdtStage) === 0) this.wdtStage++;
    if (this.wdtStage >= 4) {
      this.ctx.events.cancel(this.wdtSlot);
      return;
    }
    this.ctx.events.schedule(this.wdtSlot, this.ctx.now() + this.stageTime(this.wdtStage));
  }

  private wdtExpired(): void {
    const action = this.stageAction(this.wdtStage);
    if (action === 1) {
      this.intRaw |= 2;
      this.update();
    } else if (action >= 2) {
      this.onWdtReset?.(this.index);
      return;
    }
    this.wdtStage = (this.wdtStage + 1) % 4;
    this.armWdt();
  }

  private calibrated(): void {
    const cfg = this.regs[RTCCALICFG >>> 2];
    const slowHz = SLOW_CLOCK_HZ[(cfg >>> 13) & 3] ?? SLOW_CLOCK_HZ[0];
    const cycles = (cfg >>> 16) & 0x7fff;
    const xtalCycles = Math.round((cycles * XTAL_HZ) / slowHz);
    this.regs[RTCCALICFG1 >>> 2] = (xtalCycles & 0x1ffffff) << 7;
    this.regs[RTCCALICFG >>> 2] = cfg | CALI_RDY;
  }

  private update(): void {
    const st = this.intRaw & this.regs[INT_ENA >>> 2];
    this.ctx.matrix.setSource(this.sources[0], (st & 1) !== 0);
    this.ctx.matrix.setSource(this.sources[1], (st & 2) !== 0);
  }

  read32(offset: number): number {
    switch (offset) {
      case T0LO:
        return this.latched % TWO32 >>> 0;
      case T0HI:
        return Math.floor(this.latched / TWO32) & 0x3fffff;
      case T0UPDATE:
        return 0;
      case INT_RAW:
        return this.intRaw;
      case INT_ST:
        return this.intRaw & this.regs[INT_ENA >>> 2];
    }
    return this.regs[offset >>> 2];
  }

  write32(offset: number, value: number): void {
    const t = this.ctx.now();
    switch (offset) {
      case T0CONFIG:
        this.rebase(t);
        this.regs[T0CONFIG >>> 2] = value;
        this.armAlarm();
        return;
      case T0UPDATE:
        this.latched = this.value(t);
        return;
      case T0LOAD:
        this.count = (this.regs[T0LOADHI >>> 2] & 0x3fffff) * TWO32 + this.regs[T0LOADLO >>> 2];
        this.since = t;
        this.armAlarm();
        return;
      case T0ALARMLO:
      case T0ALARMHI:
        this.regs[offset >>> 2] = value;
        this.armAlarm();
        return;
      case INT_CLR:
        this.intRaw &= ~value;
        this.update();
        return;
      case INT_ENA:
        this.regs[INT_ENA >>> 2] = value;
        this.update();
        return;
      case WDTFEED:
        if (this.regs[WDTWPROTECT >>> 2] !== WDT_KEY && this.regs[WDTWPROTECT >>> 2] !== 0) return;
        this.wdtStage = 0;
        this.armWdt();
        return;
      case WDTWPROTECT:
        this.regs[WDTWPROTECT >>> 2] = value === WDT_KEY ? 0 : 1;
        return;
      case RTCCALICFG:
        this.regs[RTCCALICFG >>> 2] = value & ~CALI_RDY;
        if ((value & CALI_START) !== 0) {
          this.regs[RTCCALICFG2 >>> 2] &= ~1; // a new calibration: no timeout
          const slowHz = SLOW_CLOCK_HZ[(value >>> 13) & 3] ?? SLOW_CLOCK_HZ[0];
          const cycles = Math.max(1, (value >>> 16) & 0x7fff);
          this.ctx.events.schedule(this.caliSlot, t + (cycles * this.ctx.refHz) / slowHz);
        }
        return;
    }
    if (offset === RTCCALICFG2) {
      // BT124: TIMEOUT (0) — a timeout threshold (31:7) written while a periodic calibration runs
      // times it out at once (IDF waits out a running calibration that way before its own).
      this.regs[RTCCALICFG2 >>> 2] = ((value & ~1) | ((this.regs[RTCCALICFG >>> 2] & (1 << 12)) !== 0 && value >>> 7 !== 0 ? 1 : 0)) >>> 0;
      return;
    }
    if (offset >= WDTCONFIG0 && offset <= 0x5c) {
      if (this.regs[WDTWPROTECT >>> 2] === 1) return; // write-protected
      this.regs[offset >>> 2] = value;
      if (offset === WDTCONFIG0) {
        this.wdtStage = 0;
        this.armWdt();
      }
      return;
    }
    this.regs[offset >>> 2] = value;
  }

  /** The watchdog is running (tests). */
  get watchdogRunning(): boolean {
    return (this.regs[WDTCONFIG0 >>> 2] & WDT_EN) !== 0;
  }
}
