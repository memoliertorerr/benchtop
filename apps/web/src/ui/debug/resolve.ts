/**
 * Debugger display helpers, pure (tested in Node): a PC → "pc 0x05b2 main+0x14 — file.ino:12",
 * SREG flags, and memory addresses typed as 0x…, decimal or a symbol. Breakpoint texts resolve
 * through `resolveBreakpoint` in @benchtop/core, the same function the worker arms them with.
 * BT74: every board's registers as rows (names and widths from the worker), its status flags
 * line, and where its memory view starts.
 */

import type { DebugTables } from '@benchtop/core';

const hex4 = (n: number): string => `0x${n.toString(16).padStart(4, '0')}`;
const basename = (path: string): string => path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);

/** "pc 0x05b2 main+0x14 — debug-demo.ino:12" (parts missing without symbols or lines). */
export function describeLocation(pc: number, tables: DebugTables): string {
  let text = `pc ${hex4(pc)}`;
  const symbol = tables.symbols?.describe(pc);
  if (symbol !== undefined && !symbol.startsWith('0x')) text += ` ${symbol}`;
  const line = tables.lines?.addressToLine(pc);
  if (line !== undefined) text += ` — ${basename(line.file)}:${line.line}`;
  return text;
}

/** SREG as ITHSVNZC: a letter for each set flag, '·' for each clear one. */
export function formatSreg(sreg: number): string {
  return 'ITHSVNZC'
    .split('')
    .map((flag, i) => ((sreg >> (7 - i)) & 1 ? flag : '·'))
    .join('');
}

/** A data or flash address typed by the user: 0x…, decimal, or a symbol (objects and functions). */
export function resolveAddress(text: string, tables: DebugTables): number | undefined {
  const spec = text.trim();
  if (/^0x[0-9a-f]+$/i.test(spec)) return Number.parseInt(spec.slice(2), 16);
  if (/^\d+$/.test(spec)) return Number(spec);
  return tables.symbols?.lookup(spec)?.address;
}

/** A register as the grid shows it: name and value in hex, as wide as the register. */
export function registerRows(names: readonly { name: string; bits: number }[], values: Uint32Array): { name: string; text: string; wide: boolean }[] {
  return names.map((r, i) => ({ name: r.name, text: ((values[i] ?? 0) >>> 0).toString(16).padStart(r.bits / 4, '0'), wide: r.bits > 8 }));
}

/**
 * The status register as words, per MCU (`Mcu.kind`): the AVR's SREG as ITHSVNZC, Arm's xPSR
 * as its NZCV flags and exception number, Xtensa's PS as INTLEVEL, EXCM, UM, WOE and CALLINC,
 * RISC-V's mstatus as MIE/MPIE; '' when the board has none of them.
 */
export function flagsLine(kind: string, names: readonly { name: string }[], values: Uint32Array): string {
  const of = (name: string): number | undefined => {
    const i = names.findIndex((r) => r.name === name);
    return i < 0 ? undefined : values[i] >>> 0;
  };
  if (kind === 'atmega328p' || kind === 'atmega2560') {
    const sreg = of('SREG');
    return sreg === undefined ? '' : `SREG ${formatSreg(sreg)}`;
  }
  if (kind === 'rp2040') {
    const x = of('xpsr');
    if (x === undefined) return '';
    const flags = 'NZCV'.split('').map((f, i) => ((x >>> (31 - i)) & 1 ? f : '·')).join('');
    const exception = x & 0x3f;
    return `xPSR ${flags}${exception === 0 ? ' thread' : ` exception ${exception}`}`;
  }
  if (kind === 'esp32') {
    const ps = of('ps');
    if (ps === undefined) return '';
    const cpu = of('cpu');
    return `${cpu === 1 ? 'APP_CPU' : cpu === 0 ? 'PRO_CPU' : ''} PS INTLEVEL=${ps & 0xf}${ps & 0x10 ? ' EXCM' : ''}${ps & 0x20 ? ' UM' : ''}${ps & 0x40000 ? ' WOE' : ''} CALLINC=${(ps >>> 16) & 3}`.trim();
  }
  if (kind === 'rp2350') {
    const m = of('mstatus');
    return m === undefined ? '' : `mstatus${m & 0x8 ? ' MIE' : ''}${m & 0x80 ? ' MPIE' : ''}`;
  }
  return '';
}

/** Where a board's memory view starts: its RAM. */
export function memoryStart(kind: string): string {
  if (kind === 'rp2040' || kind === 'rp2350') return '0x20000000';
  if (kind === 'esp32') return '0x3ffb0000';
  return '0x100';
}
