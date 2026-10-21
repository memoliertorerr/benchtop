import { describe, expect, it } from 'vitest';
import type { McuDebug, RegisterInfo } from '../contracts/debug.ts';
import type { RunResult } from '../contracts/mcu.ts';
import { stepOver } from './stepping.ts';
import { baseSymbolName, SymbolTable } from './symbols.ts';

describe('symbols', () => {
  it('drops GCC clone suffixes', () => {
    expect(baseSymbolName('digitalWrite.constprop.3')).toBe('digitalWrite');
    expect(baseSymbolName('foo.isra.0')).toBe('foo');
    expect(baseSymbolName('foo.part.1.lto_priv.0')).toBe('foo');
    expect(baseSymbolName('bar.lto_priv.12')).toBe('bar');
    expect(baseSymbolName('baz.cold')).toBe('baz');
    expect(baseSymbolName('plain')).toBe('plain');
  });

  const table = SymbolTable.fromEntries([
    { name: 'main', address: 0x500, size: 0x80, kind: 'func', space: 'flash' },
    { name: 'digitalWrite.constprop.3', address: 0x200, size: 0x40, kind: 'func', space: 'flash' },
    { name: '_Z6myFuncv', address: 0x300, size: 0x10, kind: 'func', space: 'flash' },
    { name: 'counter', address: 0x126, size: 2, kind: 'object', space: 'data' },
    { name: 'main', address: 0x130, size: 1, kind: 'object', space: 'data' },
  ]);

  it('names a PC by the nearest function below it', () => {
    expect(table.describe(0x514)).toBe('main+0x14');
    expect(table.describe(0x500)).toBe('main');
    expect(table.describe(0x204)).toBe('digitalWrite.constprop.3+0x4');
    expect(table.describe(0x10)).toBe('0x0010');
  });

  it('looks names up exactly, then without clone suffixes, then by mangled identifier; functions first', () => {
    expect(table.lookup('main')).toMatchObject({ address: 0x500, kind: 'func' });
    expect(table.lookup('digitalWrite')).toMatchObject({ address: 0x200 });
    expect(table.lookup('myFunc')).toMatchObject({ address: 0x300 });
    expect(table.lookup('counter')).toMatchObject({ address: 0x126, space: 'data', kind: 'object' });
    expect(table.lookup('nope')).toBeUndefined();
    // Round trip through the packed data, as the worker sends it.
    expect(new SymbolTable(structuredClone(table.data)).lookup('myFunc')).toMatchObject({ address: 0x300 });
  });
});

/** A scripted CPU: `run()` jumps to the next scripted (pc, sp) stop. */
function fakeDebug(start: { pc: number; sp: number }, stops: { pc: number; sp: number }[]) {
  let pc = start.pc;
  let sp = start.sp;
  const bps = new Set<number>();
  const debug: McuDebug = {
    registers: (): readonly RegisterInfo[] => [
      { name: 'SP', bits: 16 },
      { name: 'PC', bits: 32 },
    ],
    pcIndex: 1,
    spIndex: 0,
    readRegisters(out) {
      out[0] = sp;
      out[1] = pc;
    },
    writeRegister() {},
    readMemory: () => new Uint8Array(0),
    writeMemory() {},
    setBreakpoint: (a) => void bps.add(a),
    clearBreakpoint: (a) => void bps.delete(a),
    breakpoints: () => [...bps].sort((a, b) => a - b),
    step(): RunResult {
      // The call at 0x100 (4 bytes) enters 0x200 and pushes 2 bytes.
      if (pc === 0x100) {
        pc = 0x200;
        sp -= 2;
      } else pc += 2;
      return { reason: 'target' };
    },
    instructionAt: (a) => ({ size: a === 0x100 ? 4 : 2, isCall: a === 0x100 }),
  };
  const run = (): RunResult => {
    const next = stops.shift();
    if (next === undefined) return { reason: 'target' };
    ({ pc, sp } = next);
    return { reason: bps.has(pc) ? 'breakpoint' : 'target' };
  };
  return { debug, run, state: () => ({ pc, sp }) };
}

describe('stepOver', () => {
  it('ignores the return address hit deeper in a recursion, stops when SP is back', () => {
    const f = fakeDebug({ pc: 0x100, sp: 0x8f0 }, [
      { pc: 0x104, sp: 0x8e0 }, // a deeper call returning to the same address
      { pc: 0x104, sp: 0x8f0 }, // ours
    ]);
    expect(stepOver(f.debug, f.run)).toEqual({ reason: 'stepped' });
    expect(f.state()).toEqual({ pc: 0x104, sp: 0x8f0 });
    expect(f.debug.breakpoints()).toEqual([]);
  });

  it('is one step off a call; keeps a user breakpoint at the return address; gives up at the limit', () => {
    const plain = fakeDebug({ pc: 0x300, sp: 0x8f0 }, []);
    expect(stepOver(plain.debug, plain.run)).toEqual({ reason: 'stepped' });
    expect(plain.state().pc).toBe(0x302);

    const user = fakeDebug({ pc: 0x100, sp: 0x8f0 }, [{ pc: 0x104, sp: 0x8f0 }]);
    user.debug.setBreakpoint(0x104);
    expect(stepOver(user.debug, user.run)).toEqual({ reason: 'stepped' });
    expect(user.debug.breakpoints()).toEqual([0x104]);

    const stuck = fakeDebug({ pc: 0x100, sp: 0x8f0 }, []);
    expect(stepOver(stuck.debug, stuck.run, 5)).toEqual({ reason: 'limit' });
    expect(stuck.debug.breakpoints()).toEqual([]);
  });
});
