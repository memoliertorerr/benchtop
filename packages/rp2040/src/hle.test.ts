import { parseElf32, SymbolTable } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { readFixture } from '../../core/src/firmware/fixtures.test-helper.ts';
import { HLE_RESUME } from './bootrom/layout.ts';
import { HLE_UDF, type HleTask, Rp2040Hle, type Rp2040HleCall } from './hle.ts';
import { createRp2040Mcu, type Rp2040Mcu } from './rp2040-mcu.ts';
import { runMs } from './rp2040.test-helper.ts';

// BT109: high-level emulation on the RP2040, on fixtures/rp2040/hle.c — a freestanding program
// whose replaced functions would return -1 (the RESULTS layout is in its header).

const RESULTS = 0x20030000;
const ELF = readFixture('fixtures/rp2040/hle.elf');
const SYMBOLS = SymbolTable.fromElf(parseElf32(ELF));

function at(name: string): number {
  const entry = SYMBOLS.lookup(name);
  if (entry === undefined) throw new Error(`no ${name}`);
  return entry.address;
}

interface Run {
  mcu: Rp2040Mcu;
  hle: Rp2040Hle;
  results: number[];
  /** The most generators waiting at once while slow_twice ran (both cores). */
  peak: number;
}

function run(core: 'fast' | 'stock' = 'fast'): Run {
  const mcu = createRp2040Mcu({ core });
  mcu.load({ format: 'elf', bytes: ELF });
  const hle = new Rp2040Hle(HLE_RESUME);
  let peak = 0;
  hle.replace(at('sum5'), 'sum5', (call) => 1000 + call.int(0) + call.int(1) + call.int(2) + call.int(3) + call.int(4));
  hle.replace(at('twice'), 'twice', function* (call: Rp2040HleCall): HleTask {
    const x = call.int(0);
    return (yield call.call(at('dbl'), x)) + (yield call.call(at('dbl'), x + 1));
  });
  hle.replace(at('outer'), 'outer', function* (call: Rp2040HleCall): HleTask {
    return (yield call.call(at('nest_helper'), call.arg(0))) + 1;
  });
  hle.replace(at('many'), 'many', function* (call: Rp2040HleCall): HleTask {
    return yield call.call(at('sum6'), 1, 2, 3, 4, 5, 6);
  });
  hle.replace(at('scratchy'), 'scratchy', function* (call: Rp2040HleCall): HleTask {
    call.write32(call.scratch, 0x77);
    return yield call.call(at('load_word'), call.scratch);
  });
  hle.replace(at('slow_twice'), 'slow_twice', function* (call: Rp2040HleCall): HleTask {
    const x = call.int(0);
    const a = yield call.call(at('slow_dbl'), x);
    peak = Math.max(peak, hle.running);
    const b = yield call.call(at('slow_dbl'), x + 1);
    peak = Math.max(peak, hle.running);
    return 2 * (a + b);
  });
  const ticks = at('ticks');
  hle.replace(at('tick_isr'), 'tick_isr', (call) => {
    call.write32(ticks, call.read32(ticks) + 1);
    return 0;
  });
  expect(mcu.setHle(hle)).toEqual([]);
  runMs(mcu, 30);
  const results = Array.from({ length: 13 }, (_, i) => mcu.rp.readUint32(RESULTS + 4 * i) >>> 0);
  return { mcu, hle, results, peak };
}

describe('high-level emulation on the RP2040 (BT109)', () => {
  const fast = run();

  it('runs to the end', () => {
    expect(fast.results[12]).toBe(0xd0e);
    expect(fast.mcu.runUntil(fast.mcu.cycles + 1000).reason).not.toBe('fault');
  });

  it('a plain handler gets r0–r3 and the fifth argument from the stack; its result returns in r0', () => {
    expect(fast.results[0]).toBe(1015);
  });

  it('generators call the firmware and resume with its r0; callee-saved registers survive', () => {
    expect(fast.results[1]).toBe(86);
    expect(fast.results[2]).toBe(54);
    expect(fast.results[3]).toBe(123);
  });

  it('a recursion 50 deep around a generator comes back with sp where it was', () => {
    expect(fast.results[4]).toBe(56);
    expect(fast.results[5]).toBe(0);
  });

  it('a call out passes arguments past the fourth on the stack; scratch memory is the frame’s', () => {
    expect(fast.results[6]).toBe(21);
    expect(fast.results[7]).toBe(0x77);
  });

  it('a replaced exception handler returns through EXC_RETURN (SysTick every 100 µs for 2 ms)', () => {
    expect(Math.abs(fast.results[8] - 20)).toBeLessThanOrEqual(1);
  });

  it('both cores inside a generator at once: each frame found again by its own sp', () => {
    expect(fast.results[11]).toBe(1);
    expect(fast.results[9]).toBe(804);
    expect(fast.results[10]).toBe(60);
    expect(fast.peak).toBe(2);
    expect(fast.hle.running).toBe(0);
  });

  it('the stock core takes the same UDFs to the same results (core 0’s part: its SEV doesn’t wake core 1 — core1.ts)', () => {
    const stock = run('stock');
    expect(stock.results.slice(0, 9)).toEqual(fast.results.slice(0, 9));
  });

  it('the UDFs are in flash while installed; setHle(null) puts the firmware back, a load reinstalls them', () => {
    const mcu = createRp2040Mcu();
    mcu.load({ format: 'elf', bytes: ELF });
    const original = mcu.rp.readUint16(at('twice'));
    expect(original).not.toBe(HLE_UDF);
    const hle = new Rp2040Hle(HLE_RESUME);
    hle.replace(at('twice'), 'twice', () => 7);
    mcu.setHle(hle);
    expect(mcu.rp.readUint16(at('twice'))).toBe(HLE_UDF);
    expect(hle.original(at('twice') - 0x10000000)).toBe(original);
    mcu.reset();
    expect(mcu.rp.readUint16(at('twice'))).toBe(HLE_UDF);
    mcu.load({ format: 'elf', bytes: ELF });
    expect(mcu.rp.readUint16(at('twice'))).toBe(HLE_UDF);
    mcu.setHle(null);
    expect(mcu.rp.readUint16(at('twice'))).toBe(original);
  });

  it('a function outside flash can’t be trapped; a handler’s error faults the core with its message', () => {
    const mcu = createRp2040Mcu();
    mcu.load({ format: 'elf', bytes: ELF });
    const hle = new Rp2040Hle(HLE_RESUME);
    hle.replace(0x20001000, 'in_ram', () => 0);
    hle.replace(at('sum5'), 'sum5', () => {
      throw new Error('no network');
    });
    expect(mcu.setHle(hle)).toEqual(['in_ram']);
    const result = mcu.runUntil(mcu.cycles + 125_000);
    expect(result).toMatchObject({ reason: 'fault', detail: 'hle: sum5: no network' });
  });
});
