/**
 * An LED's light under the analog layer: its current from the solved pin voltages,
 * I = max(0, Va − Vk − Vf) / rs, integrated over time (the duty of "on" from edge timestamps, as
 * shared/duty.ts does, times the on-current), shown as brightness = min(1, √(Iavg / 15 mA))
 * (decided, perceptual). Allocation-free on the update path. A part with several LEDs shares one
 * OvercurrentReport.
 */

import type { PartContext, PinHandle } from '@benchtop/core';
import { DutyChannel } from './duty.ts';

/** Current that counts as lit, amps. */
const LIT_AMPS = 1e-5;
/** Current at full brightness, amps. */
export const FULL_BRIGHTNESS_AMPS = 0.015;
/** Above this an LED reports 'led-overcurrent', amps. */
export const OVERCURRENT_AMPS = 0.03;

/** Reports 'led-overcurrent' while any of a part's LEDs carries more than 30 mA, and clears it after. */
export class OvercurrentReport {
  private readonly ctx: PartContext;
  private active = false;

  constructor(ctx: PartContext) {
    this.ctx = ctx;
  }

  update(maxAmps: number): void {
    const over = maxAmps > OVERCURRENT_AMPS;
    if (over === this.active) return;
    this.active = over;
    this.ctx.report({
      severity: 'error',
      code: 'led-overcurrent',
      // An empty message withdraws the problem (the bench's convention).
      message: over ? `~${Math.round(maxAmps * 1000)} mA, max 20 mA continuous — add a 220 Ω–1 kΩ series resistor.` : '',
      parts: [],
    });
  }

  reset(): void {
    this.active = false;
  }
}

export class DiodeLight {
  /** Latest current, amps. */
  amps = 0;
  private readonly duty: DutyChannel;
  private onAmps = 0;
  private readonly ctx: PartContext;
  private readonly anode: PinHandle;
  private readonly cathode: PinHandle;
  private readonly vf: number;
  private readonly rs: number;

  constructor(ctx: PartContext, anode: PinHandle, cathode: PinHandle, vf: number, rs: number) {
    this.ctx = ctx;
    this.duty = new DutyChannel(ctx);
    this.anode = anode;
    this.cathode = cathode;
    this.vf = vf;
    this.rs = rs;
  }

  /** Recomputes the current from the pins' volts (call from both pins' listeners). */
  update(): void {
    const amps = Math.max(0, this.anode.read().volts - this.cathode.read().volts - this.vf) / this.rs;
    this.amps = amps;
    const lit = amps > LIT_AMPS;
    if (lit && Math.abs(amps - this.onAmps) > 1e-5) {
      this.onAmps = amps;
      this.ctx.invalidate();
    }
    this.duty.set(lit);
  }

  get brightness(): number {
    return Math.min(1, Math.sqrt((this.duty.brightness * this.onAmps) / FULL_BRIGHTNESS_AMPS));
  }

  reset(): void {
    this.duty.reset();
    this.amps = 0;
    this.onAmps = 0;
  }
}
