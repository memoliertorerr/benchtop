/**
 * The ESP32-C3's debugger view (BT93): its one RISC-V core through BT24's `McuDebug`, as the
 * RP2350's hart 0 (@benchtop/rp2350's debug.ts). Registers are x0–x31 by their ABI names and pc,
 * then mstatus, mepc and mcause (read-only). Memory `data` is the core's address space read
 * without side effects (`Esp32c3Soc.peek`: memory, the flash through the MMU, a register block's
 * stored value); writes reach SRAM and RTC fast memory only. `flash` is the flash chip's bytes
 * from offset 0. Breakpoints live in the SoC, which runs the core one instruction at a time while
 * it has any. The view follows the Mcu's current SoC (a reset builds a new one).
 */

import type { McuDebug, MemorySpace, RegisterInfo, RunResult } from '@benchtop/core';
import { D_LEN, D_OP, D_RD, DESCRIPTOR_SIZE, decode, OP, RV32IMAC } from '@benchtop/riscv';
import type { Esp32c3Soc } from './soc/soc.ts';

const ABI = ['zero', 'ra', 'sp', 'gp', 'tp', 't0', 't1', 't2', 's0', 's1', 'a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10', 's11', 't3', 't4', 't5', 't6'];

const REGISTERS: readonly RegisterInfo[] = Object.freeze([
  ...ABI.map((name): RegisterInfo => ({ name, bits: 32 })),
  { name: 'pc', bits: 32 },
  { name: 'mstatus', bits: 32 },
  { name: 'mepc', bits: 32 },
  { name: 'mcause', bits: 32 },
]);

const PC = 32;
const SP = 2;

export class Esp32c3Debug implements McuDebug {
  readonly pcIndex = PC;
  readonly spIndex = SP;
  private readonly soc: () => Esp32c3Soc;
  private readonly d = new Int32Array(DESCRIPTOR_SIZE);

  constructor(soc: () => Esp32c3Soc) {
    this.soc = soc;
  }

  registers(): readonly RegisterInfo[] {
    return REGISTERS;
  }

  readRegisters(out: Uint32Array): void {
    const core = this.soc().core;
    for (let i = 0; i < 32; i++) out[i] = core.x[i] >>> 0;
    out[PC] = core.pc >>> 0;
    out[33] = core.mstatus >>> 0;
    out[34] = core.mepc >>> 0;
    out[35] = core.mcause >>> 0;
  }

  writeRegister(index: number, value: number): void {
    const core = this.soc().core;
    if (index > 0 && index < 32) core.x[index] = value | 0;
    else if (index === PC) core.pc = value >>> 0;
  }

  readMemory(space: MemorySpace, addr: number, len: number): Uint8Array {
    const soc = this.soc();
    const out = new Uint8Array(Math.max(0, len));
    if (space === 'data') for (let i = 0; i < out.length; i++) out[i] = soc.peek((addr + i) >>> 0);
    else if (space === 'flash') for (let i = 0; i < out.length; i++) out[i] = addr + i < soc.flash.data.length ? soc.flash.data[addr + i] : 0;
    return out;
  }

  writeMemory(space: MemorySpace, addr: number, bytes: Uint8Array): void {
    if (space !== 'data') return;
    const soc = this.soc();
    for (let i = 0; i < bytes.length; i++) soc.poke((addr + i) >>> 0, bytes[i]);
  }

  setBreakpoint(addr: number): void {
    this.soc().breakpoints.add(addr >>> 0);
  }

  clearBreakpoint(addr: number): void {
    this.soc().breakpoints.delete(addr >>> 0);
  }

  breakpoints(): readonly number[] {
    return [...this.soc().breakpoints].sort((a, b) => a - b);
  }

  step(): RunResult {
    const halt = this.soc().step();
    return halt === null ? { reason: 'target' } : { reason: 'halted', detail: halt };
  }

  /** 2 or 4 bytes; a call is a JAL/JALR (compressed too) that links ra or t0. */
  instructionAt(addr: number): { size: number; isCall: boolean } {
    const soc = this.soc();
    const lo = soc.peek(addr) | (soc.peek(addr + 1) << 8);
    const word = (lo & 3) === 3 ? (lo | (soc.peek(addr + 2) << 16) | (soc.peek(addr + 3) << 24)) >>> 0 : lo;
    decode(word, RV32IMAC, this.d);
    const op = this.d[D_OP];
    const rd = this.d[D_RD];
    return { size: this.d[D_LEN] || ((lo & 3) === 3 ? 4 : 2), isCall: (op === OP.JAL || op === OP.JALR) && (rd === 1 || rd === 5) };
  }
}
