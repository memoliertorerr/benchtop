/**
 * RiscvBareMachine (tests only): a RISC-V core with nothing around it but 256 KB of RAM at
 * 0x80000000 and a few MMIO words at 0x10000000 (fixtures/riscv/programs/harness.inc names them):
 *   +0  write8: a console character      +4  write32: exit with that code (the run stops)
 *   +8  write32: the interrupt lines (mip bits MSI 3, MTI 7, MEI 11) to drive from now on
 * Everything else is unmapped: accesses raise RiscvBusError (access faults). It loads a
 * fixtures/riscv/programs/<name>.bin at 0x80000000 and runs from there until the exit write,
 * an EBREAK when `ebreakHalts`, a fault, or a cycle cap. RAM pages are predecodable; a store
 * into a page the core predecoded drops it (invalidateCode).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { type RiscvBus, RiscvBusError, type RiscvCodeBus } from '../bus.ts';
import type { RiscvCsrHook } from '../csr.ts';
import { HALT, RiscvCore, type RiscvCoreOptions } from '../cpu.ts';

export const RAM_BASE = 0x80000000;
export const RAM_SIZE = 256 * 1024;
export const IN_BASE = 0x80010000;
export const OUT_BASE = 0x80020000;
export const MMIO_BASE = 0x10000000;
export const PROGRAMS_DIR = join(REPO_ROOT, 'fixtures', 'riscv', 'programs');

class BareBus implements RiscvBus, RiscvCodeBus {
  readonly ram = new Uint8Array(RAM_SIZE);
  readonly view = new DataView(this.ram.buffer);
  /** RAM pages the core predecoded (a store there drops the page). */
  readonly codePages = new Uint8Array(RAM_SIZE >>> 12);
  core: RiscvCore | null = null;
  console = '';
  exitCode: number | null = null;

  private ramOffset(addr: number, size: number, kind: string): number {
    const offset = (addr - RAM_BASE) >>> 0;
    if (offset + size > RAM_SIZE) throw new RiscvBusError(kind, addr);
    return offset;
  }

  read8(addr: number): number {
    return this.ram[this.ramOffset(addr, 1, 'load')];
  }
  read16(addr: number): number {
    return this.view.getUint16(this.ramOffset(addr, 2, 'load'), true);
  }
  read32(addr: number): number {
    if (addr >>> 0 >= MMIO_BASE && addr >>> 0 < MMIO_BASE + 16) return 0;
    return this.view.getUint32(this.ramOffset(addr, 4, 'load'), true);
  }
  write8(addr: number, value: number): void {
    if (addr >>> 0 === MMIO_BASE) {
      this.console += String.fromCharCode(value & 0xff);
      return;
    }
    const offset = this.ramOffset(addr, 1, 'store');
    this.ram[offset] = value;
    this.stored(offset, 1);
  }
  write16(addr: number, value: number): void {
    const offset = this.ramOffset(addr, 2, 'store');
    this.view.setUint16(offset, value, true);
    this.stored(offset, 2);
  }
  write32(addr: number, value: number): void {
    const a = addr >>> 0;
    if (a === MMIO_BASE + 4) {
      this.exitCode = value >>> 0;
      this.core?.requestStop();
      return;
    }
    if (a === MMIO_BASE + 8) {
      for (const irq of [3, 7, 11]) this.core?.setInterruptLine(irq, (value & (1 << irq)) !== 0);
      return;
    }
    const offset = this.ramOffset(a, 4, 'store');
    this.view.setUint32(offset, value >>> 0, true);
    this.stored(offset, 4);
  }
  fetch16(addr: number): number {
    return this.view.getUint16(this.ramOffset(addr, 2, 'fetch'), true);
  }
  codePage(address: number): boolean {
    const offset = (address - RAM_BASE) >>> 0;
    if (offset >= RAM_SIZE) return false;
    this.codePages[offset >>> 12] = 1;
    return true;
  }
  codeHalf(address: number): number {
    return this.view.getUint16((address - RAM_BASE) >>> 0, true);
  }

  private stored(offset: number, size: number): void {
    if (this.codePages[offset >>> 12] !== 0) this.core?.invalidateCode(RAM_BASE + offset, size);
  }
}

export interface BareOptions extends RiscvCoreOptions {
  /** EBREAK halts the machine instead of trapping. */
  ebreakHalts?: boolean;
  csrHook?: RiscvCsrHook;
}

/** A program's symbols from its committed listing: name → address. */
export function programSymbols(name: string): Map<string, number> {
  const symbols = new Map<string, number>();
  for (const m of readFileSync(join(PROGRAMS_DIR, `${name}.lst`), 'utf8').matchAll(/^([0-9a-f]{8}) <([^>]+)>:$/gm)) symbols.set(m[2], Number.parseInt(m[1], 16));
  return symbols;
}

export class RiscvBareMachine {
  readonly bus = new BareBus();
  readonly core: RiscvCore;

  constructor(options: BareOptions = {}) {
    this.core = new RiscvCore(this.bus, { resetPc: RAM_BASE, ...options });
    this.bus.core = this.core;
    if (options.ebreakHalts) this.core.ebreakHook = () => true;
    if (options.csrHook !== undefined) this.core.csrHook = options.csrHook;
  }

  /** Copies bytes into RAM at `address`. */
  load(bytes: Uint8Array, address = RAM_BASE): this {
    this.bus.ram.set(bytes, (address - RAM_BASE) >>> 0);
    return this;
  }

  loadProgram(name: string): this {
    return this.load(readFileSync(join(PROGRAMS_DIR, `${name}.bin`)));
  }

  /** The halfword in RAM at `address`. */
  half(address: number): number {
    return this.bus.view.getUint16((address - RAM_BASE) >>> 0, true);
  }

  /** Little-endian words into RAM at `address`. */
  writeWords(address: number, words: ArrayLike<number>): this {
    for (let i = 0; i < words.length; i++) this.bus.view.setUint32((address - RAM_BASE + 4 * i) >>> 0, words[i] >>> 0, true);
    return this;
  }

  readWords(address: number, count: number): number[] {
    return Array.from({ length: count }, (_, i) => this.bus.view.getUint32((address - RAM_BASE + 4 * i) >>> 0, true));
  }

  get exitCode(): number | null {
    return this.bus.exitCode;
  }

  get console(): string {
    return this.bus.console;
  }

  /**
   * Runs until the exit write, a halt or `maxCycles`; throws on a model fault or the cap.
   * `onWait` runs whenever a slice ends with the core asleep in WFI (to raise an interrupt).
   */
  run(maxCycles = 5_000_000, onWait?: () => void): this {
    const core = this.core;
    while (this.bus.exitCode === null && core.halt === HALT.RUNNING && core.cycles < maxCycles) {
      core.run(Math.min(onWait === undefined ? 100_000 : 1000, maxCycles - core.cycles));
      if (core.waiting && onWait !== undefined) onWait();
    }
    if (core.halt === HALT.FAULT) throw new Error(`core fault: ${core.haltReason} at 0x${core.pc.toString(16)}`);
    if (this.bus.exitCode === null && core.halt === HALT.RUNNING) throw new Error(`cycle cap ${maxCycles} at pc 0x${core.pc.toString(16)}`);
    return this;
  }
}
