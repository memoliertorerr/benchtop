/**
 * PCF8574 I/O expander as an I2C target, wired the way LCD "I2C backpacks" are:
 * P0=RS, P1=RW, P2=E, P3=backlight, P4–P7=D4–D7. Each written byte sets the port; a 1→0
 * change of P2 between consecutive writes is E's falling edge, latched into the HD44780 with
 * D3..D0 reading 0 (unconnected). Reads return the port latch. Allocation-free.
 */

import type { I2cDevice } from '@benchtop/core';
import type { Hd44780 } from './hd44780.ts';

export class Pcf8574Backpack implements I2cDevice {
  readonly address: number;
  /** The port latch, P7..P0 (power-on: all high). */
  port = 0xff;
  private readonly lcd: Hd44780;
  private readonly changed: () => void;

  /** `changed` runs after any write that changed what the display shows (text or backlight). */
  constructor(address: number, lcd: Hd44780, changed: () => void) {
    this.address = address;
    this.lcd = lcd;
    this.changed = changed;
  }

  get backlight(): boolean {
    return (this.port & 0x08) !== 0;
  }

  start(): boolean {
    return true;
  }

  write(byte: number): boolean {
    const before = this.port;
    this.port = byte & 0xff;
    if (before & 0x04 && !(this.port & 0x04) && !(this.port & 0x02)) {
      // E fell with RW=0: RS from P0, D7..D4 from P7..P4.
      this.lcd.latch((this.port & 0x01) !== 0, this.port & 0xf0);
      this.changed();
    } else if ((before ^ this.port) & 0x08) {
      this.changed();
    }
    return true;
  }

  read(): number {
    return this.port;
  }

  stop(): void {}

  reset(): void {
    this.port = 0xff;
  }
}

/** Backpack addresses: PCF8574 0x20–0x27 and PCF8574A 0x38–0x3F. Accepts 39, "0x27" or "39". */
export function parseBackpackAddress(value: string | number | boolean): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^(0x[0-9a-f]+|\d+)$/i.test(value.trim()) ? Number(value.trim()) : Number.NaN;
  if (!Number.isInteger(n) || !((n >= 0x20 && n <= 0x27) || (n >= 0x38 && n <= 0x3f))) {
    throw new Error(`address must be 0x20–0x27 or 0x38–0x3F, got ${String(value)}`);
  }
  return n;
}
