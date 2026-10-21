/**
 * LED PWM controller (0x3FF59000; ledc_reg.h, ledc_ll.h, TRM v5.8 "LED PWM Controller") — BT35.
 *
 * 8 high-speed and 8 low-speed channels (channel c: group c >> 3, number c & 7; registers at
 * 0x14·n, low speed from 0xA0: CONF0, HPOINT, DUTY, CONF1, DUTY_R) on 4 + 4 timers (CONF at
 * 0x140 + 8·t, low speed from 0x160). A timer counts its clock divided by CLOCK_DIVIDER (bits
 * 22:5, fixed point 10.8) up to 2^DUTY_RES (bits 4:0) and overflows: one PWM period. Clocks:
 * TICK_SEL (bit 25) 1 = APB (high speed) or the low-speed SLOW_CLK (LEDC_CONF APB_CLK_SEL bit 0:
 * APB, else the 8 MHz RTC clock), 0 = REF_TICK (1 MHz). PAUSE (23) or RST (24) stop it; any
 * timer write restarts its periods from that moment.
 *
 * A channel's output (SIG_OUT_EN, CONF0 bit 2; IDLE_LV bit 3 while disabled) is high while the
 * counter is in [HPOINT, HPOINT + duty): edges are timed events at exact times — a period
 * boundary, the rise at HPOINT, the fall duty ticks later. DUTY is 19.4 fixed point; its 4-bit
 * fraction (which the hardware spreads over 16 periods) is modeled as the average: the high time
 * is DUTY/16 ticks, so 0x1001 on a 13-bit timer is 256.0625 ticks every period. DUTY_START (CONF1
 * bit 31) latches DUTY and HPOINT at the next period boundary, as the hardware does (low-speed
 * channels also set PARA_UP, CONF0 bit 4: treated alike); DUTY_R then reads the new duty. Duty 0
 * and duty ≥ 2^DUTY_RES are constant levels with no events. A duty that would run past the
 * period's end (HPOINT + duty > 2^DUTY_RES) ends at the period's end — the wrap isn't modeled.
 * The hardware fade (DUTY_INC/NUM/CYCLE/SCALE) and the interrupts are storage (Later).
 *
 * Outputs reach the pads through the GPIO matrix: LEDC_HS_SIG_OUT0_IDX 71–78, LEDC_LS_SIG_OUT0_IDX
 * 79–86 (gpio_sig_map.h); `level` holds them and `onOutput` tells the pad resolver.
 */

import type { SocContext } from './context.ts';
import { REF_HZ } from './context.ts';
import { RegisterFile } from './periph.ts';

export const LEDC_BASE = 0x3ff59000;
export const LEDC_SIGNAL_BASE = 71;
const CHANNELS = 16;
const LS_CHANNELS = 0xa0;
const TIMERS = 0x140;
const LS_TIMERS = 0x160;
const LEDC_CONF = 0x190;
const RTC8M_HZ = 8_000_000;

// Channel register offsets within a channel.
const CONF0 = 0x00;
const HPOINT = 0x04;
const DUTY = 0x08;
const CONF1 = 0x0c;
const DUTY_R = 0x10;
const SIG_OUT_EN = 1 << 2;
const IDLE_LV = 1 << 3;
const DUTY_START = 1 << 31;
// Timer CONF fields.
const PAUSE = 1 << 23;
const RST = 1 << 24;
const TICK_SEL = 1 << 25;

/** Channel phases: the next event is a period boundary, a rise or a fall. */
const NEXT_BOUNDARY = 0;
const NEXT_RISE = 1;
const NEXT_FALL = 2;

export class Ledc extends RegisterFile {
  /** Output signal per channel (0–7 high speed, 8–15 low speed). */
  readonly level = new Uint8Array(CHANNELS);
  /** An output level changed. */
  onOutput: (() => void) | null = null;
  private readonly context: SocContext;
  /** Per timer (0–3 high speed, 4–7 low speed): when its periods started. */
  private readonly timerStart = new Float64Array(8);
  /** Per channel: the latched duty (ticks) and HPOINT, a pending DUTY_START, the next event. */
  private readonly duty = new Float64Array(CHANNELS);
  private readonly hpoint = new Float64Array(CHANNELS);
  private readonly pending = new Uint8Array(CHANNELS);
  private readonly next = new Uint8Array(CHANNELS);
  /** The period (index from the timer's start) the channel's current events belong to. */
  private readonly period = new Float64Array(CHANNELS);
  private readonly slots: number[] = [];

  constructor(context: SocContext) {
    super(LEDC_BASE);
    this.context = context;
    for (let c = 0; c < CHANNELS; c++) this.slots.push(context.events.add(() => this.channelEvent(c)));
  }

  implements(offset: number): boolean {
    return offset < LEDC_CONF + 4;
  }

  override systemReset(_rtcDomain: boolean): void {
    this.reset();
    for (let c = 0; c < CHANNELS; c++) this.context.events.cancel(this.slots[c]);
    this.duty.fill(0);
    this.hpoint.fill(0);
    this.pending.fill(0);
    this.timerStart.fill(this.context.now());
    let changed = false;
    for (let c = 0; c < CHANNELS; c++) {
      const v = this.idleLevel(c);
      if (v !== this.level[c]) changed = true;
      this.level[c] = v;
    }
    if (changed) this.onOutput?.();
  }

  /** The register offset of channel c's register `reg`. */
  private static ch(c: number, reg: number): number {
    return (c < 8 ? c * 0x14 : LS_CHANNELS + (c - 8) * 0x14) + reg;
  }

  /** Timer index (0–7) channel c runs on. */
  private timerOf(c: number): number {
    return (c < 8 ? 0 : 4) + (this.regs[Ledc.ch(c, CONF0) >>> 2] & 3);
  }

  private timerConf(t: number): number {
    return this.regs[((t < 4 ? TIMERS : LS_TIMERS) + (t & 3) * 8) >>> 2];
  }

  /** Reference cycles per counter tick of timer t, 0 while it is stopped. */
  private tickCycles(t: number): number {
    const conf = this.timerConf(t);
    if ((conf & (PAUSE | RST)) !== 0) return 0;
    const div = ((conf >>> 5) & 0x3ffff) / 256;
    if (div === 0) return 0;
    let clock: number;
    if ((conf & TICK_SEL) === 0) clock = 1_000_000;
    else if (t < 4) clock = this.context.apbHz;
    else clock = (this.regs[LEDC_CONF >>> 2] & 1) !== 0 ? this.context.apbHz : RTC8M_HZ;
    return (div / clock) * REF_HZ;
  }

  private resolutionTicks(t: number): number {
    return 2 ** (this.timerConf(t) & 0x1f);
  }

  private idleLevel(c: number): number {
    return (this.regs[Ledc.ch(c, CONF0) >>> 2] & IDLE_LV) !== 0 ? 1 : 0;
  }

  private setLevel(c: number, v: number): void {
    if (this.level[c] === v) return;
    this.level[c] = v;
    this.onOutput?.();
  }

  override write32(offset: number, value: number): void {
    super.write32(offset, value);
    if (offset >= TIMERS && offset < LS_TIMERS + 32) {
      if ((offset & 4) !== 0) return; // VALUE registers
      const t = offset < LS_TIMERS ? (offset - TIMERS) >>> 3 : 4 + ((offset - LS_TIMERS) >>> 3);
      this.timerStart[t] = this.context.now();
      for (let c = 0; c < CHANNELS; c++) if (this.timerOf(c) === t) this.restart(c);
      return;
    }
    if (offset === LEDC_CONF) {
      for (let c = 8; c < CHANNELS; c++) this.restart(c);
      return;
    }
    if (offset >= LEDC_CONF) return;
    const c = offset < LS_CHANNELS ? Math.floor(offset / 0x14) : 8 + Math.floor((offset - LS_CHANNELS) / 0x14);
    const reg = offset - Ledc.ch(c, 0);
    if (reg === CONF1 && (value & DUTY_START) !== 0) {
      this.pending[c] = 1;
      // The period running goes on with the old duty (its fall included); the boundary that
      // ends it latches the new one. Only a channel with nothing scheduled needs a boundary.
      if (!this.context.events.pending(this.slots[c])) this.restart(c);
    } else if (reg === CONF0) this.restart(c);
  }

  /** Recomputes channel c's schedule from now: its level and next event. */
  private restart(c: number): void {
    const slot = this.slots[c];
    this.context.events.cancel(slot);
    if ((this.regs[Ledc.ch(c, CONF0) >>> 2] & SIG_OUT_EN) === 0) {
      this.setLevel(c, this.idleLevel(c));
      return;
    }
    const t = this.timerOf(c);
    const tick = this.tickCycles(t);
    if (tick === 0) return; // stopped: the output holds
    const periodCycles = this.resolutionTicks(t) * tick;
    const now = this.context.now();
    // The period now running, and its start.
    const k = Math.floor((now - this.timerStart[t]) / periodCycles);
    this.period[c] = k;
    if (this.pending[c] !== 0) {
      // DUTY_START waits for the next boundary.
      this.next[c] = NEXT_BOUNDARY;
      this.period[c] = k + 1;
      this.context.events.schedule(slot, this.timerStart[t] + (k + 1) * periodCycles);
      return;
    }
    this.planPeriod(c, now);
  }

  /**
   * Within period `this.period[c]`: sets the level the waveform has at `now` and schedules the
   * next edge or boundary.
   */
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
        this.context.events.schedule(this.slots[c], end);
      }
      return;
    }
    const rise = start + this.hpoint[c] * tick;
    const fall = Math.min(rise + duty * tick, end);
    if (now < rise) {
      this.setLevel(c, 0);
      this.next[c] = NEXT_RISE;
      this.context.events.schedule(this.slots[c], rise);
    } else if (now < fall) {
      this.setLevel(c, 1);
      this.next[c] = NEXT_FALL;
      this.context.events.schedule(this.slots[c], fall);
    } else {
      this.setLevel(c, 0);
      this.next[c] = NEXT_BOUNDARY;
      this.period[c]++;
      this.context.events.schedule(this.slots[c], end);
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
          const raw = this.regs[Ledc.ch(c, DUTY) >>> 2] & 0x1ffffff;
          this.duty[c] = raw / 16;
          this.hpoint[c] = this.regs[Ledc.ch(c, HPOINT) >>> 2] & 0xfffff;
          this.regs[Ledc.ch(c, DUTY_R) >>> 2] = raw;
          this.regs[Ledc.ch(c, CONF1) >>> 2] &= ~DUTY_START;
        }
        this.planPeriod(c, start);
        return;
      case NEXT_RISE: {
        this.setLevel(c, 1);
        const fall = Math.min(start + (this.hpoint[c] + this.duty[c]) * tick, start + max * tick);
        this.next[c] = NEXT_FALL;
        this.context.events.schedule(this.slots[c], fall);
        return;
      }
      default:
        this.setLevel(c, 0);
        this.next[c] = NEXT_BOUNDARY;
        this.period[c]++;
        this.context.events.schedule(this.slots[c], start + max * tick);
    }
  }

  /** APB changed: keep each running channel's phase but re-time from now (≤ one period off). */
  clockChanged(): void {
    for (let t = 0; t < 8; t++) this.timerStart[t] = this.context.now();
    for (let c = 0; c < CHANNELS; c++) this.restart(c);
  }
}
