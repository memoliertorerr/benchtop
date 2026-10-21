import { SymbolTable } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { readFixture, readFixtureText } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { createEsp32Mcu, type Esp32Mcu } from '../esp32.ts';
import { REF_HZ } from '../soc/context.ts';
import { loadCachedRom } from '../test-support/rom.test-helper.ts';

// BT73: the ESP32's debugger view (the APP_CPU, where loop() runs) — fixtures/sketches/esp32/debug-demo, its
// symbols from the committed .syms.tsv.

const ROM = loadCachedRom();
const MS = REF_HZ / 1000;
const symbols = (): SymbolTable => SymbolTable.fromNm(readFixtureText('fixtures/firmware/esp32/debug-demo.syms.tsv'));

function boot(): { mcu: Esp32Mcu; serial: () => string } {
  const mcu = createEsp32Mcu({ rom: ROM });
  mcu.load({ format: 'esp32-bin', app: readFixture('fixtures/firmware/esp32/debug-demo.bin'), partitions: readFixture('fixtures/firmware/esp32/debug-demo.partitions.bin') });
  let out = '';
  mcu.uart(0)?.onTransmit((b) => (out += String.fromCharCode(b)));
  return { mcu, serial: () => out };
}

function runToBreak(mcu: Esp32Mcu, ms: number): boolean {
  const end = mcu.cycles + ms * MS;
  while (mcu.cycles < end) {
    const result = mcu.runUntil(Math.min(end, mcu.cycles + MS));
    if (result.reason === 'breakpoint') return true;
    if (result.reason !== 'target') throw new Error(`run stopped: ${result.reason} ${result.detail ?? ''}`);
  }
  return false;
}

describe('ESP32 debugger (the core loop() runs on: the APP_CPU)', () => {
  it('a breakpoint on addSlow stops there; after its ENTRY a2 = seedA; the next run passes it; counter matches the serial output', () => {
    const { mcu, serial } = boot();
    const table = symbols();
    const addSlow = table.lookup('addSlow')?.address as number;
    const counter = table.lookup('counter')?.address as number;
    const debug = mcu.debug();
    expect(debug.registers().map((r) => r.name).slice(0, 3)).toEqual(['pc', 'a0', 'a1']);
    debug.setBreakpoint(addSlow);
    const regs = new Uint32Array(debug.registers().length);
    const seeds: number[] = [];
    for (let i = 0; i < 3; i++) {
      expect(runToBreak(mcu, 2000), `stop ${i}`).toBe(true);
      debug.readRegisters(regs);
      expect(regs[debug.pcIndex]).toBe(addSlow);
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
    // the breakpoint survives a reset (the adapter keeps the set for every SoC it builds)
    mcu.reset();
    expect(debug.breakpoints()).toEqual([addSlow]);
    expect(runToBreak(mcu, 2000)).toBe(true);
    debug.clearBreakpoint(addSlow);
    expect(runToBreak(mcu, 300)).toBe(false);
  }, 60_000);

  it('reads memory without side effects: DRAM, IRAM, ROM, flash through the MMU and by offset; calls are found', () => {
    const { mcu } = boot();
    expect(runToBreak(mcu, 50)).toBe(false);
    const debug = mcu.debug();
    const soc = mcu.soc;
    const addSlow = symbols().lookup('addSlow')?.address as number; // IROM: flash through the cache MMU
    const code = debug.readMemory('data', addSlow, 3);
    expect(code[0] & 0xf).toBe(6); // ENTRY's op0
    const misses = soc.buses[0].misses;
    debug.readMemory('data', addSlow, 64);
    expect(soc.buses[0].misses).toBe(misses); // no cache lookups
    expect(debug.readMemory('data', 0x40000000, 4)).toEqual(soc.memory.bytes.subarray(0, 4)); // ROM0
    expect(debug.readMemory('flash', 0x1000, 4)).toEqual(soc.memory.flash.subarray(0x1000, 0x1004));
    expect(debug.readMemory('data', 0x3ff40000, 4)).toEqual(new Uint8Array(4)); // UART0: never read
    // Find the call to addSlow in loop(): some CALLn whose target is addSlow
    const loop = symbols().lookup('loop')?.address as number;
    let call = -1;
    for (let at = loop; at < loop + 64 && call < 0; ) {
      const { size, isCall } = debug.instructionAt(at);
      if (isCall) call = at;
      at += size;
    }
    expect(call).toBeGreaterThan(loop);
  }, 60_000);
});
