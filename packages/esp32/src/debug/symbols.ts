/**
 * ESP32 symbols for debugging (BT32): a firmware's `.syms.tsv` (nm of its ELF: address, size,
 * type, name) plus the ROM ELF's symbols, as one sorted table. symbolize(address) gives
 * "name+0xoff" for the closest symbol at or below the address (code symbols preferred over
 * absolute zero-size ones at the same address).
 */

export interface EspSymbol {
  address: number;
  size: number;
  name: string;
}

export class EspSymbols {
  private readonly sorted: EspSymbol[];
  private readonly byName = new Map<string, number>();

  constructor(symbols: Iterable<EspSymbol>) {
    const list = [...symbols].filter((s) => s.address !== 0 && s.name !== '' && !s.name.startsWith('$'));
    list.sort((a, b) => a.address - b.address || b.size - a.size);
    this.sorted = list;
    for (const s of list) if (!this.byName.has(s.name)) this.byName.set(s.name, s.address);
  }

  /** Parses a `.syms.tsv` (address, size, type, name; `#` comments). */
  static parseTsv(text: string): EspSymbol[] {
    const out: EspSymbol[] = [];
    for (const line of text.split(/\r?\n/)) {
      if (line === '' || line.startsWith('#')) continue;
      const [address, size, , name] = line.split('\t');
      if (name === undefined) continue;
      out.push({ address: Number.parseInt(address, 16), size: size === '' || size === undefined ? 0 : Number.parseInt(size, 16), name });
    }
    return out;
  }

  /** ROM symbols from parseRomElf's map. */
  static fromMap(map: ReadonlyMap<string, number>): EspSymbol[] {
    return [...map].map(([name, address]) => ({ address, size: 0, name }));
  }

  address(name: string): number | undefined {
    return this.byName.get(name);
  }

  /** The symbol containing (or closest below) `address`, or undefined. */
  lookup(address: number): EspSymbol | undefined {
    const list = this.sorted;
    let lo = 0;
    let hi = list.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (list[mid].address <= address) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (found < 0) return undefined;
    // Several symbols can share an address: take the first (largest) one there.
    const at = list[found].address;
    while (found > 0 && list[found - 1].address === at) found--;
    const symbol = list[found];
    return address - symbol.address < 0x100000 ? symbol : undefined;
  }

  symbolize(address: number): string {
    const s = this.lookup(address >>> 0);
    if (s === undefined) return `0x${(address >>> 0).toString(16)}`;
    const off = (address >>> 0) - s.address;
    return off === 0 ? s.name : `${s.name}+0x${off.toString(16)}`;
  }
}
