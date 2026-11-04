/**
 * High-level emulation on RISC-V (BT106): firmware functions TypeScript answers instead of the
 * firmware — the RISC-V counterpart of @benchtop/esp32's hle/ (the Xtensa one), so the ESP32-C3
 * can run the same WiFi model.
 *
 * `replace(address, name, handler)` puts a handler at a function's first instruction. When the
 * core decodes an instruction there it gets OP_HLE (cpu.ts), so nothing else pays for the table.
 * The function never runs: by the standard calling convention its arguments are a0–a7 (x10–x17;
 * a ninth and later on the caller's stack at sp, sp + 4, …), the handler's result goes in a0 and
 * execution continues at ra — as if the function had returned.
 *
 * A handler that calls back into the firmware (to post an event, allocate a buffer, create a
 * task, sleep) is a generator: each `yield call.call(fn, …args)` runs `fn` and resumes with its
 * result. Such a call gets a frame of its own: sp moves down FRAME_SIZE bytes (16-byte aligned:
 * 16 for stack arguments past the eighth, SCRATCH_SIZE of scratch memory the handler may use as
 * `call.scratch`), the caller's ra is kept with the frame, and every step runs at `resumePc`: a
 * call out sets a0… to its arguments and ra = resumePc and jumps to `fn`, which returns there with
 * its result in a0; the frame is found again by sp, unique among live frames on every task's
 * stack, so a task may block in a call out while others run. When the generator returns, a0 holds
 * its value, sp goes back up and execution continues at the kept ra. Calls out clobber only what
 * the convention lets a callee clobber (a0–a7, t0–t6, ra), so the caller's saved registers survive.
 *
 * resumePc is an address the firmware never executes (the SoC's ROM has unused space); a
 * handler's JavaScript error faults the core with its message. Upcalls happen only inside a
 * call, in the calling task's context — never asynchronously.
 */

import type { RiscvCore } from './cpu.ts';

/** What the core asks the table about an address, and what it runs (cpu.ts's OP_HLE). */
export const HLE_KIND = { NONE: 0, CALL: 1, RESUME: 2 } as const;

/** The core's seam: which addresses are HLE'd, and running one. Returns the next pc. */
export interface RiscvHleHook {
  kind(pc: number): number;
  run(core: RiscvCore, pc: number, kind: number): number;
}

/** A call back into the firmware: `fn` with up to 12 arguments (8 in registers, 4 on the stack). */
export interface Upcall {
  readonly fn: number;
  readonly args: readonly number[];
}

/** A handler that calls the firmware: yields Upcalls, gets their results, returns its own. */
export type HleTask = Generator<Upcall, number, number>;

/** Answers a call: a result (unsigned 32-bit), or a task that calls back first. */
export type RiscvHleHandler = (call: RiscvHleCall) => number | HleTask;

const STACK_ARGS = 16;
export const SCRATCH_SIZE = 128;
/** A generator's frame: stack arguments and scratch memory, 16-byte aligned. */
export const FRAME_SIZE = STACK_ARGS + SCRATCH_SIZE;
const SP = 2;
const RA = 1;
const A0 = 10;

const hex = (v: number): string => `0x${(v >>> 0).toString(16).padStart(8, '0')}`;

/** One call of a replaced function, as its handler sees it. */
export class RiscvHleCall {
  readonly name: string;
  readonly core: RiscvCore;
  /** a0–a7 at entry. */
  readonly args = new Uint32Array(8);
  /** The caller's stack pointer: arguments past the eighth are at callerSp + 4·(i − 8). */
  readonly callerSp: number;
  /** A generator's scratch memory (SCRATCH_SIZE bytes in its frame); 0 for a plain handler. */
  scratch = 0;

  constructor(core: RiscvCore, name: string) {
    this.core = core;
    this.name = name;
    for (let i = 0; i < 8; i++) this.args[i] = core.x[A0 + i] >>> 0;
    this.callerSp = core.x[SP] >>> 0;
  }

  /** Argument `i` (0-based), unsigned. */
  arg(i: number): number {
    return i < 8 ? this.args[i] : this.read32(this.callerSp + 4 * (i - 8));
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
  readonly handler: RiscvHleHandler;
}

interface Frame {
  readonly task: HleTask;
  readonly call: RiscvHleCall;
  /** Where the replaced function returns: the caller's ra at entry. */
  readonly returnTo: number;
  started: boolean;
}

export class RiscvHle implements RiscvHleHook {
  readonly resumePc: number;
  /** Calls answered (each replaced function's entry counts once; a generator's steps don't). */
  calls = 0;
  private readonly table = new Map<number, Replaced>();
  private readonly frames = new Map<number, Frame>();

  /** `resumePc`: where generators run and their calls out return (never executed by the firmware). */
  constructor(resumePc: number) {
    this.resumePc = resumePc >>> 0;
  }

  /** `handler` answers calls to the function at `address` (its first instruction). */
  replace(address: number, name: string, handler: RiscvHleHandler): void {
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
    return this.table.has(pc) ? HLE_KIND.CALL : HLE_KIND.NONE;
  }

  run(core: RiscvCore, pc: number, kind: number): number {
    if (kind === HLE_KIND.RESUME) return this.resume(core, pc);
    const replaced = this.table.get(pc);
    if (replaced === undefined) {
      core.fault(`hle: nothing answers ${hex(pc)}`);
      return pc;
    }
    const call = new RiscvHleCall(core, replaced.name);
    let result: number | HleTask;
    try {
      result = replaced.handler(call);
    } catch (error) {
      core.fault(`hle: ${replaced.name}: ${error instanceof Error ? error.message : String(error)}`);
      return pc;
    }
    this.calls++;
    const x = core.x;
    if (typeof result === 'number') {
      x[A0] = result | 0;
      return x[RA] >>> 0;
    }
    const sp = ((x[SP] >>> 0) - FRAME_SIZE) >>> 0;
    x[SP] = sp | 0;
    call.scratch = (sp + STACK_ARGS) >>> 0;
    this.frames.set(sp, { task: result, call, returnTo: x[RA] >>> 0, started: false });
    return this.resumePc;
  }

  /** A generator's next step: its first, or the one after a call out returned (result in a0). */
  private resume(core: RiscvCore, pc: number): number {
    const x = core.x;
    const sp = x[SP] >>> 0;
    const frame = this.frames.get(sp);
    if (frame === undefined) {
      core.fault(`hle: no TypeScript frame at sp ${hex(sp)}`);
      return pc;
    }
    const input = frame.started ? x[A0] >>> 0 : 0;
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
      x[A0] = step.value | 0;
      x[SP] = (sp + FRAME_SIZE) | 0;
      return frame.returnTo;
    }
    const upcall = step.value;
    const { fn, args } = upcall;
    if (!(fn > 0) || args.length > 8 + STACK_ARGS / 4) {
      this.frames.delete(sp);
      core.fault(`hle: ${frame.call.name} calls ${fn > 0 ? `${hex(fn)} with ${args.length} arguments` : 'a function the firmware lacks'}`);
      return pc;
    }
    for (let i = 0; i < 8; i++) x[A0 + i] = i < args.length ? args[i] | 0 : 0;
    for (let i = 8; i < args.length; i++) core.bus.write32((sp + 4 * (i - 8)) >>> 0, args[i] >>> 0);
    x[RA] = this.resumePc | 0;
    return fn >>> 0;
  }
}
