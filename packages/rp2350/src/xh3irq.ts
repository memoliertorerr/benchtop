/**
 * Hazard3's external interrupt controller, Xh3irq (BT65), one per hart, as the RP2350's
 * rvcsr.h (Hazard3's own register descriptions) gives it:
 *
 *   meiea  0xbe0  enable array      ┐ indexed: the 5 LSBs of the *written* value select a 16-bit
 *   meipa  0xbe1  pending (RO)      │ window of the 512-entry array, read and written in bits
 *   meifa  0xbe2  force array       ┘ 31:16 — so the value read depends on the operand
 *   meipra 0xbe3  priorities: the index selects four 4-bit priorities (bits 31:16)
 *   meinext 0xbe4 the highest-priority pending, enabled IRQ ≥ meicontext.ppreempt (<< 2), or
 *                 bit 31 (NOIRQ); reading an IRQ out clears its force bit; writing UPDATE
 *                 (bit 0) moves it into meicontext and sets preempt to its priority + 1 (16,
 *                 preemption off, when there is none)
 *   meicontext 0xbe5  pppreempt 31:28, ppreempt 27:24, preempt 20:16, noirq 15, irq 12:4,
 *                 mtiesave 3, msiesave 2, clearts 1 (write 1: clear mie.mtie/msie, their old
 *                 values read in the save bits; the save bits written are ORed back into mie,
 *                 the clear winning), mreteirq 0
 *   msleep 0xbf0, pmpcfgm0 0xbd0: stored
 *
 * mip.meip is asserted while an enabled, pending (or forced) IRQ has priority ≥ preempt. Taking
 * the external interrupt pushes the priority stack (pppreempt ← ppreempt ← preempt ← that IRQ's
 * priority + 1) and sets mreteirq; any other trap clears mreteirq; an mret with mreteirq set
 * pops it. Equal priorities: the lowest IRQ number wins. The RP2350 has 52 IRQs and 16 levels.
 */

import { INTERRUPT_BIT, IRQ, type RiscvCore, type RiscvCsrHook } from '@benchtop/riscv';

const CSR_PMPCFGM0 = 0xbd0;
const CSR_MEIEA = 0xbe0;
const CSR_MEIPA = 0xbe1;
const CSR_MEIFA = 0xbe2;
const CSR_MEIPRA = 0xbe3;
const CSR_MEINEXT = 0xbe4;
const CSR_MEICONTEXT = 0xbe5;
const CSR_MSLEEP = 0xbf0;

export const IRQ_COUNT = 52;
const NO_PREEMPT = 16;
const MIE_MSIE = 1 << 3;
const MIE_MTIE = 1 << 7;

export class Xh3Irq implements RiscvCsrHook {
  /** Enable and force bits, IRQs 0–63 in two words. */
  readonly enabled = new Uint32Array(2);
  readonly forced = new Uint32Array(2);
  readonly priority = new Uint8Array(64);
  pppreempt = 0;
  ppreempt = 0;
  preempt = 0;
  noirq = 1;
  irq = 0;
  mreteirq = 0;
  msleep = 0;
  pmpcfgm0 = 0;
  private readonly core: RiscvCore;
  /** The shared interrupt lines (the SoC's), two words. */
  private readonly lines: Uint32Array;

  constructor(core: RiscvCore, lines: Uint32Array) {
    this.core = core;
    this.lines = lines;
    core.csrHook = this;
    core.trapHook = (cause) => this.trapped(cause);
    core.mretHook = () => this.returned();
  }

  reset(): void {
    this.enabled.fill(0);
    this.forced.fill(0);
    this.priority.fill(0);
    this.pppreempt = this.ppreempt = this.preempt = 0;
    this.noirq = 1;
    this.irq = 0;
    this.mreteirq = 0;
    this.msleep = 0;
    this.pmpcfgm0 = 0;
    this.update();
  }

  /** The highest-priority IRQ enabled and pending with priority ≥ `min`, or −1. */
  next(min: number): number {
    let best = -1;
    let bestPriority = -1;
    for (let w = 0; w < 2; w++) {
      let active = (this.lines[w] | this.forced[w]) & this.enabled[w];
      while (active !== 0) {
        const bit = 31 - Math.clz32(active & -active);
        active &= active - 1;
        const irq = 32 * w + bit;
        const p = this.priority[irq];
        if (p >= min && p > bestPriority) {
          best = irq;
          bestPriority = p;
        }
      }
    }
    return best;
  }

  /** Re-drives mip.meip (after a line, an enable, a priority or the preemption level changed). */
  update(): void {
    this.core.setInterruptLine(IRQ.MEI, this.next(this.preempt) >= 0);
  }

  readCsr(): number | undefined {
    return undefined;
  }

  writeCsr(): boolean {
    return false;
  }

  accessCsr(csr: number, kind: number, operand: number, writes: boolean): number | undefined {
    switch (csr) {
      case CSR_MEIEA:
        return this.array(this.enabled, kind, operand, writes);
      case CSR_MEIPA: {
        const index = operand & 0x1f;
        if (index >= 4) return 0;
        const word = (this.lines[index >>> 1] | this.forced[index >>> 1]) >>> ((index & 1) * 16);
        return ((word & 0xffff) << 16) >>> 0;
      }
      case CSR_MEIFA:
        return this.array(this.forced, kind, operand, writes);
      case CSR_MEIPRA: {
        const base = (operand & 0x1f) * 4;
        let window = 0;
        for (let i = 0; i < 4; i++) window |= (base + i < 64 ? this.priority[base + i] : 0) << (4 * i);
        if (writes) {
          const next = merge(window, operand >>> 16, kind) & 0xffff;
          for (let i = 0; i < 4; i++) if (base + i < IRQ_COUNT) this.priority[base + i] = (next >>> (4 * i)) & 0xf;
          this.update();
        }
        return (window << 16) >>> 0;
      }
      case CSR_MEINEXT: {
        const next = this.next(this.ppreempt);
        const value = next < 0 ? 0x80000000 : next << 2;
        // Reading an IRQ out of meinext clears its force bit (rvcsr.h, meifa).
        if (next >= 0) this.forced[next >>> 5] &= ~(1 << (next & 31));
        if (writes && (merge(0, operand, kind) & 1) !== 0) {
          this.noirq = next < 0 ? 1 : 0;
          this.irq = next < 0 ? 0 : next;
          this.preempt = next < 0 ? NO_PREEMPT : this.priority[next] + 1;
          this.update();
        }
        return value >>> 0;
      }
      case CSR_MEICONTEXT:
        return this.context(kind, operand, writes);
      case CSR_MSLEEP: {
        const old = this.msleep;
        if (writes) this.msleep = merge(old, operand, kind) & 0x7;
        return old;
      }
      case CSR_PMPCFGM0: {
        const old = this.pmpcfgm0;
        if (writes) this.pmpcfgm0 = merge(old, operand, kind) & 0xffff;
        return old;
      }
      default:
        return undefined;
    }
  }

  private array(bits: Uint32Array, kind: number, operand: number, writes: boolean): number {
    const index = operand & 0x1f;
    if (index >= 4) return 0;
    const word = index >>> 1;
    const shift = (index & 1) * 16;
    const window = (bits[word] >>> shift) & 0xffff;
    if (writes) {
      let next = merge(window, operand >>> 16, kind) & 0xffff;
      if (index === 3) next &= (1 << (IRQ_COUNT - 48)) - 1;
      bits[word] = ((bits[word] & ~(0xffff << shift)) | (next << shift)) >>> 0;
      this.update();
    }
    return (window << 16) >>> 0;
  }

  private context(kind: number, operand: number, writes: boolean): number {
    const core = this.core;
    const clearts = writes && (merge(0, operand, kind) & 2) !== 0;
    let value = (this.pppreempt << 28) | (this.ppreempt << 24) | (this.preempt << 16) | (this.noirq << 15) | (this.irq << 4) | this.mreteirq;
    if (clearts) value |= ((core.mie & MIE_MTIE) !== 0 ? 8 : 0) | ((core.mie & MIE_MSIE) !== 0 ? 4 : 0);
    if (writes) {
      const next = merge(value >>> 0, operand, kind);
      this.pppreempt = (next >>> 28) & 0xf;
      this.ppreempt = (next >>> 24) & 0xf;
      this.preempt = Math.min(NO_PREEMPT, (next >>> 16) & 0x1f);
      this.noirq = (next >>> 15) & 1;
      this.irq = (next >>> 4) & 0x1ff;
      this.mreteirq = next & 1;
      let mie = core.mie;
      if ((next & 8) !== 0) mie |= MIE_MTIE;
      if ((next & 4) !== 0) mie |= MIE_MSIE;
      if ((next & 2) !== 0) mie &= ~(MIE_MTIE | MIE_MSIE);
      core.mie = mie;
      this.update();
    }
    return value >>> 0;
  }

  private trapped(cause: number): void {
    if (cause >>> 0 === (INTERRUPT_BIT | IRQ.MEI) >>> 0) {
      const taken = this.next(this.preempt);
      this.pppreempt = this.ppreempt;
      this.ppreempt = this.preempt & 0xf;
      this.preempt = taken < 0 ? NO_PREEMPT : this.priority[taken] + 1;
      this.mreteirq = 1;
      this.update();
    } else {
      this.mreteirq = 0;
    }
  }

  private returned(): void {
    if (this.mreteirq === 0) return;
    this.preempt = this.ppreempt;
    this.ppreempt = this.pppreempt;
    this.pppreempt = 0;
    this.mreteirq = 0;
    this.update();
  }
}

/** A CSR instruction's write: kind 0 write, 1 set, 2 clear. */
function merge(old: number, operand: number, kind: number): number {
  return (kind === 0 ? operand : kind === 1 ? old | operand : old & ~operand) >>> 0;
}
