/**
 * The ADC (BT66; RP2350 datasheet §12.4): 12 bits of 3.3 V on channels 0–3 (GPIO26–29 on the
 * RP2350A) and the temperature sensor on channel 4 (0.706 V: 27 °C). CS.START_ONCE converts the
 * AINSEL channel in 96 clk_adc cycles (2 µs at 48 MHz) — READY is clear meanwhile — into RESULT;
 * START_MANY converts back to back (or every DIV + 1 cycles when DIV is set), round-robin over
 * RROBIN's channels, into the 4-entry FIFO when FCS.EN (SHIFT: 8 bits; ERR is never set),
 * raising the FIFO interrupt (IRQ 35) at THRESH. The channel values are the pins' voltages, which
 * the Mcu adapter keeps up to date.
 */

import type { Alarm, SocClock } from '../clock.ts';
import { applyAlias, Periph, type PeriphHost } from './block.ts';

export const ADC_VREF = 3.3;
const TEMPERATURE_VOLTS = 0.706;
const CONVERSION_NANOS = 2000;
const CLK_ADC_HZ = 48_000_000;
const FIFO_DEPTH = 4;
const ADC_IRQ_FIFO = 35;

export class Adc extends Periph {
  /** Volts on channels 0–4 (4: the temperature sensor). */
  readonly volts = new Float64Array(5);
  private readonly fifo: number[] = [];
  private busy = false;
  private readonly conversion: Alarm;
  private channel = 0;

  constructor(name: string, base: number, host: PeriphHost, clock: SocClock) {
    super(name, base, host);
    this.conversion = clock.alarm(() => this.converted());
    this.volts[4] = TEMPERATURE_VOLTS;
  }

  override reset(): void {
    super.reset();
    this.fifo.length = 0;
    this.busy = false;
    this.conversion.cancel();
    this.update();
  }

  private code(channel: number): number {
    const v = channel < 5 ? this.volts[channel] : 0;
    return Math.round((Math.max(0, Math.min(ADC_VREF, v)) / ADC_VREF) * 4095);
  }

  private start(): void {
    const cs = this.regs[0];
    if ((cs & 1) === 0 || this.busy) return;
    this.busy = true;
    this.channel = (cs >>> 12) & 0xf;
    const div = this.regs[0x10 >>> 2];
    const many = (cs & 8) !== 0;
    const nanos = many && div !== 0 ? Math.max(CONVERSION_NANOS, ((((div >>> 8) + 1) * 1e9) / CLK_ADC_HZ)) : CONVERSION_NANOS;
    this.conversion.scheduleAt(this.host.now() + nanos);
  }

  private converted(): void {
    this.busy = false;
    const result = this.code(this.channel);
    this.regs[0x04 >>> 2] = result;
    const fcs = this.regs[0x08 >>> 2];
    if ((fcs & 1) !== 0) {
      if (this.fifo.length < FIFO_DEPTH) this.fifo.push((fcs & 2) !== 0 ? result >>> 4 : result);
      else this.regs[0x08 >>> 2] |= 0x800; // OVER
    }
    let cs = this.regs[0];
    const rrobin = (cs >>> 16) & 0x1ff;
    if (rrobin !== 0) {
      let next = this.channel;
      for (let i = 0; i < 9; i++) {
        next = (next + 1) % 9;
        if ((rrobin & (1 << next)) !== 0) break;
      }
      cs = (cs & ~0xf000) | (next << 12);
      this.regs[0] = cs;
    }
    this.update();
    if ((cs & 8) !== 0) this.start();
  }

  private update(): void {
    const fcs = this.regs[0x08 >>> 2];
    const thresh = (fcs >>> 24) & 0xf;
    const intr = this.fifo.length >= thresh && thresh > 0 ? 1 : 0;
    this.regs[0x14 >>> 2] = intr;
    const ints = (intr | this.regs[0x1c >>> 2]) & this.regs[0x18 >>> 2];
    this.host.setIrq(ADC_IRQ_FIFO, (ints & 1) !== 0);
  }

  override read(offset: number): number {
    switch (offset) {
      case 0x00:
        return (this.regs[0] & ~0x10c) | (this.busy ? 0 : 0x100); // READY; START_ONCE self-clears
      case 0x08: {
        const fcs = this.regs[0x08 >>> 2] & ~(0x000f0300);
        return (fcs | (this.fifo.length << 16) | (this.fifo.length === 0 ? 0x100 : 0) | (this.fifo.length >= FIFO_DEPTH ? 0x200 : 0)) >>> 0;
      }
      case 0x0c: {
        const value = this.fifo.shift();
        if (value === undefined) this.regs[0x08 >>> 2] |= 0x400; // UNDER
        this.update();
        return value ?? 0;
      }
      case 0x20:
        return (this.regs[0x14 >>> 2] | this.regs[0x1c >>> 2]) & this.regs[0x18 >>> 2];
      case 0x04:
      case 0x10:
      case 0x14:
      case 0x18:
      case 0x1c:
        return this.regs[offset >>> 2];
      default:
        return this.readStored(offset);
    }
  }

  override write(offset: number, value: number, alias: number): void {
    switch (offset) {
      case 0x00: {
        const cs = applyAlias(this.regs[0], value, alias);
        this.regs[0] = cs & ~4;
        if ((cs & 4) !== 0 || (cs & 8) !== 0) this.start();
        return;
      }
      case 0x08: {
        const next = applyAlias(this.regs[0x08 >>> 2], value, alias);
        // OVER and UNDER clear on a write of 1
        this.regs[0x08 >>> 2] = (next & ~0xc00) | (this.regs[0x08 >>> 2] & 0xc00 & ~applyAlias(0, value, alias));
        this.update();
        return;
      }
      case 0x10:
      case 0x18:
      case 0x1c:
        this.store(offset, value, alias);
        this.update();
        return;
      default:
        this.writeStored(offset, value, alias);
    }
  }
}
