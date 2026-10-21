/**
 * A peripheral block on the RP2350's APB/AHB (BT65): 4 KB of 32-bit registers at its base, with
 * the atomic aliases every such block has (datasheet §2.1.3: +0x1000 XOR, +0x2000 set, +0x3000
 * clear — the bus decodes them and hands the block the alias). Registers reset to the values the
 * pico-sdk's headers give (reg-defaults.generated.ts). A subclass models the registers it knows
 * in `read`/`write` and leaves the rest to `readStored`/`writeStored`: storage, and an `info`
 * Problem the first time each unmodelled register is touched (unless the block is `quiet`: one
 * whose registers only need to keep what was written).
 */

import { REG_DEFAULTS } from './reg-defaults.generated.ts';

export const ALIAS_NONE = 0;
export const ALIAS_XOR = 1;
export const ALIAS_SET = 2;
export const ALIAS_CLR = 3;

/** A register's new value after a write of `value` through `alias`. */
export function applyAlias(old: number, value: number, alias: number): number {
  switch (alias) {
    case ALIAS_XOR:
      return (old ^ value) >>> 0;
    case ALIAS_SET:
      return (old | value) >>> 0;
    case ALIAS_CLR:
      return (old & ~value) >>> 0;
    default:
      return value >>> 0;
  }
}

/** What a peripheral sees of the SoC. */
export interface PeriphHost {
  /** Simulated time, ns. */
  now(): number;
  /** Drives one of the 52 shared interrupt lines. */
  setIrq(irq: number, level: boolean): void;
  /** An access to a register the model doesn't implement (reported once per address). */
  unmodelled(block: string, address: number, write: boolean): void;
}

export class Periph {
  readonly name: string;
  readonly base: number;
  /** Only keeps what is written: no Problem for unmodelled registers. */
  quiet = false;
  protected readonly host: PeriphHost;
  protected readonly regs = new Uint32Array(1024);
  private readonly defaults: readonly number[];

  constructor(name: string, base: number, host: PeriphHost) {
    this.name = name;
    this.base = base;
    this.host = host;
    this.defaults = REG_DEFAULTS[base] ?? [];
    this.resetRegs();
  }

  /** Back to the reset values. */
  reset(): void {
    this.resetRegs();
  }

  private resetRegs(): void {
    this.regs.fill(0);
    const d = this.defaults;
    for (let i = 0; i < d.length; i += 2) if (d[i] < 0x1000) this.regs[d[i] >>> 2] = d[i + 1];
  }

  /** A 32-bit read at `offset` (0–0xffc, word-aligned). */
  read(offset: number): number {
    return this.readStored(offset);
  }

  /** A 32-bit write at `offset` through `alias`. */
  write(offset: number, value: number, alias: number): void {
    this.writeStored(offset, value, alias);
  }

  /** BT71 (the debugger): the stored register, without a read's side effects or a report. */
  peek(offset: number): number {
    return this.regs[offset >>> 2];
  }

  /** The stored register (reported when unmodelled). */
  protected readStored(offset: number): number {
    if (!this.quiet) this.host.unmodelled(this.name, this.base + offset, false);
    return this.regs[offset >>> 2];
  }

  /** Stores a write (reported when unmodelled). */
  protected writeStored(offset: number, value: number, alias: number): void {
    if (!this.quiet) this.host.unmodelled(this.name, this.base + offset, true);
    this.regs[offset >>> 2] = applyAlias(this.regs[offset >>> 2], value, alias);
  }

  /** Stores a write the subclass handles itself (no report). */
  protected store(offset: number, value: number, alias: number): number {
    const next = applyAlias(this.regs[offset >>> 2], value, alias);
    this.regs[offset >>> 2] = next;
    return next;
  }
}
