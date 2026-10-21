/**
 * Live sessions as MCP tools (BT69): `sim_open` a bench, then `sim_run` it in steps, `sim_input`
 * and `sim_serial` into it, `sim_state` to read parts and pins, `sim_reset`, `sim_close`,
 * `sim_list`. Every result carries the session's time; runs return the serial output since the
 * last call, new problems and the watched pins' measurements over the run.
 */

import { type DebugTables, type FirmwareImage, lineTableFromElf, parseElf32, type ProjectDoc, SymbolTable, type VisualState } from '@benchtop/core';
import { benchEnvParts } from '@benchtop/parts';
import { cachedRoms, loadFirmware, projectFromJson } from '../../load.ts';
import { parseScript, parseTime } from '../../run.ts';
import { levelText, type Session, Sessions } from '../sessions.ts';
import type { JsonSchema } from '../schema.ts';
import { type Tool, ToolError } from '../server.ts';
import { MICROPYTHON_ARG, PROJECT_ARGS, projectJsonArg, timeText, type ToolContext, withMicroPython } from './context.ts';

/** The sessions, kept on the tool context (one set per server). */
export interface SimContext extends ToolContext {
  sessions: Sessions;
}

const SESSION: JsonSchema = { type: 'string', maxLength: 16, description: 'The session id sim_open returned, e.g. "s1".' };
const WATCH: JsonSchema = { type: 'array', maxItems: 16, items: { type: 'string', maxLength: 80 }, description: 'Pins to measure on every sim_run, as "part:pin" (e.g. "uno:13", "led1:A"): edges, frequency, duty and the final level over the run.' };

/** Array values longer than this are summarized in part states (a display's framebuffer). */
const MAX_ARRAY = 32;

function compactVisual(visual: VisualState, full: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(visual)) {
    if (Array.isArray(value) && value.length > MAX_ARRAY && !full) out[key] = { length: value.length, first: value.slice(0, 8) };
    else out[key] = value;
  }
  return out;
}

/** Symbols from an nm listing (`.syms.tsv`); Arm Thumb functions lose bit 0. */
export function nmTables(text: string, doc: ProjectDoc, board: string): DebugTables {
  const type = doc.parts.find((p) => p.id === board)?.type ?? '';
  return { symbols: SymbolTable.fromNm(text, benchEnvParts(type)?.board?.mcu === 'rp2040'), lines: null };
}

/**
 * BT74: debug tables for a board whose firmware file isn't an ELF — the compiler's `.elf` beside
 * it (compile_sketch writes `<name>.ino.elf` next to `<name>.ino.uf2`), else an nm listing
 * (`.syms.tsv`, as the fixtures keep). Undefined when there's neither.
 */
function tablesBeside(context: SimContext, doc: ProjectDoc, board: string, path: string): DebugTables | undefined {
  if (/\.(elf|py)$/i.test(path)) return undefined;
  const base = path.replace(/\.(hex|uf2|bin)$/i, '');
  const read = (p: string): Uint8Array | undefined => {
    try {
      return context.io.readFile(p);
    } catch {
      return undefined;
    }
  };
  const elf = read(`${base}.elf`);
  if (elf !== undefined) {
    try {
      const parsed = parseElf32(elf);
      return { symbols: SymbolTable.fromElf(parsed), lines: lineTableFromElf(parsed) ?? null };
    } catch {
      // not an ELF we can read: fall through to a listing
    }
  }
  for (const syms of [`${base}.syms.tsv`, `${base.replace(/\.ino$/, '')}.syms.tsv`]) {
    const text = read(syms);
    if (text !== undefined) return nmTables(new TextDecoder().decode(text), doc, board);
  }
  return undefined;
}

/** Opens a session on a parsed project and its firmware; the result sim_open and open_example share. */
export function openSession(context: SimContext, label: string, doc: ProjectDoc, boards: string[], images: Record<string, FirmwareImage>, watch: readonly string[], tables: Record<string, DebugTables> = {}): object {
  const { session, closed } = context.sessions.add({ label, doc, boards, images, roms: cachedRoms(context.io), watch, serialChars: context.limits.serialChars, tables });
  return {
    session: session.id,
    project: label,
    now: timeText(session.bench.now()),
    boards,
    parts: doc.parts.map((p) => ({ id: p.id, type: p.type })),
    problems: session.newProblems(),
    ...(closed === undefined ? {} : { closed: `${closed} (the session limit is ${context.sessions.max}; it was used longest ago)` }),
  };
}

export const simOpen: Tool<SimContext> = {
  name: 'sim_open',
  title: 'Open a live simulation',
  description:
    'Builds a bench from a project and firmware (the same arguments as run_simulation) and keeps it open at time 0 for step-by-step work: sim_run advances it, sim_input / sim_serial drive it, sim_state reads it. Returns the session id, boards, parts and the circuit\'s problems. Close it with sim_close when done.',
  inputSchema: {
    type: 'object',
    properties: {
      ...PROJECT_ARGS,
      firmware: { type: 'object', additionalProperties: { type: 'string', maxLength: 1024 }, description: 'Board part id → firmware file under the root.' },
      micropython: MICROPYTHON_ARG,
      watch: WATCH,
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  run(args, context) {
    const { json, label } = projectJsonArg(args, context);
    const { doc, boards } = projectFromJson(withMicroPython(json, args.micropython));
    const firmware = (args.firmware ?? {}) as Record<string, string>;
    const images = loadFirmware(context.io, doc, boards, firmware);
    const tables: Record<string, DebugTables> = {};
    for (const [board, path] of Object.entries(firmware)) {
      const found = tablesBeside(context, doc, board, path);
      if (found !== undefined) tables[board] = found;
    }
    return openSession(context, label, doc, boards, images, (args.watch ?? []) as string[], tables);
  },
};

function serialBoard(session: Session, board: unknown): string {
  if (typeof board === 'string') {
    if (!session.boards.includes(board)) throw new ToolError(`no board "${board}" in the session (boards: ${session.boards.join(', ')})`);
    return board;
  }
  if (session.boards.length !== 1) throw new ToolError(`the session has ${session.boards.length} boards; say which ("board")`);
  return session.boards[0];
}

/** Where a board stopped at a breakpoint (its PC through the session's debug tables). */
function breakpointAt(session: Session, board: string): object | undefined {
  const debug = session.bench.debugOf(board);
  if (debug === undefined) return undefined;
  const regs = new Uint32Array(debug.registers().length);
  debug.readRegisters(regs);
  return session.location(board, regs[debug.pcIndex]);
}

export const simRun: Tool<SimContext> = {
  name: 'sim_run',
  title: 'Run a live simulation',
  description:
    'Advances an open session by "duration" (default "1s"; e.g. "250ms", "5s"), or until "untilSerial" appears in a board\'s serial output, whichever is first — within the call\'s limits. Returns the new time, why it stopped (duration, serial, wall — the call\'s wall-clock budget — or breakpoint), each board\'s serial output since the last call, problems that appeared, and for every watched pin its edges, frequency, duty and level over this run.',
  inputSchema: {
    type: 'object',
    properties: {
      session: SESSION,
      duration: { type: 'string', maxLength: 32, description: 'How long to run, e.g. "500ms" (default "1s").' },
      untilSerial: { type: 'string', maxLength: 1000, description: 'Stop as soon as this text appears in the serial output (since this run began).' },
      board: { type: 'string', maxLength: 64, description: 'The board whose serial untilSerial watches (needed with several boards).' },
    },
    required: ['session'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  run(args, context) {
    const session = context.sessions.get(args.session as string);
    const duration = parseTime(typeof args.duration === 'string' ? args.duration : '1s');
    if (duration <= 0) throw new ToolError('duration must be positive');
    if (duration > context.limits.maxSimNs) throw new ToolError(`duration ${timeText(duration)} is over the limit of ${timeText(context.limits.maxSimNs)} per call`);
    const until = typeof args.untilSerial === 'string' ? { text: args.untilSerial, board: serialBoard(session, args.board) } : undefined;
    const start = context.io.now();
    const from = session.bench.now();
    const run = session.run(duration, until, () => context.io.now() - start > context.limits.maxWallMs);
    const { serial, dropped } = session.takeSerial();
    return {
      session: session.id,
      now: timeText(session.bench.now()),
      ran: timeText(session.bench.now() - from),
      stoppedBy: run.stoppedBy,
      ...(run.breakpoint === undefined ? {} : { breakpoint: run.breakpoint, at: breakpointAt(session, run.breakpoint) }),
      serial,
      ...(dropped === undefined ? {} : { serialDropped: dropped }),
      problems: session.newProblems(),
      ...(Object.keys(run.watched).length > 0 ? { watched: run.watched } : {}),
      wallMs: Math.round(context.io.now() - start),
    };
  },
};

export const simInput: Tool<SimContext> = {
  name: 'sim_input',
  title: 'Send input to a part',
  description:
    'Sends input to a part of an open session at its current time, as a user would: { "kind": "press" } / "release" for buttons and switches, { "kind": "value", "value": n } for a pot\'s position or a sensor reading, { "kind": "key", "key": "…", "down": true } for keypads, encoders, IR; or "set" for named channels ({ "temperature": 30 }). describe_part lists what each part takes. Then sim_run to see the effect.',
  inputSchema: {
    type: 'object',
    properties: {
      session: SESSION,
      part: { type: 'string', maxLength: 64, description: 'The part id.' },
      input: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['press', 'release', 'value', 'key'] },
          value: { type: 'number' },
          key: { type: 'string', maxLength: 64 },
          down: { type: 'boolean' },
        },
        required: ['kind'],
        additionalProperties: false,
      },
      set: { type: 'object', additionalProperties: {}, description: 'Channel → number (or boolean), e.g. { "x": 0.5, "y": -1 }.' },
    },
    required: ['session', 'part'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  run(args, context) {
    const session = context.sessions.get(args.session as string);
    if ((args.input === undefined) === (args.set === undefined)) throw new ToolError('give exactly one of "input" or "set"');
    // The script parser checks the part and the input exactly as a test spec's step.
    const step = { at: '0ns', part: args.part, ...(args.input === undefined ? { set: args.set } : { input: args.input }) };
    const { steps } = parseScript([step], session.doc, session.boards);
    for (const s of steps) if (s.kind === 'input') session.bench.input(s.part, s.input);
    session.collect();
    return { session: session.id, now: timeText(session.bench.now()), sent: steps.length };
  },
};

export const simSerial: Tool<SimContext> = {
  name: 'sim_serial',
  title: 'Type into a board\'s serial port',
  description: 'Sends text to a board\'s serial input (UART 0 — USB serial on the Picos), as the serial monitor would; include "\\n" or "\\r" when the sketch reads lines. sim_run then shows the reply.',
  inputSchema: {
    type: 'object',
    properties: { session: SESSION, text: { type: 'string', maxLength: 65_536 }, board: { type: 'string', maxLength: 64, description: 'Needed with several boards.' } },
    required: ['session', 'text'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  run(args, context) {
    const session = context.sessions.get(args.session as string);
    const board = serialBoard(session, args.board);
    session.bench.sendSerial(board, new TextEncoder().encode(args.text as string));
    return { session: session.id, now: timeText(session.bench.now()), board, sent: (args.text as string).length };
  },
};

export const simState: Tool<SimContext> = {
  name: 'sim_state',
  title: 'Read a live simulation\'s state',
  description:
    'What an open session shows now: each part\'s visual state (an LED\'s brightness, a servo\'s angle, an LCD\'s text, a NeoPixel\'s colors, a display\'s framebuffer summarized unless "full"), and the level and volts of the pins asked for ("part:pin"). Filter parts with "parts".',
  inputSchema: {
    type: 'object',
    properties: {
      session: SESSION,
      parts: { type: 'array', maxItems: 100, items: { type: 'string', maxLength: 64 }, description: 'Only these part ids.' },
      pins: { type: 'array', maxItems: 64, items: { type: 'string', maxLength: 80 }, description: 'Pins to read, as "part:pin".' },
      full: { type: 'boolean', description: 'Long arrays in full (framebuffers can be large).' },
    },
    required: ['session'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  run(args, context) {
    const session = context.sessions.get(args.session as string);
    const wanted = args.parts as string[] | undefined;
    for (const id of wanted ?? []) if (!session.doc.parts.some((p) => p.id === id)) throw new ToolError(`no part "${id}" in the session`);
    const parts: Record<string, unknown> = {};
    for (const [id, visual] of session.latest) if (wanted === undefined || wanted.includes(id)) parts[id] = compactVisual(visual, args.full === true);
    const pins: Record<string, unknown> = {};
    for (const key of (args.pins ?? []) as string[]) {
      const ref = session.pinRef(key);
      const state = session.bench.pinState(ref.part, ref.pin);
      pins[key] = { level: levelText(state), volts: state === undefined ? 0 : Math.round(state.volts * 1000) / 1000 };
    }
    return { session: session.id, now: timeText(session.bench.now()), parts, ...(Object.keys(pins).length > 0 ? { pins } : {}) };
  },
};

export const simReset: Tool<SimContext> = {
  name: 'sim_reset',
  title: 'Reset a live simulation',
  description: 'Resets every board and part of an open session (time back to 0, firmware restarted, inputs released) and clears its serial buffers.',
  inputSchema: { type: 'object', properties: { session: SESSION }, required: ['session'], additionalProperties: false },
  annotations: { readOnlyHint: true, openWorldHint: false },
  run(args, context) {
    const session = context.sessions.get(args.session as string);
    session.reset();
    return { session: session.id, now: timeText(session.bench.now()) };
  },
};

export const simClose: Tool<SimContext> = {
  name: 'sim_close',
  title: 'Close a live simulation',
  description: 'Closes an open session and frees its bench.',
  inputSchema: { type: 'object', properties: { session: SESSION }, required: ['session'], additionalProperties: false },
  annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false },
  run(args, context) {
    context.sessions.close(args.session as string);
    return { closed: args.session };
  },
};

export const simList: Tool<SimContext> = {
  name: 'sim_list',
  title: 'List live simulations',
  description: 'The open sessions: id, project, boards and current time.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, openWorldHint: false },
  run(_args, context) {
    return { max: context.sessions.max, sessions: context.sessions.list().map((s) => ({ session: s.id, project: s.label, boards: s.boards, now: timeText(s.bench.now()) })) };
  },
};

export const SIM_TOOLS: readonly Tool<SimContext>[] = [simOpen, simRun, simInput, simSerial, simState, simReset, simClose, simList];
