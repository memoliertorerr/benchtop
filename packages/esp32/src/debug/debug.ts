/**
 * The ESP32's debugger view (BT73) through BT24's `McuDebug`: one core at a time — the APP_CPU,
 * where Arduino-ESP32 runs `setup()`/`loop()`, unless the PRO_CPU stopped at a breakpoint last
 * (`Esp32Soc.debugCpu`; the last register, `cpu`, says which: 0 PRO, 1 APP). Registers pc, a0–a15
 * (the current window: a2 is a function's first argument once its ENTRY has run), sar, ps,
 * windowbase, windowstart, lbeg, lend, lcount, as GDB names them. Memory `data` is that core's
 * address space read without side effects (`SocBus.peek8`: no cache tags, no Problems;
 * peripherals read 0); writes reach RAM only. `flash` is the flash chip's bytes from offset 0.
 * Breakpoints are the adapter's set, which every SoC it builds hands both cores (a core runs a
 * checked loop while it isn't empty).
 */

import type { McuDebug, MemorySpace, RegisterInfo, RunResult } from '@benchtop/core';
import type { Esp32Soc } from '../soc/soc.ts';
import { D_LEN, D_OP, DESCRIPTOR_SIZE, decode } from '../xtensa/decode.ts';
import { OP } from '../xtensa/isa.ts';

const NAMES = ['pc', ...Array.from({ length: 16 }, (_, i) => `a${i}`), 'sar', 'ps', 'windowbase', 'windowstart', 'lbeg', 'lend', 'lcount', 'cpu'];
const REGISTERS: readonly RegisterInfo[] = Object.freeze(NAMES.map((name): RegisterInfo => ({ name, bits: 32 })));
const PC = 0;
/** a1 is the stack pointer in both ABIs. */
const SP = 2;

const CALLS: ReadonlySet<number> = new Set([OP.CALL0, OP.CALL4, OP.CALL8, OP.CALL12, OP.CALLX0, OP.CALLX4, OP.CALLX8, OP.CALLX12]);

export class Esp32Debug implements McuDebug {
  readonly pcIndex = PC;
  readonly spIndex = SP;
  private readonly soc: () => Esp32Soc;
  private readonly set: Set<number>;
  private readonly d = new Int32Array(DESCRIPTOR_SIZE);

  /** `soc`: the adapter's current SoC (a new one after every reset); `breakpoints`: the adapter's set. */
  constructor(soc: () => Esp32Soc, breakpoints: Set<number>) {
    this.soc = soc;
    this.set = breakpoints;
  }

  registers(): readonly RegisterInfo[] {
    return REGISTERS;
  }

  readRegisters(out: Uint32Array): void {
    const soc = this.soc();
    const core = soc.cores[soc.debugCpu];
    out[24] = soc.debugCpu;
    out[0] = core.pc >>> 0;
    for (let i = 0; i < 16; i++) out[1 + i] = core.reg(i) >>> 0;
    out[17] = core.sar >>> 0;
    out[18] = core.ps >>> 0;
    out[19] = core.windowBase >>> 0;
    out[20] = core.windowStart >>> 0;
    out[21] = core.lbeg >>> 0;
    out[22] = core.lend >>> 0;
    out[23] = core.lcount >>> 0;
  }

  writeRegister(index: number, value: number): void {
    const soc = this.soc();
    const core = soc.cores[soc.debugCpu];
    if (index === PC) core.pc = value >>> 0;
    else if (index >= 1 && index <= 16) core.setReg(index - 1, value >>> 0);
    else if (index === 17) core.sar = value & 0x3f;
  }

  readMemory(space: MemorySpace, addr: number, len: number): Uint8Array {
    const soc = this.soc();
    const out = new Uint8Array(Math.max(0, len));
    if (space === 'data') for (let i = 0; i < out.length; i++) out[i] = soc.buses[soc.debugCpu].peek8(addr + i);
    else if (space === 'flash') {
      const flash = soc.memory.flash;
      for (let i = 0; i < out.length; i++) out[i] = addr + i < flash.length ? flash[addr + i] : 0;
    }
    return out;
  }

  writeMemory(space: MemorySpace, addr: number, bytes: Uint8Array): void {
    if (space !== 'data') return;
    const soc = this.soc();
    const bus = soc.buses[soc.debugCpu];
    for (let i = 0; i < bytes.length; i++) bus.poke8(addr + i, bytes[i]);
  }

  setBreakpoint(addr: number): void {
    this.set.add(addr >>> 0);
  }

  clearBreakpoint(addr: number): void {
    this.set.delete(addr >>> 0);
  }

  breakpoints(): readonly number[] {
    return [...this.set].sort((a, b) => a - b);
  }

  step(): RunResult {
    return this.soc().stepCore();
  }

  /** 2 or 3 bytes; a call is CALL0/4/8/12 or CALLX0/4/8/12. */
  instructionAt(addr: number): { size: number; isCall: boolean } {
    const soc = this.soc();
    const bus = soc.buses[soc.debugCpu];
    decode(bus.peek8(addr), bus.peek8(addr + 1), bus.peek8(addr + 2), this.d);
    return { size: this.d[D_LEN], isCall: CALLS.has(this.d[D_OP]) };
  }
}
