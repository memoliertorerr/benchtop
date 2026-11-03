import { describe, expect, it } from 'vitest';
import { BareMachine, symbolAddress } from '../test-support/bare-machine.test-helper.ts';
import { HALT } from '../xtensa/cpu.ts';
import { Hle, type HleCall, type HleTask } from './hle.ts';

// BT97: fixtures/xtensa/hle.S's functions answered by TypeScript, on the bare machine, with and
// without the predecode cache. The resume and return addresses sit at the end of IRAM (zeros the
// program never reaches).
const SCRATCH = 0x3ffb0000;
const at = (name: string): number => symbolAddress('hle', name);

function machine(selector: number, predecode: boolean): { m: BareMachine; hle: Hle } {
  const m = BareMachine.load('hle');
  m.core.predecode = predecode;
  m.bus.write32(SCRATCH, selector);
  const hle = new Hle({ resumePc: 0x4009ff00, returnPc: 0x4009ff04 });
  hle.replace(at('target'), 'target', (call) => call.arg(0) + call.arg(1) * 10);
  hle.replace(at('twice'), 'twice', function* (call: HleCall): HleTask {
    const sum: number = yield call.call(at('add3'), call.arg(0), 10, 20);
    return sum * 2;
  });
  hle.replace(at('seven'), 'seven', function* (call: HleCall): HleTask {
    return yield call.call(at('sum7'), 1, 2, 3, 4, 5, 6, 7);
  });
  hle.replace(at('outer'), 'outer', function* (call: HleCall): HleTask {
    const mid: number = yield call.call(at('mid'), call.arg(0) + 1);
    return mid + 1;
  });
  hle.replace(at('inner'), 'inner', function* (call: HleCall): HleTask {
    // outer's frame is waiting for mid while this one runs: two TypeScript frames at once.
    expect(hle.running).toBe(2);
    const sum: number = yield call.call(at('add3'), call.arg(0), 1000, 10000);
    return sum * 3;
  });
  hle.replace(at('deep'), 'deep', function* (call: HleCall): HleTask {
    const sum: number = yield call.call(at('rec'), call.arg(0));
    return sum + 100;
  });
  m.core.setHle(hle);
  return { m, hle };
}

function run(selector: number, predecode: boolean): { m: BareMachine; hle: Hle } {
  const result = machine(selector, predecode);
  const core = result.m.run(200_000);
  expect(core.haltReason).toBe('1, 15');
  expect(core.halt).toBe(HALT.BREAK);
  // No replaced function's own body ran.
  expect(result.m.read32(SCRATCH + 4)).toBe(0);
  expect(result.hle.running).toBe(0);
  return result;
}

describe('high-level emulation on the Xtensa core (BT97)', () => {
  for (const predecode of [true, false]) {
    const mode = predecode ? 'predecode cache' : 'no cache';

    it(`answers CALL4, CALL8 and CALL12 callers with their arguments, leaving the caller's registers (${mode})`, () => {
      for (const selector of [1, 2, 3]) {
        const { m, hle } = run(selector, predecode);
        expect(m.a(2)).toBe(57);
        expect(m.a(3)).toBe(0x33);
        if (selector === 2) expect(m.a(7)).toBe(0x77);
        expect(hle.calls).toBe(1);
      }
    });

    it(`calls back into the firmware and continues with the result, from CALL8 and CALL4 callers (${mode})`, () => {
      expect(run(4, predecode).m.a(2)).toBe(66);
      expect(run(5, predecode).m.a(2)).toBe(66);
    });

    it(`passes a seventh argument on the stack (${mode})`, () => {
      expect(run(6, predecode).m.a(2)).toBe(28);
    });

    it(`nests: TypeScript calls firmware that calls TypeScript that calls firmware (${mode})`, () => {
      // inner(2) = 3 · add3(2, 1000, 10000) = 33006; mid = 33106; outer = 33107.
      const { m, hle } = run(7, predecode);
      expect(m.a(2)).toBe(33107);
      expect(hle.calls).toBe(2);
    });

    it(`keeps the register window right through overflows and underflows around a TypeScript frame (${mode})`, () => {
      // drec(12) = 78 + deep(5) = 78 + rec(5) + 100 = 193.
      const { m } = run(8, predecode);
      expect(m.a(2)).toBe(193);
      expect(m.a(3)).toBe(0); // WINDOWBASE as at the start
      expect(m.a(4)).toBe(1); // WINDOWSTART
      expect(m.a(5)).toBeGreaterThan(0);
      expect(m.a(6)).toBe(m.a(5)); // every spilled frame came back
    });
  }

  it('faults with the handler’s message when a handler throws', () => {
    const { m, hle } = machine(1, true);
    hle.replace(at('target'), 'target', () => {
      throw new Error('broken');
    });
    m.core.setHle(hle);
    const core = m.run(200_000);
    expect(core.halt).toBe(HALT.FAULT);
    expect(core.haltReason).toBe('hle: target: broken');
  });

  it('runs the original function again once the table is gone', () => {
    const { m } = machine(2, true);
    m.core.setHle(null);
    m.run(200_000);
    expect(m.a(2)).toBe(0xdead);
    expect(m.read32(SCRATCH + 4)).toBe(0xdead);
  });
});
