/**
 * The ESP32-C3's LED PWM controller (BT93; ledc_reg.h, TRM §31), at 0x60019000: six channels
 * (0x14·c: CONF0, HPOINT, DUTY, CONF1, DUTY_R) on four timers (CONF at 0xA0 + 8·t), the low-speed
 * group of the ESP32's controller alone. A timer counts its clock divided by CLK_DIV (21:4, fixed
 * point 10.8) up to 2^DUTY_RES (3:0, ≤ 14) and overflows: one period. Clock: TICK_SEL (24) the
 * 1 MHz REF_TICK, else LEDC_CONF's APB_CLK_SEL (1:0 — 1 APB, 2 RC_FAST 17.5 MHz, 3 XTAL); PAUSE
 * (22) or RST (23, set at reset) stop it; any timer write restarts its periods from that moment.
 *
 * As on the ESP32 (@benchtop/esp32's ledc.ts, whose scheduling this follows): a channel's output
 * (SIG_OUT_EN, CONF0 bit 2; IDLE_LV bit 3 while disabled) is high while the counter is in
 * [HPOINT, HPOINT + duty), edges are events at exact times, DUTY (18:0, 15.4 fixed point) counts
 * its fraction as the average, DUTY_START (CONF1 bit 31) latches DUTY and HPOINT at the next
 * period boundary (CONF0's PARA_UP, which IDF writes after it, restarts the schedule), duty 0 and
 * duty ≥ 2^DUTY_RES are constant levels. Fades and interrupts are storage. Outputs reach the pads
 * as LEDC_LS_SIG_OUT0–5 (signals 45–50); `onOutput` tells the pad resolver.
 */

import type { Peripheral } from '@benchtop/esp32';
import { REF_HZ, type SocContext, XTAL_HZ } from './context.ts';
import { registerDefault } from './periph.ts';

export const LEDC_BASE = 0x60019000;
export const LEDC_SIGNAL_BASE = 45;
export const LEDC_CHANNELS = 6;
const TIMERS = 0x0a0;
const LEDC_CONF = 0x0d0;
const RC_FAST_HZ = 17_500_000;

const CONF0 = 0x00;
const HPOINT = 0x04;
const DUTY = 0x08;
const CONF1 = 0x0c;
const DUTY_R = 0x10;
const SIG_OUT_EN = 1 << 2;
const IDLE_LV = 1 << 3;
const DUTY_START = 1 << 31;
const PAUSE = 1 << 22;
const RST = 1 << 23;
const TICK_SEL = 1 << 24;

const NEXT_BOUNDARY = 0;
const NEXT_RISE = 1;
const NEXT_FALL = 2;

export class Ledc implements Peripheral {
  readonly regs = new Uint32Array(1024);
  /** Output signal per channel. */
  readonly level = new Uint8Array(LEDC_CHANNELS);
  /** An output level changed. */
  onOutput: (() => void) | null = null;
  private readonly ctx: SocContext;
  private readonly timerStart = new Float64Array(4);
  private readonly duty = new Float64Array(LEDC_CHANNELS);
  private readonly hpoint = new Float64Array(LEDC_CHANNELS);
  private readonly pending = new Uint8Array(LEDC_CHANNELS);
  private readonly next = new Uint8Array(LEDC_CHANNELS);
  private readonly period = new Float64Array(LEDC_CHANNELS);
  private readonly slots: number[] = [];

  constructor(ctx: SocContext) {
    this.ctx = ctx;
    for (let c = 0; c < LEDC_CHANNELS; c++) this.slots.push(ctx.events.add(() => this.channelEvent(c)));
    this.systemReset();
  }

  implements(offset: number): boolean {
    return offset < TIMERS + 32 || (offset >= 0xc0 && offset <= LEDC_CONF) || offset === 0xfc;
  }

  systemReset(): void {
    for (let i = 0; i < this.regs.length; i++) this.regs[i] = registerDefault(LEDC_BASE + i * 4);
    for (let c = 0; c < LEDC_CHANNELS; c++) this.ctx.events.cancel(this.slots[c]);
    this.duty.fill(0);
    this.hpoint.fill(0);
    this.pending.fill(0);
    this.timerStart.fill(this.ctx.now());
    let changed = false;
    for (let c = 0; c < LEDC_CHANNELS; c++) {
      const v = this.idleLevel(c);
      if (v !== this.level[c]) changed = true;
      this.level[c] = v;
    }
    if (changed) this.onOutput?.();
  }

  read32(offset: number): number {
    return this.regs[offset >>> 2];
  }

  private timerOf(c: number): number {
    return this.regs[(c * 0x14 + CONF0) >>> 2] & 3;
  }

  private timerConf(t: number): number {
    return this.regs[(TIMERS + t * 8) >>> 2];
  }

  /** Reference cycles per counter tick of timer t, 0 while it is stopped. */
  private tickCycles(t: number): number {
    const conf = this.timerConf(t);
    if ((conf & (PAUSE | RST)) !== 0) return 0;
    const div = ((conf >>> 4) & 0x3ffff) / 256;
    if (div === 0) return 0;
    let clock: number;
    if ((conf & TICK_SEL) !== 0) clock = 1_000_000;
    else {
      const sel = this.regs[LEDC_CONF >>> 2] & 3;
      clock = sel === 1 ? this.ctx.apbHz : sel === 2 ? RC_FAST_HZ : sel === 3 ? XTAL_HZ : 0;
      if (clock === 0) return 0;
    }
    return (div / clock) * REF_HZ;
  }

  private resolutionTicks(t: number): number {
    return 2 ** (this.timerConf(t) & 0xf);
  }

  private idleLevel(c: number): number {
    return (this.regs[(c * 0x14 + CONF0) >>> 2] & IDLE_LV) !== 0 ? 1 : 0;
  }

  private setLevel(c: number, v: number): void {
    if (this.level[c] === v) return;
    this.level[c] = v;
    this.onOutput?.();
  }

  /** The duty as a fraction of the period (0–1) a channel outputs now — for tools and tests. */
  dutyFraction(c: number): number {
    if ((this.regs[(c * 0x14 + CONF0) >>> 2] & SIG_OUT_EN) === 0) return this.idleLevel(c);
    return Math.min(1, this.duty[c] / this.resolutionTicks(this.timerOf(c)));
  }

  write32(offset: number, value: number): void {
    if (offset === 0xfc || (offset >= TIMERS && offset < TIMERS + 32 && (offset & 4) !== 0)) return; // DATE, timer VALUE
    if (offset < LEDC_CHANNELS * 0x14 && offset % 0x14 === DUTY_R) return;
    this.regs[offset >>> 2] = value;
    if (offset >= TIMERS && offset < TIMERS + 32) {
      const t = (offset - TIMERS) >>> 3;
      this.regs[offset >>> 2] &= ~(1 << 25); // PARA_UP reads 0
      this.timerStart[t] = this.ctx.now();
      for (let c = 0; c < LEDC_CHANNELS; c++) if (this.timerOf(c) === t) this.restart(c);
      return;
    }
    if (offset === LEDC_CONF) {
      for (let c = 0; c < LEDC_CHANNELS; c++) this.restart(c);
      return;
    }
    if (offset >= LEDC_CHANNELS * 0x14) return;
    const c = Math.floor(offset / 0x14);
    const reg = offset - c * 0x14;
    if (reg === CONF1 && (value & DUTY_START) !== 0) {
      this.pending[c] = 1;
      if (!this.ctx.events.pending(this.slots[c])) this.restart(c);
    } else if (reg === CONF0) {
      this.regs[offset >>> 2] &= ~(1 << 4); // PARA_UP reads 0
      this.restart(c);
    }
  }

  private restart(c: number): void {
    const slot = this.slots[c];
    this.ctx.events.cancel(slot);
    if ((this.regs[(c * 0x14 + CONF0) >>> 2] & SIG_OUT_EN) === 0) {
      this.setLevel(c, this.idleLevel(c));
      return;
    }
    const t = this.timerOf(c);
    const tick = this.tickCycles(t);
    if (tick === 0) return;
    const periodCycles = this.resolutionTicks(t) * tick;
    const now = this.ctx.now();
    const k = Math.floor((now - this.timerStart[t]) / periodCycles);
    this.period[c] = k;
    if (this.pending[c] !== 0) {
      this.next[c] = NEXT_BOUNDARY;
      this.period[c] = k + 1;
      this.ctx.events.schedule(slot, this.timerStart[t] + (k + 1) * periodCycles);
      return;
    }
    this.planPeriod(c, now);
  }

  private planPeriod(c: number, now: number): void {
    const t = this.timerOf(c);
    const tick = this.tickCycles(t);
    const max = this.resolutionTicks(t);
    const start = this.timerStart[t] + this.period[c] * max * tick;
    const end = start + max * tick;
    const duty = this.duty[c];
    if (duty <= 0 || duty >= max) {
      this.setLevel(c, duty <= 0 ? 0 : 1);
      if (this.pending[c] !== 0) {
        this.next[c] = NEXT_BOUNDARY;
        this.period[c]++;
        this.ctx.events.schedule(this.slots[c], end);
      }
      return;
    }
    const rise = start + this.hpoint[c] * tick;
    const fall = Math.min(rise + duty * tick, end);
    if (now < rise) {
      this.setLevel(c, 0);
      this.next[c] = NEXT_RISE;
      this.ctx.events.schedule(this.slots[c], rise);
    } else if (now < fall) {
      this.setLevel(c, 1);
      this.next[c] = NEXT_FALL;
      this.ctx.events.schedule(this.slots[c], fall);
    } else {
      this.setLevel(c, 0);
      this.next[c] = NEXT_BOUNDARY;
      this.period[c]++;
      this.ctx.events.schedule(this.slots[c], end);
    }
  }

  private channelEvent(c: number): void {
    const t = this.timerOf(c);
    const tick = this.tickCycles(t);
    if (tick === 0) return;
    const max = this.resolutionTicks(t);
    const start = this.timerStart[t] + this.period[c] * max * tick;
    switch (this.next[c]) {
      case NEXT_BOUNDARY:
        if (this.pending[c] !== 0) {
          this.pending[c] = 0;
          const raw = this.regs[(c * 0x14 + DUTY) >>> 2] & 0x7ffff;
          this.duty[c] = raw / 16;
          this.hpoint[c] = this.regs[(c * 0x14 + HPOINT) >>> 2] & 0x3fff;
          this.regs[(c * 0x14 + DUTY_R) >>> 2] = raw;
          this.regs[(c * 0x14 + CONF1) >>> 2] &= ~DUTY_START;
        }
        this.planPeriod(c, start);
        return;
      case NEXT_RISE: {
        this.setLevel(c, 1);
        const fall = Math.min(start + (this.hpoint[c] + this.duty[c]) * tick, start + max * tick);
        this.next[c] = NEXT_FALL;
        this.ctx.events.schedule(this.slots[c], fall);
        return;
      }
      default:
        this.setLevel(c, 0);
        this.next[c] = NEXT_BOUNDARY;
        this.period[c]++;
        this.ctx.events.schedule(this.slots[c], start + max * tick);
    }
  }

  /** APB changed: re-time every running channel from now (≤ one period off). */
  clockChanged(): void {
    for (let t = 0; t < 4; t++) this.timerStart[t] = this.ctx.now();
    for (let c = 0; c < LEDC_CHANNELS; c++) this.restart(c);
  }
}
