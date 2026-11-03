/**
 * High-level emulation (BT97): firmware functions TypeScript answers instead of the firmware.
 *
 * `replace(address, name, handler)` puts a handler at a function's first instruction. When the
 * core decodes an instruction there it gets OP_HLE (xtensa/cpu.ts), so nothing else pays for the
 * table. The function's own `entry` never runs: the caller's CALLn has set PS.CALLINC = n and
 * a(4n) = the return address, so the arguments are the caller's a(4n+2)… (a further one on the
 * caller's stack from a1), a handler's result goes in the caller's a(4n+2), and execution
 * continues at the return address — as if the function had returned. A CALL0 caller (n = 0)
 * passes a2… and returns to a0.
 *
 * A handler that calls back into the firmware (to post an event, allocate a buffer, create a
 * task, sleep) is a generator: each `yield call.call(fn, …args)` runs `fn` and resumes with its
 * result. Such a call gets a frame of its own, as a compiled function's would: hleEntry does
 * what `entry a1, FRAME_SIZE` does (a window overflow first when the frame ahead is live; the HLE
 * op then runs again, and the generator — which hasn't started — is made afresh), and the first
 * step runs at `resumePc`. Every step runs there: a CALL8 out (a8 = resumePc, a10… = arguments)
 * returns to it with the result in a10, and the frame is found again by its stack pointer, which
 * is unique among live frames on every task's stack, on either core. resumePc's op touches
 * window quarter 3 (a8–a15), so a live frame there spills before a step writes them. When the
 * generator returns, a2 holds its value and execution goes to `returnPc`, which decodes as RETW:
 * the caller's frame may have been spilled meanwhile, and RETW's window underflow restores it
 * and runs the RETW again. A generator's frame (FRAME_SIZE bytes below the caller's a1): 16
 * bytes at the bottom for stack arguments past the sixth, SCRATCH_SIZE bytes of scratch memory
 * the handler may use (`call.scratch`) while it runs, and at the top the 32 bytes the windowed
 * ABI reserves (the caller's caller's a0–a3 and this frame's a4–a7 when they spill).
 *
 * resumePc and returnPc are addresses the firmware never executes (the SoC uses the ROM's unused
 * tail); a handler's JavaScript error faults the core with its message. Upcalls happen only
 * inside a call, in the calling task's context — never asynchronously.
 */

import { HLE_KIND, type XtensaCore, type XtensaHle } from '../xtensa/cpu.ts';
import { PS } from '../xtensa/exceptions.ts';

/**
 * The ESP32's resume and return addresses: the ROM's unused tail — ROM1's instruction-bus view
 * past its .rodata (which ends at 0x4006F018), zeros the firmware never executes, and in the
 * 1 GB region RETW needs (the same as IRAM's, flash code's and the ROM's).
 */
export const ESP32_HLE_RESUME_PC = 0x4006fff0;
export const ESP32_HLE_RETURN_PC = 0x4006fff4;

/** A call back into the firmware: `fn` with up to 10 arguments. */
export interface Upcall {
  readonly fn: number;
  readonly args: readonly number[];
}

/** A handler that calls the firmware: yields Upcalls, gets their results, returns its own. */
export type HleTask = Generator<Upcall, number, number>;

/** Answers a call: a result (unsigned 32-bit), or a task that calls back first. */
export type HleHandler = (call: HleCall) => number | HleTask;

/** Bytes for stack arguments, scratch memory, the ABI's reserved top — a generator's frame. */
const STACK_ARGS = 16;
export const SCRATCH_SIZE = 128;
const RESERVED = 32;
export const FRAME_SIZE = STACK_ARGS + SCRATCH_SIZE + RESERVED;

const hex = (v: number): string => `0x${(v >>> 0).toString(16).padStart(8, '0')}`;

/** One call of a replaced function, as its handler sees it. */
export class HleCall {
  readonly name: string;
  readonly core: XtensaCore;
  /** The first six arguments (a2–a7 of the function's view). */
  readonly args = new Uint32Array(6);
  /** The caller's stack pointer: arguments past the sixth are at callerSp + 4·(i − 6). */
  readonly callerSp: number;
  /** A generator's scratch memory (SCRATCH_SIZE bytes in its frame); 0 for a plain handler. */
  scratch = 0;

  constructor(core: XtensaCore, name: string, n: number) {
    this.core = core;
    this.name = name;
    const wb = core.windowBase << 2;
    for (let i = 0; i < 6; i++) this.args[i] = core.ar[(wb + (n << 2) + 2 + i) & 63];
    this.callerSp = core.ar[(wb + 1) & 63];
  }

  /** Argument `i` (0-based), unsigned. */
  arg(i: number): number {
    return i < 6 ? this.args[i] : this.core.bus.read32((this.callerSp + 4 * (i - 6)) >>> 0);
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
    return this.core.bus.read8(address >>> 0);
  }

  read16(address: number): number {
    return this.core.bus.read16(address >>> 0);
  }

  read32(address: number): number {
    return this.core.bus.read32(address >>> 0) >>> 0;
  }

  write8(address: number, value: number): void {
    this.core.bus.write8(address >>> 0, value & 0xff);
  }

  write16(address: number, value: number): void {
    this.core.bus.write16(address >>> 0, value & 0xffff);
  }

  write32(address: number, value: number): void {
    this.core.bus.write32(address >>> 0, value >>> 0);
  }

  readBytes(address: number, length: number): Uint8Array {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) out[i] = this.core.bus.read8((address + i) >>> 0);
    return out;
  }

  writeBytes(address: number, bytes: ArrayLike<number>): void {
    for (let i = 0; i < bytes.length; i++) this.core.bus.write8((address + i) >>> 0, bytes[i] & 0xff);
  }

  fill(address: number, length: number, value = 0): void {
    for (let i = 0; i < length; i++) this.core.bus.write8((address + i) >>> 0, value);
  }

  /** A NUL-terminated string of at most `max` bytes (Latin-1 bytes; UTF-8 decoding is the caller's). */
  readString(address: number, max = 256): string {
    let out = '';
    for (let i = 0; i < max; i++) {
      const b = this.core.bus.read8((address + i) >>> 0);
      if (b === 0) break;
      out += String.fromCharCode(b);
    }
    return out;
  }
}

interface Replaced {
  readonly name: string;
  readonly handler: HleHandler;
}

interface Frame {
  readonly task: HleTask;
  readonly call: HleCall;
  started: boolean;
}

export interface HleOptions {
  /** Where generators run and their calls out return (an address the firmware never executes). */
  resumePc: number;
  /** Where a generator's RETW runs (another such address). */
  returnPc: number;
}

export class Hle implements XtensaHle {
  readonly resumePc: number;
  readonly returnPc: number;
  /** Calls answered (each replaced function's entry counts once; a generator's steps don't). */
  calls = 0;
  private readonly table = new Map<number, Replaced>();
  private readonly frames = new Map<number, Frame>();

  constructor(options: HleOptions) {
    this.resumePc = options.resumePc >>> 0;
    this.returnPc = options.returnPc >>> 0;
  }

  /** `handler` answers calls to the function at `address` (its first instruction). */
  replace(address: number, name: string, handler: HleHandler): void {
    this.table.set(address >>> 0, { name, handler });
  }

  /** The name a replaced address answers to, or undefined. */
  nameAt(address: number): string | undefined {
    return this.table.get(address >>> 0)?.name;
  }

  /** Generators between steps (waiting for a call out to return, or for their first step). */
  get running(): number {
    return this.frames.size;
  }

  kind(pc: number): number {
    if (pc === this.resumePc) return HLE_KIND.RESUME;
    if (pc === this.returnPc) return HLE_KIND.RETURN;
    return this.table.has(pc) ? HLE_KIND.CALL : HLE_KIND.NONE;
  }

  run(core: XtensaCore, pc: number, kind: number): number {
    if (kind === HLE_KIND.RESUME) return this.resume(core, pc);
    const replaced = this.table.get(pc);
    if (replaced === undefined) {
      core.fault(`hle: nothing answers ${hex(pc)}`);
      return pc;
    }
    const n = (core.ps & PS.CALLINC) >>> PS.CALLINC_SHIFT;
    const call = new HleCall(core, replaced.name, n);
    let result: number | HleTask;
    try {
      result = replaced.handler(call);
    } catch (error) {
      core.fault(`hle: ${replaced.name}: ${error instanceof Error ? error.message : String(error)}`);
      return pc;
    }
    if (typeof result === 'number') {
      this.calls++;
      const wb = core.windowBase << 2;
      core.ar[(wb + (n << 2) + 2) & 63] = result >>> 0;
      if (n === 0) return core.ar[wb & 63];
      return ((pc & 0xc0000000) | (core.ar[(wb + (n << 2)) & 63] & 0x3fffffff)) >>> 0;
    }
    const entered = core.hleEntry(FRAME_SIZE, pc);
    if (entered === 0) return core.pc; // a window overflow first; this runs again after it
    if (entered < 0) {
      core.fault(`hle: ${replaced.name} calls back into the firmware, so it needs a windowed call (CALL4/8/12) outside exception handlers`);
      return pc;
    }
    this.calls++;
    const sp = core.reg(1);
    call.scratch = (sp + STACK_ARGS) >>> 0;
    this.frames.set(sp, { task: result, call, started: false });
    return this.resumePc;
  }

  /** A generator's next step: its first, or the one after a call out returned (result in a10). */
  private resume(core: XtensaCore, pc: number): number {
    const sp = core.reg(1);
    const frame = this.frames.get(sp);
    if (frame === undefined) {
      core.fault(`hle: no TypeScript frame at sp ${hex(sp)}`);
      return pc;
    }
    const input = frame.started ? core.reg(10) : 0;
    frame.started = true;
    let step: IteratorResult<Upcall, number>;
    try {
      step = frame.task.next(input);
    } catch (error) {
      this.frames.delete(sp);
      core.fault(`hle: ${frame.call.name}: ${error instanceof Error ? error.message : String(error)}`);
      return pc;
    }
    if (step.done === true) {
      this.frames.delete(sp);
      core.setReg(2, step.value >>> 0);
      return this.returnPc;
    }
    const upcall = step.value;
    if (!(upcall.fn > 0) || upcall.args.length > 6 + STACK_ARGS / 4) {
      this.frames.delete(sp);
      core.fault(`hle: ${frame.call.name} calls ${upcall.fn > 0 ? `${hex(upcall.fn)} with ${upcall.args.length} arguments` : 'a function the firmware lacks'}`);
      return pc;
    }
    return core.hleCall(upcall.fn, upcall.args, this.resumePc);
  }
}
