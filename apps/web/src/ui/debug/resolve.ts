/**
 * Debugger display helpers, pure (tested in Node): a PC → "pc 0x05b2 main+0x14 — file.ino:12",
 * SREG flags, and memory addresses typed as 0x…, decimal or a symbol. Breakpoint texts resolve
 * through `resolveBreakpoint` in @benchtop/core, the same function the worker arms them with.
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
