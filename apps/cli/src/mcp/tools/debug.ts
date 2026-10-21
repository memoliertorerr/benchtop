/**
 * Debugging a board in a live session (BT70; every board since BT74 — the Uno, Nano and Mega,
 * the Pico's core 0, the Pico 2's hart 0, the ESP32's APP_CPU or whichever core stopped) through
 * BT24's `McuDebug`: `debug_registers`, `debug_memory`, `debug_breakpoints` (by address, function
 * or file:line — symbols come from the .elf, or an .elf or .syms.tsv beside a .hex/.uf2/.bin;
 * lines need an ELF) and `debug_step` (one instruction or over a call). `sim_run` continues: it
 * stops at a breakpoint and says where.
 */

import { type McuDebug, type MemorySpace, resolveBreakpoint, stepOver } from '@benchtop/core';
import type { Session } from '../sessions.ts';
import type { JsonSchema } from '../schema.ts';
import { type Tool, ToolError } from '../server.ts';
import { timeText } from './context.ts';
import type { SimContext } from './sim.ts';

const SESSION: JsonSchema = { type: 'string', maxLength: 16, description: 'The session id.' };
const BOARD: JsonSchema = { type: 'string', maxLength: 64, description: 'The board part id (needed with several boards).' };
/** Bytes one memory read returns at most. */
const MAX_READ = 1024;
/** Instructions one step call executes at most. */
const MAX_STEPS = 10_000;

function target(args: Record<string, unknown>, context: SimContext): { session: Session; board: string; debug: McuDebug } {
  const session = context.sessions.get(args.session as string);
  let board: string;
  if (typeof args.board === 'string') {
    if (!session.boards.includes(args.board)) throw new ToolError(`no board "${args.board}" in the session (boards: ${session.boards.join(', ')})`);
    board = args.board;
  } else if (session.boards.length === 1) board = session.boards[0];
  else throw new ToolError(`the session has ${session.boards.length} boards; say which ("board")`);
  const debug = session.bench.debugOf(board);
  if (debug === undefined) {
    const type = session.doc.parts.find((p) => p.id === board)?.type ?? '?';
    throw new ToolError(`the MCU on "${board}" (${type}) has no debugger here`);
  }
  return { session, board, debug };
}

function pcOf(debug: McuDebug): number {
  const regs = new Uint32Array(debug.registers().length);
  debug.readRegisters(regs);
  return regs[debug.pcIndex];
}

export const debugRegisters: Tool<SimContext> = {
  name: 'debug_registers',
  title: 'Read the CPU registers',
  description: 'A board\'s CPU registers in an open session, named as GDB names them — AVR: R0–R31, SREG (flags as ITHSVNZC), SP, PC; Pico (Cortex-M0+ core 0): r0–r12, sp, lr, pc, xpsr; Pico 2 (RISC-V hart 0): zero, ra, sp, …, a0–a7, …, pc, mstatus, mepc, mcause; ESP32 (the APP_CPU, where loop() runs, or the core that stopped): pc, a0–a15 of the current window, sar, ps, windowbase, windowstart, lbeg, lend, lcount, cpu — and where the PC is (function+offset, and file:line with an ELF). A function\'s first argument: AVR R25:R24, Pico r0, Pico 2 a0, ESP32 a2 after its ENTRY.',
  inputSchema: { type: 'object', properties: { session: SESSION, board: BOARD }, required: ['session'], additionalProperties: false },
  annotations: { readOnlyHint: true, openWorldHint: false },
  run(args, context) {
    const { session, board, debug } = target(args, context);
    const info = debug.registers();
    const regs = new Uint32Array(info.length);
    debug.readRegisters(regs);
    const registers: Record<string, number> = {};
    info.forEach((r, i) => (registers[r.name] = regs[i]));
    const sreg = registers.SREG;
    return {
      session: session.id,
      board,
      now: timeText(session.bench.now()),
      at: session.location(board, regs[debug.pcIndex]),
      registers,
      ...(sreg === undefined ? {} : { flags: 'ITHSVNZC'.split('').map((f, i) => ((sreg >> (7 - i)) & 1 ? f : '·')).join('') }),
    };
  },
};

export const debugMemory: Tool<SimContext> = {
  name: 'debug_memory',
  title: 'Read memory',
  description: 'Reads a board\'s memory without side effects: "data" (AVR: registers, I/O and SRAM from 0x100; the 32-bit boards: the CPU\'s whole address space — RAM at 0x20000000 on the Picos, 0x3FFB0000 on the ESP32 — with peripheral registers read as stored, or 0), "flash" (the chip from offset 0) or "eeprom" (AVR), at an address or a symbol (a global variable or function), up to 1024 bytes. Returns hex bytes and, for 1, 2 or 4 bytes, the little-endian value.',
  inputSchema: {
    type: 'object',
    properties: {
      session: SESSION,
      board: BOARD,
      space: { type: 'string', enum: ['data', 'flash', 'eeprom'], description: 'Default "data".' },
      address: { type: 'integer', minimum: 0, maximum: 0xffffff },
      symbol: { type: 'string', maxLength: 128, description: 'A symbol instead of an address (its own space and size apply).' },
      length: { type: 'integer', minimum: 1, maximum: MAX_READ, description: 'Bytes (default: the symbol\'s size, else 16).' },
    },
    required: ['session'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  run(args, context) {
    const { session, board, debug } = target(args, context);
    let space = (args.space ?? 'data') as MemorySpace;
    let address: number;
    let length = args.length as number | undefined;
    let symbol: object | undefined;
    if (typeof args.symbol === 'string') {
      const entry = session.tables.get(board)?.symbols?.lookup(args.symbol);
      if (entry === undefined) throw new ToolError(session.tables.has(board) ? `no symbol "${args.symbol}"` : 'no symbols: open the session with the firmware as an .elf');
      space = entry.space;
      address = entry.address;
      length ??= Math.min(MAX_READ, Math.max(1, entry.size));
      symbol = { name: args.symbol, kind: entry.kind, size: entry.size };
    } else if (typeof args.address === 'number') address = args.address;
    else throw new ToolError('give "address" or "symbol"');
    length ??= 16;
    const bytes = debug.readMemory(space, address, length);
    const value = bytes.length === 1 ? bytes[0] : bytes.length === 2 ? bytes[0] | (bytes[1] << 8) : bytes.length === 4 ? (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0 : undefined;
    return {
      session: session.id,
      board,
      space,
      address: `0x${address.toString(16)}`,
      ...(symbol === undefined ? {} : { symbol }),
      hex: [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' '),
      ...(value === undefined ? {} : { value }),
    };
  },
};

export const debugBreakpoints: Tool<SimContext> = {
  name: 'debug_breakpoints',
  title: 'Set or clear breakpoints',
  description:
    'Sets and clears breakpoints on a board in an open session, then lists them. A breakpoint is "0x05b2" (an address), "loop" (a function) or "sketch.ino:12" (a source line; functions and lines need the .elf). sim_run stops when one is reached ("stoppedBy": "breakpoint", with where); sim_run again continues.',
  inputSchema: {
    type: 'object',
    properties: {
      session: SESSION,
      board: BOARD,
      set: { type: 'array', maxItems: 32, items: { type: 'string', maxLength: 200 } },
      clear: { type: 'array', maxItems: 32, items: { type: 'string', maxLength: 200 } },
      clearAll: { type: 'boolean' },
    },
    required: ['session'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  run(args, context) {
    const { session, board, debug } = target(args, context);
    const tables = session.tables.get(board) ?? { symbols: null, lines: null };
    const errors: string[] = [];
    if (args.clearAll === true) for (const a of debug.breakpoints()) debug.clearBreakpoint(a);
    for (const [list, apply] of [
      [args.clear, (a: number) => debug.clearBreakpoint(a)],
      [args.set, (a: number) => debug.setBreakpoint(a)],
    ] as const) {
      for (const text of (list ?? []) as string[]) {
        const resolved = resolveBreakpoint(text, tables);
        if (resolved.ok) for (const a of resolved.addresses) apply(a);
        else errors.push(`${text}: ${resolved.error}`);
      }
    }
    return { session: session.id, board, breakpoints: debug.breakpoints().map((a) => session.location(board, a)), ...(errors.length > 0 ? { errors } : {}) };
  },
};

export const debugStep: Tool<SimContext> = {
  name: 'debug_step',
  title: 'Step instructions',
  description: 'Executes one instruction (or "count" of them) on a board in an open session, the rest of the bench keeping time; with "over": true a call runs to its return. Returns where the PC is after.',
  inputSchema: {
    type: 'object',
    properties: { session: SESSION, board: BOARD, count: { type: 'integer', minimum: 1, maximum: MAX_STEPS }, over: { type: 'boolean' } },
    required: ['session'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  run(args, context) {
    const { session, board, debug } = target(args, context);
    const count = (args.count ?? 1) as number;
    let stopped: string | undefined;
    for (let i = 0; i < count && stopped === undefined; i++) {
      if (args.over === true) {
        const result = stepOver(debug, () => (session.bench.runFor(1_000_000).reason === 'breakpoint' ? { reason: 'breakpoint' } : { reason: 'target' }));
        if (result.reason !== 'stepped') stopped = result.reason;
      } else session.bench.debugStep(board);
      const halt = session.bench.mcuStopped(board);
      if (halt !== null) stopped = `${halt.reason}${halt.detail === '' ? '' : `: ${halt.detail}`}`;
    }
    session.collect();
    return { session: session.id, board, now: timeText(session.bench.now()), at: session.location(board, pcOf(debug)), ...(stopped === undefined ? {} : { stopped }) };
  },
};

export const DEBUG_TOOLS: readonly Tool<SimContext>[] = [debugRegisters, debugMemory, debugBreakpoints, debugStep];
