/**
 * The ESP32 mask ROM from Espressif's esp-rom-elfs (`esp32_rev0_rom.elf`, Apache-2.0; fetched
 * with `npm run fetch:esp32-rom`, never committed): its loadable sections (SHF_ALLOC PROGBITS)
 * and its symbols. Loading them into the address space, and the ROM's .data initialisation,
 * are BT32.
 */

import { EM_XTENSA, parseElf32 } from '@benchtop/core';

const SHT_PROGBITS = 1;
const SHF_ALLOC = 2;

export interface RomSegment {
  name: string;
  address: number;
  /** A view into the input. */
  data: Uint8Array;
}

export interface RomImage {
  segments: RomSegment[];
  /**
   * The ROM's initialized RAM data (`.data_*`: PROGBITS, not ALLOC, at RAM addresses): the
   * bytes its reset handler copies from ROM into RAM. In the mask ROM they sit at the
   * `_rom_store_table` source addresses (0x4000D670…, past the ELF's `.text`).
   */
  data: RomSegment[];
  /** Symbol name → address (functions and data; the first definition wins). */
  symbols: Map<string, number>;
}

export function parseRomElf(bytes: Uint8Array): RomImage {
  const elf = parseElf32(bytes);
  if (elf.machine !== EM_XTENSA) throw new Error(`not an Xtensa ELF (e_machine ${elf.machine}, expected ${EM_XTENSA})`);
  const segments = elf.sections
    .filter((s) => s.type === SHT_PROGBITS && (s.flags & SHF_ALLOC) !== 0 && s.size > 0)
    .map((s) => ({ name: s.name, address: s.addr, data: s.data }));
  const data = elf.sections
    .filter((s) => s.type === SHT_PROGBITS && (s.flags & SHF_ALLOC) === 0 && s.size > 0 && s.addr >= 0x3ff80000 && s.addr < 0x40000000)
    .map((s) => ({ name: s.name, address: s.addr, data: s.data }));
  const symbols = new Map<string, number>();
  for (const symbol of elf.symbols) {
    if (symbol.name === '' || symbol.type === 'FILE' || symbol.type === 'SECTION') continue;
    if (!symbols.has(symbol.name)) symbols.set(symbol.name, symbol.value);
  }
  return { segments, data, symbols };
}

/** `_rom_store_table` (esp32.rom.ld; the literal at 0x40000424 in the ROM reset handler). */
export const ROM_STORE_TABLE = 0x4000d4f8;
export const ROM_STORE_TABLE_END = 0x4000d5c8;

/** Word access to the address space (a SocBus, or anything with the same two methods). */
export interface WordAccess {
  read32(address: number): number;
  write32(address: number, value: number): void;
}

/**
 * Puts the ROM's initial RAM data where the mask ROM keeps it: for each `_rom_store_table` entry
 * whose source lies outside the ELF's loaded sections, the bytes of the `.data_*` sections
 * covering its destination go to source + (section address − destination start). The table must
 * already be in ROM (loadRom). Returns the bytes placed.
 */
export function placeRomData(bus: WordAccess, rom: RomImage, write8: (address: number, value: number) => void): number {
  let placed = 0;
  for (let e = ROM_STORE_TABLE; e < ROM_STORE_TABLE_END; e += 16) {
    const start = bus.read32(e);
    const end = bus.read32(e + 4);
    const source = bus.read32(e + 8);
    if (end <= start || rom.segments.some((s) => source >= s.address && source < s.address + s.data.length)) continue;
    for (const section of rom.data) {
      const from = Math.max(start, section.address);
      const to = Math.min(end, section.address + section.data.length);
      for (let a = from; a < to; a++) {
        write8(source + (a - start), section.data[a - section.address]);
        placed++;
      }
    }
  }
  return placed;
}

/**
 * Initializes the ROM's RAM data the way its reset handler's `unpackloop` (0x40000501) does:
 * `_rom_store_table` holds 16-byte entries {destination start, destination end, source, always};
 * the PRO_CPU copies every entry's words from source to [start, end), the APP_CPU only those with
 * always = 1. Returns the number of entries.
 */
export function unpackRomData(bus: WordAccess, proCpu = true): number {
  let entries = 0;
  for (let e = ROM_STORE_TABLE; e < ROM_STORE_TABLE_END; e += 16) {
    const start = bus.read32(e);
    const end = bus.read32(e + 4);
    const source = bus.read32(e + 8);
    const always = bus.read32(e + 12);
    entries++;
    if (!proCpu && always !== 1) continue;
    for (let a = start, s = source; a < end; a += 4, s += 4) bus.write32(a, bus.read32(s));
  }
  return entries;
}
