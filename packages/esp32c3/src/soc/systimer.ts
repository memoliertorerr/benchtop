/**
 * The ESP32-C3's system timer (BT92; TRM §10, systimer_reg.h), at 0x60023000: two 52-bit counters
 * (units 0 and 1) ticking at 16 MHz while CONF enables them, and three comparators, each alarming
 * once at its target or periodically every `period` ticks of the unit it watches. IDF 4.4 counts
 * esp_timer on unit 0 with comparator 2, and the FreeRTOS tick on unit 1 with comparator 0 in
 * period mode.
 *
 * Software reads a unit by writing UNIT_OP.UPDATE and then the VALUE registers, which hold the
 * count captured at that write (UNIT_OP.VALUE_VALID reads 1); it loads one with LOAD_HI/LO and
 * UNIT_LOAD. A comparator takes its target and period only on COMPn_LOAD (period mode's first
 * alarm one period after the load); its CONF's UNIT_SEL and PERIOD_MODE act as written — IDF's
 * systimer_hal_select_alarm_mode sets PERIOD_MODE after the load. An alarm sets INT_RAW bit n;
 * source SYSTIMER_TARGETn is high while INT_RAW & INT_ENA has bit n. Counts are exact: a unit's
 * value is its load plus the whole ticks since then (a double holds 52 bits).
 */

import type { Peripheral } from '@benchtop/esp32';
import { type SocContext, SYSTIMER_TICK } from './context.ts';
import { SRC } from './intmatrix.ts';

export const SYSTIMER_BASE = 0x60023000;

const CONF = 0x00;
const UNIT_OP = [0x04, 0x08];
const UNIT_LOAD_HI = [0x0c, 0x14];
const TARGET_HI = [0x1c, 0x24, 0x2c];
const TARGET_CONF = [0x34, 0x38, 0x3c];
const VALUE_HI = [0x40, 0x48];
const COMP_LOAD = [0x50, 0x54, 0x58];
const UNIT_LOAD = [0x5c, 0x60];
const INT_ENA = 0x64;
const INT_RAW = 0x68;
const INT_CLR = 0x6c;
const INT_ST = 0x70;
const DATE = 0xfc;

const CLK_EN = 1 << 31;
const UNIT_WORK_EN = [1 << 30, 1 << 29];
const TARGET_WORK_EN = [1 << 24, 1 << 23, 1 << 22];
const OP_UPDATE = 1 << 30;
const OP_VALID = 1 << 29;
const PERIOD_MODE = 1 << 30;
const PERIOD_MASK = 0x3ffffff;
const UNIT_SEL = 1 << 31;
const TWO32 = 2 ** 32;
const MASK52 = 2 ** 52;

export class Systimer implements Peripheral {
  private readonly ctx: SocContext;
  conf = 0;
  /** Per unit: the value at `since` and whether it counts. */
  private readonly base = [0, 0];
  private readonly since = [0, 0];
  private readonly captured = [0, 0];
  private readonly valid = [false, false];
  private readonly loadHi = [0, 0];
  private readonly loadLo = [0, 0];
  /** Comparators: the registers as written, what COMPn_LOAD latched, and the next alarm's count. */
  private readonly targetHi = [0, 0, 0];
  private readonly targetLo = [0, 0, 0];
  private readonly targetConf = [0, 0, 0];
  private readonly loadedTarget = [0, 0, 0];
  private readonly loadedPeriod = [0, 0, 0];
  private readonly armedTarget = [0, 0, 0];
  intEna = 0;
  intRaw = 0;
  private readonly slots: number[];

  constructor(ctx: SocContext) {
    this.ctx = ctx;
    this.slots = [0, 1, 2].map((n) => ctx.events.add(() => this.alarm(n)));
    this.systemReset();
  }

  systemReset(): void {
    this.conf = CLK_EN | UNIT_WORK_EN[0];
    this.base.fill(0);
    this.since.fill(0);
    this.captured.fill(0);
    this.valid.fill(false);
    this.loadHi.fill(0);
    this.loadLo.fill(0);
    this.targetHi.fill(0);
    this.targetLo.fill(0);
    this.targetConf.fill(0);
    this.loadedTarget.fill(0);
    this.loadedPeriod.fill(0);
    this.armedTarget.fill(0);
    this.intEna = this.intRaw = 0;
    for (const slot of this.slots) this.ctx.events.cancel(slot);
    this.updateSources();
  }

  private counting(unit: number): boolean {
    return (this.conf & CLK_EN) !== 0 && (this.conf & UNIT_WORK_EN[unit]) !== 0;
  }

  /** Unit `unit`'s count at reference time `t`. */
  value(unit: number, t = this.ctx.now()): number {
    if (!this.counting(unit)) return this.base[unit];
    return (this.base[unit] + Math.floor((t - this.since[unit]) / SYSTIMER_TICK)) % MASK52;
  }

  /** Freeze or resume a unit at the current time (CONF changes). */
  private rebase(t: number): void {
    for (let u = 0; u < 2; u++) {
      this.base[u] = this.value(u, t);
      this.since[u] = t;
    }
  }

  read32(offset: number): number {
    switch (offset) {
      case CONF:
        return this.conf >>> 0;
      case UNIT_OP[0]:
      case UNIT_OP[1]:
        return this.valid[offset === UNIT_OP[0] ? 0 : 1] ? OP_VALID : 0;
      case VALUE_HI[0]:
      case VALUE_HI[1]:
        return Math.floor(this.captured[offset === VALUE_HI[0] ? 0 : 1] / TWO32) & 0xfffff;
      case VALUE_HI[0] + 4:
      case VALUE_HI[1] + 4:
        return this.captured[offset === VALUE_HI[0] + 4 ? 0 : 1] % TWO32 >>> 0;
      case INT_ENA:
        return this.intEna;
      case INT_RAW:
        return this.intRaw;
      case INT_ST:
        return this.intRaw & this.intEna;
      case DATE:
        return 0x2006171;
    }
    for (let u = 0; u < 2; u++) {
      if (offset === UNIT_LOAD_HI[u]) return this.loadHi[u];
      if (offset === UNIT_LOAD_HI[u] + 4) return this.loadLo[u];
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
      case CONF:
        this.rebase(t);
        this.conf = value >>> 0;
        for (let n = 0; n < 3; n++) this.arm(n);
        return;
      case UNIT_OP[0]:
      case UNIT_OP[1]: {
        const u = offset === UNIT_OP[0] ? 0 : 1;
        if ((value & OP_UPDATE) !== 0) {
          this.captured[u] = this.value(u, t);
          this.valid[u] = true;
        }
        return;
      }
      case INT_ENA:
        this.intEna = value & 7;
        this.updateSources();
        return;
      case INT_CLR:
        this.intRaw &= ~value;
        this.updateSources();
        return;
    }
    for (let u = 0; u < 2; u++) {
      if (offset === UNIT_LOAD_HI[u]) this.loadHi[u] = value & 0xfffff;
      else if (offset === UNIT_LOAD_HI[u] + 4) this.loadLo[u] = value >>> 0;
      else if (offset === UNIT_LOAD[u] && (value & 1) !== 0) {
        this.base[u] = this.loadHi[u] * TWO32 + this.loadLo[u];
        this.since[u] = t;
        this.valid[u] = false;
        for (let n = 0; n < 3; n++) this.arm(n);
      } else continue;
      return;
    }
    for (let n = 0; n < 3; n++) {
      if (offset === TARGET_HI[n]) this.targetHi[n] = value & 0xfffff;
      else if (offset === TARGET_HI[n] + 4) this.targetLo[n] = value >>> 0;
      else if (offset === TARGET_CONF[n]) {
        const changed = (this.targetConf[n] ^ value) & (PERIOD_MODE | UNIT_SEL);
        this.targetConf[n] = value >>> 0;
        if (changed !== 0) this.retarget(n, t);
      } else if (offset === COMP_LOAD[n] && (value & 1) !== 0) {
        this.loadedTarget[n] = this.targetHi[n] * TWO32 + this.targetLo[n];
        this.loadedPeriod[n] = this.targetConf[n] & PERIOD_MASK;
        this.retarget(n, t);
      } else continue;
      return;
    }
  }

  /** Comparator n's next alarm afresh: its loaded target, or one period from now in period mode. */
  private retarget(n: number, t: number): void {
    const conf = this.targetConf[n];
    if ((conf & PERIOD_MODE) !== 0) this.armedTarget[n] = this.value((conf & UNIT_SEL) !== 0 ? 1 : 0, t) + this.loadedPeriod[n];
    else this.armedTarget[n] = this.loadedTarget[n];
    this.arm(n);
  }

  /** Schedules comparator n's next alarm (or cancels it). */
  private arm(n: number): void {
    const slot = this.slots[n];
    const conf = this.targetConf[n];
    const unit = (conf & UNIT_SEL) !== 0 ? 1 : 0;
    if ((this.conf & TARGET_WORK_EN[n]) === 0 || !this.counting(unit)) {
      this.ctx.events.cancel(slot);
      return;
    }
    const now = this.ctx.now();
    const ticks = this.armedTarget[n] - this.value(unit, now);
    // Due now or past: fire at the next tick boundary (a one-shot target already passed alarms at once).
    const when = ticks <= 0 ? now : this.since[unit] + (this.armedTarget[n] - this.base[unit]) * SYSTIMER_TICK;
    this.ctx.events.schedule(slot, when);
    this.ctx.hurry(when);
  }

  private alarm(n: number): void {
    this.intRaw |= 1 << n;
    this.updateSources();
    if ((this.targetConf[n] & PERIOD_MODE) !== 0 && this.loadedPeriod[n] !== 0) {
      this.armedTarget[n] += this.loadedPeriod[n];
      this.arm(n);
    }
  }

  private updateSources(): void {
    const st = this.intRaw & this.intEna;
    this.ctx.matrix.setSource(SRC.SYSTIMER_TARGET0, (st & 1) !== 0);
    this.ctx.matrix.setSource(SRC.SYSTIMER_TARGET1, (st & 2) !== 0);
    this.ctx.matrix.setSource(SRC.SYSTIMER_TARGET2, (st & 4) !== 0);
  }
}
