/**
 * The AVR debugger view (BT24; Uno, Nano and, since BT46, Mega): registers R0–R31, SREG, SP, PC; side-effect-free memory
 * access; breakpoints; single steps. Reads go straight to `cpu.data`/`progBytes` (cpu.readData()
 * would run peripheral read hooks — reading UDR0 would consume a received byte). avr8js ignores
 * BREAK (0x9598 decodes as a 1-cycle no-op), so breakpoints are a per-word Uint8Array the
 * adapter checks before each instruction, in a loop it only enters while one is set.
 *
 * Addresses are byte addresses; avr8js's `cpu.pc` is a word index, converted here.
 */

import type { McuDebug, MemorySpace, RegisterInfo, RunResult } from '@benchtop/core';
import type { AvrMcu } from './avr-mcu.ts';

const SREG = 0x5f;
const SPL = 0x5d;
const SPH = 0x5e;

const REGISTERS: readonly RegisterInfo[] = Object.freeze([
  ...Array.from({ length: 32 }, (_, i): RegisterInfo => ({ name: `R${i}`, bits: 8 })),
  { name: 'SREG', bits: 8 },
  { name: 'SP', bits: 16 },
  { name: 'PC', bits: 32 },
]);

/** First word of a 32-bit instruction: CALL, JMP, LDS, STS. */
export function isTwoWord(op: number): boolean {
  return (op & 0xfe0c) === 0x940c || (op & 0xfc0f) === 0x9000;
}

/** CALL, RCALL, ICALL, EICALL. */
export function isCallOpcode(op: number): boolean {
  return (op & 0xfe0e) === 0x940e || (op & 0xf000) === 0xd000 || op === 0x9509 || op === 0x9519;
}

export class AvrDebug implements McuDebug {
  readonly pcIndex = 34;
  readonly spIndex = 33;
  private readonly mcu: AvrMcu;

  constructor(mcu: AvrMcu) {
    this.mcu = mcu;
  }

  registers(): readonly RegisterInfo[] {
    return REGISTERS;
  }

  readRegisters(out: Uint32Array): void {
    const cpu = this.mcu.core.cpu;
    const d = cpu.data;
    for (let i = 0; i < 32; i++) out[i] = d[i];
    out[32] = d[SREG];
    out[33] = d[SPL] | (d[SPH] << 8);
    out[34] = cpu.pc * 2;
  }

  writeRegister(index: number, value: number): void {
    const cpu = this.mcu.core.cpu;
    if (index >= 0 && index < 32) cpu.data[index] = value & 0xff;
    else if (index === 32) cpu.data[SREG] = value & 0xff;
    else if (index === 33) {
      cpu.data[SPL] = value & 0xff;
      cpu.data[SPH] = (value >> 8) & 0xff;
    } else if (index === 34) {
      cpu.pc = (value >>> 1) % this.mcu.breakpointWords.length;
      this.mcu.resumeAt = -1;
    } else throw new RangeError(`no register ${index}`);
  }

  readMemory(space: MemorySpace, addr: number, len: number): Uint8Array {
    const memory = this.memory(space);
    checkRange(space, memory.length, addr, len);
    return memory.slice(addr, addr + len);
  }

  writeMemory(space: MemorySpace, addr: number, bytes: Uint8Array): void {
    const memory = this.memory(space);
    checkRange(space, memory.length, addr, bytes.length);
    memory.set(bytes, addr);
  }

  setBreakpoint(addr: number): void {
    const word = this.word(addr);
    if (this.mcu.breakpointWords[word] === 1) return;
    this.mcu.breakpointWords[word] = 1;
    this.mcu.breakpointCount++;
  }

  clearBreakpoint(addr: number): void {
    const word = this.word(addr);
    if (this.mcu.breakpointWords[word] === 0) return;
    this.mcu.breakpointWords[word] = 0;
    this.mcu.breakpointCount--;
  }

  breakpoints(): readonly number[] {
    const out: number[] = [];
    const words = this.mcu.breakpointWords;
    if (this.mcu.breakpointCount > 0) for (let w = 0; w < words.length; w++) if (words[w] === 1) out.push(w * 2);
    return out;
  }

  step(): RunResult {
    return this.mcu.stepInstruction();
  }

  instructionAt(addr: number): { size: number; isCall: boolean } {
    const progMem = this.mcu.core.cpu.progMem;
    const word = addr >>> 1;
    if (word >= progMem.length) return { size: 2, isCall: false };
    const op = progMem[word];
    return { size: isTwoWord(op) ? 4 : 2, isCall: isCallOpcode(op) };
  }

  private memory(space: MemorySpace): Uint8Array {
    const cpu = this.mcu.core.cpu;
    if (space === 'flash') return cpu.progBytes;
    if (space === 'data') return cpu.data;
    return this.mcu.eepromBytes;
  }

  private word(addr: number): number {
    if (!Number.isInteger(addr) || addr < 0 || addr >= this.mcu.breakpointWords.length * 2 || addr % 2 !== 0) {
      const limit = (this.mcu.breakpointWords.length * 2).toString(16);
      throw new RangeError(`breakpoint address 0x${Number(addr).toString(16)} is not an even flash address below 0x${limit}`);
    }
    return addr >>> 1;
  }
}

function checkRange(space: MemorySpace, size: number, addr: number, len: number): void {
  if (!Number.isInteger(addr) || !Number.isInteger(len) || addr < 0 || len < 0 || addr + len > size) {
    throw new RangeError(`${space} [0x${Number(addr).toString(16)}, +${len}) is outside 0..0x${size.toString(16)}`);
  }
}
