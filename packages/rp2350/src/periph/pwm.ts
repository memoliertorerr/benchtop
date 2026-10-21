/**
 * PWM (BT66; RP2350 datasheet §12.5): 12 slices of CSR, DIV, CTR, CC, TOP at 0x14 apart, then EN
 * (0xf0, every slice's CSR.EN at once), INTR and the two IRQ sets (IRQ 8 and 9: PWM_IRQ_WRAP_0/1).
 * Free-running slices only (CSR.DIVMODE 0; the gated and edge-counting modes are reported).
 *
 * A slice counts at clk_sys / (DIV.INT + DIV.FRAC/16) (INT 0 is 256) from 0 to TOP and wraps
 * (a period of TOP + 1 counts), or up to TOP and back in phase-correct mode (2 × (TOP + 1));
 * channel A (B) is high while the count is below CC.A (CC.B), inverted by A_INV (B_INV). The
 * model keeps when the count was 0 and schedules the slice's next output edge or wrap, so pins
 * change at their exact times and a steady slice costs a couple of events a period. A disabled
 * slice holds its count and outputs; PH_ADV/PH_RET move it by one count; a CTR write sets it.
 * GPIO n is slice (n >> 1) & 7 (the RP2350A's pins), channel A on even pins, B on odd.
 */

import type { Alarm, SocClock } from '../clock.ts';
import { applyAlias, Periph, type PeriphHost } from './block.ts';

export const PWM_SLICES = 12;
const STRIDE = 0x14;
const IRQ_WRAP_0 = 8;
const IRQ_WRAP_1 = 9;

export class Pwm extends Periph {
  private readonly sysHz: () => number;
  /** Per slice: when the count was 0 (ns), the count while disabled. */
  private readonly zeroAt = new Float64Array(PWM_SLICES);
  private readonly held = new Float64Array(PWM_SLICES);
  private readonly alarms: Alarm[];
  private intr = 0;
  /** A slice's output may have changed. */
  onChange: (() => void) | null = null;

  constructor(name: string, base: number, host: PeriphHost, clock: SocClock, sysHz: () => number) {
    super(name, base, host);
    this.sysHz = sysHz;
    this.alarms = Array.from({ length: PWM_SLICES }, (_, s) => clock.alarm(() => this.event(s)));
  }

  override reset(): void {
    super.reset();
    this.zeroAt.fill(0);
    this.held.fill(0);
    this.intr = 0;
    for (const alarm of this.alarms) alarm.cancel();
    this.updateIrqs();
  }

  private csr(s: number): number {
    return this.regs[(s * STRIDE) >>> 2];
  }

  private enabled(s: number): boolean {
    return (this.csr(s) & 1) !== 0;
  }

  /** One count, ns. */
  private tick(s: number): number {
    const div = this.regs[(s * STRIDE + 4) >>> 2];
    const ratio = ((div >>> 4) & 0xff || 256) + (div & 0xf) / 16;
    return (ratio * 1e9) / (this.sysHz() || 150_000_000);
  }

  private top(s: number): number {
    return this.regs[(s * STRIDE + 0x10) >>> 2] & 0xffff;
  }

  /** Counts in one period. */
  private periodCounts(s: number): number {
    const top = this.top(s) + 1;
    return (this.csr(s) & 2) !== 0 ? 2 * top : top;
  }

  /** The position in the period, in counts (fractional), now. */
  private phase(s: number): number {
    if (!this.enabled(s)) return this.held[s];
    // A hair past now: an edge scheduled for this instant has happened (rounding mustn't put the
    // count just before it).
    const counts = (this.host.now() - this.zeroAt[s]) / this.tick(s) + 1e-7;
    const period = this.periodCounts(s);
    return ((counts % period) + period) % period;
  }

  /** The counter value a phase shows (phase-correct counts down after TOP). */
  private counter(s: number, phase: number): number {
    const top = this.top(s) + 1;
    const p = Math.floor(phase);
    return (this.csr(s) & 2) !== 0 && p >= top ? 2 * top - 1 - p : p;
  }

  /** A channel's output level now (0/1). */
  output(s: number, channel: number): number {
    const cc = this.regs[(s * STRIDE + 0xc) >>> 2];
    const level = channel === 0 ? cc & 0xffff : cc >>> 16;
    const high = this.counter(s, this.phase(s)) < level ? 1 : 0;
    const inv = (this.csr(s) >>> (2 + channel)) & 1;
    return high ^ inv;
  }

  /** Re-anchors a slice at its current count (after a configuration change) and reschedules. */
  private restart(s: number, phase: number): void {
    if (this.enabled(s)) {
      this.zeroAt[s] = this.host.now() - phase * this.tick(s);
      this.schedule(s);
    } else {
      this.held[s] = phase;
      this.alarms[s].cancel();
    }
    this.onChange?.();
  }

  /** Schedules the next edge of A or B, or the wrap — strictly after now. */
  private schedule(s: number): void {
    const now = this.host.now();
    const tick = this.tick(s);
    const period = this.periodCounts(s);
    const counts = (now - this.zeroAt[s]) / tick;
    let k = Math.floor(counts / period);
    let phase = counts - k * period;
    if (period - phase < 1e-6) {
      // at the wrap (rounding put it a hair before): the next period has begun
      k += 1;
      phase = 0;
    }
    const top = this.top(s) + 1;
    const cc = this.regs[(s * STRIDE + 0xc) >>> 2];
    const pc = (this.csr(s) & 2) !== 0;
    let next = period;
    for (const level of [cc & 0xffff, cc >>> 16]) {
      const candidates = pc ? [level, 2 * top - level] : [level];
      for (const c of candidates) if (c > phase + 1e-6 && c < next) next = c;
    }
    this.alarms[s].scheduleAt(Math.max(this.zeroAt[s] + (k * period + next) * tick, now + 0.001));
  }

  private event(s: number): void {
    if (!this.enabled(s)) return;
    const phase = this.phase(s);
    if (phase < 1e-6 || phase > this.periodCounts(s) - 1e-6) {
      this.intr |= 1 << s;
      this.updateIrqs();
    }
    this.onChange?.();
    this.schedule(s);
  }

  private updateIrqs(): void {
    const f0 = (this.intr | this.regs[0xfc >>> 2]) & this.regs[0xf8 >>> 2];
    const f1 = (this.intr | this.regs[0x108 >>> 2]) & this.regs[0x104 >>> 2];
    this.host.setIrq(IRQ_WRAP_0, f0 !== 0);
    this.host.setIrq(IRQ_WRAP_1, f1 !== 0);
  }

  override read(offset: number): number {
    if (offset < PWM_SLICES * STRIDE) {
      const s = Math.floor(offset / STRIDE);
      if (offset % STRIDE === 8) return this.counter(s, this.phase(s)) & 0xffff;
      return this.regs[offset >>> 2];
    }
    switch (offset) {
      case 0xf0: {
        let en = 0;
        for (let s = 0; s < PWM_SLICES; s++) if (this.enabled(s)) en |= 1 << s;
        return en;
      }
      case 0xf4:
        return this.intr;
      case 0x100:
        return (this.intr | this.regs[0xfc >>> 2]) & this.regs[0xf8 >>> 2];
      case 0x10c:
        return (this.intr | this.regs[0x108 >>> 2]) & this.regs[0x104 >>> 2];
      case 0xf8:
      case 0xfc:
      case 0x104:
      case 0x108:
        return this.regs[offset >>> 2];
      default:
        return this.readStored(offset);
    }
  }

  override write(offset: number, value: number, alias: number): void {
    if (offset < PWM_SLICES * STRIDE) {
      const s = Math.floor(offset / STRIDE);
      const reg = offset % STRIDE;
      const phase = this.phase(s);
      if (reg === 8) {
        this.restart(s, applyAlias(0, value, alias) & 0xffff);
        return;
      }
      const before = this.regs[offset >>> 2];
      let next = applyAlias(before, value, alias);
      let shift = 0;
      if (reg === 0) {
        if ((next & 0x80) !== 0) shift = 1; // PH_ADV
        if ((next & 0x40) !== 0) shift = -1; // PH_RET
        next &= ~0xc0;
        if (((next >>> 4) & 3) !== 0) this.host.unmodelled(this.name, this.base + offset, true); // DIVMODE ≠ free-running
      }
      this.regs[offset >>> 2] = next;
      const period = this.periodCounts(s);
      this.restart(s, (((phase + shift) % period) + period) % period);
      return;
    }
    switch (offset) {
      case 0xf0: {
        const en = applyAlias(this.read(0xf0), value, alias);
        for (let s = 0; s < PWM_SLICES; s++) {
          const phase = this.phase(s);
          const at = (s * STRIDE) >>> 2;
          this.regs[at] = (en & (1 << s)) !== 0 ? this.regs[at] | 1 : this.regs[at] & ~1;
          this.restart(s, phase);
        }
        return;
      }
      case 0xf4:
        this.intr &= ~applyAlias(0, value, alias);
        this.updateIrqs();
        return;
      case 0xf8:
      case 0xfc:
      case 0x104:
      case 0x108:
        this.store(offset, value, alias);
        this.updateIrqs();
        return;
      default:
        this.writeStored(offset, value, alias);
    }
  }
}
