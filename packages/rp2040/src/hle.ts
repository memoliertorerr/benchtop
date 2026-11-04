/**
 * High-level emulation on the RP2040's Cortex-M0+ (BT109): firmware functions TypeScript answers
 * instead of the firmware — the Thumb counterpart of @benchtop/esp32's hle/ (Xtensa) and
 * @benchtop/riscv's hle.ts, so the Pico W's CYW43 can be answered at its driver's API.
 *
 * The trap. Both cores decode per halfword (rp2040js's if-chain, the fast core's OP_OF), so an
 * address can't change what it decodes to; instead `install` writes `UDF #0x48` over each
 * replaced function's first halfword in flash (keeping the original, restored by `uninstall`).
 * A UDF calls rp2040js's `onBreak`, where the adapter asks `has(pc)` before anything else, so the
 * table costs nothing on any other instruction, on the stock and the fast core alike, and on
 * core 1 (DualCore puts the running core in `rp.core`). Only functions in flash can be replaced:
 * one copied to SRAM by the startup code would be copied from its load address, which a symbol
 * table doesn't give.
 *
 * The call (AAPCS): arguments in r0–r3, more on the caller's stack at sp, sp + 4, …; the
 * handler's result goes to r0 and execution returns to lr — through `BXWritePC`, so an exception
 * handler's EXC_RETURN works too. A handler that calls back into the firmware is a generator:
 * each `yield call.call(fn, …args)` runs `fn` and resumes with its r0. Such a call gets a frame
 * of its own: sp moves down FRAME_SIZE bytes (8-byte aligned: 16 for stack arguments past the
 * fourth, SCRATCH_SIZE of scratch memory the handler may use as `call.scratch`), the caller's lr
 * is kept with the frame, and every step runs at `resumePc` (a UDF in our bootrom, bootrom/
 * layout.ts HLE_RESUME): a call out puts its arguments in r0–r3 and on the stack, sets lr =
 * resumePc | 1 and jumps to `fn`, which returns there; the frame is found again by sp (each core
 * has its own stack, and an interrupt taken meanwhile stacks below it). Calls out clobber only what
 * the convention lets a callee clobber (r0–r3, r12, lr), so the caller's r4–r11 survive.
 */

import type { RP2040 } from 'rp2040js';

type Core = RP2040['core'];

/** UDF #0x48 ('H'): what a replaced function's first halfword becomes. */
export const HLE_UDF = 0xde48;

/** A call back into the firmware: `fn` with up to 8 arguments (4 in registers, 4 on the stack). */
export interface Upcall {
  readonly fn: number;
  readonly args: readonly number[];
}

/** A handler that calls the firmware: yields Upcalls, gets their results, returns its own. */
export type HleTask = Generator<Upcall, number, number>;

/** Answers a call: a result (unsigned 32-bit, to r0), or a task that calls back first. */
export type Rp2040HleHandler = (call: Rp2040HleCall) => number | HleTask;

const STACK_ARGS = 16;
export const SCRATCH_SIZE = 128;
/** A generator's frame: stack arguments and scratch memory, 8-byte aligned. */
export const FRAME_SIZE = STACK_ARGS + SCRATCH_SIZE;
const SP = 13;
const LR = 14;
const FLASH_BASE = 0x10000000;

const hex = (v: number): string => `0x${(v >>> 0).toString(16).padStart(8, '0')}`;

/** One call of a replaced function, as its handler sees it. */
export class Rp2040HleCall {
  readonly name: string;
  readonly rp: RP2040;
  /** r0–r3 at entry. */
  readonly args = new Uint32Array(4);
  /** The caller's stack pointer: arguments past the fourth are at callerSp + 4·(i − 4). */
  readonly callerSp: number;
  /** A generator's scratch memory (SCRATCH_SIZE bytes in its frame); 0 for a plain handler. */
  scratch = 0;

  constructor(rp: RP2040, core: Core, name: string) {
    this.rp = rp;
    this.name = name;
    const r = core.registers;
    for (let i = 0; i < 4; i++) this.args[i] = r[i] >>> 0;
    this.callerSp = r[SP] >>> 0;
  }

  /** Argument `i` (0-based), unsigned. */
  arg(i: number): number {
    return i < 4 ? this.args[i] : this.read32(this.callerSp + 4 * (i - 4));
  }

  /** Argument `i` as a signed 32-bit number. */
  int(i: number): number {
    return this.arg(i) | 0;
  }

  /** An Upcall of `fn` (for `yield`). */
  call(fn: number, ...args: number[]): Upcall {
    return { fn, args };
  }

  read8(address: number): number {
    return this.rp.readUint8(address >>> 0);
  }

  read16(address: number): number {
    return this.rp.readUint16(address >>> 0);
  }

  read32(address: number): number {
    return this.rp.readUint32(address >>> 0) >>> 0;
  }

  write8(address: number, value: number): void {
    this.rp.writeUint8(address >>> 0, value & 0xff);
  }

  write16(address: number, value: number): void {
    this.rp.writeUint16(address >>> 0, value & 0xffff);
  }

  write32(address: number, value: number): void {
    this.rp.writeUint32(address >>> 0, value >>> 0);
  }

  readBytes(address: number, length: number): Uint8Array {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) out[i] = this.rp.readUint8((address + i) >>> 0);
    return out;
  }

  writeBytes(address: number, bytes: ArrayLike<number>): void {
    for (let i = 0; i < bytes.length; i++) this.rp.writeUint8((address + i) >>> 0, bytes[i] & 0xff);
  }

  fill(address: number, length: number, value = 0): void {
    for (let i = 0; i < length; i++) this.rp.writeUint8((address + i) >>> 0, value & 0xff);
  }

  /** A NUL-terminated string of at most `max` bytes (Latin-1 bytes; UTF-8 decoding is the caller's). */
  readString(address: number, max = 256): string {
    let out = '';
    for (let i = 0; i < max; i++) {
      const b = this.rp.readUint8((address + i) >>> 0);
      if (b === 0) break;
      out += String.fromCharCode(b);
    }
    return out;
  }
}

interface Replaced {
  readonly name: string;
  readonly handler: Rp2040HleHandler;
}

interface Frame {
  readonly task: HleTask;
  readonly call: Rp2040HleCall;
  /** Where the replaced function returns: the caller's lr at entry (bit 0 set, or an EXC_RETURN). */
  readonly returnTo: number;
  started: boolean;
}

export class Rp2040Hle {
  readonly resumePc: number;
  /** Calls answered (each replaced function's entry counts once; a generator's steps don't). */
  calls = 0;
  private readonly table = new Map<number, Replaced>();
  private readonly frames = new Map<number, Frame>();
  /** Original halfwords under the UDFs `install` wrote, by flash offset. */
  private readonly patched = new Map<number, number>();

  /** `resumePc`: a UDF the firmware never executes, where generators run and their calls out return. */
  constructor(resumePc: number) {
    this.resumePc = (resumePc & ~1) >>> 0;
  }

  /** `handler` answers calls to the function at `address` (its first instruction; bit 0 ignored). */
  replace(address: number, name: string, handler: Rp2040HleHandler): void {
    this.table.set((address & ~1) >>> 0, { name, handler });
  }

  /** The name a replaced address answers to, or undefined. */
  nameAt(address: number): string | undefined {
    return this.table.get((address & ~1) >>> 0)?.name;
  }

  /** Generators between steps (waiting for a call out to return, or for their first step). */
  get running(): number {
    return this.frames.size;
  }

  /** Whether a UDF at `pc` is ours (a replaced function's entry, or the resume address). */
  has(pc: number): boolean {
    return pc === this.resumePc || this.table.has(pc);
  }

  /**
   * Writes the UDFs into `flash` (the chip's flash array, offset 0 = 0x10000000). Returns the
   * names of replaced functions outside flash, which can't be trapped.
   */
  install(flash: Uint8Array): string[] {
    this.uninstall(flash);
    const outside: string[] = [];
    for (const [address, { name }] of this.table) {
      const offset = address - FLASH_BASE;
      if (offset < 0 || offset + 2 > flash.length) {
        outside.push(name);
        continue;
      }
      this.patched.set(offset, flash[offset] | (flash[offset + 1] << 8));
      flash[offset] = HLE_UDF & 0xff;
      flash[offset + 1] = HLE_UDF >>> 8;
    }
    return outside;
  }

  /** Puts the original halfwords back. */
  uninstall(flash: Uint8Array): void {
    for (const [offset, original] of this.patched) {
      flash[offset] = original & 0xff;
      flash[offset + 1] = original >>> 8;
    }
    this.patched.clear();
  }

  /** The halfword the firmware had at a patched flash offset (the debugger's view), or undefined. */
  original(offset: number): number | undefined {
    return this.patched.get(offset);
  }

  /** Forgets generators between steps (a reset: their stacks are gone). */
  reset(): void {
    this.frames.clear();
  }

  /**
   * The UDF at `pc` is ours (`has`): runs the replaced function or a generator's next step on
   * `core` and moves its PC on. A handler's JavaScript error faults through `fault`.
   */
  run(rp: RP2040, core: Core, pc: number, fault: (message: string) => void): void {
    if (pc === this.resumePc) {
      this.resume(core, fault);
      return;
    }
    const replaced = this.table.get(pc);
    if (replaced === undefined) return;
    const call = new Rp2040HleCall(rp, core, replaced.name);
    let result: number | HleTask;
    try {
      result = replaced.handler(call);
    } catch (error) {
      fault(`hle: ${replaced.name}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    this.calls++;
    const r = core.registers;
    if (typeof result === 'number') {
      r[0] = result | 0;
      core.BXWritePC(r[LR] >>> 0);
      return;
    }
    const sp = ((r[SP] >>> 0) - FRAME_SIZE) >>> 0;
    r[SP] = sp | 0;
    call.scratch = (sp + STACK_ARGS) >>> 0;
    this.frames.set(sp, { task: result, call, returnTo: r[LR] >>> 0, started: false });
    core.PC = this.resumePc;
  }

  /** A generator's next step: its first, or the one after a call out returned (result in r0). */
  private resume(core: Core, fault: (message: string) => void): void {
    const r = core.registers;
    const sp = r[SP] >>> 0;
    const frame = this.frames.get(sp);
    if (frame === undefined) {
      fault(`hle: no TypeScript frame at sp ${hex(sp)}`);
      return;
    }
    const input = frame.started ? r[0] >>> 0 : 0;
    frame.started = true;
    let step: IteratorResult<Upcall, number>;
    try {
      step = frame.task.next(input);
    } catch (error) {
      this.frames.delete(sp);
      fault(`hle: ${frame.call.name}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (step.done === true) {
      this.frames.delete(sp);
      r[0] = step.value | 0;
      r[SP] = (sp + FRAME_SIZE) | 0;
      core.BXWritePC(frame.returnTo);
      return;
    }
    const { fn, args } = step.value;
    if (!(fn > 0) || args.length > 4 + STACK_ARGS / 4) {
      this.frames.delete(sp);
      fault(`hle: ${frame.call.name} calls ${fn > 0 ? `${hex(fn)} with ${args.length} arguments` : 'a function the firmware lacks'}`);
      return;
    }
    for (let i = 0; i < 4; i++) r[i] = i < args.length ? args[i] | 0 : 0;
    for (let i = 4; i < args.length; i++) core.writeUint32((sp + 4 * (i - 4)) >>> 0, args[i] >>> 0);
    r[LR] = (this.resumePc | 1) | 0;
    core.PC = (fn & ~1) >>> 0;
  }
}
