/**
 * The RP2040's debugger view (BT72): core 0 — where `setup()`/`loop()` run — on rp2040js's
 * Cortex-M0+, through BT24's `McuDebug`. Registers r0–r12, sp, lr, pc and xpsr as GDB names
 * them. Memory `data` is core 0's address space read without side effects: our bootrom, flash
 * (every XIP alias), SRAM and the USB DPRAM from their arrays; peripheral registers read 0
 * (rp2040js has no side-effect-free path into them). Writes reach SRAM and DPRAM. `flash` is the
 * flash chip's bytes from offset 0. Breakpoints and steps live in the adapter's run loop
 * (rp2040-mcu.ts), which calls `executeInstruction` itself.
 */

import type { McuDebug, MemorySpace, RegisterInfo, RunResult } from '@benchtop/core';
import type { Rp2040Mcu } from './rp2040-mcu.ts';

const NAMES = ['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10', 'r11', 'r12', 'sp', 'lr', 'pc', 'xpsr'];
const REGISTERS: readonly RegisterInfo[] = Object.freeze(NAMES.map((name): RegisterInfo => ({ name, bits: 32 })));
const PC = 15;
const SP = 13;
const XPSR = 16;

const SRAM_BASE = 0x20000000;
const DPRAM_BASE = 0x50100000;

/** A 32-bit Thumb-2 encoding starts with 0b11101, 0b11110 or 0b11111 in its top five bits. */
export function isWideThumb(halfword: number): boolean {
  const top = halfword >>> 11;
  return top === 0b11101 || top === 0b11110 || top === 0b11111;
}

/** BL (32-bit: 0xF000-prefix then 0b11x1 in the second half's top bits) or BLX <reg>. */
export function isThumbCall(first: number, second: number): boolean {
  if (first >>> 11 === 0b11110) return (second & 0xd000) === 0xd000;
  return (first & 0xff87) === 0x4780;
}

export class Rp2040Debug implements McuDebug {
  readonly pcIndex = PC;
  readonly spIndex = SP;
  private readonly mcu: Rp2040Mcu;

  constructor(mcu: Rp2040Mcu) {
    this.mcu = mcu;
  }

  registers(): readonly RegisterInfo[] {
    return REGISTERS;
  }

  readRegisters(out: Uint32Array): void {
    const core = this.mcu.rp.core;
    for (let i = 0; i < 15; i++) out[i] = core.registers[i] >>> 0;
    out[PC] = (core.PC & ~1) >>> 0;
    out[XPSR] = core.xPSR >>> 0;
  }

  writeRegister(index: number, value: number): void {
    const core = this.mcu.rp.core;
    if (index >= 0 && index < 15) core.registers[index] = value >>> 0;
    else if (index === PC) core.PC = (value & ~1) >>> 0;
    else if (index === XPSR) core.xPSR = value >>> 0;
  }

  /** One byte of core 0's address space, without side effects (0 where no array backs it). */
  peek(addr: number): number {
    const rp = this.mcu.rp;
    addr >>>= 0;
    if (addr < rp.bootrom.length * 4) return (rp.bootrom[addr >>> 2] >>> ((addr & 3) * 8)) & 0xff;
    if (addr >>> 26 === 0x10000000 >>> 26) {
      const o = addr & 0xffffff;
      return o < rp.flash.length ? rp.flash[o] : 0;
    }
    if (addr >= SRAM_BASE && addr < SRAM_BASE + rp.sram.length) return rp.sram[addr - SRAM_BASE];
    if (addr >= DPRAM_BASE && addr < DPRAM_BASE + rp.usbDPRAM.length) return rp.usbDPRAM[addr - DPRAM_BASE];
    return 0;
  }

  readMemory(space: MemorySpace, addr: number, len: number): Uint8Array {
    const out = new Uint8Array(Math.max(0, len));
    const flash = this.mcu.rp.flash;
    if (space === 'data') for (let i = 0; i < out.length; i++) out[i] = this.peek(addr + i);
    else if (space === 'flash') for (let i = 0; i < out.length; i++) out[i] = addr + i < flash.length ? flash[addr + i] : 0;
    return out;
  }

  writeMemory(space: MemorySpace, addr: number, bytes: Uint8Array): void {
    if (space !== 'data') return;
    const rp = this.mcu.rp;
    for (let i = 0; i < bytes.length; i++) {
      const a = (addr + i) >>> 0;
      if (a >= SRAM_BASE && a < SRAM_BASE + rp.sram.length) rp.sram[a - SRAM_BASE] = bytes[i];
      else if (a >= DPRAM_BASE && a < DPRAM_BASE + rp.usbDPRAM.length) rp.usbDPRAM[a - DPRAM_BASE] = bytes[i];
    }
  }

  setBreakpoint(addr: number): void {
    this.mcu.breakpoints.add((addr & ~1) >>> 0);
  }

  clearBreakpoint(addr: number): void {
    this.mcu.breakpoints.delete((addr & ~1) >>> 0);
  }

  breakpoints(): readonly number[] {
    return [...this.mcu.breakpoints].sort((a, b) => a - b);
  }

  step(): RunResult {
    return this.mcu.stepCore0();
  }

  instructionAt(addr: number): { size: number; isCall: boolean } {
    const first = this.peek(addr) | (this.peek(addr + 1) << 8);
    const wide = isWideThumb(first);
    const second = wide ? this.peek(addr + 2) | (this.peek(addr + 3) << 8) : 0;
    return { size: wide ? 4 : 2, isCall: isThumbCall(first, second) };
  }
}
