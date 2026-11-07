/**
 * The ESP32-S3 mask ROM ELF (BT124; `esp32s3_rev0_rom.elf`, rom-manifest.ts): its code and read-only
 * data (PROGBITS at ROM addresses — IBUS 0x4000_0000+, and its DBUS view 0x3FF0_0000+ for
 * .rodata), the RAM data its reset path would leave (PROGBITS at DRAM addresses, 0x3FCE_D000+:
 * function tables, interface pointers, .data), and its symbols. As the C3's: each RAM section sits
 * at its address, no store table to unpack.
 */

import { EM_XTENSA, parseElf32 } from '@benchtop/core';
import { DRAM_BASE, DRAM_END, DROM_BASE, DROM_SIZE, ROM_BASE, ROM_SIZE } from '../soc/memory.ts';

const SHT_PROGBITS = 1;

export interface S3RomSection {
  name: string;
  address: number;
  data: Uint8Array;
}

export interface S3Rom {
  /** Code and read-only data, at ROM (IBUS) or its DBUS view. */
  code: S3RomSection[];
  /** Initial RAM contents, at DRAM addresses. */
  ram: S3RomSection[];
  symbols: Map<string, number>;
}

const inRom = (a: number): boolean => (a >= ROM_BASE && a < ROM_BASE + ROM_SIZE) || (a >= DROM_BASE && a < DROM_BASE + DROM_SIZE);

export function parseS3Rom(bytes: Uint8Array): S3Rom {
  const elf = parseElf32(bytes);
  if (elf.machine !== EM_XTENSA) throw new Error(`not an Xtensa ELF (e_machine ${elf.machine}, expected ${EM_XTENSA})`);
  const code: S3RomSection[] = [];
  const ram: S3RomSection[] = [];
  for (const s of elf.sections) {
    if (s.type !== SHT_PROGBITS || s.size === 0) continue;
    if (inRom(s.addr) && inRom(s.addr + s.size - 1)) code.push({ name: s.name, address: s.addr, data: s.data });
    else if (s.addr >= DRAM_BASE && s.addr + s.size <= DRAM_END) ram.push({ name: s.name, address: s.addr, data: s.data });
  }
  if (code.length === 0) throw new Error('the ELF has no sections at ROM addresses');
  const symbols = new Map<string, number>();
  for (const symbol of elf.symbols) {
    if (symbol.name === '' || symbol.type === 'FILE' || symbol.type === 'SECTION') continue;
    if (!symbols.has(symbol.name)) symbols.set(symbol.name, symbol.value);
  }
  return { code, ram, symbols };
}
