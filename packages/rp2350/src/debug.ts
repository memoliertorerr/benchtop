/**
 * The RP2350's debugger view (BT71): hart 0 — where `setup()`/`loop()` run — through BT24's
 * `McuDebug`. Registers are x0–x31 by their ABI names (zero, ra, sp, …, t6) and pc, then mstatus,
 * mepc and mcause (read-only). Memory `data` is hart 0's address space as the bus sees it, read
 * without side effects (`Rp2350Soc.peek`: memory, else a register block's stored value); writes
 * reach RAM only. `flash` is the flash chip's bytes from offset 0. Breakpoints live in the SoC,
 * which runs hart 0 instruction by instruction while it has any.
 */

import type { McuDebug, MemorySpace, RegisterInfo, RunResult } from '@benchtop/core';
import { D_LEN, D_OP, D_RD, DESCRIPTOR_SIZE, decode, HAZARD3, OP } from '@benchtop/riscv';
import type { Rp2350Soc } from './soc.ts';

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
/** The flash chip's size (bytes the `flash` space reaches). */
const FLASH_BYTES = 4 * 1024 * 1024;

export class Rp2350Debug implements McuDebug {
  readonly pcIndex = PC;
  readonly spIndex = SP;
  private readonly soc: Rp2350Soc;
  private readonly d = new Int32Array(DESCRIPTOR_SIZE);

  constructor(soc: Rp2350Soc) {
    this.soc = soc;
  }

  registers(): readonly RegisterInfo[] {
    return REGISTERS;
  }

  readRegisters(out: Uint32Array): void {
    const hart = this.soc.harts[0];
    for (let i = 0; i < 32; i++) out[i] = hart.x[i] >>> 0;
    out[PC] = hart.pc >>> 0;
    out[33] = hart.mstatus >>> 0;
    out[34] = hart.mepc >>> 0;
    out[35] = hart.mcause >>> 0;
  }

  writeRegister(index: number, value: number): void {
    const hart = this.soc.harts[0];
    if (index > 0 && index < 32) hart.x[index] = value | 0;
    else if (index === PC) hart.pc = value >>> 0;
  }

  readMemory(space: MemorySpace, addr: number, len: number): Uint8Array {
    const out = new Uint8Array(Math.max(0, len));
    if (space === 'data') for (let i = 0; i < out.length; i++) out[i] = this.soc.peek((addr + i) >>> 0);
    else if (space === 'flash') for (let i = 0; i < out.length; i++) out[i] = addr + i < FLASH_BYTES ? this.soc.flash[addr + i] : 0;
    return out;
  }

  writeMemory(space: MemorySpace, addr: number, bytes: Uint8Array): void {
    if (space !== 'data') return;
    for (let i = 0; i < bytes.length; i++) this.soc.poke((addr + i) >>> 0, bytes[i]);
  }

  setBreakpoint(addr: number): void {
    this.soc.breakpoints.add(addr >>> 0);
  }

  clearBreakpoint(addr: number): void {
    this.soc.breakpoints.delete(addr >>> 0);
  }

  breakpoints(): readonly number[] {
    return [...this.soc.breakpoints].sort((a, b) => a - b);
  }

  step(): RunResult {
    const halt = this.soc.stepHart0();
    return halt === null ? { reason: 'target' } : { reason: 'halted', detail: halt };
  }

  /** 2 or 4 bytes; a call is a JAL/JALR (compressed too) that links ra or t0. */
  instructionAt(addr: number): { size: number; isCall: boolean } {
    const lo = this.soc.peek(addr) | (this.soc.peek(addr + 1) << 8);
    const word = (lo & 3) === 3 ? (lo | (this.soc.peek(addr + 2) << 16) | (this.soc.peek(addr + 3) << 24)) >>> 0 : lo;
    decode(word, HAZARD3, this.d);
    const op = this.d[D_OP];
    const rd = this.d[D_RD];
    return { size: this.d[D_LEN] || ((lo & 3) === 3 ? 4 : 2), isCall: (op === OP.JAL || op === OP.JALR) && (rd === 1 || rd === 5) };
  }
}

/** A board without its bootrom has no SoC: a view with nothing in it (it never stops). */
export class NoSocDebug implements McuDebug {
  readonly pcIndex = PC;
  readonly spIndex = SP;

  registers(): readonly RegisterInfo[] {
    return REGISTERS;
  }

  readRegisters(out: Uint32Array): void {
    out.fill(0);
  }

  writeRegister(): void {}

  readMemory(_space: MemorySpace, _addr: number, len: number): Uint8Array {
    return new Uint8Array(Math.max(0, len));
  }

  writeMemory(): void {}

  setBreakpoint(): void {}

  clearBreakpoint(): void {}

  breakpoints(): readonly number[] {
    return [];
  }

  step(): RunResult {
    return { reason: 'halted', detail: 'the RP2350 bootrom is not installed' };
  }

  instructionAt(): { size: number; isCall: boolean } {
    return { size: 4, isCall: false };
  }
}
