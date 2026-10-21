import { avrMcuFactory } from '@benchtop/avr';
import { Bench, lineTableFromElf, NS_PER_MS, parseElf32, parseProject, type ProjectDoc, stepOver, SymbolTable } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { readFixture, readFixtureText } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { analogSpecFor } from '../analog-specs.ts';
import { benchEnvParts } from '../catalog.ts';

// The CPU debugger (BT24) through the Bench: breakpoint stops end runUntil early, the bench
// resumes from there, and a step keeps the rest of the bench in time.

const ELF = readFixture('fixtures/firmware/uno/debug-demo.elf');
const symbols = SymbolTable.fromElf(parseElf32(ELF));

function load() {
  const parsed = parseProject(JSON.parse(readFixtureText('fixtures/projects/debug-demo.json')) as ProjectDoc);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const bench = new Bench(parsed.doc, { part: benchEnvParts, createMcu: avrMcuFactory }, { analogSpecFor });
  bench.attachFirmware('uno', { format: 'elf', bytes: ELF });
  let serial = '';
  bench.onSerial('uno', (bytes) => (serial += String.fromCharCode(...bytes)));
  return { bench, serial: () => serial };
}

describe('debugger on the bench', () => {
  it('a breakpoint ends runUntil at the MCU’s time and names the board; running again resumes', () => {
    const { bench, serial } = load();
    const debug = bench.debugOf('uno')!;
    const addSlow = symbols.lookup('addSlow')!.address;
    debug.setBreakpoint(addSlow);
    const first = bench.runUntil(1000 * NS_PER_MS);
    expect(first).toEqual({ reason: 'breakpoint', board: 'uno' });
    const t1 = bench.now();
    expect(t1).toBeGreaterThan(0);
    expect(t1).toBeLessThan(1000 * NS_PER_MS);
    const second = bench.runUntil(1000 * NS_PER_MS);
    expect(second).toEqual({ reason: 'breakpoint', board: 'uno' });
    // One loop later: ~100 ms (delay(100)) plus printing.
    expect((bench.now() - t1) / NS_PER_MS).toBeGreaterThan(100);
    expect(serial()).toContain('a=1234 counter=1\r\n');
    debug.clearBreakpoint(addSlow);
    expect(bench.runUntil(1000 * NS_PER_MS)).toEqual({ reason: 'target' });
    expect(bench.now()).toBe(1000 * NS_PER_MS);
    expect(bench.problems()).toEqual([]);
  });

  it('debugStep moves one instruction and the bench’s time with it; step over runs the bench', () => {
    const { bench } = load();
    const debug = bench.debugOf('uno')!;
    const regs = new Uint32Array(35);
    const lines = lineTableFromElf(parseElf32(ELF))!;
    const sketch = readFixtureText('fixtures/sketches/uno/debug-demo/debug-demo.ino').split('\n');
    const line = sketch.findIndex((l) => l.trimEnd().endsWith('// DEBUG_MARK')) + 1;
    // The call to addSlow is on the line before DEBUG_MARK.
    const [callLine] = lines.lineToAddresses('debug-demo.ino', line - 1);
    let pc = callLine;
    while (!debug.instructionAt(pc).isCall) pc += debug.instructionAt(pc).size;
    debug.setBreakpoint(pc);
    expect(bench.runUntil(1000 * NS_PER_MS)).toMatchObject({ reason: 'breakpoint' });
    debug.readRegisters(regs);
    expect(regs[34]).toBe(pc);
    const t = bench.now();
    expect(stepOver(debug, () => bench.runFor(10 * NS_PER_MS))).toEqual({ reason: 'stepped' });
    debug.readRegisters(regs);
    expect(regs[34]).toBe(pc + 4);
    expect(bench.now()).toBeGreaterThan(t);
    const before = bench.now();
    bench.debugStep('uno');
    debug.readRegisters(regs);
    expect(regs[34]).toBe(pc + 8); // sts (4 bytes)
    expect(bench.now() - before).toBeCloseTo(2 * 62.5, 6); // STS takes 2 cycles at 16 MHz
  });
});
