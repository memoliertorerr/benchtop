import { describe, expect, it } from 'vitest';
import { symbolAddress } from '../test-support/bare-machine.test-helper.ts';
import { bootFixture, runUntil } from '../test-support/boot.test-helper.ts';
import { createTestSoc, runPro } from '../test-support/soc.test-helper.ts';
import { HALT } from '../xtensa/cpu.ts';
import { REF_HZ } from './context.ts';
import { SRAM0 } from './memory.ts';
import { CACHE_ENABLE, CACHE_MASK, FlashMmu } from './mmu.ts';
import type { Esp32Soc } from './soc.ts';

// BT37: the predecoded instruction cache (xtensa/icache.ts) sees every way code changes, and a
// run through it is exactly a run without it.

const RESULTS = 0x3ffb0400;

/** fixtures/xtensa/smc on a test SoC, flash and MMU set up as smc.S says; returns its results. */
function runSmc(predecode: boolean): { results: number[]; fills: number } {
  const soc = createTestSoc({ program: 'smc' });
  soc.setPredecode(predecode);
  const code = (symbol: string): Uint8Array => {
    const o = SRAM0.offset + (symbolAddress('smc', symbol) - SRAM0.start);
    return soc.memory.bytes.slice(o, o + 8);
  };
  soc.memory.flash.set(code('five'), 0x10000);
  soc.memory.flash.set(code('six'), 0x20000);
  const bus = soc.buses[0];
  expect(FlashMmu.entryOf(0x400d0000)).toBe(77);
  bus.write32(0x3ff10000 + 77 * 4, 1); // PRO MMU: 0x400D0000 → flash page 1
  bus.write32(0x3ff00044, bus.read32(0x3ff00044) & ~CACHE_MASK.IRAM0); // DPORT_PRO_CACHE_CTRL1
  bus.write32(0x3ff00040, bus.read32(0x3ff00040) | CACHE_ENABLE); // DPORT_PRO_CACHE_CTRL
  const core = soc.cores[0];
  core.breakHook = (s, t) => s === 1 && (t === 15 || t === 14);
  runPro(soc);
  expect(core.haltReason).toBe('1, 14');
  // Step 4: erase flash page 2's first sector and program `seven` there.
  soc.flash.writeEnable(true);
  soc.flash.erase(0x20000, 0x1000);
  soc.flash.writeEnable(true);
  soc.flash.program(0x20000, code('seven'), 8);
  core.halt = HALT.RUNNING;
  core.pc += 3;
  runPro(soc);
  expect(core.haltReason).toBe('1, 15');
  return { results: Array.from({ length: 8 }, (_, i) => bus.read32(RESULTS + i * 4)), fills: core.icache.fills };
}

describe('predecode cache invalidation (BT37)', () => {
  it('smc: code rewritten in IRAM, through the SRAM1 data alias, remapped by the MMU and reprogrammed in flash runs as new', () => {
    const cached = runSmc(true);
    expect(cached.results).toEqual([1, 2, 3, 4, 5, 6, 7, 7]);
    expect(cached.fills).toBeGreaterThan(0);
    const plain = runSmc(false);
    expect(plain.results).toEqual([1, 2, 3, 4, 5, 6, 7, 7]);
    expect(plain.fills).toBe(0);
  });
});

interface RunState {
  instructions: number[];
  cycles: number[];
  ccount: number[];
  pc: number[];
  uart: string;
  time: number;
  misses: number[];
}

function state(soc: Esp32Soc, uart: string[]): RunState {
  return {
    instructions: soc.cores.map((c) => c.instructions),
    cycles: soc.cores.map((c) => c.cycles),
    ccount: soc.cores.map((c) => c.ccount),
    pc: soc.cores.map((c) => c.pc),
    uart: uart[0],
    time: soc.time,
    misses: soc.buses.map((b) => b.misses),
  };
}

describe('a run through the predecode cache is exactly a run without it (BT37)', () => {
  it('crc-bench to its output line: instruction counts, cycles, CCOUNTs, PCs, flash cache misses and UART match', () => {
    const runs = [true, false].map((predecode) => {
      const { soc, uart } = bootFixture('crc-bench');
      soc.setPredecode(predecode);
      runUntil(soc, 3, () => uart[0].includes('\n'));
      expect(soc.stopReason).toBe('');
      return state(soc, uart);
    });
    expect(runs[0].uart).toMatch(/^crc=[0-9a-f]{8}\n$/);
    expect(runs[0]).toEqual(runs[1]);
  }, 60_000);

  it('blink for 3 s: the same, and GPIO2 toggles at the same reference times', () => {
    const runs = [true, false].map((predecode) => {
      const { soc, uart } = bootFixture('blink');
      soc.setPredecode(predecode);
      const edges: number[] = [];
      soc.gpio.onOutput = (word, value, time) => {
        if (word === 0) edges.push(time, (value >>> 2) & 1);
      };
      const result = soc.runUntil(3 * REF_HZ);
      expect(result.reason).toBe('target');
      return { ...state(soc, uart), edges };
    });
    expect(runs[0].edges.length).toBeGreaterThan(8);
    expect(runs[0]).toEqual(runs[1]);
  }, 60_000);
});
