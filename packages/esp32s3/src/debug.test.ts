import { SymbolTable } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { readFixtureText } from '../../core/src/firmware/fixtures.test-helper.ts';
import { Esp32s3Debug } from './debug.ts';
import { REF_HZ } from './soc/rtc-cntl.ts';
import type { Esp32s3Soc } from './soc/soc.ts';
import { bootS3Fixture } from './test-support/boot.test-helper.ts';

// BT125: the S3's debugger view (the APP_CPU, where loop() runs) — fixtures/sketches/esp32s3/debug-demo,
// its symbols from the committed .syms.tsv. The SoC directly: the breakpoint set goes to both cores
// as an adapter would hand it.

const MS = REF_HZ / 1000;
const symbols = (): SymbolTable => SymbolTable.fromNm(readFixtureText('fixtures/firmware/esp32s3/debug-demo.syms.tsv'));

function boot(): { soc: Esp32s3Soc; debug: Esp32s3Debug; serial: () => string } {
  const { soc, uart } = bootS3Fixture('debug-demo');
  const breakpoints = new Set<number>();
  soc.cores[0].breakpoints = breakpoints;
  soc.cores[1].breakpoints = breakpoints;
  return { soc, debug: new Esp32s3Debug(() => soc, breakpoints), serial: () => uart[0] };
}

function runToBreak(soc: Esp32s3Soc, ms: number): boolean {
  const end = soc.time + ms * MS;
  while (soc.time < end) {
    const result = soc.runUntil(Math.min(end, soc.time + MS));
    if (result.reason === 'breakpoint') return true;
    if (result.reason !== 'target') throw new Error(`run stopped: ${result.reason} ${result.detail ?? ''}`);
  }
  return false;
}

describe('ESP32-S3 debugger (BT125: the core loop() runs on, the APP_CPU)', () => {
  it('a breakpoint on addSlow stops there; after its ENTRY a2 = seedA; counter matches the serial output; cleared, it runs on', () => {
    const { soc, debug, serial } = boot();
    const table = symbols();
    const addSlow = table.lookup('addSlow')?.address as number;
    const counter = table.lookup('counter')?.address as number;
    expect(debug.registers().map((r) => r.name).slice(0, 3)).toEqual(['pc', 'a0', 'a1']);
    debug.setBreakpoint(addSlow);
    const regs = new Uint32Array(debug.registers().length);
    const seeds: number[] = [];
    for (let i = 0; i < 3; i++) {
      expect(runToBreak(soc, 2000), `stop ${i}`).toBe(true);
      debug.readRegisters(regs);
      expect(regs[debug.pcIndex]).toBe(addSlow);
      expect(regs[24]).toBe(1); // the APP_CPU
      expect(debug.instructionAt(addSlow).size).toBe(3); // ENTRY
      expect(debug.step().reason).toBe('target');
      debug.readRegisters(regs);
      expect(regs[debug.pcIndex]).toBe(addSlow + 3);
      seeds.push(regs[1 + 2]); // a2
    }
    expect(seeds).toEqual([1234, 1235, 1236]);
    const printed = [...serial().matchAll(/counter=(\d+)/g)].map((m) => Number(m[1]));
    const bytes = debug.readMemory('data', counter, 2);
    expect(bytes[0] | (bytes[1] << 8)).toBe(printed.at(-1));
    debug.clearBreakpoint(addSlow);
    expect(debug.breakpoints()).toEqual([]);
    expect(runToBreak(soc, 300)).toBe(false);
    expect(soc.problems.problems.filter((p) => p.severity !== 'info')).toEqual([]);
  }, 60_000);

  it('reads memory without side effects — flash through the MMU, ROM, by offset; writes RAM; finds calls', () => {
    const { soc, debug, serial } = boot();
    expect(runToBreak(soc, 150)).toBe(false);
    const table = symbols();
    const addSlow = table.lookup('addSlow')?.address as number; // IROM: flash through the MMU
    expect(debug.readMemory('data', addSlow, 3)[0] & 0xf).toBe(6); // ENTRY's op0
    expect(debug.readMemory('data', 0x40000000, 4)).toEqual(soc.memory.rom.subarray(0, 4));
    expect(debug.readMemory('flash', 0x1000, 4)).toEqual(soc.flash.data.subarray(0x1000, 0x1004));
    expect(debug.readMemory('data', 0x60000000, 4)).toEqual(new Uint8Array(4)); // UART0's FIFO: never read
    // seedA in DRAM: a debugger write shows in the next print.
    const seedA = table.lookup('seedA')?.address as number;
    debug.writeMemory('data', seedA, new Uint8Array([0x0f, 0x27, 0, 0])); // 9999
    const before = serial().length;
    expect(runToBreak(soc, 120)).toBe(false);
    expect(serial().slice(before)).toMatch(/a=9999 counter=/);
    // The call to addSlow in loop(): some CALLn.
    const loop = table.lookup('loop')?.address as number;
    let call = -1;
    for (let at = loop; at < loop + 64 && call < 0; ) {
      const { size, isCall } = debug.instructionAt(at);
      if (isCall) call = at;
      at += size;
    }
    expect(call).toBeGreaterThan(loop);
  }, 60_000);
});
