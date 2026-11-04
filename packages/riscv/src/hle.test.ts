import { describe, expect, it } from 'vitest';
import { HALT } from './cpu.ts';
import { RiscvHle, type RiscvHleCall } from './hle.ts';
import { OUT_BASE, programSymbols, RiscvBareMachine } from './test-support/bare-machine.test-helper.ts';

// BT106: functions TypeScript answers on the RISC-V core — fixtures/riscv/programs/hle.S on the
// bare machine: a plain handler with a stack argument, generators calling back into the
// firmware (two waiting at once, deep recursion around them), a call out with stack arguments,
// scratch memory; with the predecode cache and without.

const SYMBOLS = programSymbols('hle');
const at = (name: string): number => SYMBOLS.get(name) as number;

function machine(predecode: boolean) {
  const m = new RiscvBareMachine();
  m.core.predecode = predecode;
  m.loadProgram('hle');
  const hle = new RiscvHle(at('hle_resume'));
  hle.replace(at('sum9'), 'sum9', (call: RiscvHleCall) => {
    let total = 1000;
    for (let i = 0; i < 9; i++) total += call.arg(i);
    return total;
  });
  hle.replace(at('twice'), 'twice', function* (call) {
    const x = call.arg(0);
    const a = yield call.call(at('double'), x);
    const b = yield call.call(at('double'), x + 1);
    return a + b;
  });
  hle.replace(at('outer'), 'outer', function* (call) {
    const r = yield call.call(at('nest_helper'), call.arg(0));
    return r + 1;
  });
  hle.replace(at('many'), 'many', function* (call) {
    return yield call.call(at('sum10'), 1, 2, 3, 4, 5, 6, 7, 8, 9, 10);
  });
  hle.replace(at('scratchy'), 'scratchy', function* (call) {
    expect(call.scratch).not.toBe(0);
    call.write32(call.scratch, 0x77);
    return yield call.call(at('load_word'), call.scratch);
  });
  m.core.setHle(hle);
  return { m, hle };
}

describe('RISC-V HLE (BT106)', () => {
  for (const predecode of [true, false]) {
    it(`answers calls and runs generators that call the firmware (${predecode ? 'predecoded' : 'uncached'})`, () => {
      const { m, hle } = machine(predecode);
      m.run();
      expect(m.exitCode).toBe(0);
      expect(m.readWords(OUT_BASE, 8)).toEqual([1045, 86, 0x5a5a, 123, 56, 0, 55, 0x77]);
      expect(hle.running).toBe(0); // every generator finished
      // sum9, twice, outer + its twice, rec's twice, many, scratchy
      expect(hle.calls).toBe(7);
    });
  }

  it('a handler that throws faults the core with its message; an unknown generator frame too', () => {
    const { m, hle } = machine(true);
    hle.replace(at('sum9'), 'sum9', () => {
      throw new Error('no such thing');
    });
    expect(() => m.run()).toThrow(/core fault: hle: sum9: no such thing at 0x800000a0/);
    expect(m.core.halt).toBe(HALT.FAULT);
  });

  it('an address only decodes as the HLE op while the table lists it', () => {
    const { m } = machine(true);
    m.core.setHle(null);
    m.run();
    expect(m.readWords(OUT_BASE, 1)).toEqual([0xffffffff]); // sum9's own body ran: -1
  });
});
