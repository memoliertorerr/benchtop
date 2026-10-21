import { lineTableFromElf, parseElf32, resolveBreakpoint, SymbolTable } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { readFixture, readFixtureText } from '../../../../../packages/core/src/firmware/fixtures.test-helper.ts';
import { describeLocation, formatSreg, resolveAddress } from './resolve.ts';

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
