import { SymbolTable } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { readFixtureText } from '../../core/src/firmware/fixtures.test-helper.ts';
import { createRp2350Mcu, RP2350_CLOCK_HZ, type Rp2350Mcu } from './rp2350-mcu.ts';
import { bootPico2, cachedRom, runMs } from './rp2350.test-helper.ts';

// BT71: the RP2350's debugger view on hart 0 — fixtures/sketches/pico2/debug-demo (its symbols
// from the committed .syms.tsv), and hand-placed instructions for instructionAt.

const symbols = (): SymbolTable => SymbolTable.fromNm(readFixtureText('fixtures/firmware/pico2/debug-demo.syms.tsv'));

/** Runs up to `ms`; true when the run stopped at a breakpoint. */
function runToBreak(mcu: Rp2350Mcu, ms: number): boolean {
  const step = RP2350_CLOCK_HZ / 1000;
  const end = mcu.cycles + ms * step;
  while (mcu.cycles < end) {
    const result = mcu.runUntil(Math.min(end, mcu.cycles + step));
    if (result.reason === 'breakpoint') return true;
    if (result.reason !== 'target') throw new Error(`run stopped: ${result.reason} ${result.detail ?? ''}`);
  }
  return false;
}

describe('RP2350 debugger (hart 0)', () => {
  it('names the registers as GDB does and reads them', () => {
    const { mcu } = bootPico2('debug-demo');
    runMs(mcu, 50);
    const debug = mcu.debug();
    const names = debug.registers().map((r) => r.name);
    expect(names.slice(0, 4)).toEqual(['zero', 'ra', 'sp', 'gp']);
    expect(names[10]).toBe('a0');
    expect(names[debug.pcIndex]).toBe('pc');
    expect(names[debug.spIndex]).toBe('sp');
    const regs = new Uint32Array(names.length);
    debug.readRegisters(regs);
    expect(regs[0]).toBe(0);
    expect(regs[debug.spIndex] >>> 28).toBe(2); // the stack is in SRAM
    expect(regs[debug.pcIndex]).toBe(mcu.soc?.harts[0].pc);
  });

  it('a breakpoint on addSlow stops with a0 = seedA; the next run passes it; counter matches the serial output', () => {
    const { mcu } = bootPico2('debug-demo');
    let serial = '';
    mcu.uart(0)?.onTransmit((b) => (serial += String.fromCharCode(b)));
    const table = symbols();
    const addSlow = table.lookup('addSlow');
    const counter = table.lookup('counter');
    const seedA = table.lookup('seedA');
    expect(addSlow?.kind).toBe('func');
    const debug = mcu.debug();
    debug.setBreakpoint(addSlow?.address as number);
    expect(debug.breakpoints()).toEqual([addSlow?.address]);
    const regs = new Uint32Array(debug.registers().length);
    const seeds: number[] = [];
    for (let i = 0; i < 3; i++) {
      expect(runToBreak(mcu, 1000), `stop ${i}`).toBe(true);
      debug.readRegisters(regs);
      expect(regs[debug.pcIndex]).toBe(addSlow?.address);
      seeds.push(regs[10]);
    }
    expect(seeds).toEqual([1234, 1235, 1236]);
    const seedBytes = debug.readMemory('data', seedA?.address as number, 4);
    expect(new DataView(seedBytes.buffer).getInt32(0, true)).toBe(1236);
    // counter, as the sketch printed it last
    const printed = [...serial.matchAll(/counter=(\d+)/g)].map((m) => Number(m[1]));
    const bytes = debug.readMemory('data', counter?.address as number, 2);
    expect(bytes[0] | (bytes[1] << 8)).toBe(printed.at(-1));
    debug.clearBreakpoint(addSlow?.address as number);
    expect(runToBreak(mcu, 300)).toBe(false);
  }, 30_000);

  it('steps one instruction at a time; instructionAt sizes them and finds calls', () => {
    const { mcu } = bootPico2('debug-demo');
    const debug = mcu.debug();
    const addSlow = symbols().lookup('addSlow')?.address as number;
    debug.setBreakpoint(addSlow);
    expect(runToBreak(mcu, 1000)).toBe(true);
    const regs = new Uint32Array(debug.registers().length);
    let pc = addSlow;
    for (let i = 0; i < 4; i++) {
      const { size } = debug.instructionAt(pc);
      expect([2, 4]).toContain(size);
      expect(debug.step().reason).toBe('target');
      debug.readRegisters(regs);
      pc = regs[debug.pcIndex];
    }
    expect(pc).toBeGreaterThan(addSlow);
    expect(pc - addSlow).toBeLessThan(24);
    // Hand-placed instructions in SRAM: jal ra; c.jal; j (no link); c.jalr ra; jalr t0
    const at = 0x20070000;
    const code = [0xef, 0x00, 0x00, 0x00, 0x01, 0x20, 0x6f, 0x00, 0x00, 0x00, 0x82, 0x90, 0xe7, 0x02, 0x00, 0x00];
    debug.writeMemory('data', at, Uint8Array.from(code));
    expect([0, 4, 6, 10, 12].map((o) => debug.instructionAt(at + o))).toEqual([
      { size: 4, isCall: true },
      { size: 2, isCall: true },
      { size: 4, isCall: false },
      { size: 2, isCall: true },
      { size: 4, isCall: true },
    ]);
  }, 30_000);

  it('reads memory without side effects: RAM, flash both ways, ROM, peripheral registers', () => {
    const { mcu } = bootPico2('serial-hello');
    runMs(mcu, 30);
    const soc = mcu.soc;
    if (soc === null) throw new Error('no SoC');
    const debug = mcu.debug();
    expect([...debug.readMemory('data', 0x20000000, 8)]).toEqual([...soc.sram.subarray(0, 8)]);
    expect([...debug.readMemory('data', 0x10000000, 8)]).toEqual([...debug.readMemory('flash', 0, 8)]);
    expect([...debug.readMemory('data', 0x00000000, 4)]).toEqual([...soc.read(0, 0, 4).toString(16).padStart(8, '0').match(/../g)!.reverse().map((h) => Number.parseInt(h, 16))]);
    // Peripheral registers come from what the blocks store: a debugger read never runs a block's
    // read (which pops UART0's RX FIFO, clears interrupt flags, …).
    const uart = soc.uarts[0];
    const read = uart.read.bind(uart);
    let reads = 0;
    uart.read = (offset: number) => {
      reads++;
      return read(offset);
    };
    const before = soc.read(0, 0x40070018, 4); // UARTFR, through the bus
    expect(reads).toBe(1);
    debug.readMemory('data', 0x40070000, 0x40);
    expect(reads).toBe(1);
    expect(soc.read(0, 0x40070018, 4)).toBe(before);
    expect(debug.readMemory('eeprom', 0, 4)).toEqual(new Uint8Array(4));
  }, 30_000);

  it('without a bootrom the view is empty and never stops', () => {
    const mcu = createRp2350Mcu({});
    const debug = mcu.debug();
    expect(debug.registers().length).toBe(36);
    expect(debug.step().reason).toBe('halted');
    expect(debug.readMemory('data', 0x20000000, 4)).toEqual(new Uint8Array(4));
    expect(cachedRom().length).toBeGreaterThan(0);
  });
});
