/** BT83: a supply part watching its own terminals (`supply-fight`). */

import type { PartContext, PinHandle } from '@benchtop/core';

/**
 * A source's terminal held off its volts by another supply (a 9 V battery's + on a board's 5 V):
 * the switch-level resolver sees two highs and no conflict, so the source watches its own
 * terminal and reports a `supply-fight` while the net sits more than 0.1 V away (a supply tied to
 * another at the same volts is fine, as on the bench).
 */
export class FightWatch {
  private readonly ctx: PartContext;
  private readonly pin: PinHandle;
  private readonly label: string;
  target = 0;
  private reported = false;

  constructor(ctx: PartContext, pin: PinHandle, label: string) {
    this.ctx = ctx;
    this.pin = pin;
    this.label = label;
    pin.onChange(this.check);
  }

  readonly check = (): void => {
    const volts = this.pin.read().volts;
    const fight = Math.abs(volts - this.target) > 0.1;
    if (fight === this.reported) return;
    this.reported = fight;
    this.ctx.report({
      severity: 'error',
      code: 'supply-fight',
      message: fight ? `${this.label} (${this.target.toFixed(2)} V) is tied to another supply: the net reads ${volts.toFixed(2)} V.` : '',
      parts: [],
    });
  };
}

