import { isDebuggable, lineTableFromElf, parseElf32, stepOver, SymbolTable } from '@benchtop/core';
import { avrInstruction } from 'avr8js';
import { describe, expect, it } from 'vitest';
import { readFixture, readFixtureText } from '../../core/src/firmware/fixtures.test-helper.ts';
import { type Atmega328p, createAtmega328p, UNO_CLOCK_HZ } from './atmega328p.ts';

// The Uno debugger (BT24) on debug-demo.elf: breakpoints by symbol and by file:line, steps,
// step over, registers and side-effect-free memory reads.

const ELF = readFixture('fixtures/firmware/uno/debug-demo.elf');
const elf = parseElf32(ELF);
const symbols = SymbolTable.fromElf(elf);
const lines = lineTableFromElf(elf)!;
const R = (name: string): number => ['SREG', 'SP', 'PC'].indexOf(name) + 32;

function boot() {
  const mcu = createAtmega328p();
  mcu.load({ format: 'elf', bytes: ELF });
  let serial = '';
  mcu.uart(0)!.onTransmit((byte) => (serial += String.fromCharCode(byte)));
  const debug = mcu.debug();
  const regs = new Uint32Array(debug.registers().length);
  const read = (): Uint32Array => {
    debug.readRegisters(regs);
    return regs;
  };
  /** Runs until a breakpoint (or `ms` of simulated time). */
  const run = (ms = 2000) => mcu.runUntil(mcu.cycles + (ms * UNO_CLOCK_HZ) / 1000);
  return { mcu, debug, read, run, serial: () => serial };
}

/** The last "a=<n> counter=<m>" line printed. */
function lastPrinted(serial: string): { a: number; counter: number } | undefined {
  const all = [...serial.matchAll(/a=(\d+) counter=(\d+)\r\n/g)];
  const last = all.at(-1);
  return last && { a: Number(last[1]), counter: Number(last[2]) };
}

/** Byte addresses of CALL instructions whose target is `target`. */
function callsTo(mcu: Atmega328p, target: number): number[] {
  const flash = mcu.core.cpu.progMem;
  const out: number[] = [];
  for (let w = 0; w + 1 < flash.length; w++) {
    const op = flash[w];
    if ((op & 0xfe0e) !== 0x940e) continue;
    const words = (((op & 0x01f0) >> 3) | (op & 1)) * 0x10000 + flash[w + 1];
    if (words * 2 === target) out.push(w * 2);
  }
  return out;
}

describe('Uno debugger', () => {
  const addSlow = symbols.lookup('addSlow')!;

  it('is debuggable, with R0–R31, SREG, SP, PC', () => {
    const { mcu, debug } = boot();
    expect(isDebuggable(mcu)).toBe(true);
    expect(debug.registers().map((r) => r.name)).toEqual([...Array.from({ length: 32 }, (_, i) => `R${i}`), 'SREG', 'SP', 'PC']);
    expect([debug.spIndex, debug.pcIndex]).toEqual([33, 34]);
    expect(addSlow).toMatchObject({ kind: 'func', space: 'flash' });
  });

  it('a breakpoint on addSlow stops at its address with a = seedA in R25:R24, as the sketch prints it', () => {
    const { debug, read, run, serial } = boot();
    debug.setBreakpoint(addSlow.address);
    const seen: number[] = [];
    for (let hit = 0; hit < 3; hit++) {
      expect(run()).toEqual({ reason: 'breakpoint' });
      const regs = read();
      expect(regs[R('PC')]).toBe(addSlow.address);
      seen.push(regs[24] + 256 * regs[25]);
      // The previous call's a= is the line printed since.
      if (hit > 0) expect(lastPrinted(serial())?.a).toBe(seen[hit - 1]);
    }
    expect(seen).toEqual([1234, 1235, 1236]);
    expect(symbols.describe(addSlow.address + 4)).toBe('addSlow+0x4');
  });

  it('step() executes exactly one instruction', () => {
    const { mcu, debug, read, run } = boot();
    debug.setBreakpoint(addSlow.address);
    run();
    const before = read().slice();
    const cycles = mcu.cycles;
    expect(debug.instructionAt(addSlow.address)).toEqual({ size: 2, isCall: false }); // movw r26, r24
    expect(debug.step()).toEqual({ reason: 'target' });
    const after = read();
    expect(after[R('PC')]).toBe(addSlow.address + 2);
    expect(mcu.cycles - cycles).toBe(1);
    expect([after[26], after[27]]).toEqual([before[24], before[25]]);
    expect(after[R('SP')]).toBe(before[R('SP')]);
  });

  it('step over a CALL returns to PC + 4 with SP unchanged', () => {
    const { mcu, debug, read, run } = boot();
    const [call] = callsTo(mcu, addSlow.address);
    expect(call).toBeDefined();
    expect(debug.instructionAt(call)).toEqual({ size: 4, isCall: true });
    debug.setBreakpoint(call);
    expect(run()).toEqual({ reason: 'breakpoint' });
    const sp = read()[R('SP')];
    expect(stepOver(debug, () => run())).toEqual({ reason: 'stepped' });
    const regs = read();
    expect(regs[R('PC')]).toBe(call + 4);
    expect(regs[R('SP')]).toBe(sp);
    expect(debug.breakpoints()).toEqual([call]); // the temporary breakpoint is gone
    // A user breakpoint inside the call stops the step over there instead.
    run(); // back at the call (next loop)
    debug.setBreakpoint(addSlow.address);
    expect(stepOver(debug, () => run())).toEqual({ reason: 'breakpoint' });
    expect(read()[R('PC')]).toBe(addSlow.address);
    expect(debug.breakpoints()).toEqual([addSlow.address, call]);
  });

  it('a breakpoint at debug-demo.ino:<DEBUG_MARK> stops at that line’s first is_stmt address', () => {
    const sketch = readFixtureText('fixtures/sketches/uno/debug-demo/debug-demo.ino').split('\n');
    const line = sketch.findIndex((l) => l.trimEnd().endsWith('// DEBUG_MARK')) + 1;
    const [address] = lines.lineToAddresses('debug-demo.ino', line);
    if (address === undefined) throw new Error(`debug-demo.ino:${line} has no is_stmt row: adjust the sketch`);
    const { debug, read, run } = boot();
    debug.setBreakpoint(address);
    expect(run()).toEqual({ reason: 'breakpoint' });
    const pc = read()[R('PC')];
    expect(pc).toBe(address);
    expect(lines.addressToLine(pc)).toMatchObject({ line });
  });

  it("readMemory('data', &counter, 2) equals the counter the sketch printed", () => {
    const counter = symbols.lookup('counter')!;
    expect(counter).toMatchObject({ kind: 'object', space: 'data', size: 2 });
    const { debug, run, serial } = boot();
    debug.setBreakpoint(addSlow.address);
    for (let hit = 0; hit < 4; hit++) run();
    const bytes = debug.readMemory('data', counter.address, 2);
    expect(bytes[0] | (bytes[1] << 8)).toBe(lastPrinted(serial())?.counter);
    expect(lastPrinted(serial())?.counter).toBe(3);
  });

  it('reading UDR0 or TWDR through readMemory leaves peripheral state unchanged', () => {
    const { mcu, debug, read, run } = boot();
    run(50); // Serial.begin has run
    // Interrupts off, so HardwareSerial's RX interrupt doesn't take the byte first.
    debug.writeRegister(R('SREG'), read()[R('SREG')] & ~0x80);
    mcu.uart(0)!.receive(Uint8Array.of(0x41));
    run(1); // one byte at 115200 baud takes ~87 µs
    const UCSR0A = 0xc0;
    const UDR0 = 0xc6;
    const TWDR = 0xbb;
    const data = mcu.core.cpu.data;
    expect(data[UCSR0A] & 0x80).toBe(0x80); // RXC: a byte is waiting
    const snapshot = data.slice();
    debug.readMemory('data', UDR0, 1);
    debug.readMemory('data', TWDR, 1);
    const all = debug.readMemory('data', 0, data.length);
    expect(Array.from(all)).toEqual(Array.from(snapshot));
    expect(Array.from(data)).toEqual(Array.from(snapshot));
    expect(data[UCSR0A] & 0x80).toBe(0x80); // still waiting: nothing consumed it
    // What readMemory avoids: the CPU's own read of UDR0 takes the byte and clears RXC.
    expect(mcu.core.cpu.readData(UDR0)).toBe(0x41);
    expect(data[UCSR0A] & 0x80).toBe(0);
    expect(() => debug.readMemory('data', data.length - 1, 2)).toThrow(RangeError);
    expect(debug.readMemory('flash', addSlow.address, 2)).toEqual(Uint8Array.of(0xdc, 0x01));
    expect(debug.readMemory('eeprom', 0, 4)).toEqual(Uint8Array.of(0xff, 0xff, 0xff, 0xff));
  });

  it('writes registers and memory (for the GDB stub)', () => {
    const { debug, read, run } = boot();
    debug.setBreakpoint(addSlow.address);
    run();
    debug.writeRegister(24, 0x34);
    debug.writeRegister(25, 0x12);
    debug.writeMemory('data', 0x100, Uint8Array.of(0xaa));
    expect([read()[24], read()[25]]).toEqual([0x34, 0x12]);
    expect(debug.readMemory('data', 0x100, 1)[0]).toBe(0xaa);
    debug.writeRegister(34, addSlow.address + 2);
    expect(read()[R('PC')]).toBe(addSlow.address + 2);
  });

  it('simulated MHz: 0 breakpoints matches the plain avr8js loop; 1 breakpoint reported', () => {
    const mhz = (mode: 'raw' | 'none' | 'one'): number => {
      const { mcu, debug } = boot();
      if (mode === 'one') debug.setBreakpoint(0x7ffe); // never reached
      const target = UNO_CLOCK_HZ / 5; // 0.2 s
      const start = performance.now();
      if (mode === 'raw') {
        // The loop runUntil had before this step.
        const cpu = mcu.core.cpu;
        while (cpu.cycles < target) {
          avrInstruction(cpu);
          cpu.tick();
        }
      } else {
        expect(mcu.runUntil(target)).toEqual({ reason: 'target' });
      }
      return target / ((performance.now() - start) * 1000);
    };
    mhz('none'); // warm up
    // Best of many short alternating runs: machine load only ever slows a run down, and the
    // full verify runs test files in parallel.
    let raw = 0;
    let none = 0;
    let one = 0;
    for (let k = 0; k < 8; k++) {
      raw = Math.max(raw, mhz('raw'));
      none = Math.max(none, mhz('none'));
      one = Math.max(one, mhz('one'));
    }
    console.info(`debug-demo: ${raw.toFixed(2)} simulated MHz plain loop, ${none.toFixed(2)} with 0 breakpoints, ${one.toFixed(2)} with 1`);
    expect(none).toBeGreaterThanOrEqual(raw * 0.97);
    expect(one).toBeGreaterThan(0);
  }, 30_000); // 5 s of simulated time: ~4.5 s of wall time alone, more under load
});
