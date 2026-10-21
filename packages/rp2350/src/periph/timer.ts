/**
 * TIMER0 and TIMER1 (BT65; RP2350 datasheet §12.8): a 64-bit microsecond counter — simulated time
 * in µs plus whatever TIMEHW/TIMELW set — four 32-bit alarms that fire when TIMELR equals them
 * (the low word: an alarm in the past waits for the wrap, as on the chip), and INTR/INTE/INTF/INTS
 * driving the block's four IRQs (TIMER0: 0–3, TIMER1: 4–7). Reading TIMELR latches the high word
 * for TIMEHR. ARMED clears on a write of 1; INTR clears on a write of 1.
 */

import type { Alarm, SocClock } from '../clock.ts';
import { applyAlias, Periph, type PeriphHost } from './block.ts';

export class Timer extends Periph {
  private readonly irqBase: number;
  /** Microseconds added to simulated time (TIMEHW/TIMELW writes). */
  private offset = 0;
  private latchedHigh = 0;
  private armed = 0;
  private intr = 0;
  private readonly alarmTargets = new Uint32Array(4);
  private readonly alarms: Alarm[];

  constructor(name: string, base: number, host: PeriphHost, clock: SocClock, irqBase: number) {
    super(name, base, host);
    this.irqBase = irqBase;
    this.alarms = [0, 1, 2, 3].map((i) => clock.alarm(() => this.fire(i)));
  }

  override reset(): void {
    super.reset();
    this.offset = 0;
    this.latchedHigh = 0;
    this.armed = 0;
    this.intr = 0;
    for (const alarm of this.alarms) alarm.cancel();
    this.updateIrqs();
  }

  /** The counter now, µs (fractional below 2^53). */
  private micros(): number {
    return Math.floor(this.host.now() / 1000) + this.offset;
  }

  override read(offset: number): number {
    const now = this.micros();
    switch (offset) {
      case 0x08: // TIMEHR: latched by TIMELR
        return this.latchedHigh;
      case 0x0c: // TIMELR
        this.latchedHigh = Math.floor(now / 0x100000000) >>> 0;
        return now >>> 0;
      case 0x24: // TIMERAWH
        return Math.floor(now / 0x100000000) >>> 0;
      case 0x28: // TIMERAWL
        return now >>> 0;
      case 0x10:
      case 0x14:
      case 0x18:
      case 0x1c:
        return this.alarmTargets[(offset - 0x10) >>> 2];
      case 0x20:
        return this.armed;
      case 0x3c:
        return this.intr;
      case 0x40:
      case 0x44:
        return this.regs[offset >>> 2];
      case 0x48:
        return (this.intr | this.regs[0x44 >>> 2]) & this.regs[0x40 >>> 2] & 0xf;
      case 0x2c:
      case 0x30:
      case 0x34:
      case 0x38:
        return this.regs[offset >>> 2];
      default:
        return this.readStored(offset);
    }
  }

  override write(offset: number, value: number, alias: number): void {
    switch (offset) {
      case 0x00: {
        // TIMEHW: sets the high word (TIMELW, written first, set the low one)
        const low = this.micros() >>> 0;
        const high = applyAlias(0, value, alias);
        this.offset = high * 0x100000000 + low - Math.floor(this.host.now() / 1000);
        this.rescheduleAll();
        break;
      }
      case 0x04: {
        const high = Math.floor(this.micros() / 0x100000000);
        this.offset = high * 0x100000000 + applyAlias(0, value, alias) - Math.floor(this.host.now() / 1000);
        this.rescheduleAll();
        break;
      }
      case 0x10:
      case 0x14:
      case 0x18:
      case 0x1c: {
        const i = (offset - 0x10) >>> 2;
        this.alarmTargets[i] = applyAlias(this.alarmTargets[i], value, alias);
        this.armed |= 1 << i;
        this.schedule(i);
        break;
      }
      case 0x20: {
        const clear = applyAlias(0, value, alias) & 0xf;
        this.armed &= ~clear;
        for (let i = 0; i < 4; i++) if ((clear & (1 << i)) !== 0) this.alarms[i].cancel();
        break;
      }
      case 0x3c:
        this.intr &= ~applyAlias(0, value, alias);
        this.updateIrqs();
        break;
      case 0x40:
      case 0x44:
        this.store(offset, value, alias);
        this.updateIrqs();
        break;
      case 0x2c:
      case 0x30:
      case 0x34:
      case 0x38:
        this.store(offset, value, alias);
        break;
      default:
        this.writeStored(offset, value, alias);
    }
  }

  private schedule(i: number): void {
    const now = this.micros();
    const delta = (this.alarmTargets[i] - (now >>> 0)) >>> 0;
    // The alarm matches when the low word equals its target: at the next µs boundary at the earliest.
    const atMicros = now + (delta === 0 ? 0x100000000 : delta);
    this.alarms[i].scheduleAt((atMicros - this.offset) * 1000);
  }

  private rescheduleAll(): void {
    for (let i = 0; i < 4; i++) if ((this.armed & (1 << i)) !== 0) this.schedule(i);
  }

  private fire(i: number): void {
    if ((this.armed & (1 << i)) === 0) return;
    this.armed &= ~(1 << i);
    this.intr |= 1 << i;
    this.updateIrqs();
  }

  private updateIrqs(): void {
    const ints = (this.intr | this.regs[0x44 >>> 2]) & this.regs[0x40 >>> 2];
    for (let i = 0; i < 4; i++) this.host.setIrq(this.irqBase + i, (ints & (1 << i)) !== 0);
  }
}
