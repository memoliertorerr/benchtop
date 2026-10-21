/**
 * Peripheral dispatch for 0x3FF00000–0x3FF7FFFF (TRM v5.8 Table 3.3-6), in 4 KB blocks. Each
 * block is a Peripheral; until a real model replaces it, a RegisterFile — header reset values
 * (reg-defaults.generated.ts) and plain read-back — answers, and every access to it is an
 * unknown-register access: the first 32 distinct addresses become `esp32-unimplemented-register`
 * Problems (with the value, R/W and the PC), and a counter keeps the total. Nothing throws.
 */

import { REG_DEFAULT_PAIRS } from './reg-defaults.generated.ts';

export const PERIPH_BASE = 0x3ff00000;
export const PERIPH_END = 0x3ff80000;
export const BLOCK_COUNT = (PERIPH_END - PERIPH_BASE) >>> 12;
/** AHB alias of 0x3FF40000–0x3FF7FFFF (what IDF uses for UART and I2C FIFOs). */
export const AHB_BASE = 0x60000000;
export const AHB_SIZE = 0x40000;
export const AHB_TARGET = 0x3ff40000;

/** A peripheral block: word registers by byte offset in its 4 KB. */
export interface Peripheral {
  read32(offset: number): number;
  write32(offset: number, value: number): void;
  /** For a partly modeled block: the offsets it models (accesses elsewhere are logged). */
  implements?(offset: number): boolean;
  /** A chip reset (BT33): back to the reset state. `rtcDomain`: the RTC domain resets too. */
  systemReset?(rtcDomain: boolean): void;
}

/** Block names, from soc.h's DR_REG_* list and TRM Table 3.3-6. */
const NAMED_BLOCKS: [number, string][] = [
  [0x3ff00000, 'DPORT'], [0x3ff01000, 'AES'], [0x3ff02000, 'RSA'], [0x3ff03000, 'SHA'], [0x3ff04000, 'SECURE_BOOT'],
  [0x3ff10000, 'MMU_TABLE'], [0x3ff11000, 'MMU_TABLE'], [0x3ff12000, 'MMU_TABLE'], [0x3ff13000, 'MMU_TABLE'],
  [0x3ff1f000, 'PID'], [0x3ff40000, 'UART0'], [0x3ff42000, 'SPI1'], [0x3ff43000, 'SPI0'], [0x3ff44000, 'GPIO'],
  [0x3ff45000, 'FE2'], [0x3ff46000, 'FE'], [0x3ff47000, 'FRC_TIMER'], [0x3ff48000, 'RTC_CNTL'], [0x3ff49000, 'IO_MUX'],
  [0x3ff4b000, 'HINF'], [0x3ff4c000, 'UHCI1'], [0x3ff4f000, 'I2S0'], [0x3ff50000, 'UART1'], [0x3ff51000, 'BT'],
  [0x3ff53000, 'I2C0'], [0x3ff54000, 'UHCI0'], [0x3ff55000, 'SLCHOST'], [0x3ff56000, 'RMT'], [0x3ff57000, 'PCNT'],
  [0x3ff58000, 'SLC'], [0x3ff59000, 'LEDC'], [0x3ff5a000, 'EFUSE'], [0x3ff5b000, 'SPI_ENCRYPT'], [0x3ff5c000, 'NRX'],
  [0x3ff5d000, 'BB'], [0x3ff5e000, 'PWM0'], [0x3ff5f000, 'TIMG0'], [0x3ff60000, 'TIMG1'], [0x3ff61000, 'RTCMEM0'],
  [0x3ff62000, 'RTCMEM1'], [0x3ff63000, 'RTCMEM2'], [0x3ff64000, 'SPI2'], [0x3ff65000, 'SPI3'], [0x3ff66000, 'SYSCON'],
  [0x3ff67000, 'I2C1'], [0x3ff68000, 'SDMMC'], [0x3ff69000, 'EMAC'], [0x3ff6a000, 'EMAC'], [0x3ff6b000, 'CAN'],
  [0x3ff6c000, 'PWM1'], [0x3ff6d000, 'I2S1'], [0x3ff6e000, 'UART2'], [0x3ff75000, 'RNG'],
];

/** The name of the block at `address` ("RESERVED" where the TRM lists none). */
export function blockName(address: number): string {
  const base = (address & ~0xfff) >>> 0;
  for (const [b, name] of NAMED_BLOCKS) if (b === base) return name;
  return 'RESERVED';
}

const hex = (v: number): string => `0x${(v >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;

/** A Problem the SoC reports (BT34's board model forwards these to ctx.report). */
export interface SocProblem {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  address: number;
}

/** Problems deduplicated per (code, address), at most 32 per code; counters keep the totals. */
export class ProblemLog {
  static readonly LIMIT = 32;
  readonly problems: SocProblem[] = [];
  listener: ((problem: SocProblem) => void) | null = null;
  /** Every reported occurrence, per code (duplicates and those past the limit included). */
  readonly totals = new Map<string, number>();
  private readonly seen = new Map<string, Set<number>>();

  /**
   * Counts an occurrence of `code` at `address`; true when it should become a new Problem (then
   * call add). Split in two so callers build a message only for new ones — no allocation for
   * the repeats, which can come from a firmware loop polling a register.
   */
  admit(code: string, address: number): boolean {
    this.totals.set(code, (this.totals.get(code) ?? 0) + 1);
    let seen = this.seen.get(code);
    if (seen === undefined) {
      seen = new Set();
      this.seen.set(code, seen);
    }
    if (seen.has(address) || seen.size >= ProblemLog.LIMIT) return false;
    seen.add(address);
    return true;
  }

  add(severity: SocProblem['severity'], code: string, address: number, message: string): void {
    const problem: SocProblem = { severity, code, message, address: address >>> 0 };
    this.problems.push(problem);
    this.listener?.(problem);
  }

  /** admit + add, for callers whose message is cheap or rare. */
  report(severity: SocProblem['severity'], code: string, address: number, message: string): void {
    if (this.admit(code, address)) this.add(severity, code, address, message);
  }

  count(code: string): number {
    return this.problems.filter((p) => p.code === code).length;
  }
}

let defaults: Map<number, number> | undefined;

/** Header reset value of the register at `address` (0 where the headers give none). */
export function registerDefault(address: number): number {
  if (defaults === undefined) {
    defaults = new Map();
    for (let i = 0; i < REG_DEFAULT_PAIRS.length; i += 2) defaults.set(REG_DEFAULT_PAIRS[i], REG_DEFAULT_PAIRS[i + 1]);
  }
  return defaults.get(address >>> 0) ?? 0;
}

/** A 4 KB block of plain registers: reset values from the headers, writes read back. */
export class RegisterFile implements Peripheral {
  readonly regs = new Uint32Array(1024);
  readonly base: number;

  constructor(base: number) {
    this.base = base;
    this.reset();
  }

  reset(): void {
    for (let i = 0; i < 1024; i++) this.regs[i] = registerDefault(this.base + i * 4);
  }

  /** A chip reset. Models with more state override this (never `reset`, which the constructor calls). */
  systemReset(_rtcDomain: boolean): void {
    this.reset();
  }

  read32(offset: number): number {
    return this.regs[offset >>> 2];
  }

  write32(offset: number, value: number): void {
    this.regs[offset >>> 2] = value;
  }
}

export const CODE_UNIMPLEMENTED = 'esp32-unimplemented-register';

/** The peripheral space: one Peripheral per 4 KB block, and which blocks are modeled. */
export class PeripheralMap {
  readonly blocks: Peripheral[] = [];
  /** 1 for a block with a real model; accesses to the others are logged as unknown. */
  readonly modeled = new Uint8Array(BLOCK_COUNT);
  readonly problems: ProblemLog;

  constructor(problems: ProblemLog) {
    this.problems = problems;
    for (let i = 0; i < BLOCK_COUNT; i++) this.blocks.push(new RegisterFile(PERIPH_BASE + i * 0x1000));
  }

  /** Puts a model in charge of the 4 KB block at `base`. */
  register(base: number, peripheral: Peripheral): void {
    const index = (base - PERIPH_BASE) >>> 12;
    this.blocks[index] = peripheral;
    this.modeled[index] = 1;
  }

  /** A chip reset: every block (each model once) back to its reset state. */
  systemReset(rtcDomain: boolean): void {
    const done = new Set<Peripheral>();
    for (const block of this.blocks) {
      if (done.has(block)) continue;
      done.add(block);
      block.systemReset?.(rtcDomain);
    }
  }

  /** The RegisterFile behind an unmodeled block (tests and later steps read its state). */
  registers(base: number): RegisterFile {
    const block = this.blocks[(base - PERIPH_BASE) >>> 12];
    if (!(block instanceof RegisterFile)) throw new Error(`0x${base.toString(16)} is modeled`);
    return block;
  }

  /** A word read at a word-aligned peripheral address; `pc` names the instruction. */
  read32(address: number, pc: number): number {
    const index = (address - PERIPH_BASE) >>> 12;
    const block = this.blocks[index];
    const value = block.read32(address & 0xffc) >>> 0;
    if (this.modeled[index] === 0 || (block.implements !== undefined && !block.implements(address & 0xffc))) this.unknown('read', address, value, pc);
    return value;
  }

  write32(address: number, value: number, pc: number): void {
    const index = (address - PERIPH_BASE) >>> 12;
    const block = this.blocks[index];
    block.write32(address & 0xffc, value >>> 0);
    if (this.modeled[index] === 0 || (block.implements !== undefined && !block.implements(address & 0xffc))) this.unknown('write', address, value, pc);
  }

  private unknown(access: 'read' | 'write', address: number, value: number, pc: number): void {
    if (!this.problems.admit(CODE_UNIMPLEMENTED, address)) return;
    const offset = `0x${(address & 0xfff).toString(16).toUpperCase().padStart(3, '0')}`;
    this.problems.add('warning', CODE_UNIMPLEMENTED, address, `${access} ${hex(address)} (${blockName(address)}+${offset}) = ${hex(value)} at PC ${hex(pc)}`);
  }
}
