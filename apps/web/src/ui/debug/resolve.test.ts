import { lineTableFromElf, parseElf32, resolveBreakpoint, SymbolTable } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { readFixture, readFixtureText } from '../../../../../packages/core/src/firmware/fixtures.test-helper.ts';
import { describeLocation, flagsLine, formatSreg, memoryStart, registerRows, resolveAddress } from './resolve.ts';

const elf = parseElf32(readFixture('fixtures/firmware/uno/debug-demo.elf'));
const tables = { symbols: SymbolTable.fromElf(elf), lines: lineTableFromElf(elf) ?? null };
const markLine = readFixtureText('fixtures/sketches/uno/debug-demo/debug-demo.ino').split('\n').findIndex((l) => l.trimEnd().endsWith('// DEBUG_MARK')) + 1;

describe('breakpoint specs', () => {
  it('resolves addresses, functions and file:line', () => {
    const addSlow = tables.symbols.lookup('addSlow')!.address;
    expect(resolveBreakpoint('0x322', tables)).toEqual({ ok: true, addresses: [0x322] });
    expect(resolveBreakpoint(' addSlow ', tables)).toEqual({ ok: true, addresses: [addSlow] });
    const mark = resolveBreakpoint(`debug-demo.ino:${markLine}`, tables);
    expect(mark.ok && mark.addresses.length).toBeGreaterThan(0);
    expect(resolveBreakpoint('0x323', tables)).toMatchObject({ ok: false });
    expect(resolveBreakpoint('counter', tables)).toEqual({ ok: false, error: '"counter" is data, not code' });
    expect(resolveBreakpoint('nope', tables)).toEqual({ ok: false, error: 'no symbol "nope"' });
    expect(resolveBreakpoint('debug-demo.ino:1', tables)).toEqual({ ok: false, error: 'no code at debug-demo.ino:1' });
    expect(resolveBreakpoint('addSlow', { symbols: null, lines: null })).toMatchObject({ ok: false });
  });

  it('describes a PC and formats SREG', () => {
    const addSlow = tables.symbols.lookup('addSlow')!.address;
    expect(describeLocation(addSlow + 4, tables)).toMatch(/^pc 0x0326 addSlow\+0x4 — debug-demo\.ino:\d+$/);
    expect(describeLocation(0x10, { symbols: null, lines: null })).toBe('pc 0x0010');
    expect(formatSreg(0x82)).toBe('I·····Z·');
    expect(resolveAddress('counter', tables)).toBe(tables.symbols.lookup('counter')!.address);
    expect(resolveAddress('0x100', tables)).toBe(0x100);
    expect(resolveAddress('256', tables)).toBe(256);
  });
});

describe('every board in the registers grid (BT74)', () => {
  it('rows are as wide as each register', () => {
    expect(registerRows([{ name: 'R0', bits: 8 }, { name: 'SP', bits: 16 }, { name: 'pc', bits: 32 }], Uint32Array.of(0x5, 0x8ff, 0x10003208))).toEqual([
      { name: 'R0', text: '05', wide: false },
      { name: 'SP', text: '08ff', wide: true },
      { name: 'pc', text: '10003208', wide: true },
    ]);
  });

  it('flags per MCU: SREG, xPSR, PS, mstatus', () => {
    expect(flagsLine('atmega328p', [{ name: 'SREG' }], Uint32Array.of(0b10000011))).toBe('SREG I·····ZC');
    expect(flagsLine('rp2040', [{ name: 'xpsr' }], Uint32Array.of(0x61000000))).toBe('xPSR ·ZC· thread');
    expect(flagsLine('rp2040', [{ name: 'xpsr' }], Uint32Array.of(0x8100000f))).toBe('xPSR N··· exception 15');
    expect(flagsLine('esp32', [{ name: 'ps' }, { name: 'cpu' }], Uint32Array.of(0x00060020, 1))).toBe('APP_CPU PS INTLEVEL=0 UM WOE CALLINC=2');
    expect(flagsLine('rp2350', [{ name: 'mstatus' }], Uint32Array.of(0x1888))).toBe('mstatus MIE MPIE');
    expect(flagsLine('unknown', [], new Uint32Array(0))).toBe('');
  });

  it('memory starts in each board\'s RAM', () => {
    expect(['atmega328p', 'rp2040', 'rp2350', 'esp32'].map(memoryStart)).toEqual(['0x100', '0x20000000', '0x20000000', '0x3ffb0000']);
  });
});
