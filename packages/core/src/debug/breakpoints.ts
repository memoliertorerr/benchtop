/**
 * Breakpoint text → flash addresses: `0x05b2` is an address, `file.ino:12` a source line (the
 * lowest statement address of each place the line's code landed), anything else a function
 * name. Shared by the worker (which resolves and arms them at every load, before the first
 * instruction runs) and the UI (which shows what each one resolved to).
 */

import type { LineTable } from '../firmware/dwarf-line.ts';
import type { SymbolTable } from './symbols.ts';

export interface DebugTables {
  symbols: SymbolTable | null;
  lines: LineTable | null;
}

export type ResolvedBreakpoint = { ok: true; addresses: number[] } | { ok: false; error: string };

export function resolveBreakpoint(text: string, tables: DebugTables): ResolvedBreakpoint {
  const spec = text.trim();
  if (/^0x[0-9a-f]+$/i.test(spec)) {
    const address = Number.parseInt(spec.slice(2), 16);
    if (address % 2 !== 0) return { ok: false, error: 'instruction addresses are even' };
    return { ok: true, addresses: [address] };
  }
  const line = /^(.+):(\d+)$/.exec(spec);
  if (line !== null) {
    if (tables.lines === null) return { ok: false, error: 'no line table (load the .elf)' };
    const addresses = tables.lines.lineToAddresses(line[1], Number(line[2]));
    return addresses.length > 0 ? { ok: true, addresses } : { ok: false, error: `no code at ${spec}` };
  }
  if (tables.symbols === null) return { ok: false, error: 'no symbols (load the .elf)' };
  const symbol = tables.symbols.lookup(spec);
  if (symbol === undefined) return { ok: false, error: `no symbol "${spec}"` };
  if (symbol.kind !== 'func') return { ok: false, error: `"${spec}" is data, not code` };
  return { ok: true, addresses: [symbol.address] };
}
