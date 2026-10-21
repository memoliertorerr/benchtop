/**
 * What a debuggable MCU adds (BT24, additive): registers, side-effect-free memory access,
 * breakpoints and single steps. Addresses are byte addresses everywhere (ELF, DWARF and GDB all
 * use bytes); an adapter whose CPU counts words converts at this boundary.
 */

import type { Mcu, RunResult } from './mcu.ts';

/** AVR: 'data' is the data space — R0–R31 at 0x00–0x1F, I/O at 0x20–0xFF, SRAM from 0x100. */
export type MemorySpace = 'flash' | 'data' | 'eeprom';

export interface RegisterInfo {
  name: string;
  bits: 8 | 16 | 32;
}

export interface McuDebug {
  /** Fixed order; AVR: R0–R31, SREG, SP, PC. */
  registers(): readonly RegisterInfo[];
  readonly pcIndex: number;
  readonly spIndex: number;
  /** Fills `out` in `registers()` order; PC is a byte address. */
  readRegisters(out: Uint32Array): void;
  writeRegister(index: number, value: number): void;
  /** A copy of `len` bytes from `addr`, with no side effects (no peripheral read hooks). */
  readMemory(space: MemorySpace, addr: number, len: number): Uint8Array;
  writeMemory(space: MemorySpace, addr: number, bytes: Uint8Array): void;
  setBreakpoint(addr: number): void;
  clearBreakpoint(addr: number): void;
  breakpoints(): readonly number[];
  /** Executes exactly one instruction. */
  step(): RunResult;
  instructionAt(addr: number): { size: number; isCall: boolean };
}

export interface Debuggable {
  debug(): McuDebug;
}

/** Whether an MCU offers `debug()`. */
export function isDebuggable(mcu: Mcu): mcu is Mcu & Debuggable {
  return typeof (mcu as Partial<Debuggable>).debug === 'function';
}
