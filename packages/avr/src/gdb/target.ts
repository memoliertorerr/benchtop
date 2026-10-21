/**
 * The AVR as GDB sees it (avr-tdep conventions): `g`/`G` carry 39 bytes — R0–R31, SREG, SP
 * (2 bytes little-endian), PC (4 bytes little-endian, a byte address). Memory addresses put
 * flash at 0x000000, the data space at 0x800000 and EEPROM at 0x810000; anything else, or past
 * the end of a space, is an error (E01). Built on BT24's McuDebug; no contract changes.
 */

import type { McuDebug, MemorySpace } from '@benchtop/core';
import { fromHex, toHex } from './rsp.ts';

export const GDB_REGISTER_BYTES = 39;
const DATA_BASE = 0x800000;
const EEPROM_BASE = 0x810000;
/** Most bytes one `m` answers (PacketSize 0x1000 holds 0x7ff bytes as hex). */
export const MAX_MEMORY_READ = 0x7ff;

/** A GDB address → (space, offset), or undefined outside the three spaces. */
export function gdbSpace(address: number): { space: MemorySpace; offset: number } | undefined {
  if (!Number.isInteger(address) || address < 0) return undefined;
  if (address < DATA_BASE) return { space: 'flash', offset: address };
  if (address < EEPROM_BASE) return { space: 'data', offset: address - DATA_BASE };
  if (address < EEPROM_BASE + 0x10000) return { space: 'eeprom', offset: address - EEPROM_BASE };
  return undefined;
}

export class AvrGdbTarget {
  readonly debug: McuDebug;
  private readonly regs: Uint32Array;

  constructor(debug: McuDebug) {
    this.debug = debug;
    this.regs = new Uint32Array(debug.registers().length);
  }

  get pc(): number {
    this.debug.readRegisters(this.regs);
    return this.regs[this.debug.pcIndex];
  }

  set pc(address: number) {
    this.debug.writeRegister(this.debug.pcIndex, address);
  }

  /** `g`: 78 hex characters. */
  readRegisters(): string {
    this.debug.readRegisters(this.regs);
    const bytes = new Uint8Array(GDB_REGISTER_BYTES);
    for (let i = 0; i < 33; i++) bytes[i] = this.regs[i]; // R0–R31, SREG
    const sp = this.regs[this.debug.spIndex];
    bytes[33] = sp & 0xff;
    bytes[34] = (sp >> 8) & 0xff;
    const pc = this.regs[this.debug.pcIndex];
    for (let i = 0; i < 4; i++) bytes[35 + i] = (pc >>> (8 * i)) & 0xff;
    return toHex(bytes);
  }

  /** `G`: false for anything but exactly 78 hex characters. */
  writeRegisters(hex: string): boolean {
    const bytes = fromHex(hex);
    if (bytes === undefined || bytes.length !== GDB_REGISTER_BYTES) return false;
    for (let i = 0; i < 33; i++) this.debug.writeRegister(i, bytes[i]);
    this.debug.writeRegister(this.debug.spIndex, bytes[33] | (bytes[34] << 8));
    this.debug.writeRegister(this.debug.pcIndex, (bytes[35] | (bytes[36] << 8) | (bytes[37] << 16) | (bytes[38] << 24)) >>> 0);
    return true;
  }

  /** `m`: hex, or undefined (E01) outside a space. Long reads are cut to MAX_MEMORY_READ. */
  readMemory(address: number, length: number): string | undefined {
    const where = gdbSpace(address);
    if (where === undefined || !Number.isInteger(length) || length < 0) return undefined;
    try {
      return toHex(this.debug.readMemory(where.space, where.offset, Math.min(length, MAX_MEMORY_READ)));
    } catch {
      return undefined;
    }
  }

  /** `M`: false (E01) outside a space or for malformed data. */
  writeMemory(address: number, length: number, hex: string): boolean {
    const where = gdbSpace(address);
    const bytes = fromHex(hex);
    if (where === undefined || bytes === undefined || bytes.length !== length) return false;
    try {
      this.debug.writeMemory(where.space, where.offset, bytes);
      return true;
    } catch {
      return false;
    }
  }
}
