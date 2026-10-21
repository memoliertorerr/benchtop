/**
 * A part's divider as two resistive links (top: VCC side, bottom: GND side), for outputs that are
 * purely resistive — pots, joystick axes, LDR and NTC modules. The analog layer solves the true
 * voltage (with whatever load hangs on it); each link stays at least 1 Ω. With the analog layer
 * off, the middle resolves at switch level (a weak tie: no level, the average voltage).
 */

import type { PartContext } from '@benchtop/core';

export const MIN_LINK_OHMS = 1;

export class Divider {
  private readonly top: ReturnType<PartContext['link']>;
  private readonly bottom: ReturnType<PartContext['link']>;

  constructor(ctx: PartContext, topLink: string, bottomLink: string) {
    this.top = ctx.link(topLink);
    this.bottom = ctx.link(bottomLink);
  }

  /** Sets both halves, ohms (each clamped to ≥ 1 Ω). */
  set(topOhms: number, bottomOhms: number): void {
    this.top.setOhms(Math.max(MIN_LINK_OHMS, topOhms));
    this.bottom.setOhms(Math.max(MIN_LINK_OHMS, bottomOhms));
  }

  /** A pot of `totalOhms` at `position` 0..1 (0 = at GND, 1 = at VCC). */
  setPosition(totalOhms: number, position: number): void {
    const p = position < 0 ? 0 : position > 1 ? 1 : position;
    this.set((1 - p) * totalOhms, p * totalOhms);
  }
}
