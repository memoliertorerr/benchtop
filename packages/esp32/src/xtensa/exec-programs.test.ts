import { describe, expect, it } from 'vitest';
import { BareMachine } from '../test-support/bare-machine.test-helper.ts';
import { HALT } from './cpu.ts';
import { SR } from './regs.ts';

// The fixtures/xtensa programs on the bare machine (BT28). Expected values are the ones
// hand-derived in each .S file's header comment (extui's come from a JS model).

const RESULTS = 0x3ffb0400;
const SCRATCH = 0x3ffb0000;

function runProgram(name: string) {
  const machine = BareMachine.load(name);
  const core = machine.run();
  expect({ halt: core.halt, reason: core.haltReason }, name).toEqual({ halt: HALT.BREAK, reason: '1, 15' });
  const results = (count: number): number[] => Array.from({ length: count }, (_, i) => machine.read32(RESULTS + i * 4));
  return { machine, core, results };
}

const hex = (values: number[]): string[] => values.map((v) => `0x${(v >>> 0).toString(16)}`);

describe('Xtensa programs on the bare machine', () => {
  it('alu', () => {
    const { results } = runProgram('alu');
    const expected = [
      12, 2, 0xfffffffe, 19, 33, 61, 9, 23, 51, 0x00f0, 0xfff0, 0xff00, 0xfffffff9, 7, 0x80000000, 0xfffffffd, 7, 7, 0xfffffffd,
      0xffffffff, 0x7f, 0x2345, 127, 0xffffff80, 100, 31, 32, 30, 30, 31, 222, 111, 222, 111,
    ];
    expect(hex(results(expected.length))).toEqual(hex(expected));
  });

  it('shifts: SSL/SSR/SSAI/SSA8L/SSA8B with SLL/SRL/SRA/SRC, SLLI/SRLI/SRAI, RSR.SAR', () => {
    const { results } = runProgram('shifts');
    const expected = [
      0x23456780, 0x12345678, 0x00123456, 0xff800000, 0x67880000, 0x78800000, 0x34567880, 0x02468acf, 0x2468acf0, 0x80000000, 0x00002468,
      0xffffffff, 0xf8000000, 0x80000000, 0x12345678, 17,
    ];
    expect(hex(results(expected.length))).toEqual(hex(expected));
  });

  it('extui at every width 1–16 (JS model)', () => {
    const { results } = runProgram('extui');
    const value = 0xa5c3f00f;
    const expected = Array.from({ length: 16 }, (_, i) => {
      const width = i + 1;
      const shift = (3 * width) % (33 - width);
      return Number((BigInt(value) >> BigInt(shift)) & ((1n << BigInt(width)) - 1n));
    });
    expect(hex(results(16))).toEqual(hex(expected));
  });

  it('loads and stores: sign extension, sub-word stores, unaligned access', () => {
    const { results } = runProgram('loadstore');
    const expected = [
      0x01, 0xff, 0x80, 0x7f01, 0x80ff, 0xffff80ff, 0x7f01, 0x80ff7f01, 0xcdefab00, 0x0080ff7f, 0xff7f, 0x22334400, 0x00000011, 0x00002345, 0xff,
      0xffffff00,
    ];
    expect(hex(results(expected.length))).toEqual(hex(expected));
  });

  it('l32r: negative offsets, across a second literal pool', () => {
    const { results } = runProgram('l32r');
    expect(hex(results(7))).toEqual(hex([0x01234567, 0x89abcdef, 0xffffffff, 0, 0xdeadbeef, 0x0badf00d, 0x01234567]));
  });

  it('every branch form, taken and not taken (56 checks)', () => {
    const { machine } = runProgram('branches');
    expect(machine.a(2)).toBe(0); // the failing check's number otherwise
    expect(machine.a(14)).toBe(56);
  });

  it('j, jx, call0, callx0, ret', () => {
    const { machine } = runProgram('jumps');
    expect([machine.a(5), machine.a(2), machine.a(3)]).toEqual([1123, 1, 2]);
  });

  it('every density form', () => {
    const { results, machine } = runProgram('density');
    expect(machine.a(2)).not.toBe(0xbad);
    expect(hex(results(13))).toEqual(hex([0xffffffe0, 95, 7, 14, 13, 28, 28, 1, 2, 3, 4, 4, 77]));
  });

  it('movi / addmi / addi extremes', () => {
    const { machine } = runProgram('movi');
    expect(hex([2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => machine.a(n)))).toEqual(
      hex([0xfffff800, 2047, 0xffff87ff, 0x86ff, 1919, 2174, 256, 0, 0xfffffffe]),
    );
  });

  it('sync instructions and NOPs change nothing', () => {
    const { machine } = runProgram('sync');
    expect([2, 3, 4, 5, 6, 7].map((n) => machine.a(n))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(machine.read32(SCRATCH)).toBe(0x5a5a5a5a);
  });

  it('smoke: 1 + … + 10', () => {
    const { machine } = runProgram('smoke');
    expect([machine.a(2), machine.a(3), machine.read32(SCRATCH)]).toEqual([55, 11, 55]);
  });

  it('faults: an unimplemented op names its mnemonic; an invalid word raises IllegalInstruction', () => {
    const machine = new BareMachine();
    machine.setIram([0x20, 0x53, 0x50]); // pitlb a2, a3 (its result format is unknown)
    machine.core.pc = 0x40080000;
    machine.run(10);
    expect(machine.core.haltReason).toBe('unimplemented: pitlb');
    // With vectors at 0x40080400 and PS.UM = 1: EXCCAUSE 0, EPC1 = the word, the user vector.
    const invalid = new BareMachine();
    invalid.setIram([0x0e, 0x00, 0x00]); // op0 = 0xE: no instruction
    invalid.setIram([0xf0, 0x41, 0x00], 0x740); // break 1, 15 at VECBASE + 0x340
    invalid.core.writeSpecial(SR.VECBASE, 0x40080400);
    invalid.core.writeSpecial(SR.PS, 0x20);
    invalid.core.pc = 0x40080000;
    invalid.run(10);
    expect([invalid.core.halt, invalid.core.pc, invalid.core.readSpecial(SR.EXCCAUSE), invalid.core.readSpecial(SR.EPC1)]).toEqual([
      HALT.BREAK,
      0x40080740,
      0,
      0x40080000,
    ]);
  });
});
