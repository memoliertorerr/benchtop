import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Esp32c3Debug } from './debug.ts';
import { REF_HZ } from './soc/context.ts';
import { bootC3Fixture, C3_FIXTURE_DIR } from './test-support/boot.test-helper.ts';

function symbol(name: string): number {
  for (const line of readFileSync(join(C3_FIXTURE_DIR, 'serial-hello.syms.tsv'), 'utf8').split('\n')) {
    const [address, , , n] = line.split('\t');
    if (n === name) return Number.parseInt(address, 16);
  }
  throw new Error(`no symbol ${name}`);
}

describe('the ESP32-C3 debugger view (BT93)', () => {
  it('stops before loop() at a breakpoint, every second, and steps from there', () => {
    const { soc, uart } = bootC3Fixture('serial-hello');
    const debug = new Esp32c3Debug(() => soc);
    const loop = symbol('_Z4loopv');
    debug.setBreakpoint(loop);
    expect(debug.breakpoints()).toEqual([loop]);
    soc.runUntil(3 * REF_HZ);
    expect(soc.atBreakpoint).toBe(true);
    const regs = new Uint32Array(debug.registers().length);
    debug.readRegisters(regs);
    expect(regs[debug.pcIndex]).toBe(loop);
    // setup() ran: its line is queued in the UART's FIFO (115200 baud), loop() hasn't run yet.
    expect(uart[0].length + soc.uarts[0].pendingTx).toBe('hello from esp32c3\r\n'.length);
    const first = soc.time;
    // The next run executes the breakpoint's instruction and stops at the next loop() a second later.
    soc.runUntil(3 * REF_HZ);
    expect(soc.atBreakpoint).toBe(true);
    expect(Math.abs((soc.time - first) / REF_HZ - 1)).toBeLessThan(0.002);
    // A step moves to the next instruction: 2 or 4 bytes on, as instructionAt says.
    const { size } = debug.instructionAt(loop);
    expect(debug.step()).toEqual({ reason: 'target' });
    debug.readRegisters(regs);
    expect(regs[debug.pcIndex]).toBe(loop + size);
    debug.clearBreakpoint(loop);
    soc.runUntil(soc.time + 1.1 * REF_HZ);
    expect(soc.atBreakpoint).toBe(false);
    expect(uart[0]).toBe('hello from esp32c3\r\ntick 1\ntick 2\n');
  });

  it('reads memory without side effects: flash through the MMU, the flash chip, SRAM; writes reach RAM only', () => {
    const { soc } = bootC3Fixture('serial-hello');
    soc.runUntil(0.5 * REF_HZ);
    const debug = new Esp32c3Debug(() => soc);
    // loop()'s code through the instruction cache equals the same bytes read through the data bus view.
    const loop = symbol('_Z4loopv');
    const code = debug.readMemory('data', loop, 16);
    expect([...code].some((b) => b !== 0)).toBe(true);
    const drom = 0x3c000000 + (loop - 0x42000000);
    expect([...debug.readMemory('data', drom, 16)]).toEqual([...code]);
    // The flash chip: the partition table's first entry magic at 0x8000.
    expect([...debug.readMemory('flash', 0x8000, 2)]).toEqual([0xaa, 0x50]);
    // A UART's FIFO register isn't popped by a peek.
    const before = soc.uarts[0].pendingTx;
    debug.readMemory('data', 0x60000000, 4);
    expect(soc.uarts[0].pendingTx).toBe(before);
    // RAM takes a write, ROM doesn't.
    debug.writeMemory('data', 0x3fcdf000, Uint8Array.of(1, 2, 3));
    expect([...debug.readMemory('data', 0x3fcdf000, 3)]).toEqual([1, 2, 3]);
    const rom = debug.readMemory('data', 0x40000000, 1)[0];
    debug.writeMemory('data', 0x40000000, Uint8Array.of(rom ^ 0xff));
    expect(debug.readMemory('data', 0x40000000, 1)[0]).toBe(rom);
  });

  it('knows calls: loop() calls delay() with a JAL that links ra', () => {
    const { soc } = bootC3Fixture('serial-hello');
    const debug = new Esp32c3Debug(() => soc);
    const loop = symbol('_Z4loopv');
    const end = loop + 0x30;
    let calls = 0;
    for (let a = loop; a < end; ) {
      const { size, isCall } = debug.instructionAt(a);
      expect([2, 4]).toContain(size);
      if (isCall) calls++;
      a += size;
    }
    expect(calls).toBeGreaterThanOrEqual(1);
  });
});
