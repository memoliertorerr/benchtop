import { describe, expect, it } from 'vitest';
import { BareMachine, IRAM_BASE, symbolAddress } from '../test-support/bare-machine.test-helper.ts';
import { HALT } from './cpu.ts';
import { DESCRIPTOR_SIZE, decode } from './decode.ts';
import { disasm } from './disasm.ts';
import { EXCCAUSE } from './exceptions.ts';
import { OPS } from './isa.ts';

// BT30: the ISA options beyond the core — MUL/DIV, MAC16, the FPU, booleans, atomics and misc
// ops — each through a fixtures/xtensa program whose expected values are hand-derived in its
// .S header (32/40-bit products also checked with Python integers there).

const RESULTS = 0x3ffb0400;
const SCRATCH = 0x3ffb0000;

function run(name: string) {
  const machine = BareMachine.load(name);
  const core = machine.run(5_000_000);
  expect({ halt: core.halt, reason: core.haltReason, a2: machine.a(2).toString(16) }, name).toMatchObject({ halt: HALT.BREAK, reason: '1, 15' });
  const end = machine.a(15);
  const results: number[] = [];
  for (let a = RESULTS; a < end; a += 4) results.push(machine.read32(a));
  return { machine, results };
}

const hex = (values: number[]): string[] => values.map((v) => (v >>> 0).toString(16));

describe('ISA options on the bare machine', () => {
  it('muldiv: MUL16S/U, MULL, MULUH/MULSH, QUOS/QUOU/REMS/REMU, divide by zero', () => {
    const { machine, results } = run('muldiv');
    expect(hex(results)).toEqual(
      hex([
        0xffff0000, 0x00010000, 0x3fff0001, 0x242d2080, 0x0b00ea4e, 0xfffffffe, 1, 0, 0x40000000, 0xffffffff, 0xff4ff15b,
        -3, -1, -3, 1, 0x7ffffffc, 1, 0x80000000, 0, 0, 100,
        0x55, // the destination survives both divide-by-zero exceptions
      ]),
    );
    const log = [0, 4, 8, 12].map((offset) => machine.read32(SCRATCH + 0x104 + offset));
    expect(hex(log)).toEqual(
      hex([EXCCAUSE.INTEGER_DIVIDE_BY_ZERO, symbolAddress('muldiv', 'div_zero_s'), EXCCAUSE.INTEGER_DIVIDE_BY_ZERO, symbolAddress('muldiv', 'div_zero_u')]),
    );
  });

  it('misc: NSA/NSAU, MIN/MAX(U), CLAMPS and SEXT at widths 7–22, ABS/NEG of INT_MIN', () => {
    const { results } = run('misc');
    const widths: number[] = [];
    for (let w = 7; w <= 22; w++) {
      const sext = (v: number): number => ((v << (31 - w)) >> (31 - w)) >>> 0;
      widths.push(2 ** w - 1, -(2 ** w), 100, sext(0xaaaaaaaa), sext(0x55555555));
    }
    expect(hex(results)).toEqual(
      hex([31, 31, 30, 0, 0, 7, 15, 32, 31, 0, 16, -1, 1, 1, 0xffffffff, ...widths, 0x80000000, 5, 0x80000000, -5]),
    );
    // The SEXT expectation, by hand for two widths: bit 7 of 0xaa…aa is set, bit 8 is not.
    expect(hex([results[15 + 3], results[20 + 3], results[20 + 4]])).toEqual(hex([0xffffffaa, 0xaa, 0xffffff55]));
  });

  it('mac16: every operand form and half, the 40-bit accumulator, LDINC/LDDEC', () => {
    const { results } = run('mac16');
    expect(hex(results)).toEqual(
      hex([
        -14, -1, 21, 0, -10, -1, 15, 0, 0x6fff2, 0, 15, 0, // AA forms, UMUL
        0xfed4012c, 0x4a, 0x018ffe70, 0xffffff9c, // 300 × MULA, then 700 × MULS
        0, 0xffffff80, // wrap at 40 bits
        -10, -1, -163840, -1, 15, 0, 14, 0, -28, -1, -98304, -1, // AD, DA, DD
        0x11111111, 0, 0x22222222, 4, // LDINC, LDDEC
        0x5555, 0x22222222, 4, 0xffff, 0x11111111, 0, // MULA.*.LDINC/LDDEC
      ]),
    );
  });

  it('bool: BR logic, ALL/ANY groups, BT/BF, MOVT/MOVF', () => {
    const { results } = run('bool');
    expect(hex(results)).toEqual(hex([0x55a6, 0x29f0, 9, 0x66, 0x55, 0x66, 0x55]));
  });

  it('atomic: S32C1I success and failure, a CAS loop, L32AI/S32RI/S32NB', () => {
    const { results } = run('atomic');
    expect(results).toEqual([5, 9, 9, 9, 1, 2, 10, 9, 0x1234, 0x5678]);
  });

  it('fpu-ops: rounding modes, flags, fused multiply-add, conversions, compares, moves, loads/stores, CPENABLE', () => {
    const { machine, results } = run('fpu-ops');
    const I = 0x80;
    const UI = 0x180;
    const OI = 0x280;
    const V = 0x800;
    // [result, FSR] pairs, sections as numbered in fpu-ops.S.
    const expected = [
      [0x3f800000, I], [0x3f800000, I], [0x3f800001, I], [0x3f800000, I], // 1
      [0x3f800001, I], [0x3f800000, I], [0x3f800001, I], [0x3f800000, I], // 2
      [0xbf800000, I], [0xbf800000, I], [0xbf800000, I], [0xbf800001, I], // 3
      [0x7f800000, OI], [0x7f7fffff, OI], [0x7f800000, OI], [0x7f7fffff, OI], // 4
      [0x00400000, 0], // 5
      [0, UI], [0, UI], [1, UI], [0, UI], // 6
      [0, 0], [0x80000000, 0], // 7
      [0x7fc00000, V], [0x7fc00000, V], [0x7fc12345, 0], [0x7fc12345, V], // 8
      [0x33800000, 0], [0xb3800000, 0], [0x3f800000, I], [0x3f800001, I], // 9
      [0x40600000, 0], [0x4f000000, I], [0x4effffff, I], [0xbfe00000, 0], [0x4f800000, I], [0x4f7fffff, I], [0x47800000, 0], // 10
      [2, 0], [11, 0], [-2, 0], [2, 0], [4, 0], [-2, 0], [3, 0], [2, 0], [-3, 0], [-2, 0], [2, 0], [3, 0], [0xc0000000, 0], // 11
      [0x7fffffff, V], [0x7fffffff, V], [0x80000000, V], [0, V], [0, 0], [2, 0],
      [0x78, 0], [0x66, 0], [0x55, V], [0, 0], [0x66, 0], // 12
      [0x40000000, 0], [0x3f800000, 0], [0x40000000, 0], [0x3f800000, 0], [0x40000000, 0], [0x3f800000, 0], // 13
      [0x7f812345, 0], [0x7f812345, 0], [0x7f812345, 0], [0xff812345, 0], // 14
      [0x3f800000, 0], [0x40000000, 0], [8, 0], [0x3f800000, 0], [0x40000000, 0], [12, 0], // 15
    ].flat();
    expect(hex(results)).toEqual(hex(expected));
    // 16: both coprocessor-disabled traps, at the instructions that raised them.
    const log = [0, 4, 8].map((offset) => machine.read32(SCRATCH + 0x100 + offset));
    expect(hex(log)).toEqual(hex([2, symbolAddress('fpu-ops', 'cp_first'), symbolAddress('fpu-ops', 'cp_second')]));
  });

  it('region protection: WITLB/WDTLB set an entry, RxTLB0/1 read its VPN and PPN | attribute, IxTLB change nothing', () => {
    const machine = new BareMachine();
    const core = machine.core;
    /** Runs `name at, as` once with a2 = at and a3 = as; returns a2 after. */
    const exec = (name: string, at: number, as: number): number => {
      const op = OPS.find((o) => o.name === name);
      if (op === undefined) throw new Error(name);
      const two = op.operands.length === 2; // `name at, as`; IITLB/IDTLB take only as
      const word = (op.match | (3 << 8) | (two ? 2 << 4 : 0)) >>> 0;
      const d = new Int32Array(DESCRIPTOR_SIZE);
      decode(word & 0xff, (word >>> 8) & 0xff, word >>> 16, d);
      expect(disasm(d, IRAM_BASE)).toBe(two ? `${name}\ta2, a3` : `${name}\ta3`);
      machine.setIram([word & 0xff, (word >>> 8) & 0xff, word >>> 16]);
      core.pc = IRAM_BASE;
      core.setReg(2, at);
      core.setReg(3, as);
      core.step();
      expect(core.halt).toBe(HALT.RUNNING);
      return core.reg(2) >>> 0;
    };
    expect([...core.itlb, ...core.dtlb]).toEqual(Array(16).fill(2)); // core-matmap.h: reset CA 2
    exec('witlb', 0x3, 0x400d1234); // mpu_ll_set_region_x on region 2
    exec('wdtlb', 0xf, 0x6000abcd); // illegal for region 3
    expect([core.itlb[2], core.dtlb[3], core.itlb[3], core.dtlb[2]]).toEqual([3, 15, 2, 2]);
    expect(exec('ritlb0', 0, 0x400d1234).toString(16)).toBe('40000000');
    expect(exec('ritlb1', 0, 0x400d1234).toString(16)).toBe('40000003');
    expect(exec('rdtlb0', 0, 0x6000abcd).toString(16)).toBe('60000000');
    expect(exec('rdtlb1', 0, 0x6000abcd).toString(16)).toBe('6000000f');
    exec('iitlb', 0, 0x400d1234);
    exec('idtlb', 0, 0x6000abcd);
    expect([core.itlb[2], core.dtlb[3]]).toEqual([3, 15]);
  });
});
