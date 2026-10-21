import { describe, expect, it } from 'vitest';
import { BareMachine, IRAM_BASE, symbolAddress } from '../test-support/bare-machine.test-helper.ts';
import { HALT } from './cpu.ts';
import { DESCRIPTOR_SIZE, decode } from './decode.ts';
import { disasm } from './disasm.ts';
import { EXCCAUSE } from './exceptions.ts';
import { OPS } from './isa.ts';
import { SR, UR } from './regs.ts';

// BT29: the windowed ABI, exceptions, interrupts, loops and the special registers, on the bare
// machine. Expected values are the ones derived in each fixtures/xtensa/*.S header comment
// (window counts also by an independent model of WINDOWSTART); addresses come from the .lst.

const SCRATCH = 0x3ffb0000;
const EVENTS = 0x3ffb0100;
const RESULTS = 0x3ffb0400;
const VECBASE = 0x40080400;

const hex = (values: number[]): string[] => values.map((v) => `0x${(v >>> 0).toString(16)}`);

function run(name: string, setup?: (machine: BareMachine) => void) {
  const machine = BareMachine.load(name);
  setup?.(machine);
  const core = machine.run(1_000_000);
  expect({ halt: core.halt, reason: core.haltReason, a2: hex([machine.a(2)])[0] }, name).toMatchObject({ halt: HALT.BREAK, reason: '1, 15' });
  return { machine, core };
}

/** The event log the program wrote (harness.inc EVENT / EVENT_REG). */
function events(machine: BareMachine): number[] {
  const end = machine.read32(SCRATCH);
  const log: number[] = [];
  for (let a = EVENTS; a < end; a += 4) log.push(machine.read32(a));
  return log;
}

/** Counts fetches at each window vector's first instruction. */
function countVectors(machine: BareMachine): Record<string, number> {
  const vectors: Record<number, string> = { 0x00: 'OF4', 0x40: 'UF4', 0x80: 'OF8', 0xc0: 'UF8', 0x100: 'OF12', 0x140: 'UF12' };
  const counts: Record<string, number> = { OF4: 0, UF4: 0, OF8: 0, UF8: 0, OF12: 0, UF12: 0 };
  const bus = machine.bus;
  const fetch = bus.fetch.bind(bus);
  bus.fetch = (addr: number): number => {
    const name = vectors[addr - VECBASE];
    if (name !== undefined) counts[name]++;
    return fetch(addr);
  };
  return counts;
}

describe('windowed registers', () => {
  const cases = [
    { name: 'window-recurse', sum: 820, counts: { OF4: 0, UF4: 0, OF8: 33, UF8: 33, OF12: 0, UF12: 0 } },
    { name: 'window-recurse4', sum: 820, counts: { OF4: 25, UF4: 25, OF8: 0, UF8: 0, OF12: 0, UF12: 0 } },
    { name: 'window-recurse12', sum: 210, counts: { OF4: 0, UF4: 0, OF8: 0, UF8: 0, OF12: 15, UF12: 15 } },
    { name: 'window-mixed', sum: 465, counts: { OF4: 8, UF4: 8, OF8: 8, UF8: 8, OF12: 7, UF12: 7 } },
  ];
  for (const { name, sum, counts } of cases) {
    it(`${name}: the sum, our handlers' counts, and WINDOWBASE/WINDOWSTART back at their entry values`, () => {
      const { machine } = run(name);
      const overflows = counts.OF4 + counts.OF8 + counts.OF12;
      const underflows = counts.UF4 + counts.UF8 + counts.UF12;
      expect([machine.a(2), machine.a(3), machine.a(4), machine.a(5), machine.a(6)]).toEqual([sum, 0, 1, overflows, underflows]);
      // The vector arrivals are counted at fetch(), which the predecode cache doesn't call per
      // instruction: a second run without it.
      let vectors: Record<string, number> = {};
      run(name, (m) => {
        m.core.predecode = false;
        vectors = countVectors(m);
      });
      expect(vectors).toEqual(counts);
    });
  }

  it('alloca: MOVSP with the caller spilled raises Alloca; the handler reloads the caller and MOVSP succeeds', () => {
    const { machine } = run('alloca');
    const regs = Array.from({ length: 11 }, (_, i) => machine.a(i + 2));
    // a2 old − new SP, a3 WINDOWSTART after the movsp, a4/a5 main's registers, a6/a7 MISC0/1,
    // a8 Alloca count, a9 EXCCAUSE, a10/a11 WINDOWBASE/START, a12 EPC1.
    expect(hex(regs)).toEqual(hex([32, 0b101, 0x1234, 0x5678, 2, 2, 1, EXCCAUSE.ALLOCA, 0, 1, symbolAddress('alloca', 'alloca_movsp')]));
  });
});

describe('interrupts and timers', () => {
  it('ccompare-int: timer 0 wakes WAITI once, timer 1 preempts level 1, software 7/29, NMI at INTLEVEL 15, EXCM masks ≤ 3', () => {
    let pulses = 0;
    const { machine, core } = run('ccompare-int', (m) => {
      m.checkpoint = (at) => {
        pulses++;
        at.core.pulseInterrupt(14);
      };
    });
    expect(pulses).toBe(1);
    const log = events(machine);
    const epc3 = log[2];
    expect(epc3).toBeGreaterThanOrEqual(symbolAddress('ccompare-int', 'l1_spin'));
    expect(epc3).toBeLessThan(symbolAddress('ccompare-int', 'l1_spin_end'));
    expect(hex(log)).toEqual(hex([0x11, 0x33, epc3, 0x21, 0x1e, 0x01, 0x77, 0x2f, 0x02, 0x55, 0x30, 0x03, 0x3d, 0x17, 0x04]));
    // T0_DELTA, T0_COUNT, INT_SET, INT_CLEAR, INT_END
    const words = [0x14, 0x18, 0x1c, 0x20, 0x24].map((offset) => machine.read32(SCRATCH + offset));
    expect(hex(words)).toEqual(hex([1002, 1, 0x20000080, 0x80, 0]));
    expect(words[0]).toBeGreaterThanOrEqual(1000);
    expect(words[0]).toBeLessThanOrEqual(1008);
    expect(core.slept).toBeGreaterThan(990); // WAITI skipped the wait instead of spinning
  });

  it('a level-type line is taken while high and enabled; the NMI ignores INTENABLE', () => {
    const machine = new BareMachine();
    const core = machine.core;
    core.writeSpecial(SR.PS, 0x20); // UM, INTLEVEL 0
    core.writeSpecial(SR.VECBASE, VECBASE);
    machine.setIram([0xf0, 0x41, 0x00], VECBASE + 0x340 - IRAM_BASE); // break 1, 15 at the user vector
    machine.setIram([0xf0, 0x41, 0x00], VECBASE + 0x2c0 - IRAM_BASE); // and at the NMI vector
    machine.setIram([0xf0, 0x20, 0x00, 0xf0, 0x20, 0x00]); // nop; nop
    core.pc = IRAM_BASE;
    core.setInterruptLine(3, true); // level 1, not enabled
    core.run(2);
    expect(core.pc).toBe(IRAM_BASE + 6);
    expect(core.irqCheck).toBe(false);
    core.writeSpecial(SR.INTENABLE, 1 << 3);
    expect(core.irqCheck).toBe(true);
    core.setInterruptLine(3, false);
    expect(core.irqCheck).toBe(false);
    core.writeSpecial(SR.INTENABLE, 0);
    core.pulseInterrupt(14);
    core.run(10);
    expect([core.pc, core.readSpecial(SR.EPC7), core.ps & 0x1f]).toEqual([VECBASE + 0x2c0, IRAM_BASE + 6, 0x17]);
    expect(core.interrupt & (1 << 14)).toBe(0); // taken: cleared
  });
});

describe('exceptions', () => {
  it('ill (user and kernel), syscall, a bus error, and a double exception with DEPC', () => {
    const { machine } = run('exceptions');
    const at = (symbol: string): number => symbolAddress('exceptions', symbol);
    expect(hex(events(machine))).toEqual(
      hex([
        0xa0, EXCCAUSE.ILLEGAL_INSTRUCTION, at('ill_user'),
        0xb0, EXCCAUSE.ILLEGAL_INSTRUCTION, at('ill_kernel'),
        0xa1, EXCCAUSE.SYSCALL, at('do_syscall'),
        0xa3, EXCCAUSE.LOAD_STORE_ERROR, 0x10000000,
        0xd0, at('handler_ill'), EXCCAUSE.ILLEGAL_INSTRUCTION, at('bad_load'), 0x30,
        0xa4, 0x30,
        0xee, 0x20,
      ]),
    );
  });

  it('without vectors in memory, an exception at reset is a double exception at the double vector (a fault)', () => {
    const machine = new BareMachine();
    machine.setIram([0x0e, 0x00, 0x00]); // op0 = 0xE: no instruction
    machine.core.pc = IRAM_BASE;
    machine.run(10);
    // PS.EXCM = 1 at reset: DEPC + the double vector in the (unmapped) ROM, whose fetch fails there.
    expect(machine.core.haltReason).toBe('double exception at the double-exception vector 0x400003c0 (cause 2)');
    expect(machine.core.readSpecial(SR.DEPC)).toBe(IRAM_BASE);
  });
});

describe('zero-overhead loops', () => {
  it('LOOP/LOOPNEZ/LOOPGTZ at 0, 1, 5 and negative counts; a taken branch to LEND; a timer interrupt inside the body', () => {
    const { machine } = run('loops');
    const results = Array.from({ length: 16 }, (_, i) => machine.read32(RESULTS + i * 4));
    expect(hex(results)).toEqual(hex([5, 1, 0, 1, 5, 0, 0, 1, 5, 1000, 0xfffffc18, 100, 0xffffff99, 2, 3, 200]));
    const log = events(machine);
    expect(log[0]).toBe(0x11);
    expect(log[1]).toBeGreaterThanOrEqual(symbolAddress('loops', 'timer_body'));
    expect(log[1]).toBeLessThan(symbolAddress('loops', 'timer_end'));
    expect(log).toHaveLength(2);
  });
});

describe('special and user registers', () => {
  const FULL = 0xffffffff;
  const PS_BITS = 0x70f3f;
  // Writable bits per register, from the ISA RM's register descriptions and the ESP32
  // core-isa.h (2 IBREAK, 2 DBREAK, 4 MISC, 8 coprocessor enables, a 40-bit MAC16 accumulator).
  const MASKS: Record<string, number> = {
    lbeg: FULL, lend: FULL, lcount: FULL, sar: 0x3f, br: 0xffff, litbase: 0, scompare1: FULL, acclo: FULL, acchi: 0xff,
    m0: FULL, m1: FULL, m2: FULL, m3: FULL, windowbase: 0xf, windowstart: 0xffff, ibreakenable: 0x3, memctl: FULL,
    atomctl: 0x3f, ddr: FULL, ibreaka0: FULL, ibreaka1: FULL, dbreaka0: FULL, dbreaka1: FULL, dbreakc0: 0xc000003f,
    dbreakc1: 0xc000003f, configid0: 0, depc: FULL, cpenable: 0xff, intenable: FULL, ps: PS_BITS, vecbase: 0xfffffc00,
    exccause: 0x3f, debugcause: 0x3f, icount: FULL, icountlevel: 0xf, excvaddr: FULL, ccompare0: FULL, ccompare1: FULL,
    ccompare2: FULL, misc0: FULL, misc1: FULL, misc2: FULL, misc3: FULL,
    expstate: FULL, threadptr: FULL, fcr: 0x7f, fsr: 0xf80, f64r_lo: FULL, f64r_hi: FULL, f64s: FULL,
  };
  for (let i = 1; i <= 7; i++) MASKS[`epc${i}`] = MASKS[`excsave${i}`] = FULL;
  for (let i = 2; i <= 7; i++) MASKS[`eps${i}`] = PS_BITS;
  const SPECIAL = new Set(['interrupt', 'intset', 'intclear', 'prid', 'configid1', 'ccount', 'mmid']);

  const ops = new Map<string, Map<string, number>>(); // register → kind → OPS index
  OPS.forEach((op, index) => {
    const m = /^(rsr|wsr|xsr|rur|wur)\.(.+)$/.exec(op.name);
    if (m === null) return;
    const kinds = ops.get(m[2]) ?? new Map<string, number>();
    kinds.set(m[1], index);
    ops.set(m[2], kinds);
  });

  /** Executes one rsr/wsr/xsr/rur/wur of `register` with operand register a`n` holding `value`; returns a`n` after. */
  function exec(machine: BareMachine, kind: string, register: string, n: number, value = 0): number {
    const index = ops.get(register)?.get(kind);
    if (index === undefined) throw new Error(`no ${kind}.${register}`);
    const op = OPS[index];
    const word = (op.match | (kind === 'rur' ? n << 12 : n << 4)) >>> 0;
    const bytes = [word & 0xff, (word >>> 8) & 0xff, (word >>> 16) & 0xff];
    const d = new Int32Array(DESCRIPTOR_SIZE);
    decode(bytes[0], bytes[1], bytes[2], d);
    expect(disasm(d, IRAM_BASE)).toBe(`${kind}.${register}\ta${n}`);
    machine.setIram(bytes);
    const core = machine.core;
    core.pc = IRAM_BASE;
    core.setReg(n, value);
    // The operand register is the one in the window the instruction started in (XSR.WINDOWBASE).
    const physical = ((core.windowBase << 2) + n) & 63;
    core.step();
    expect(core.halt).toBe(HALT.RUNNING);
    return core.ar[physical];
  }

  it('every register regs.ts names has instructions, and every rsr/wsr/xsr/rur/wur has an expectation', () => {
    const named = [...Object.keys(SR), ...Object.keys(UR)].map((k) => k.toLowerCase());
    for (const name of named) {
      if (name === 'interrupt') expect(ops.has('intset')).toBe(true);
      expect(ops.has(name), name).toBe(true);
    }
    for (const register of ops.keys()) expect(register in MASKS || SPECIAL.has(register), register).toBe(true);
  });

  for (const [register, mask] of Object.entries(MASKS)) {
    it(`${register}: write, read and exchange through its writable mask`, () => {
      const [read, write] = ops.get(register)?.has('rur') ? ['rur', 'wur'] : ['rsr', 'wsr'];
      // ACCHI holds accumulator bits 39–32 and reads back sign-extended.
      const readBack = (v: number): number => (register === 'acchi' ? ((v << 24) >> 24) >>> 0 : (v & mask) >>> 0);
      for (const pattern of [FULL, 0xa5a5a5a5, 0x5a5a5a5a]) {
        const machine = new BareMachine();
        if (register === 'fcr' || register === 'fsr') machine.core.writeSpecial(SR.CPENABLE, 1); // FPU state
        exec(machine, write, register, 2, pattern);
        expect(hex([exec(machine, read, register, 3)])).toEqual(hex([readBack(pattern)]));
        if (ops.get(register)?.has('xsr')) {
          const next = ~pattern >>> 0;
          expect(hex([exec(machine, 'xsr', register, 4, next)])).toEqual(hex([readBack(pattern)]));
          expect(hex([exec(machine, read, register, 5)])).toEqual(hex([readBack(next)]));
        }
      }
    });
  }

  it('INTERRUPT reads pending; INTSET/INTCLEAR reach only software and edge bits', () => {
    const machine = new BareMachine();
    exec(machine, 'wsr', 'intset', 2, FULL);
    expect(hex([exec(machine, 'rsr', 'interrupt', 3)])).toEqual(hex([0x70400480]));
    exec(machine, 'wsr', 'intclear', 2, 0x20000400);
    expect(hex([exec(machine, 'rsr', 'interrupt', 3)])).toEqual(hex([0x50400080]));
    machine.core.setInterruptLine(0, true); // a level line can't be cleared by INTCLEAR
    exec(machine, 'wsr', 'intclear', 2, FULL);
    expect(hex([exec(machine, 'rsr', 'interrupt', 3)])).toEqual(hex([0x1]));
  });

  it('read-only PRID and CONFIGID1, write-only MMID, and CCOUNT counting on from a write', () => {
    const machine = new BareMachine();
    expect(exec(machine, 'rsr', 'prid', 2)).toBe(0xcdcd);
    expect(exec(machine, 'rsr', 'configid1', 2)).toBe(0);
    exec(machine, 'wsr', 'mmid', 2, 0x1234);
    exec(machine, 'wsr', 'ccount', 2, 1000);
    expect(exec(machine, 'rsr', 'ccount', 3)).toBe(1001); // one instruction later
    expect(exec(machine, 'xsr', 'ccount', 4, 50)).toBe(1002);
    expect(exec(machine, 'rsr', 'ccount', 5)).toBe(51);
    expect(new BareMachine().core.prid).toBe(0xcdcd);
  });

  it('RER/WER: unknown external registers read 0; written ones read back', () => {
    const machine = new BareMachine();
    // rer a2, a3 = 0x406320; wer a2, a3 = 0x407320 (ISA RM: op0 0, op1 0, op2 4, r 6/7).
    const d = new Int32Array(DESCRIPTOR_SIZE);
    decode(0x20, 0x63, 0x40, d);
    expect(disasm(d, IRAM_BASE)).toBe('rer\ta2, a3');
    decode(0x20, 0x73, 0x40, d);
    expect(disasm(d, IRAM_BASE)).toBe('wer\ta2, a3');
    machine.setIram([0x20, 0x63, 0x40]);
    machine.core.pc = IRAM_BASE;
    machine.core.setReg(3, 0x103000);
    machine.core.setReg(2, 0xdead);
    machine.core.step();
    expect(machine.core.reg(2)).toBe(0);
    machine.setIram([0x20, 0x73, 0x40]);
    machine.core.pc = IRAM_BASE;
    machine.core.setReg(2, 0xbeef);
    machine.core.step();
    expect(machine.core.eri.get(0x103000)).toBe(0xbeef);
  });
});
