import { INTERRUPT_BIT, IRQ, type RiscvBus, RiscvCore } from '@benchtop/riscv';
import { describe, expect, it } from 'vitest';
import { Xh3Irq } from './xh3irq.ts';

// BT65: Hazard3's Xh3irq as rvcsr.h describes it, driven through the hooks the core calls.

const bus: RiscvBus = {
  read8: () => 0,
  read16: () => 0,
  read32: () => 0,
  write8: () => {},
  write16: () => {},
  write32: () => {},
  fetch16: () => 0x0001, // c.nop
};

const MEIEA = 0xbe0;
const MEIPA = 0xbe1;
const MEIFA = 0xbe2;
const MEIPRA = 0xbe3;
const MEINEXT = 0xbe4;
const MEICONTEXT = 0xbe5;
const WRITE = 0;
const SET = 1;

function setup() {
  const core = new RiscvCore(bus);
  const lines = new Uint32Array(2);
  const irq = new Xh3Irq(core, lines);
  const raise = (n: number, level = true): void => {
    lines[n >>> 5] = level ? lines[n >>> 5] | (1 << (n & 31)) : lines[n >>> 5] & ~(1 << (n & 31));
    irq.update();
  };
  const enable = (n: number): void => void irq.accessCsr(MEIEA, SET, ((1 << (n & 15)) << 16) | (n >>> 4), true);
  const priority = (n: number, p: number): void => void irq.accessCsr(MEIPRA, SET, ((p << (4 * (n & 3))) << 16) | (n >>> 2), true);
  const meip = (): number => (core.mip >>> IRQ.MEI) & 1;
  return { core, irq, raise, enable, priority, meip };
}

describe('Xh3irq', () => {
  it('reads and writes 16-bit windows selected by the operand\'s low bits', () => {
    const { irq, enable } = setup();
    enable(3);
    enable(33);
    expect(irq.accessCsr(MEIEA, SET, 0, false)).toBe(0x00080000);
    expect(irq.accessCsr(MEIEA, SET, 2, false)).toBe(0x00020000);
    expect(irq.accessCsr(MEIEA, SET, 1, false)).toBe(0);
    expect(irq.accessCsr(MEIEA, WRITE, 2, true)).toBe(0x00020000); // write the window to 0
    expect(irq.accessCsr(MEIEA, SET, 2, false)).toBe(0);
  });

  it('raises mip.meip for an enabled pending IRQ, and meipa shows pending lines and forces', () => {
    const { irq, raise, enable, meip } = setup();
    raise(33);
    expect(meip()).toBe(0);
    expect(irq.accessCsr(MEIPA, SET, 2, false)).toBe(0x00020000);
    enable(33);
    expect(meip()).toBe(1);
    raise(33, false);
    expect(meip()).toBe(0);
    irq.accessCsr(MEIFA, SET, (1 << 16) | 2, true); // force IRQ 32
    expect(irq.accessCsr(MEIPA, SET, 2, false)).toBe(0x00010000);
  });

  it('meinext gives the highest priority (lowest number on a tie) ≥ ppreempt, and a read clears its force bit', () => {
    const { irq, raise, enable, priority } = setup();
    for (const n of [3, 33, 40]) {
      enable(n);
      raise(n);
    }
    priority(3, 2);
    priority(33, 5);
    priority(40, 5);
    expect(irq.priority[33]).toBe(5);
    expect(irq.accessCsr(MEINEXT, SET, 0, false)).toBe(33 << 2);
    raise(33, false);
    raise(40, false);
    irq.accessCsr(MEIFA, SET, (1 << (40 - 32)) << 16 | 2, true);
    expect(irq.accessCsr(MEINEXT, SET, 0, false)).toBe(40 << 2); // forced
    expect(irq.forced[1]).toBe(0); // …and the read cleared it
    expect(irq.accessCsr(MEINEXT, SET, 0, false)).toBe(3 << 2);
    raise(3, false);
    expect(irq.accessCsr(MEINEXT, SET, 0, false)).toBe(0x80000000);
  });

  it('meinext.update moves the IRQ into meicontext and raises preempt to its priority + 1', () => {
    const { irq, raise, enable, priority, meip } = setup();
    enable(3);
    enable(33);
    priority(3, 2);
    priority(33, 5);
    raise(33);
    expect(irq.accessCsr(MEINEXT, SET, 1, true)).toBe(33 << 2);
    expect([irq.irq, irq.noirq, irq.preempt]).toEqual([33, 0, 6]);
    raise(3); // priority 2 < preempt 6: pending, not taken
    expect(meip()).toBe(0);
  });

  it('pushes the priority stack on the external interrupt and pops it on mret', () => {
    const { core, irq, raise, enable, priority } = setup();
    enable(33);
    priority(33, 5);
    raise(33);
    core.trapHook?.((INTERRUPT_BIT | IRQ.MEI) >>> 0, 0, 0);
    expect([irq.pppreempt, irq.ppreempt, irq.preempt, irq.mreteirq]).toEqual([0, 0, 6, 1]);
    core.mretHook?.();
    expect([irq.preempt, irq.mreteirq]).toEqual([0, 0]);
    core.trapHook?.((INTERRUPT_BIT | IRQ.MEI) >>> 0, 0, 0);
    core.trapHook?.(2, 0, 0); // another trap clears mreteirq
    core.mretHook?.();
    expect(irq.preempt).toBe(6);
  });

  it('clearts clears mie.mtie/msie and reads their old values; written save bits restore them', () => {
    const { core, irq } = setup();
    core.mie = (1 << 7) | (1 << 3) | (1 << 11);
    const saved = irq.accessCsr(MEICONTEXT, SET, 2, true) as number;
    expect(saved & 0xc).toBe(0xc);
    expect(core.mie).toBe(1 << 11);
    irq.accessCsr(MEICONTEXT, WRITE, saved, true);
    expect(core.mie).toBe((1 << 7) | (1 << 3) | (1 << 11));
    expect((irq.accessCsr(MEICONTEXT, SET, 0, false) as number) & 0xc).toBe(0); // save bits read 0 without clearts
  });
});
