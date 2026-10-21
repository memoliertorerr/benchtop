/**
 * Symbols for the debugger: function names for a PC ("main+0x14") and name lookup for
 * breakpoints. Built from an ELF's .symtab; packed into plain arrays so the worker can send it
 * to the UI. Names stay as the compiler wrote them (mangled C++ names included; a demangler is
 * Later), but lookup ignores the clone suffixes GCC adds under LTO (.constprop.N, .isra.N,
 * .part.N, .lto_priv.N, .cold) and also finds a plain C++ function by its identifier
 * (`myFunc` → `_Z6myFuncv`).
 */

import { EM_AVR, type Elf32 } from '../firmware/elf.ts';
import type { MemorySpace } from '../contracts/debug.ts';

export const SYMBOL_FUNC = 0;
export const SYMBOL_OBJECT = 1;

/** Plain data for a postMessage: names joined by '\n'; entries sorted by (space, address). */
export interface SymbolTableData {
  names: string;
  address: Uint32Array;
  size: Uint32Array;
  /** SYMBOL_FUNC or SYMBOL_OBJECT. */
  kind: Uint8Array;
  /** 0 flash, 1 data, 2 eeprom. */
  space: Uint8Array;
}

export interface SymbolEntry {
  name: string;
  address: number;
  size: number;
  kind: 'func' | 'object';
  space: MemorySpace;
}

const SPACES: readonly MemorySpace[] = ['flash', 'data', 'eeprom'];
const CLONE_SUFFIX = /(?:\.(?:constprop|isra|part|lto_priv)\.\d+|\.cold(?:\.\d+)?)+$/;

/** A name without GCC's clone suffixes: `digitalWrite.constprop.3` → `digitalWrite`. */
export function baseSymbolName(name: string): string {
  return name.replace(CLONE_SUFFIX, '');
}

/** The identifier of a plain mangled function name (`_Z7addSlowii` → `addSlow`), else undefined. */
function mangledIdentifier(name: string): string | undefined {
  const m = /^_Z(\d+)/.exec(name);
  if (m === null) return undefined;
  const length = Number(m[1]);
  const start = m[0].length;
  return length > 0 && start + length <= name.length ? name.slice(start, start + length) : undefined;
}

export class SymbolTable {
  readonly data: SymbolTableData;
  private readonly list: string[];
  /** Indexes of FUNC entries, by address. */
  private readonly funcs: number[];

  constructor(data: SymbolTableData) {
    this.data = data;
    this.list = data.names === '' ? [] : data.names.split('\n');
    this.funcs = [];
    for (let i = 0; i < data.kind.length; i++) if (data.kind[i] === SYMBOL_FUNC) this.funcs.push(i);
    this.funcs.sort((a, b) => data.address[a] - data.address[b]);
  }

  /** FUNC and OBJECT symbols with a defined section. AVR data-space objects sit at 0x800000+. */
  static fromElf(elf: Elf32): SymbolTable {
    const entries: SymbolEntry[] = [];
    const avr = elf.machine === EM_AVR;
    for (const symbol of elf.symbols) {
      if (symbol.name === '' || symbol.shndx === 0 || symbol.shndx >= 0xff00) continue;
      if (symbol.type !== 'FUNC' && symbol.type !== 'OBJECT') continue;
      let space: MemorySpace = 'flash';
      let address = symbol.value;
      if (avr && symbol.value >= 0x810000 && symbol.value < 0x820000) {
        space = 'eeprom';
        address = symbol.value - 0x810000;
      } else if (avr && symbol.value >= 0x800000 && symbol.value < 0x810000) {
        space = 'data';
        address = symbol.value - 0x800000;
      }
      entries.push({ name: symbol.name, address, size: symbol.size, kind: symbol.type === 'FUNC' ? 'func' : 'object', space });
    }
    return SymbolTable.fromEntries(entries);
  }

  static fromEntries(entries: readonly SymbolEntry[]): SymbolTable {
    const sorted = [...entries].sort((a, b) => SPACES.indexOf(a.space) - SPACES.indexOf(b.space) || a.address - b.address || (a.name < b.name ? -1 : 1));
    return new SymbolTable({
      names: sorted.map((e) => e.name.replace(/\n/g, ' ')).join('\n'),
      address: Uint32Array.from(sorted, (e) => e.address),
      size: Uint32Array.from(sorted, (e) => e.size),
      kind: Uint8Array.from(sorted, (e) => (e.kind === 'func' ? SYMBOL_FUNC : SYMBOL_OBJECT)),
      space: Uint8Array.from(sorted, (e) => SPACES.indexOf(e.space)),
    });
  }

  get size(): number {
    return this.list.length;
  }

  entry(index: number): SymbolEntry {
    const d = this.data;
    return {
      name: this.list[index],
      address: d.address[index],
      size: d.size[index],
      kind: d.kind[index] === SYMBOL_FUNC ? 'func' : 'object',
      space: SPACES[d.space[index]] ?? 'flash',
    };
  }

  /** The nearest function at or below `pc`, with the offset into it. */
  functionAt(pc: number): { name: string; offset: number; address: number } | undefined {
    const { address } = this.data;
    let lo = 0;
    let hi = this.funcs.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (address[this.funcs[mid]] <= pc) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (found < 0) return undefined;
    const i = this.funcs[found];
    return { name: this.list[i], offset: pc - address[i], address: address[i] };
  }

  /** "main+0x14", "addSlow", or "0x05b2" when no function is below `pc`. */
  describe(pc: number): string {
    const f = this.functionAt(pc);
    if (f === undefined) return `0x${pc.toString(16).padStart(4, '0')}`;
    return f.offset === 0 ? f.name : `${f.name}+0x${f.offset.toString(16)}`;
  }

  /**
   * A symbol by name: an exact match first, then one whose name minus clone suffixes matches,
   * then a plain mangled function with that identifier. Functions win over objects.
   */
  lookup(name: string): SymbolEntry | undefined {
    const tiers: number[][] = [[], [], []];
    for (let i = 0; i < this.list.length; i++) {
      const candidate = this.list[i];
      if (candidate === name) tiers[0].push(i);
      else if (baseSymbolName(candidate) === name) tiers[1].push(i);
      else if (mangledIdentifier(baseSymbolName(candidate)) === name) tiers[2].push(i);
    }
    for (const tier of tiers) {
      if (tier.length === 0) continue;
      const func = tier.find((i) => this.data.kind[i] === SYMBOL_FUNC);
      return this.entry(func ?? tier[0]);
    }
    return undefined;
  }
}
