/**
 * The ESP32-S2's system timer (BT148; systimer_reg.h at 0x3F42_3000) — not the C3/S3's: one 64-bit
 * counter that adds TIMER_PLL_STEP (STEP 19:10) per 80 MHz APB cycle under the PLL and
 * TIMER_XTAL_STEP (9:0) per 40 MHz crystal cycle otherwise (IDF sets 1 and 2: 80 ticks a µs
 * either way — SYSTIMER_LL_TICKS_PER_US), while CONF.CLK_EN (31) is set; and three comparators,
 * each alarming once when the counter reaches its TARGETn, or (TARGETn_CONF.PERIOD_MODE, 30)
 * every PERIOD (29:0) ticks, while TARGETn_CONF.WORK_EN (31) is set. IDF 4.4 runs esp_timer on
 * it (comparator 0 one-shot; the FreeRTOS tick is the core's CCOMPARE).
 *
 * UPDATE (31) captures the count into VALUE_HI/LO and VALUE_VALID (30) reads 1; LOAD (31) sets it
 * from LOAD_HI/LO. An alarm sets INT_RAW bit n; source SYSTIMER_TARGETn is high while INT_RAW &
 * INT_ENA has bit n. Counts are exact to 2^53 (a double): the value is its base plus the whole
 * ticks since `since`; a clock change (`clockChanged`) or a STEP write starts a new segment.
 */

import type { Peripheral } from '@benchtop/esp32';
import type { SocContext } from '@benchtop/esp32c3';
import { S2_SRC } from './intmatrix.ts';

export const SYSTIMER_BASE = 0x3f423000;

const CONF = 0x00;
const LOAD = 0x04;
const LOAD_HI = 0x08;
const LOAD_LO = 0x0c;
const STEP = 0x10;
const TARGET_HI = [0x14, 0x1c, 0x24];
const TARGET_CONF = [0x2c, 0x30, 0x34];
const UPDATE = 0x38;
const VALUE_HI = 0x3c;
const VALUE_LO = 0x40;
const INT_ENA = 0x44;
const INT_RAW = 0x48;
const INT_CLR = 0x4c;
const DATE = 0xfc;

const CLK_EN = 1 << 31;
const BIT31 = 1 << 31;
const VALUE_VALID = 1 << 30;
const WORK_EN = 1 << 31;
const PERIOD_MODE = 1 << 30;
const PERIOD_MASK = 0x3fffffff;
const TWO32 = 2 ** 32;
const STEP_RESET = 0x450;

export class S2Systimer implements Peripheral {
  private readonly ctx: SocContext;
  conf = 0;
  step = STEP_RESET;
  /** The count at `since`. */
  private base = 0;
  private since = 0;
  private captured = 0;
  private valid = false;
  private loadHi = 0;
  private loadLo = 0;
  private readonly targetHi = [0, 0, 0];
  private readonly targetLo = [0, 0, 0];
  private readonly targetConf = [0, 0, 0];
  /** Each comparator's next alarm, as a count, and whether its one-shot alarm has gone off. */
  private readonly armed = [0, 0, 0];
  private readonly fired = [false, false, false];
  intEna = 0;
  intRaw = 0;
  private readonly slots: number[];
  private readonly sources = [S2_SRC.SYSTIMER_TARGET0, S2_SRC.SYSTIMER_TARGET1, S2_SRC.SYSTIMER_TARGET2] as const;

  constructor(ctx: SocContext) {
    this.ctx = ctx;
    this.slots = [0, 1, 2].map((n) => ctx.events.add(() => this.alarm(n)));
    this.systemReset();
  }

  systemReset(): void {
    this.conf = 0;
    this.step = STEP_RESET;
    this.base = 0;
    this.since = this.ctx.now();
    this.captured = 0;
    this.valid = false;
    this.loadHi = this.loadLo = 0;
    this.targetHi.fill(0);
    this.targetLo.fill(0);
    this.targetConf.fill(0);
    this.armed.fill(0);
    this.fired.fill(false);
    this.intEna = this.intRaw = 0;
    for (const slot of this.slots) this.ctx.events.cancel(slot);
    this.updateSources();
  }

  /** Ticks per reference cycle now (0 while the clock is off). */
  private rate(): number {
    if ((this.conf & CLK_EN) === 0) return 0;
    const perSecond = this.ctx.apbHz >= 80_000_000 ? 80_000_000 * ((this.step >>> 10) & 0x3ff) : 40_000_000 * (this.step & 0x3ff);
    return perSecond / this.ctx.refHz;
  }

  /** The count at reference time `t`. */
  value(t = this.ctx.now()): number {
    const rate = this.rate();
    return rate === 0 ? this.base : this.base + Math.floor((t - this.since) * rate);
  }

  /** The APB clock changed (or the step): the count so far is kept, the next segment runs at the new rate. */
  clockChanged(): void {
    const t = this.ctx.now();
    this.base = this.value(t);
    this.since = t;
    for (let n = 0; n < 3; n++) this.arm(n);
  }

  read32(offset: number): number {
    switch (offset) {
      case CONF:
        return this.conf >>> 0;
      case LOAD_HI:
        return this.loadHi;
      case LOAD_LO:
        return this.loadLo;
      case STEP:
        return this.step;
      case UPDATE:
        return this.valid ? VALUE_VALID : 0;
      case VALUE_HI:
        return Math.floor(this.captured / TWO32) >>> 0;
      case VALUE_LO:
        return this.captured % TWO32 >>> 0;
      case INT_ENA:
        return this.intEna;
      case INT_RAW:
        return this.intRaw;
      case DATE:
        return 0x1807160;
    }
    for (let n = 0; n < 3; n++) {
      if (offset === TARGET_HI[n]) return this.targetHi[n];
      if (offset === TARGET_HI[n] + 4) return this.targetLo[n];
      if (offset === TARGET_CONF[n]) return this.targetConf[n] >>> 0;
    }
    return 0;
  }

  write32(offset: number, value: number): void {
    const t = this.ctx.now();
    switch (offset) {
      case CONF: {
        this.base = this.value(t);
        this.since = t;
        this.conf = value >>> 0;
        for (let n = 0; n < 3; n++) this.arm(n);
        return;
      }
      case LOAD:
        if ((value & BIT31) !== 0) {
          this.base = this.loadHi * TWO32 + this.loadLo;
          this.since = t;
          this.valid = false;
          for (let n = 0; n < 3; n++) this.arm(n);
        }
        return;
      case LOAD_HI:
        this.loadHi = value >>> 0;
        return;
      case LOAD_LO:
        this.loadLo = value >>> 0;
        return;
      case STEP:
        this.base = this.value(t);
        this.since = t;
        this.step = value & 0xfffff;
        for (let n = 0; n < 3; n++) this.arm(n);
        return;
      case UPDATE:
        if ((value & BIT31) !== 0) {
          this.captured = this.value(t);
          this.valid = true;
        }
        return;
      case INT_ENA:
        this.intEna = value & 7;
        this.updateSources();
        return;
      case INT_CLR:
        this.intRaw &= ~value;
        this.updateSources();
        return;
    }
    for (let n = 0; n < 3; n++) {
      if (offset === TARGET_HI[n]) this.targetHi[n] = value >>> 0;
      else if (offset === TARGET_HI[n] + 4) this.targetLo[n] = value >>> 0;
      else if (offset === TARGET_CONF[n]) this.targetConf[n] = value >>> 0;
      else continue;
      this.retarget(n, t);
      return;
    }
  }

  /** Comparator n afresh: its target, or one period from now in period mode. */
  private retarget(n: number, t: number): void {
    const conf = this.targetConf[n];
    this.armed[n] = (conf & PERIOD_MODE) !== 0 ? this.value(t) + (conf & PERIOD_MASK) : this.targetHi[n] * TWO32 + this.targetLo[n];
    this.fired[n] = false;
    this.arm(n);
  }

  /** Schedules comparator n's next alarm (or cancels it). */
  private arm(n: number): void {
    const slot = this.slots[n];
    const rate = this.rate();
    if ((this.targetConf[n] & WORK_EN) === 0 || rate === 0 || this.fired[n]) {
      this.ctx.events.cancel(slot);
      return;
    }
    const now = this.ctx.now();
    const ticks = this.armed[n] - this.value(now);
    const when = ticks <= 0 ? now : this.since + Math.ceil((this.armed[n] - this.base) / rate);
    this.ctx.events.schedule(slot, when);
    this.ctx.hurry(when);
  }

  private alarm(n: number): void {
    this.intRaw |= 1 << n;
    this.updateSources();
    const conf = this.targetConf[n];
    if ((conf & PERIOD_MODE) !== 0 && (conf & PERIOD_MASK) !== 0) {
      this.armed[n] += conf & PERIOD_MASK;
      this.arm(n);
    } else this.fired[n] = true; // one-shot: once, until a target or CONF is written again
  }

  private updateSources(): void {
    const st = this.intRaw & this.intEna;
    for (let n = 0; n < 3; n++) this.ctx.matrix.setSource(this.sources[n], ((st >>> n) & 1) !== 0);
  }
}
