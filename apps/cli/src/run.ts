/**
 * The headless runner behind `benchtop run`: load a project and firmware files, run at max
 * speed, apply a scripted input timeline, check assertions, and report as JSON. All file access
 * and the wall clock come in through `RunIo`, so tests run it in-process.
 *
 * Grammar (docs/ARCHITECTURE.md, "Headless runner"):
 * - Times are "<number><ns|us|ms|s>"; a bare number is a usage error.
 * - `serial contains "<text>" by <time>` (or `serial[<board>] …` with several boards): passes at
 *   the first match at or before that time. Escapes: \" \\ \n.
 * - `pin <part>:<pin> is <0|1|z|x> at <time>`: the pin's net then (z floating, x conflict). On
 *   boards a numeric pin also matches with or without a leading D (13 ↔ D13).
 * - BT49: `serial matches /<regex>/<imsu> by <time>` (the first match in the kept serial text,
 *   timed by when its last character arrived); `pin … frequency is <hz> [Hz] ±<pct>% between
 *   <t1> and <t2>` (rising edges in the window) and `pin … duty is <pct>% ±<points> between …`
 *   (time high over the window), both from a probe; and what parts show at a time: `led <part> is
 *   <lit|dark>` (brightness ≥ 0.3 / ≤ 0.05), `servo <part> angle is <deg> ±<deg>`, `lcd <part>
 *   row <n> is "<text>"` (rows from 0, trailing spaces ignored), `pixel <part>[<i>] is #rrggbb`,
 *   `digits <part> show "<text>"`. ± may be written +- or +/-.
 * - Script: an array of steps or { steps: [...], expect: [...] }. A step is { at, part, input }
 *   (a part input) or { at, serial, board? } (BT48: text sent to a board's UART 0, as typed in the
 *   serial monitor; `board` may be left out with one board). Steps apply at exactly their time,
 *   in file order; assertions at the same time see their effect.
 *
 * Exit codes: 0 every assertion passed, 1 one failed, 2 usage, load or run error.
 */

import { type Bench, MAX_PROBES, type Mcu, type NetState, type PartInput, type Problem, type ProjectDoc, type VisualState } from '@benchtop/core';
import { sevenSegmentText } from '@benchtop/parts';
import { buildBench, type CliIo, loadFirmware, loadProject, parseJson, projectFromJson, readText, resolvePin, UsageError } from './load.ts';

export { UsageError } from './load.ts';

export interface RunOptions {
  project: string;
  /** Board part id → firmware file path. */
  firmware: Readonly<Record<string, string>>;
  script?: string | undefined;
  /** A script given as its parsed JSON instead of a file (BT48: a test spec's steps). */
  scriptJson?: unknown;
  /** The project as parsed JSON instead of the file `project` (BT50: a recorded spec's inline circuit). */
  projectJson?: unknown;
  expect: readonly string[];
  duration?: string | undefined;
}

export type RunIo = CliIo;

export interface AssertionResult {
  text: string;
  ok: boolean;
  /** When it was decided: the match time (serial) or the asked time (pin); null if never seen. */
  atNs: number | null;
  detail: string;
}

export interface RunReport {
  ok: boolean;
  exitCode: 0 | 1 | 2;
  simulatedNs: number;
  wallMs: number;
  simulatedMHz: number;
  assertions: AssertionResult[];
  /** Each board's UART 0 output (the first 1 MB). */
  serial: Record<string, string>;
  problems: Problem[];
  error: string | null;
}

/** Serial text kept per board in the report. */
export const SERIAL_CAP = 1024 * 1024;

const UNITS: Record<string, number> = { ns: 1, us: 1e3, ms: 1e6, s: 1e9 };

/** "<number><ns|us|ms|s>" → ns. */
export function parseTime(text: string): number {
  const m = /^(\d+(?:\.\d+)?)(ns|us|ms|s)$/.exec(text.trim());
  if (m === null) {
    throw new UsageError(/^\d+(?:\.\d+)?$/.test(text.trim()) ? `time "${text}" needs a unit (ns, us, ms or s)` : `not a time: "${text}" (e.g. 500ms, 2s)`);
  }
  return Math.round(Number(m[1]) * UNITS[m[2]]);
}

/** "1.5 s", "500 ms", "250 µs", "40 ns". */
export function formatNs(ns: number): string {
  if (ns >= 1e9) return `${+(ns / 1e9).toFixed(6)} s`;
  if (ns >= 1e6) return `${+(ns / 1e6).toFixed(6)} ms`;
  if (ns >= 1e3) return `${+(ns / 1e3).toFixed(3)} µs`;
  return `${ns} ns`;
}

type Level = 0 | 1 | 'z' | 'x';

export type Assertion =
  | { kind: 'serial'; text: string; board: string | null; needle: string; by: number }
  | { kind: 'match'; text: string; board: string | null; regex: RegExp; by: number }
  | { kind: 'pin'; text: string; part: string; pin: string; level: Level; at: number }
  | { kind: 'led'; text: string; part: string; lit: boolean; at: number }
  | { kind: 'servo'; text: string; part: string; angle: number; tolerance: number; at: number }
  | { kind: 'lcd'; text: string; part: string; row: number; expected: string; at: number }
  | { kind: 'pixel'; text: string; part: string; index: number; rgb: number; at: number }
  | { kind: 'digits'; text: string; part: string; expected: string; at: number }
  | { kind: 'frequency'; text: string; part: string; pin: string; hz: number; percent: number; from: number; to: number }
  | { kind: 'duty'; text: string; part: string; pin: string; percent: number; tolerance: number; from: number; to: number };

/** The time an assertion is decided at: its `at`, its `by`, or the end of its window. */
export function decidedAt(a: Assertion): number {
  if (a.kind === 'serial' || a.kind === 'match') return a.by;
  if (a.kind === 'frequency' || a.kind === 'duty') return a.to;
  return a.at;
}

/** The longest regex source `serial matches` takes (patterns come from users' files). */
export const MAX_REGEX_SOURCE = 1024;

function unescape(quoted: string, text: string): string {
  return quoted.replace(/\\(.)/g, (_, c: string) => {
    if (c === '"' || c === '\\') return c;
    if (c === 'n') return '\n';
    throw new UsageError(`unknown escape \\${c} in: ${text}`);
  });
}

const FORMS = [
  'serial contains "<text>" by <time>',
  'serial matches /<regex>/ by <time>',
  'pin <part>:<pin> is <0|1|z|x> at <time>',
  'pin <part>:<pin> frequency is <hz> ±<pct>% between <time> and <time>',
  'pin <part>:<pin> duty is <pct>% ±<pct>% between <time> and <time>',
  'led <part> is <lit|dark> at <time>',
  'servo <part> angle is <deg> ±<deg> at <time>',
  'lcd <part> row <n> is "<text>" at <time>',
  'pixel <part>[<i>] is #rrggbb at <time>',
  'digits <part> show "<text>" at <time>',
];

const NUM = String.raw`(\d+(?:\.\d+)?)`;
const PM = String.raw`\s*(?:±|\+-|\+\/-)\s*`;
const QUOTED = String.raw`"((?:[^"\\]|\\.)*)"`;
const re = (source: string): RegExp => new RegExp(`^${source}$`);
const GRAMMAR = {
  serial: re(String.raw`serial(?:\[([^\]]+)\])?\s+contains\s+${QUOTED}\s+by\s+(\S+)`),
  match: re(String.raw`serial(?:\[([^\]]+)\])?\s+matches\s+\/(.+)\/([a-z]*)\s+by\s+(\S+)`),
  pin: re(String.raw`pin\s+([^\s:]+):(\S+)\s+is\s+([01zx])\s+at\s+(\S+)`),
  frequency: re(String.raw`pin\s+([^\s:]+):(\S+)\s+frequency\s+is\s+${NUM}\s*(?:Hz)?${PM}${NUM}\s*%\s+between\s+(\S+)\s+and\s+(\S+)`),
  duty: re(String.raw`pin\s+([^\s:]+):(\S+)\s+duty\s+is\s+${NUM}\s*%${PM}${NUM}\s*%?\s+between\s+(\S+)\s+and\s+(\S+)`),
  led: re(String.raw`led\s+(\S+)\s+is\s+(lit|dark)\s+at\s+(\S+)`),
  servo: re(String.raw`servo\s+(\S+)\s+angle\s+is\s+(-?\d+(?:\.\d+)?)\s*°?${PM}${NUM}\s*°?\s+at\s+(\S+)`),
  lcd: re(String.raw`lcd\s+(\S+)\s+row\s+(\d+)\s+is\s+${QUOTED}\s+at\s+(\S+)`),
  pixel: re(String.raw`pixel\s+([^\s[]+)\[(\d+)\]\s+is\s+#([0-9a-fA-F]{6})\s+at\s+(\S+)`),
  digits: re(String.raw`digits\s+(\S+)\s+shows?\s+${QUOTED}\s+at\s+(\S+)`),
};

/** A regex from `serial matches /…/flags`: i, m, s and u only (g and y would make it stateful). */
function serialRegex(source: string, flags: string, text: string): RegExp {
  if (source.length > MAX_REGEX_SOURCE) throw new UsageError(`${text}: the regex is longer than ${MAX_REGEX_SOURCE} characters`);
  if (!/^[imsu]*$/.test(flags)) throw new UsageError(`${text}: regex flags may be i, m, s and u`);
  try {
    return new RegExp(source, flags);
  } catch (error) {
    throw new UsageError(`${text}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** One assertion from its text. */
export function parseAssertion(text: string): Assertion {
  const t = text.trim();
  let m: RegExpExecArray | null;
  if ((m = GRAMMAR.serial.exec(t)) !== null) return { kind: 'serial', text: t, board: m[1] ?? null, needle: unescape(m[2], t), by: parseTime(m[3]) };
  if ((m = GRAMMAR.match.exec(t)) !== null) return { kind: 'match', text: t, board: m[1] ?? null, regex: serialRegex(m[2], m[3], t), by: parseTime(m[4]) };
  if ((m = GRAMMAR.pin.exec(t)) !== null) {
    const level: Level = m[3] === '0' ? 0 : m[3] === '1' ? 1 : (m[3] as 'z' | 'x');
    return { kind: 'pin', text: t, part: m[1], pin: m[2], level, at: parseTime(m[4]) };
  }
  if ((m = GRAMMAR.frequency.exec(t)) !== null) {
    const a = { kind: 'frequency' as const, text: t, part: m[1], pin: m[2], hz: Number(m[3]), percent: Number(m[4]), from: parseTime(m[5]), to: parseTime(m[6]) };
    if (a.hz <= 0) throw new UsageError(`${t}: the frequency must be above 0 Hz`);
    if (a.to <= a.from) throw new UsageError(`${t}: the window must end after it starts`);
    return a;
  }
  if ((m = GRAMMAR.duty.exec(t)) !== null) {
    const a = { kind: 'duty' as const, text: t, part: m[1], pin: m[2], percent: Number(m[3]), tolerance: Number(m[4]), from: parseTime(m[5]), to: parseTime(m[6]) };
    if (a.percent > 100) throw new UsageError(`${t}: a duty cycle is at most 100 %`);
    if (a.to <= a.from) throw new UsageError(`${t}: the window must end after it starts`);
    return a;
  }
  if ((m = GRAMMAR.led.exec(t)) !== null) return { kind: 'led', text: t, part: m[1], lit: m[2] === 'lit', at: parseTime(m[3]) };
  if ((m = GRAMMAR.servo.exec(t)) !== null) return { kind: 'servo', text: t, part: m[1], angle: Number(m[2]), tolerance: Number(m[3]), at: parseTime(m[4]) };
  if ((m = GRAMMAR.lcd.exec(t)) !== null) return { kind: 'lcd', text: t, part: m[1], row: Number(m[2]), expected: unescape(m[3], t), at: parseTime(m[4]) };
  if ((m = GRAMMAR.pixel.exec(t)) !== null) return { kind: 'pixel', text: t, part: m[1], index: Number(m[2]), rgb: Number.parseInt(m[3], 16), at: parseTime(m[4]) };
  if ((m = GRAMMAR.digits.exec(t)) !== null) return { kind: 'digits', text: t, part: m[1], expected: unescape(m[2], t), at: parseTime(m[3]) };
  throw new UsageError(`not an assertion: ${t} (expected one of: ${FORMS.join(' · ')})`);
}

export type ScriptStep = { kind: 'input'; at: number; part: string; input: PartInput } | { kind: 'serial'; at: number; board: string; text: string };

/** Characters one serial step may send. */
export const MAX_SERIAL_STEP = 64 * 1024;

function parseInput(value: unknown, where: string): PartInput {
  const v = value as Record<string, unknown> | null;
  if (typeof v !== 'object' || v === null) throw new UsageError(`${where}: input must be an object`);
  switch (v.kind) {
    case 'press':
    case 'release':
      return { kind: v.kind };
    case 'value':
      if (typeof v.value !== 'number' || !Number.isFinite(v.value)) throw new UsageError(`${where}: a value input needs a finite number "value"`);
      return { kind: 'value', value: v.value };
    case 'key':
      if (typeof v.key !== 'string' || typeof v.down !== 'boolean') throw new UsageError(`${where}: a key input needs a string "key" and a boolean "down"`);
      return { kind: 'key', key: v.key, down: v.down };
    default:
      throw new UsageError(`${where}: input kind must be press, release, value or key`);
  }
}

/** A script file's steps and assertions; part ids and boards are checked against the project. */
export function parseScript(json: unknown, doc: ProjectDoc, boards: readonly string[]): { steps: ScriptStep[]; expect: string[] } {
  const body = json as { steps?: unknown; expect?: unknown } | unknown[];
  const steps = Array.isArray(body) ? body : body?.steps;
  const expect = Array.isArray(body) ? [] : (body?.expect ?? []);
  if (!Array.isArray(steps)) throw new UsageError('script: expected an array of steps, or { "steps": [...], "expect": [...] }');
  if (!Array.isArray(expect) || expect.some((e) => typeof e !== 'string')) throw new UsageError('script: "expect" must be an array of strings');
  const parts = new Set(doc.parts.map((p) => p.id));
  const parsed = steps.map((raw: unknown, i): ScriptStep => {
    const step = raw as { at?: unknown; part?: unknown; input?: unknown; serial?: unknown; board?: unknown } | null;
    const where = `script step ${i + 1}`;
    if (typeof step !== 'object' || step === null) throw new UsageError(`${where}: must be an object`);
    if (typeof step.at !== 'string') throw new UsageError(`${where}: "at" must be a time string like "100ms"`);
    if (step.serial !== undefined) {
      if (typeof step.serial !== 'string') throw new UsageError(`${where}: "serial" must be a string`);
      if (step.serial.length > MAX_SERIAL_STEP) throw new UsageError(`${where}: "serial" is longer than ${MAX_SERIAL_STEP} characters`);
      let board: string;
      if (step.board === undefined) {
        if (boards.length !== 1) throw new UsageError(`${where}: the project has ${boards.length} boards; say "board"`);
        board = boards[0];
      } else if (typeof step.board !== 'string' || !boards.includes(step.board)) throw new UsageError(`${where}: no board "${String(step.board)}" in the project`);
      else board = step.board;
      return { kind: 'serial', at: parseTime(step.at), board, text: step.serial };
    }
    if (typeof step.part !== 'string' || !parts.has(step.part)) throw new UsageError(`${where}: no part "${String(step.part)}" in the project`);
    return { kind: 'input', at: parseTime(step.at), part: step.part, input: parseInput(step.input, where) };
  });
  return { steps: parsed, expect: expect as string[] };
}

/** `run` arguments: <project.json> [--firmware <board>=<path>]… [--script f] [--expect a]… [--duration t] [--report f]. */
export function parseRunArgs(argv: readonly string[]): RunOptions & { report?: string | undefined } {
  let project: string | undefined;
  const firmware: Record<string, string> = {};
  const expect: string[] = [];
  let script: string | undefined;
  let duration: string | undefined;
  let report: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`${arg} needs a value`);
      return v;
    };
    if (arg === '--firmware') {
      const v = value();
      const eq = v.indexOf('=');
      if (eq <= 0 || eq === v.length - 1) throw new UsageError(`--firmware wants <board>=<path>, got "${v}"`);
      firmware[v.slice(0, eq)] = v.slice(eq + 1);
    } else if (arg === '--expect') expect.push(value());
    else if (arg === '--script') script = value();
    else if (arg === '--duration') duration = value();
    else if (arg === '--report') report = value();
    else if (arg.startsWith('--')) throw new UsageError(`unknown option ${arg}`);
    else if (project === undefined) project = arg;
    else throw new UsageError(`unexpected argument "${arg}"`);
  }
  if (project === undefined) throw new UsageError('no project file given');
  return { project, firmware, expect, script, duration, report };
}

const levelOf = (state: NetState): Level => (state.conflict ? 'x' : state.level === null ? 'z' : state.level);

/** LCD part types → columns and rows. */
const LCD_SIZES: Readonly<Record<string, { cols: number; rows: number }>> = {
  lcd1602: { cols: 16, rows: 2 },
  'lcd1602-i2c': { cols: 16, rows: 2 },
  lcd2004: { cols: 20, rows: 4 },
  'lcd2004-i2c': { cols: 20, rows: 4 },
};

/** Which part types each visual expectation reads, for usage errors. */
const VISUAL_TYPES: Readonly<Record<'led' | 'servo' | 'lcd' | 'pixel' | 'digits', { test: (type: string) => boolean; what: string }>> = {
  led: { test: (t) => t === 'led', what: 'an LED' },
  servo: { test: (t) => t === 'servo', what: 'a servo' },
  lcd: { test: (t) => Object.hasOwn(LCD_SIZES, t), what: 'a character LCD' },
  pixel: { test: (t) => t.startsWith('neopixel-'), what: 'a NeoPixel strip, ring or matrix' },
  digits: { test: (t) => t.startsWith('seven-segment'), what: 'a 7-segment display' },
};

/** Checks an assertion's parts, pins and boards against the project (and resolves pin names). */
function checkAgainstProject(a: Assertion, doc: ProjectDoc, boards: readonly string[]): void {
  if (a.kind === 'serial' || a.kind === 'match') {
    if (a.board === null) {
      if (boards.length !== 1) throw new UsageError(`${a.text}: the project has ${boards.length} boards; say serial[<board>]`);
      a.board = boards[0];
    } else if (!boards.includes(a.board)) throw new UsageError(`${a.text}: no board "${a.board}"`);
    return;
  }
  const part = doc.parts.find((p) => p.id === a.part);
  if (part === undefined) throw new UsageError(`${a.text}: no part "${a.part}"`);
  if (a.kind === 'pin' || a.kind === 'frequency' || a.kind === 'duty') {
    const name = resolvePin(doc, a.part, a.pin);
    if (name === undefined) throw new UsageError(`${a.text}: "${a.part}" has no pin "${a.pin}"`);
    a.pin = name;
    return;
  }
  const kind = VISUAL_TYPES[a.kind];
  if (!kind.test(part.type)) throw new UsageError(`${a.text}: "${a.part}" is a ${part.type}, not ${kind.what}`);
  if (a.kind === 'lcd' && a.row >= LCD_SIZES[part.type].rows) throw new UsageError(`${a.text}: a ${part.type} has rows 0–${LCD_SIZES[part.type].rows - 1}`);
}

const hex = (rgb: number): string => `#${rgb.toString(16).padStart(6, '0')}`;
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

/** A visual expectation against the part's latest visual state. */
function checkVisual(
  a: Extract<Assertion, { kind: 'led' | 'servo' | 'lcd' | 'pixel' | 'digits' }>,
  visual: VisualState | undefined,
  type: string,
): { ok: boolean; detail: string } {
  switch (a.kind) {
    case 'led': {
      const b = num(visual?.brightness) ?? 0; // an LED that never reported is dark
      return { ok: a.lit ? b >= LIT : b <= DARK, detail: `brightness ${b.toFixed(2)}` };
    }
    case 'servo': {
      const angle = num(visual?.angle);
      if (angle === undefined) return { ok: false, detail: 'no angle reported' };
      return { ok: Math.abs(angle - a.angle) <= a.tolerance, detail: `angle ${angle}°` };
    }
    case 'lcd': {
      const { cols } = LCD_SIZES[type];
      const chars = (Array.isArray(visual?.characters) ? visual.characters : []) as number[];
      const row = visual?.displayOn === true ? String.fromCharCode(...chars.slice(a.row * cols, (a.row + 1) * cols)) : '';
      return { ok: row.trimEnd() === a.expected.trimEnd(), detail: `row ${a.row} is ${JSON.stringify(row.trimEnd())}${visual?.displayOn === true ? '' : ' (display off)'}` };
    }
    case 'pixel': {
      const pixels = (Array.isArray(visual?.pixels) ? visual.pixels : []) as number[];
      if (a.index >= pixels.length) return { ok: false, detail: `it has ${pixels.length} pixels` };
      return { ok: pixels[a.index] === a.rgb, detail: hex(pixels[a.index]) };
    }
    case 'digits': {
      const shown = sevenSegmentText((Array.isArray(visual?.values) ? visual.values : []) as number[]);
      return { ok: shown === a.expected, detail: `shows ${JSON.stringify(shown)}` };
    }
  }
}

/** An LED is lit at this brightness or more, dark at DARK or less (in between: dim, neither). */
const LIT = 0.3;
const DARK = 0.05;
/** A window's probe is drained at least this often (ns). */
const DRAIN_NS = 50e6;

interface Window {
  a: Extract<Assertion, { kind: 'frequency' | 'duty' }>;
  probe: number;
  /** The next probe edge to read (absolute index). */
  cursor: number;
  lastTime: number;
  lastLevel: number;
  highNs: number;
  rises: number;
  firstRise: number;
  lastRise: number;
  lost: number;
}

function openWindow(bench: Bench, a: Window['a']): Window {
  const probe = bench.addProbe({ part: a.part, pin: a.pin });
  if (probe < 0) throw new UsageError(`${a.text}: too many probed pins (at most ${MAX_PROBES})`);
  const state = bench.pinState(a.part, a.pin);
  const level = state === undefined || state.conflict || state.level === null ? 2 : state.level;
  const read = bench.readProbe(probe, 0);
  return { a, probe, cursor: read === undefined ? 0 : read.from + read.times.length, lastTime: bench.now(), lastLevel: level, highNs: 0, rises: 0, firstRise: -1, lastRise: -1, lost: 0 };
}

/** Folds the probe's new edges into the window's high time and rising edges. */
function drainWindow(bench: Bench, w: Window): void {
  const read = bench.readProbe(w.probe, w.cursor);
  if (read === undefined) return;
  w.lost += read.lost;
  w.cursor = read.from + read.times.length;
  const { from, to } = w.a;
  for (let i = 0; i < read.times.length; i++) {
    const time = read.times[i];
    const level = read.levels[i];
    const start = Math.max(w.lastTime, from);
    const end = Math.min(time, to);
    if (end > start && w.lastLevel === 1) w.highNs += end - start;
    if (level === 1 && w.lastLevel !== 1 && time >= from && time <= to) {
      if (w.firstRise < 0) w.firstRise = time;
      w.lastRise = time;
      w.rises++;
    }
    w.lastTime = time;
    w.lastLevel = level;
  }
}

/** The window's verdict at its end (edges already drained). */
function closeWindow(w: Window): { ok: boolean; detail: string } {
  const { a } = w;
  const start = Math.max(w.lastTime, a.from);
  if (a.to > start && w.lastLevel === 1) w.highNs += a.to - start;
  w.lastTime = a.to;
  if (w.lost > 0) return { ok: false, detail: `the probe dropped ${w.lost} edges; shorten the window` };
  if (a.kind === 'duty') {
    const duty = (100 * w.highNs) / (a.to - a.from);
    return { ok: Math.abs(duty - a.percent) <= a.tolerance, detail: `measured ${duty.toFixed(2)} %` };
  }
  if (w.rises < 2) return { ok: false, detail: `${w.rises} rising edge${w.rises === 1 ? '' : 's'} between ${formatNs(a.from)} and ${formatNs(a.to)}` };
  const hz = ((w.rises - 1) * 1e9) / (w.lastRise - w.firstRise);
  return { ok: Math.abs(hz - a.hz) <= (a.hz * a.percent) / 100, detail: `measured ${hz.toFixed(2)} Hz` };
}

/** Runs a project headless. Never throws: errors become exit code 2 in the report. */
export function runHeadless(options: RunOptions, io: RunIo): RunReport {
  const start = io.now();
  const report: RunReport = {
    ok: false,
    exitCode: 2,
    simulatedNs: 0,
    wallMs: 0,
    simulatedMHz: 0,
    assertions: [],
    serial: {},
    problems: [],
    error: null,
  };
  const mcus: Mcu[] = [];
  const finish = (): RunReport => {
    report.wallMs = Math.round((io.now() - start) * 10) / 10;
    const cycles = mcus.reduce((sum, mcu) => sum + mcu.cycles, 0);
    report.simulatedMHz = report.wallMs > 0 ? Math.round((cycles / (report.wallMs * 1000)) * 100) / 100 : 0;
    report.ok = report.exitCode === 0;
    return report;
  };
  try {
    // Project and everything that refers to it.
    const { doc, boards } = options.projectJson !== undefined ? projectFromJson(options.projectJson) : loadProject(io, options.project);
    const scriptJson = options.scriptJson ?? (options.script === undefined ? undefined : parseJson(readText(io, options.script, 'script'), options.script));
    const script = scriptJson === undefined ? { steps: [], expect: [] } : parseScript(scriptJson, doc, boards);
    const assertions = [...options.expect, ...script.expect].map(parseAssertion);
    for (const a of assertions) checkAgainstProject(a, doc, boards);

    // Duration: --duration, else the latest scripted or asserted time.
    const times = [...script.steps.map((s) => s.at), ...assertions.map(decidedAt)];
    let duration: number;
    if (options.duration !== undefined) duration = parseTime(options.duration);
    else if (times.length > 0) duration = Math.max(...times);
    else throw new UsageError('nothing sets the run length: pass --duration, a script or an assertion');
    for (const a of assertions) {
      const t = decidedAt(a);
      if (t > duration) throw new UsageError(`${a.text}: ${formatNs(t)} is past the run's ${formatNs(duration)}`);
    }

    const images = loadFirmware(io, doc, boards, options.firmware);
    const built = buildBench(doc, images, io.esp32Rom?.());
    const bench = built.bench;
    mcus.push(...built.mcus);

    // Serial: the report keeps the first SERIAL_CAP characters; `contains` streams every chunk,
    // `matches` runs once at the end over the kept text, timed by the chunk its match ends in.
    const containsAssertions = assertions.filter((a) => a.kind === 'serial');
    const seen = containsAssertions.map(() => ({ carry: '', at: null as number | null }));
    const chunkEnds: Record<string, number[]> = {};
    const chunkTimes: Record<string, number[]> = {};
    for (const board of boards) {
      report.serial[board] = '';
      chunkEnds[board] = [];
      chunkTimes[board] = [];
      const decoder = new TextDecoder();
      bench.onSerial(board, (bytes) => {
        const chunk = decoder.decode(bytes, { stream: true });
        const kept = report.serial[board];
        if (kept.length < SERIAL_CAP && chunk.length > 0) {
          report.serial[board] = kept + chunk.slice(0, SERIAL_CAP - kept.length);
          chunkEnds[board].push(report.serial[board].length);
          chunkTimes[board].push(bench.now());
        }
        containsAssertions.forEach((a, i) => {
          const state = seen[i];
          if (a.board !== board || state.at !== null) return;
          const window = state.carry + chunk;
          if (window.includes(a.needle)) state.at = bench.now();
          else state.carry = a.needle.length > 1 ? window.slice(-(a.needle.length - 1)) : '';
        });
      });
    }
    containsAssertions.forEach((a, i) => {
      if (a.needle === '') seen[i].at = 0;
    });

    // Windows (frequency, duty): a probe per pin, its edges drained at every stop and every
    // 50 ms inside a window so its ring never overflows below ~1.3 MHz.
    const windows = assertions.filter((a) => a.kind === 'frequency' || a.kind === 'duty').map((a) => openWindow(bench, a));
    const drains: number[] = [];
    for (const w of windows) for (let t = w.a.from; t < w.a.to; t += DRAIN_NS) drains.push(t);

    // The timeline: at each distinct time, drain the windows, apply the steps (file order),
    // collect what parts show, then check what is due then.
    const encoder = new TextEncoder();
    const results = new Map<Assertion, AssertionResult>();
    const latest = new Map<string, VisualState>();
    const collect = (): void => {
      for (const [part, visual] of bench.collectFrame().parts) latest.set(part, visual);
    };
    collect();
    const stops = [...new Set([...times, ...drains, ...windows.map((w) => w.a.from), duration])].sort((a, b) => a - b);
    for (const t of stops) {
      bench.runUntil(t);
      for (const w of windows) drainWindow(bench, w);
      for (const step of script.steps) {
        if (step.at !== t) continue;
        if (step.kind === 'serial') bench.sendSerial(step.board, encoder.encode(step.text));
        else bench.input(step.part, step.input);
      }
      collect();
      for (const a of assertions) {
        if (a.kind === 'serial' || a.kind === 'match' || decidedAt(a) !== t) continue;
        if (a.kind === 'frequency' || a.kind === 'duty') {
          const w = windows.find((x) => x.a === a) as Window;
          results.set(a, { text: a.text, atNs: t, ...closeWindow(w) });
        } else if (a.kind === 'pin') {
          const state = bench.pinState(a.part, a.pin);
          const level = state === undefined ? 'z' : levelOf(state);
          results.set(a, { text: a.text, ok: level === a.level, atNs: t, detail: `level ${level}` });
        } else {
          const type = doc.parts.find((p) => p.id === a.part)?.type ?? '';
          results.set(a, { text: a.text, atNs: t, ...checkVisual(a, latest.get(a.part), type) });
        }
      }
    }
    report.simulatedNs = bench.now();
    containsAssertions.forEach((a, i) => {
      const at = seen[i].at;
      const ok = at !== null && at <= a.by;
      const detail = at === null ? `not seen by ${formatNs(a.by)}` : ok ? `seen at ${formatNs(at)}` : `seen at ${formatNs(at)}, after ${formatNs(a.by)}`;
      results.set(a, { text: a.text, ok, atNs: at, detail });
    });
    for (const a of assertions) {
      if (a.kind !== 'match') continue;
      const board = a.board as string;
      const m = a.regex.exec(report.serial[board]);
      if (m === null) {
        results.set(a, { text: a.text, ok: false, atNs: null, detail: `no match by ${formatNs(a.by)}` });
        continue;
      }
      const end = m.index + m[0].length;
      const k = chunkEnds[board].findIndex((e) => e >= end);
      const at = k < 0 ? 0 : chunkTimes[board][k];
      const ok = at <= a.by;
      const shown = JSON.stringify(m[0].length > 60 ? `${m[0].slice(0, 57)}...` : m[0]);
      results.set(a, { text: a.text, ok, atNs: at, detail: ok ? `matched ${shown} at ${formatNs(at)}` : `matched ${shown} at ${formatNs(at)}, after ${formatNs(a.by)}` });
    }
    report.assertions = assertions.map((a) => results.get(a) as AssertionResult);
    report.problems = [...bench.problems()];
    bench.dispose();
    report.exitCode = report.assertions.every((a) => a.ok) ? 0 : 1;
  } catch (error) {
    report.exitCode = 2;
    report.error = error instanceof Error ? error.message : String(error);
  }
  return finish();
}

/** The one-line human summary main.ts prints on stderr. */
export function summaryLine(report: RunReport): string {
  if (report.exitCode === 2) return `error — ${report.error ?? 'unknown error'}`;
  const passed = report.assertions.filter((a) => a.ok).length;
  const head = `${report.ok ? 'ok' : 'FAILED'} — ${passed}/${report.assertions.length} assertions passed, ${formatNs(report.simulatedNs)} simulated in ${(report.wallMs / 1000).toFixed(2)} s (${report.simulatedMHz} MHz)`;
  const failed = report.assertions.find((a) => !a.ok);
  return failed === undefined ? head : `${head}; first failure: ${failed.text} (${failed.detail})`;
}
