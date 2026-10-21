import { SymbolTable } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { readFixtureText } from '../../core/src/firmware/fixtures.test-helper.ts';
import { isThumbCall, isWideThumb } from './debug.ts';
import { RP2040_CLOCK_HZ, type Rp2040Mcu } from './rp2040-mcu.ts';
import { bootPico, runMs } from './rp2040.test-helper.ts';

// BT72: the RP2040's debugger view on core 0 — fixtures/sketches/pico/debug-demo with its
// committed .syms.tsv (Thumb: function addresses lose bit 0).

const symbols = (): SymbolTable => SymbolTable.fromNm(readFixtureText('fixtures/firmware/pico/debug-demo.syms.tsv'), true);

function runToBreak(mcu: Rp2040Mcu, ms: number): boolean {
  const step = RP2040_CLOCK_HZ / 1000;
  const end = mcu.cycles + ms * step;
  while (mcu.cycles < end) {
    const result = mcu.runUntil(Math.min(end, mcu.cycles + step));
    if (result.reason === 'breakpoint') return true;
    if (result.reason !== 'target') throw new Error(`run stopped: ${result.reason} ${result.detail ?? ''}`);
  }
  return false;
}

describe('RP2040 debugger (core 0)', () => {
  it('names the registers as GDB does', () => {
    const { mcu } = bootPico('debug-demo');
    runMs(mcu, 20);
    const debug = mcu.debug();
    const names = debug.registers().map((r) => r.name);
    expect(names).toEqual(['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10', 'r11', 'r12', 'sp', 'lr', 'pc', 'xpsr']);
    const regs = new Uint32Array(names.length);
    debug.readRegisters(regs);
    expect(regs[debug.spIndex] >>> 28).toBe(2);
    expect(regs[16] & 0x01000000).toBe(0x01000000); // xPSR's T bit: always Thumb
  });

  it('a breakpoint on addSlow stops with r0 = seedA; the next run passes it; counter by symbol matches the serial output', () => {
    const { mcu } = bootPico('debug-demo');
    let serial = '';
    mcu.uart(0)?.onTransmit((b) => (serial += String.fromCharCode(b)));
    const table = symbols();
    const addSlow = table.lookup('addSlow')?.address as number;
    const counter = table.lookup('counter')?.address as number;
    const debug = mcu.debug();
    debug.setBreakpoint(addSlow | 1); // a Thumb address with its bit set works too
    expect(debug.breakpoints()).toEqual([addSlow]);
    const regs = new Uint32Array(debug.registers().length);
    const seeds: number[] = [];
    for (let i = 0; i < 3; i++) {
      expect(runToBreak(mcu, 1500), `stop ${i}`).toBe(true);
      debug.readRegisters(regs);
      expect(regs[debug.pcIndex]).toBe(addSlow);
      seeds.push(regs[0]);
    }
    expect(seeds).toEqual([1234, 1235, 1236]);
    const printed = [...serial.matchAll(/counter=(\d+)/g)].map((m) => Number(m[1]));
    const bytes = debug.readMemory('data', counter, 2);
    expect(bytes[0] | (bytes[1] << 8)).toBe(printed.at(-1));
    debug.clearBreakpoint(addSlow);
    expect(runToBreak(mcu, 300)).toBe(false);
  }, 30_000);

  it('steps one instruction at a time with the clock moving; instructionAt sizes Thumb and finds BL/BLX', () => {
    const { mcu } = bootPico('debug-demo');
    const debug = mcu.debug();
    const addSlow = symbols().lookup('addSlow')?.address as number;
    debug.setBreakpoint(addSlow);
    expect(runToBreak(mcu, 1500)).toBe(true);
    const regs = new Uint32Array(debug.registers().length);
    const before = mcu.cycles;
    let pc = addSlow;
    for (let i = 0; i < 4; i++) {
      const { size } = debug.instructionAt(pc);
      expect([2, 4]).toContain(size);
      expect(debug.step().reason).toBe('target');
      debug.readRegisters(regs);
      pc = regs[debug.pcIndex];
    }
    expect(pc).toBeGreaterThan(addSlow);
    expect(mcu.cycles).toBeGreaterThan(before);
    // BL (0xF000 0xF800 pattern), BLX r3, a plain B, a 32-bit non-call (LDR.W)
    expect(isWideThumb(0xf000)).toBe(true);
    expect(isThumbCall(0xf000, 0xf800)).toBe(true);
    expect(isThumbCall(0x4798, 0)).toBe(true); // blx r3
    expect(isThumbCall(0x4718, 0)).toBe(false); // bx r3
    expect(isThumbCall(0xe7fe, 0)).toBe(false); // b .
    expect(isWideThumb(0xf8d0)).toBe(true);
    expect(isThumbCall(0xf8d0, 0x0000)).toBe(false); // ldr.w
    const at = 0x20030000;
    debug.writeMemory('data', at, Uint8Array.of(0x00, 0xf0, 0x00, 0xf8, 0x98, 0x47));
    expect([debug.instructionAt(at), debug.instructionAt(at + 4)]).toEqual([
      { size: 4, isCall: true },
      { size: 2, isCall: true },
    ]);
  }, 30_000);

  it('reads memory without side effects: SRAM, flash both ways, the bootrom; peripherals read 0', () => {
    const { mcu } = bootPico('debug-demo');
    runMs(mcu, 20);
    const debug = mcu.debug();
    expect([...debug.readMemory('data', 0x20000000, 8)]).toEqual([...mcu.rp.sram.subarray(0, 8)]);
    expect([...debug.readMemory('data', 0x10000100, 8)]).toEqual([...debug.readMemory('flash', 0x100, 8)]);
    expect([...debug.readMemory('data', 0x13000100, 8)]).toEqual([...debug.readMemory('flash', 0x100, 8)]); // an XIP alias
    const sp = mcu.rp.bootrom[0];
    expect(debug.readMemory('data', 0, 4)).toEqual(Uint8Array.of(sp & 0xff, (sp >>> 8) & 0xff, (sp >>> 16) & 0xff, sp >>> 24));
    expect(debug.readMemory('data', 0x40034000, 4)).toEqual(new Uint8Array(4)); // UART0: not read
  });
});
