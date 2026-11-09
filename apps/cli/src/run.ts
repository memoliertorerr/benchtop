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
 * - BT170: `pin <part>:<pin> volts is <v> [V] ±<v> [V] at <time>`: the net's volts then (an
 *   analog-layer net's solved volts — a capacitor's charge, a divider, a transistor's drop).
 * - BT49: `serial matches /<regex>/<imsu> by <time>` (the first match in the kept serial text,
 *   timed by when its last character arrived); `pin … frequency is <hz> [Hz] ±<pct>% between
 *   <t1> and <t2>` (rising edges in the window) and `pin … duty is <pct>% ±<points> between …`
 *   (time high over the window), both from a probe; and what parts show at a time: `led <part> is
 *   <lit|dark>` (brightness ≥ 0.3 / ≤ 0.05; BT110: a Pico's onboard LED too), `servo <part> angle is <deg> ±<deg>`,
 *   BT174: `motor <part> rpm is <rpm> ±<rpm>` (a DC motor's signed speed), `lcd <part>
 *   row <n> is "<text>"` (rows from 0, trailing spaces ignored), `pixel <part>[<i>] is #rrggbb`
 *   (a NeoPixel part, or the ESP32-C3-DevKitM-1's RGB LED as pixel 0),
 *   `digits <part> show "<text>"`. ± may be written +- or +/-.
 * - BT55: `env <gas|temperature|humidity|light|sound> at <part> is <v> ±<tol> at <time>` (or
 *   `>`, `<`, `>=`, `<=` <v>): the environment's value at a part that sits in it (a sensor, a
 *   source, a body) — ppm, °C, %RH, lux, dB.
 * - BT88: `bus i2c <part> wrote|read <hex bytes> by <time>` and `bus spi <part> sent <hex bytes>
 *   by <time>`: some transaction with that part (BT86's bus log) carried those bytes in a row —
 *   an I2C write or read, an SPI frame's MOSI — by that time (when the transaction ended).
 * - BT100: `wifi <board> connected by <time>` (the board's station got its address from an
 *   access point's DHCP server), `http <part> served <METHOD|*> <path[?query]> by <time>` (an
 *   http-server part answered such a request) and `http <part> got <status> [with "<text>"] by
 *   <time>` (an http-client part's request came back with that status, its body holding the
 *   text): the first such event on the bench's network, by that time.
 * - BT139: `usb received "<text>" by <time>` (or `usb[<board>] …`): the board's USB host (an
 *   ESP32-S3's USB-OTG port, enumerated by the bench) received the text — in what a keyboard typed
 *   or in an event's line ("mouse: left down", "MIDI: note on ch 1 C4 (60) velocity 100") — by
 *   that time; checked every 10 ms, timed by the event (or the check, for typed text).
 * - Script: an array of steps or { steps: [...], expect: [...] }. A step is { at, part, input }
 *   (a part input), { at, part, set: { <channel>: <number|boolean>, … } } (BT55: channel inputs
 *   `set:<channel>=<v>`, booleans as 1/0 — an environment source's rate or on/off, a DHT22's
 *   temperature) or { at, serial, board? } (BT48: text sent to a board's UART 0, as typed in the
 *   serial monitor; `board` may be left out with one board). Steps apply at exactly their time,
 *   in file order; assertions at the same time see their effect.
 * - BT144: { at, part, write: "<path>", text: "…" } (or base64: "…") creates or replaces a file
 *   on a part's storage — a microSD card, or an ESP32-S3 or ESP32-S2 board's USB drive — and { at, part,
 *   remove: "<path>" } deletes a file or a directory with what is in it. A file step that can't
 *   apply then (no volume, the drive not mounted yet, a bad name, full, nothing to remove) ends
 *   the run with an error naming the step.
 * - BT145: { at, midi: "90 3C 64", board? } sends whole MIDI 1.0 messages (hex bytes) from a
 *   board's USB host to the device's MIDI port (an error when it has none then); { at, locks:
 *   ["caps"], board? } sets the host's lock keys on (num, caps, scroll; [] none), which its
 *   keyboards get as their LEDs. `board` may be left out with one board whose USB port the
 *   bench hosts (an ESP32-S3 or, BT150, an ESP32-S2).
 *
 * Exit codes: 0 every assertion passed, 1 one failed, 2 usage, load or run error.
 */

import { type Bench, BusDecoder, type BusTransaction, ipString, MAX_PROBES, type Mcu, type NetEvent, type NetState, type NvSector, type PartInput, type Problem, type ProjectDoc, type UsbLocks, type VisualState } from '@benchtop/core';
import { encodeMidi } from '@benchtop/esp32s3';
import { base64Decode, CATALOG, envSpecFor, netSpecFor, sevenSegmentText } from '@benchtop/parts';
import { buildBench, cachedRoms, type CliIo, loadFirmware, loadTables, loadProject, parseJson, projectFromJson, readText, resolvePin, UsageError } from './load.ts';
import { uplinkFor } from './uplink.ts';

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
  /** BT68: the longest run accepted (ns of simulated time); a longer one is a usage error. */
  maxDurationNs?: number | undefined;
  /** BT68: wall-clock budget (ms); the run stops with an error when it is used up. */
  maxWallMs?: number | undefined;
  /** BT156: boards' EEPROM or flash data to start from (a recorded spec's `memory`; trailing 0xFF may be left out). */
  memory?: Readonly<Record<string, readonly NvSector[]>> | undefined;
}

/**
 * BT156: puts a spec's memory back on its boards — after the bench is built (the firmware booted,
 * not yet run), as the app's worker restores saved data. A board the project lacks, one without
 * memory, or a sector that isn't a data sector of its memory is a usage error naming it.
 */
export function restoreSpecMemory(bench: Bench, boards: readonly string[], memory: Readonly<Record<string, readonly NvSector[]>>): void {
  for (const [board, sectors] of Object.entries(memory)) {
    if (!boards.includes(board)) throw new UsageError(`memory: "${board}" isn't a board of the project`);
    const nv = bench.nonVolatileOf(board);
    if (nv === null) throw new UsageError(`memory.${board}: this board keeps no EEPROM or flash data`);
    const padded: NvSector[] = sectors.map((sector) => {
      const at = `0x${sector.offset.toString(16)}`;
      if (sector.offset % nv.sectorSize !== 0 || sector.offset + nv.sectorSize > nv.size) throw new UsageError(`memory.${board}: ${at} isn't the start of a sector of its ${nv.kind} (${nv.size} bytes, ${nv.sectorSize}-byte sectors)`);
      if (sector.bytes.length > nv.sectorSize) throw new UsageError(`memory.${board}: the sector at ${at} holds ${sector.bytes.length} bytes, more than its ${nv.sectorSize}`);
      const bytes = new Uint8Array(nv.sectorSize).fill(0xff);
      bytes.set(sector.bytes);
      return { offset: sector.offset, bytes };
    });
    const restored = nv.restore(padded);
    if (restored < padded.length) throw new UsageError(`memory.${board}: ${padded.length - restored} of ${padded.length} sectors fall on the firmware's own program sectors`);
  }
}

export type RunIo = CliIo;

/** Simulated time between wall-clock checks when a run has a budget. */
const WALL_SLICE_NS = 10_000_000;

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
  | { kind: 'volts'; text: string; part: string; pin: string; volts: number; tolerance: number; at: number }
  | { kind: 'led'; text: string; part: string; lit: boolean; at: number }
  | { kind: 'servo'; text: string; part: string; angle: number; tolerance: number; at: number }
  | { kind: 'motor'; text: string; part: string; rpm: number; tolerance: number; at: number }
  | { kind: 'lcd'; text: string; part: string; row: number; expected: string; at: number }
  | { kind: 'pixel'; text: string; part: string; index: number; rgb: number; at: number }
  | { kind: 'digits'; text: string; part: string; expected: string; at: number }
  | { kind: 'frequency'; text: string; part: string; pin: string; hz: number; percent: number; from: number; to: number }
  | { kind: 'duty'; text: string; part: string; pin: string; percent: number; tolerance: number; from: number; to: number }
  | { kind: 'env'; text: string; field: EnvField; part: string; op: EnvOp; value: number; tolerance: number; at: number }
  | { kind: 'bus'; text: string; bus: 'i2c' | 'spi'; part: string; how: 'wrote' | 'read' | 'sent'; bytes: number[]; by: number }
  | { kind: 'file'; text: string; part: string; path: string; needle: string; by: number }
  | { kind: 'usb'; text: string; board: string | null; needle: string; by: number }
  | { kind: 'wifi'; text: string; board: string; by: number }
  | { kind: 'served'; text: string; part: string; method: string; path: string; by: number }
  | { kind: 'got'; text: string; part: string; status: number; needle: string | null; by: number };

/** BT100: assertions decided by events on the bench's network. */
type NetAssertion = Extract<Assertion, { kind: 'wifi' | 'served' | 'got' }>;
const isNetAssertion = (a: Assertion): a is NetAssertion => a.kind === 'wifi' || a.kind === 'served' || a.kind === 'got';

type EnvField = 'gas' | 'temperature' | 'humidity' | 'light' | 'sound';
type EnvOp = 'is' | '>' | '<' | '>=' | '<=';
const ENV_UNITS: Readonly<Record<EnvField, string>> = { gas: 'ppm', temperature: '°C', humidity: '%RH', light: 'lux', sound: 'dB' };

/** The time an assertion is decided at: its `at`, its `by`, or the end of its window. */
export function decidedAt(a: Assertion): number {
  if (a.kind === 'serial' || a.kind === 'match' || a.kind === 'bus' || a.kind === 'file' || a.kind === 'usb' || isNetAssertion(a)) return a.by;
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
  'pin <part>:<pin> volts is <v> ±<v> at <time>',
  'pin <part>:<pin> frequency is <hz> ±<pct>% between <time> and <time>',
  'pin <part>:<pin> duty is <pct>% ±<pct>% between <time> and <time>',
  'led <part> is <lit|dark> at <time>',
  'servo <part> angle is <deg> ±<deg> at <time>',
  'motor <part> rpm is <rpm> ±<rpm> at <time>',
  'lcd <part> row <n> is "<text>" at <time>',
  'pixel <part>[<i>] is #rrggbb at <time>',
  'digits <part> show "<text>" at <time>',
  'env <gas|temperature|humidity|light|sound> at <part> is <v> ±<tol> at <time> (or > < >= <= <v>)',
  'bus i2c <part> wrote|read <hex bytes> by <time>',
  'bus spi <part> sent <hex bytes> by <time>',
  'file <part> <path> contains "<text>" by <time>',
  'wifi <board> connected by <time>',
  'http <server part> served <METHOD> <path> by <time>',
  'http <client part> got <status> [with "<text>"] by <time>',
  'usb received "<text>" by <time>',
];

const NUM = String.raw`(\d+(?:\.\d+)?)`;
const PM = String.raw`\s*(?:±|\+-|\+\/-)\s*`;
const QUOTED = String.raw`"((?:[^"\\]|\\.)*)"`;
const re = (source: string): RegExp => new RegExp(`^${source}$`);
const GRAMMAR = {
  serial: re(String.raw`serial(?:\[([^\]]+)\])?\s+contains\s+${QUOTED}\s+by\s+(\S+)`),
  match: re(String.raw`serial(?:\[([^\]]+)\])?\s+matches\s+\/(.+)\/([a-z]*)\s+by\s+(\S+)`),
  pin: re(String.raw`pin\s+([^\s:]+):(\S+)\s+is\s+([01zx])\s+at\s+(\S+)`),
  volts: re(String.raw`pin\s+([^\s:]+):(\S+)\s+volts\s+is\s+(-?\d+(?:\.\d+)?)\s*V?${PM}${NUM}\s*V?\s+at\s+(\S+)`),
  frequency: re(String.raw`pin\s+([^\s:]+):(\S+)\s+frequency\s+is\s+${NUM}\s*(?:Hz)?${PM}${NUM}\s*%\s+between\s+(\S+)\s+and\s+(\S+)`),
  duty: re(String.raw`pin\s+([^\s:]+):(\S+)\s+duty\s+is\s+${NUM}\s*%${PM}${NUM}\s*%?\s+between\s+(\S+)\s+and\s+(\S+)`),
  led: re(String.raw`led\s+(\S+)\s+is\s+(lit|dark)\s+at\s+(\S+)`),
  servo: re(String.raw`servo\s+(\S+)\s+angle\s+is\s+(-?\d+(?:\.\d+)?)\s*°?${PM}${NUM}\s*°?\s+at\s+(\S+)`),
  motor: re(String.raw`motor\s+(\S+)\s+rpm\s+is\s+(-?\d+(?:\.\d+)?)${PM}${NUM}\s+at\s+(\S+)`),
  lcd: re(String.raw`lcd\s+(\S+)\s+row\s+(\d+)\s+is\s+${QUOTED}\s+at\s+(\S+)`),
  pixel: re(String.raw`pixel\s+([^\s[]+)\[(\d+)\]\s+is\s+#([0-9a-fA-F]{6})\s+at\s+(\S+)`),
  digits: re(String.raw`digits\s+(\S+)\s+shows?\s+${QUOTED}\s+at\s+(\S+)`),
  env: re(String.raw`env\s+(gas|temperature|humidity|light|sound)\s+at\s+(\S+)\s+(?:is\s+(-?\d+(?:\.\d+)?)${PM}${NUM}|(>=|<=|>|<)\s*(-?\d+(?:\.\d+)?))\s+at\s+(\S+)`),
  bus: re(String.raw`bus\s+(i2c|spi)\s+(\S+)\s+(wrote|read|sent)\s+((?:[0-9a-fA-F]{2}\s+)*[0-9a-fA-F]{2})\s+by\s+(\S+)`),
  file: re(String.raw`file\s+(\S+)\s+(\S+)\s+contains\s+${QUOTED}\s+by\s+(\S+)`),
  wifi: re(String.raw`wifi\s+(\S+)\s+connected\s+by\s+(\S+)`),
  served: re(String.raw`http\s+(\S+)\s+served\s+(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|\*)\s+(\/\S*)\s+by\s+(\S+)`),
  got: re(String.raw`http\s+(\S+)\s+got\s+(\d{3})(?:\s+with\s+${QUOTED})?\s+by\s+(\S+)`),
  usb: re(String.raw`usb(?:\[([^\]]+)\])?\s+received\s+${QUOTED}\s+by\s+(\S+)`),
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
  if ((m = GRAMMAR.usb.exec(t)) !== null) return { kind: 'usb', text: t, board: m[1] ?? null, needle: unescape(m[2], t), by: parseTime(m[3]) };
  if ((m = GRAMMAR.pin.exec(t)) !== null) {
    const level: Level = m[3] === '0' ? 0 : m[3] === '1' ? 1 : (m[3] as 'z' | 'x');
    return { kind: 'pin', text: t, part: m[1], pin: m[2], level, at: parseTime(m[4]) };
  }
  if ((m = GRAMMAR.volts.exec(t)) !== null) {
    return { kind: 'volts', text: t, part: m[1], pin: m[2], volts: Number(m[3]), tolerance: Number(m[4]), at: parseTime(m[5]) };
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
  if ((m = GRAMMAR.motor.exec(t)) !== null) return { kind: 'motor', text: t, part: m[1], rpm: Number(m[2]), tolerance: Number(m[3]), at: parseTime(m[4]) };
  if ((m = GRAMMAR.lcd.exec(t)) !== null) return { kind: 'lcd', text: t, part: m[1], row: Number(m[2]), expected: unescape(m[3], t), at: parseTime(m[4]) };
  if ((m = GRAMMAR.pixel.exec(t)) !== null) return { kind: 'pixel', text: t, part: m[1], index: Number(m[2]), rgb: Number.parseInt(m[3], 16), at: parseTime(m[4]) };
  if ((m = GRAMMAR.digits.exec(t)) !== null) return { kind: 'digits', text: t, part: m[1], expected: unescape(m[2], t), at: parseTime(m[3]) };
  if ((m = GRAMMAR.env.exec(t)) !== null) {
    const field = m[1] as EnvField;
    if (m[3] !== undefined) return { kind: 'env', text: t, field, part: m[2], op: 'is', value: Number(m[3]), tolerance: Number(m[4]), at: parseTime(m[7]) };
    return { kind: 'env', text: t, field, part: m[2], op: m[5] as EnvOp, value: Number(m[6]), tolerance: 0, at: parseTime(m[7]) };
  }
  if ((m = GRAMMAR.bus.exec(t)) !== null) {
    const bus = m[1] as 'i2c' | 'spi';
    const how = m[3] as 'wrote' | 'read' | 'sent';
    if (bus === 'i2c' && how === 'sent') throw new UsageError(`${t}: an I2C transaction "wrote" or "read" its bytes`);
    if (bus === 'spi' && how !== 'sent') throw new UsageError(`${t}: an SPI frame "sent" its bytes`);
    return { kind: 'bus', text: t, bus, part: m[2], how, bytes: m[4].split(/\s+/).map((h) => Number.parseInt(h, 16)), by: parseTime(m[5]) };
  }
  if ((m = GRAMMAR.file.exec(t)) !== null) return { kind: 'file', text: t, part: m[1], path: m[2], needle: unescape(m[3], t), by: parseTime(m[4]) };
  if ((m = GRAMMAR.wifi.exec(t)) !== null) return { kind: 'wifi', text: t, board: m[1], by: parseTime(m[2]) };
  if ((m = GRAMMAR.served.exec(t)) !== null) return { kind: 'served', text: t, part: m[1], method: m[2], path: m[3], by: parseTime(m[4]) };
  if ((m = GRAMMAR.got.exec(t)) !== null) return { kind: 'got', text: t, part: m[1], status: Number(m[2]), needle: m[3] === undefined ? null : unescape(m[3], t), by: parseTime(m[4]) };
  throw new UsageError(`not an assertion: ${t} (expected one of: ${FORMS.join(' · ')})`);
}

/** Whether `bytes` holds `seq` in a row. */
function containsRun(bytes: readonly number[], seq: readonly number[]): boolean {
  outer: for (let i = 0; i + seq.length <= bytes.length; i++) {
    for (let k = 0; k < seq.length; k++) if (bytes[i + k] !== seq[k]) continue outer;
    return true;
  }
  return false;
}

/** BT88: whether a transaction with `part` (the source's part) satisfies a bus assertion. */
function busMatches(a: Extract<Assertion, { kind: 'bus' }>, tx: BusTransaction, part: string | null): boolean {
  if (part !== a.part || tx.bus !== a.bus) return false;
  if (tx.bus === 'i2c') return tx.read === (a.how === 'read') && containsRun(tx.bytes, a.bytes);
  if (tx.bus === 'spi') return containsRun(tx.mosi, a.bytes);
  return false;
}

export type ScriptStep =
  | { kind: 'input'; at: number; part: string; input: PartInput }
  | { kind: 'serial'; at: number; board: string; text: string }
  /** BT119: a board reset (a power cycle: its EEPROM or flash keeps what it stored). */
  | { kind: 'reset'; at: number; board: string }
  /** BT144: a file created or replaced on a part's storage (a microSD card, an S3 board's USB drive). */
  | { kind: 'write'; at: number; part: string; path: string; bytes: Uint8Array; where: string }
  /** BT144: a file or a directory (with what is in it) removed from a part's storage. */
  | { kind: 'remove'; at: number; part: string; path: string; where: string }
  /** BT145: MIDI messages from a board's USB host to its device. */
  | { kind: 'midi'; at: number; board: string; bytes: Uint8Array; where: string }
  /** BT145: the lock keys of a board's USB host. */
  | { kind: 'locks'; at: number; board: string; locks: UsbLocks };

type FileStep = Extract<ScriptStep, { kind: 'write' | 'remove' }>;

/** BT144: bytes one `write` step may hold (a spec file holds 1 MB). */
export const MAX_FILE_STEP = 256 * 1024;
/** Characters a file step's path may have. */
const MAX_FILE_PATH = 1024;

/** BT150: boards whose own USB port the bench hosts — USB-OTG on an ESP32-S3 or an ESP32-S2. */
export function hostsUsb(mcu: string | undefined): boolean {
  return mcu === 'esp32s3' || mcu === 'esp32s2';
}

/** Part types whose storage file steps and `file` assertions read: a microSD card, an ESP32-S3 or ESP32-S2 board (its USB drive). */
function keepsFiles(type: string): boolean {
  return FILE_TYPES.has(type) || hostsUsb(CATALOG.get(type)?.board?.mcu);
}

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

/** Channels one `set` step may set. */
export const MAX_SET_CHANNELS = 32;

/** A `set` step's channels → channel inputs (`set:<channel>=<v>`, booleans as 1/0), in key order. */
function parseSet(value: unknown, where: string): PartInput[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new UsageError(`${where}: "set" must map channel names to numbers or booleans`);
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) throw new UsageError(`${where}: "set" names no channel`);
  if (entries.length > MAX_SET_CHANNELS) throw new UsageError(`${where}: "set" names more than ${MAX_SET_CHANNELS} channels`);
  return entries.map(([channel, v]) => {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/.test(channel)) throw new UsageError(`${where}: "${channel}" is not a channel name`);
    if (typeof v === 'boolean') return { kind: 'key', key: `set:${channel}=${v ? 1 : 0}`, down: true };
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new UsageError(`${where}: "set.${channel}" must be a finite number or a boolean`);
    return { kind: 'key', key: `set:${channel}=${v}`, down: true };
  });
}

/** BT144: a `write` or `remove` step (its part is in the project). */
function parseFileStep(step: { at?: unknown; input?: unknown; set?: unknown; write?: unknown; remove?: unknown; text?: unknown; base64?: unknown }, part: string, doc: ProjectDoc, where: string): FileStep {
  if (step.input !== undefined || step.set !== undefined || (step.write !== undefined && step.remove !== undefined)) throw new UsageError(`${where}: give one of "input", "set", "write" or "remove"`);
  const type = doc.parts.find((p) => p.id === part)?.type ?? '';
  if (!keepsFiles(type)) throw new UsageError(`${where}: "${part}" is a ${type}, not a part that keeps files (a microSD card, or an ESP32-S3 or ESP32-S2 board's USB drive)`);
  const key = step.write !== undefined ? 'write' : 'remove';
  const path = step.write ?? step.remove;
  if (typeof path !== 'string' || path.trim() === '' || path.length > MAX_FILE_PATH) throw new UsageError(`${where}: "${key}" must be a file's path (up to ${MAX_FILE_PATH} characters)`);
  const at = parseTime(step.at as string);
  if (key === 'remove') {
    if (step.text !== undefined || step.base64 !== undefined) throw new UsageError(`${where}: a "remove" step takes no "text" or "base64"`);
    return { kind: 'remove', at, part, path, where };
  }
  if ((step.text === undefined) === (step.base64 === undefined)) throw new UsageError(`${where}: a "write" step needs "text" or "base64" (one of them)`);
  let bytes: Uint8Array | null;
  if (step.text !== undefined) {
    if (typeof step.text !== 'string') throw new UsageError(`${where}: "text" must be a string`);
    bytes = new TextEncoder().encode(step.text);
  } else {
    if (typeof step.base64 !== 'string') throw new UsageError(`${where}: "base64" must be a string`);
    bytes = base64Decode(step.base64);
    if (bytes === null) throw new UsageError(`${where}: "base64" is not base64`);
  }
  if (bytes.length > MAX_FILE_STEP) throw new UsageError(`${where}: a "write" step holds at most ${MAX_FILE_STEP} bytes; this one has ${bytes.length}`);
  return { kind: 'write', at, part, path, bytes, where };
}

/** BT144: a file step on its part's storage; one that can't apply ends the run, naming why. */
function applyFileStep(bench: Bench, step: FileStep): void {
  const what = `${step.where} (${step.kind === 'write' ? 'write' : 'remove'} ${step.path} on ${step.part}) at ${formatNs(step.at)}`;
  const board = bench.boards().includes(step.part);
  const drive = board ? (bench.usbOf(step.part)?.drive ?? null) : null;
  const notReady = drive !== null && drive.state !== 'mounted' ? `: its USB drive is ${drive.state}${drive.problem === '' ? '' : ` (${drive.problem})`}` : '';
  const storage = bench.storage(step.part);
  if (storage === undefined) throw new Error(`${what}: "${step.part}" keeps no files then${board ? ' (no USB drive mounted yet)' : ''}`);
  if (step.kind === 'remove') {
    if (!storage.remove(step.path)) throw new Error(`${what}: nothing there to remove${notReady}`);
    return;
  }
  if (!storage.write(step.path, step.bytes)) throw new Error(`${what}: it couldn't be written${notReady === '' ? ' (no volume, a bad name, a file where a directory goes, full or write-protected)' : notReady}`);
}

/** BT145: bytes one `midi` step may send. */
export const MAX_MIDI_STEP = 4096;
const LOCK_NAMES = ['num', 'caps', 'scroll'] as const;

/** BT145: a `midi` or `locks` step, for a board whose USB port the bench hosts. */
function parseUsbStep(step: { at?: unknown; board?: unknown; midi?: unknown; locks?: unknown; part?: unknown }, doc: ProjectDoc, boards: readonly string[], where: string): ScriptStep {
  if (step.midi !== undefined && step.locks !== undefined) throw new UsageError(`${where}: give "midi" or "locks", not both`);
  if (step.part !== undefined) throw new UsageError(`${where}: a "${step.midi !== undefined ? 'midi' : 'locks'}" step names a "board", not a "part"`);
  const hosted = boards.filter((b) => hostsUsb(CATALOG.get(doc.parts.find((p) => p.id === b)?.type ?? '')?.board?.mcu));
  let board: string;
  if (step.board === undefined) {
    if (hosted.length !== 1) throw new UsageError(`${where}: say "board" (the project's boards with a USB host: ${hosted.length === 0 ? 'none' : hosted.join(', ')})`);
    board = hosted[0];
  } else if (typeof step.board !== 'string' || !hosted.includes(step.board)) {
    throw new UsageError(`${where}: ${typeof step.board === 'string' && boards.includes(step.board) ? `"${step.board}" has no USB port the bench hosts (an ESP32-S3 or ESP32-S2 board has)` : `no board "${String(step.board)}"`}`);
  } else board = step.board;
  const at = parseTime(step.at as string);
  if (step.locks !== undefined) {
    const list = step.locks;
    if (!Array.isArray(list) || list.some((l) => typeof l !== 'string' || !(LOCK_NAMES as readonly string[]).includes(l))) throw new UsageError(`${where}: "locks" lists the lock keys on: "num", "caps", "scroll" ([] for none)`);
    return { kind: 'locks', at, board, locks: { num: list.includes('num'), caps: list.includes('caps'), scroll: list.includes('scroll') } };
  }
  if (typeof step.midi !== 'string' || !/^\s*[0-9a-fA-F]{2}(\s+[0-9a-fA-F]{2})*\s*$/.test(step.midi)) throw new UsageError(`${where}: "midi" is MIDI bytes in hex, e.g. "90 3C 64"`);
  const bytes = new Uint8Array(step.midi.trim().split(/\s+/).map((h) => Number.parseInt(h, 16)));
  if (bytes.length > MAX_MIDI_STEP) throw new UsageError(`${where}: a "midi" step sends at most ${MAX_MIDI_STEP} bytes`);
  const packets = encodeMidi(bytes);
  if (typeof packets === 'string') throw new UsageError(`${where}: ${packets}`);
  return { kind: 'midi', at, board, bytes, where };
}

/** A script file's steps and assertions; part ids and boards are checked against the project. */
export function parseScript(json: unknown, doc: ProjectDoc, boards: readonly string[]): { steps: ScriptStep[]; expect: string[] } {
  const body = json as { steps?: unknown; expect?: unknown } | unknown[];
  const steps = Array.isArray(body) ? body : body?.steps;
  const expect = Array.isArray(body) ? [] : (body?.expect ?? []);
  if (!Array.isArray(steps)) throw new UsageError('script: expected an array of steps, or { "steps": [...], "expect": [...] }');
  if (!Array.isArray(expect) || expect.some((e) => typeof e !== 'string')) throw new UsageError('script: "expect" must be an array of strings');
  const parts = new Set(doc.parts.map((p) => p.id));
  const parsed = steps.map((raw: unknown, i): ScriptStep | ScriptStep[] => {
    const step = raw as { at?: unknown; part?: unknown; input?: unknown; set?: unknown; serial?: unknown; board?: unknown; reset?: unknown; write?: unknown; remove?: unknown; text?: unknown; base64?: unknown; midi?: unknown; locks?: unknown } | null;
    const where = `script step ${i + 1}`;
    if (typeof step !== 'object' || step === null) throw new UsageError(`${where}: must be an object`);
    if (typeof step.at !== 'string') throw new UsageError(`${where}: "at" must be a time string like "100ms"`);
    if (step.reset !== undefined) {
      if (typeof step.reset !== 'string' || !boards.includes(step.reset)) throw new UsageError(`${where}: "reset" names a board of the project (${boards.join(', ') || 'none'}), not ${JSON.stringify(step.reset)}`);
      return { kind: 'reset', at: parseTime(step.at), board: step.reset };
    }
    if (step.midi !== undefined || step.locks !== undefined) return parseUsbStep(step, doc, boards, where);
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
    if (step.write !== undefined || step.remove !== undefined) return parseFileStep(step, step.part, doc, where);
    if (step.set !== undefined) {
      if (step.input !== undefined) throw new UsageError(`${where}: give "input" or "set", not both`);
      const at = parseTime(step.at);
      const part = step.part;
      return parseSet(step.set, where).map((input): ScriptStep => ({ kind: 'input', at, part, input }));
    }
    return { kind: 'input', at: parseTime(step.at), part: step.part, input: parseInput(step.input, where) };
  });
  return { steps: parsed.flat(), expect: expect as string[] };
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

/** BT110: boards whose visual state has an onboard LED's brightness as `led`. */
const BOARD_LEDS = new Set(['raspberry-pi-pico', 'raspberry-pi-pico-2', 'raspberry-pi-pico-w', 'raspberry-pi-pico-2w']);

/** Which part types each visual expectation reads, for usage errors. */
const VISUAL_TYPES: Readonly<Record<'led' | 'servo' | 'motor' | 'lcd' | 'pixel' | 'digits', { test: (type: string) => boolean; what: string }>> = {
  // BT110: the Picos' onboard LED too (their visual's `led`; the Pico W's sits on the CYW43).
  led: { test: (t) => t === 'led' || BOARD_LEDS.has(t), what: 'an LED (or a Pico, by its onboard LED)' },
  servo: { test: (t) => t === 'servo', what: 'a servo' },
  // BT174: a DC motor's visual `rpm` (signed: forward while + is the higher).
  motor: { test: (t) => t === 'dc-motor', what: 'a DC motor' },
  lcd: { test: (t) => Object.hasOwn(LCD_SIZES, t), what: 'a character LCD' },
  // BT94: the ESP32-C3-DevKitM-1's own RGB LED is a WS2812 too (its pixels[0]).
  pixel: { test: (t) => t.startsWith('neopixel-') || t === 'esp32-c3-devkitm-1' || t === 'esp32-s3-devkitc-1' || t === 'esp32-s2-devkitm-1', what: 'a NeoPixel strip, ring or matrix (or a board with one)' },
  digits: { test: (t) => t.startsWith('seven-segment'), what: 'a 7-segment display' },
};

/** BT91: parts whose files `file` assertions read (`bench.storage`). */
const FILE_TYPES: ReadonlySet<string> = new Set(['microsd-card']);

/** Checks an assertion's parts, pins and boards against the project (and resolves pin names). */
function checkAgainstProject(a: Assertion, doc: ProjectDoc, boards: readonly string[]): void {
  if (a.kind === 'serial' || a.kind === 'match') {
    if (a.board === null) {
      if (boards.length !== 1) throw new UsageError(`${a.text}: the project has ${boards.length} boards; say serial[<board>]`);
      a.board = boards[0];
    } else if (!boards.includes(a.board)) throw new UsageError(`${a.text}: no board "${a.board}"`);
    return;
  }
  if (a.kind === 'usb') {
    // BT139: boards whose own USB port the bench hosts (an ESP32-S3's USB-OTG; BT150: an S2's).
    const hosted = boards.filter((b) => hostsUsb(CATALOG.get(doc.parts.find((p) => p.id === b)?.type ?? '')?.board?.mcu));
    if (a.board === null) {
      if (hosted.length !== 1) throw new UsageError(`${a.text}: say usb[<board>] (the project's boards with a USB host: ${hosted.length === 0 ? 'none' : hosted.join(', ')})`);
      a.board = hosted[0];
    } else if (!hosted.includes(a.board)) throw new UsageError(`${a.text}: ${boards.includes(a.board) ? `"${a.board}" has no USB port the bench hosts (an ESP32-S3 or ESP32-S2 board has)` : `no board "${a.board}"`}`);
    return;
  }
  if (a.kind === 'wifi') {
    if (!boards.includes(a.board)) throw new UsageError(`${a.text}: no board "${a.board}"`);
    if (!doc.parts.some((p) => netSpecFor(p.type, p.props)?.kind === 'access-point')) throw new UsageError(`${a.text}: the project has no WiFi access point`);
    return;
  }
  const part = doc.parts.find((p) => p.id === a.part);
  if (part === undefined) throw new UsageError(`${a.text}: no part "${a.part}"`);
  if (a.kind === 'bus') return;
  if (a.kind === 'served' || a.kind === 'got') {
    const want = a.kind === 'served' ? 'http-server' : 'http-client';
    if (part.type !== want) throw new UsageError(`${a.text}: "${a.part}" is a ${part.type}, not an ${want} part`);
    return;
  }
  if (a.kind === 'file') {
    // BT142: an ESP32-S3 (BT150: or S2) board's USB drive (its host's mass storage) keeps files too.
    if (!keepsFiles(part.type)) throw new UsageError(`${a.text}: "${a.part}" is a ${part.type}, not a part that keeps files (a microSD card, or an ESP32-S3 or ESP32-S2 board's USB drive)`);
    return;
  }
  if (a.kind === 'pin' || a.kind === 'volts' || a.kind === 'frequency' || a.kind === 'duty') {
    const name = resolvePin(doc, a.part, a.pin);
    if (name === undefined) throw new UsageError(`${a.text}: "${a.part}" has no pin "${a.pin}"`);
    a.pin = name;
    return;
  }
  if (a.kind === 'env') {
    const roleOf = (p: ProjectDoc['parts'][number]): string | undefined => envSpecFor(p.type, p.props)?.role;
    if (!doc.parts.some((p) => roleOf(p) === 'ambient')) throw new UsageError(`${a.text}: the project has no environment part`);
    const role = roleOf(part);
    if (role === undefined || role === 'ambient') throw new UsageError(`${a.text}: "${a.part}" is a ${part.type}, not a part placed in the environment (a sensor, a source or a body)`);
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
  a: Extract<Assertion, { kind: 'led' | 'servo' | 'motor' | 'lcd' | 'pixel' | 'digits' }>,
  visual: VisualState | undefined,
  type: string,
): { ok: boolean; detail: string } {
  switch (a.kind) {
    case 'led': {
      const b = num(visual?.brightness) ?? num(visual?.led) ?? 0; // an LED that never reported is dark
      return { ok: a.lit ? b >= LIT : b <= DARK, detail: `brightness ${b.toFixed(2)}` };
    }
    case 'servo': {
      const angle = num(visual?.angle);
      if (angle === undefined) return { ok: false, detail: 'no angle reported' };
      return { ok: Math.abs(angle - a.angle) <= a.tolerance, detail: `angle ${angle}°` };
    }
    case 'motor': {
      const rpm = num(visual?.rpm) ?? 0; // a motor that never reported is stopped
      return { ok: Math.abs(rpm - a.rpm) <= a.tolerance, detail: `${rpm} rpm` };
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

/** An `env` expectation against the world's value at the part. */
function checkEnv(a: Extract<Assertion, { kind: 'env' }>, value: number | undefined): { ok: boolean; detail: string } {
  if (value === undefined) return { ok: false, detail: `no ${a.field} at "${a.part}" (it isn't placed in the environment)` };
  const shown = `${a.field} ${value.toFixed(2)} ${ENV_UNITS[a.field]}`;
  switch (a.op) {
    case 'is':
      return { ok: Math.abs(value - a.value) <= a.tolerance, detail: shown };
    case '>':
      return { ok: value > a.value, detail: shown };
    case '<':
      return { ok: value < a.value, detail: shown };
    case '>=':
      return { ok: value >= a.value, detail: shown };
    case '<=':
      return { ok: value <= a.value, detail: shown };
  }
}

/** An LED is lit at this brightness or more, dark at DARK or less (in between: dim, neither). */
const LIT = 0.3;
const DARK = 0.05;
/** A window's probe is drained at least this often (ns). */
const DRAIN_NS = 50e6;
/** BT139: how often usb assertions read a board's USB host. */
const USB_CHECK_NS = 10_000_000;

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
/**
 * BT100: whether a network event satisfies an assertion — its detail when it does, null when it
 * is about something else, or '!' and a note when it is about the same part but doesn't match
 * (a client's other status: the failure says what it got).
 */
function netMatch(a: NetAssertion, e: NetEvent): string | null {
  if (a.kind === 'wifi') return e.kind === 'connected' && e.board === a.board ? `connected to ${e.ap} as ${ipString(e.ip)}` : null;
  if (a.kind === 'served') {
    if (e.kind !== 'served' || e.part !== a.part) return null;
    const q = a.path.indexOf('?');
    const path = q < 0 ? a.path : a.path.slice(0, q);
    const query = q < 0 ? null : a.path.slice(q + 1);
    const hit = (a.method === '*' || a.method === e.method) && path === e.path && (query === null || query === e.query);
    return hit ? `served ${e.method} ${e.path}${e.query === '' ? '' : `?${e.query}`} → ${e.status}` : `!${e.method} ${e.path}${e.query === '' ? '' : `?${e.query}`}`;
  }
  if (e.kind !== 'got' || e.part !== a.part) return null;
  const got = e.status === 0 ? `error: ${e.error}` : `${e.status}`;
  if (e.status !== a.status) return `!${got}`;
  if (a.needle !== null && !e.body.includes(a.needle)) return `!${got} without the text`;
  return `got ${got}`;
}

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
  // BT101: the real network, when `--network` named hosts (closed when the run ends).
  let uplink: ReturnType<typeof uplinkFor>;
  const finish = (): RunReport => {
    uplink?.dispose();
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
    if (options.maxDurationNs !== undefined && duration > options.maxDurationNs) throw new UsageError(`the run is ${formatNs(duration)} long; the limit is ${formatNs(options.maxDurationNs)}`);

    const images = loadFirmware(io, doc, boards, options.firmware);
    uplink = uplinkFor(io);
    const built = buildBench(doc, images, cachedRoms(io), undefined, loadTables(io, doc, options.firmware), uplink);
    const bench = built.bench;
    mcus.push(...built.mcus);
    if (options.memory !== undefined) restoreSpecMemory(bench, boards, options.memory);

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

    // BT88: bus assertions read the bench's bus log at every stop (and every 50 ms, so its ring
    // of 65,536 records doesn't wrap between reads), each satisfied by the first transaction
    // that carries its bytes.
    const busAssertions = assertions.filter((a): a is Extract<Assertion, { kind: 'bus' }> => a.kind === 'bus');
    const busSeen = new Map<Assertion, number>();
    const busDecoder = new BusDecoder();
    let busSince = 0;
    const checkBus = (txs: readonly BusTransaction[]): void => {
      const sources = bench.busLog().sources;
      for (const tx of txs) {
        for (const a of busAssertions) if (!busSeen.has(a) && busMatches(a, tx, sources[tx.source]?.part ?? null)) busSeen.set(a, tx.end);
      }
    };
    const drainBus = (): void => {
      if (busAssertions.length === 0) return;
      const log = bench.busLog();
      const records = log.read(busSince);
      busSince = records.from + records.times.length;
      checkBus(busDecoder.feed(records, log.sources));
    };
    if (busAssertions.length > 0) for (let t = DRAIN_NS; t < duration; t += DRAIN_NS) drains.push(t);

    // BT91: file assertions read their part's files (a microSD card's) at every stop and every
    // 50 ms — again only when the storage changed — each satisfied when its file first holds the text.
    const fileAssertions = assertions.filter((a): a is Extract<Assertion, { kind: 'file' }> => a.kind === 'file');
    const fileSeen = new Map<Assertion, number>();
    const fileNotes = new Map<Assertion, string>();
    const fileVersions = new Map<Assertion, number>();
    const utf8 = new TextDecoder();
    const checkFiles = (): void => {
      for (const a of fileAssertions) {
        if (fileSeen.has(a)) continue;
        const storage = bench.storage(a.part);
        if (storage === undefined) {
          fileNotes.set(a, `"${a.part}" keeps no files`);
          continue;
        }
        if (fileVersions.get(a) === storage.version) continue;
        fileVersions.set(a, storage.version);
        const bytes = storage.read(a.path);
        if (bytes === undefined) fileNotes.set(a, `no file ${a.path}`);
        else if (utf8.decode(bytes).includes(a.needle)) fileSeen.set(a, bench.now());
        else fileNotes.set(a, `${a.path} (${bytes.length} bytes) doesn't hold it`);
      }
    };
    if (fileAssertions.length > 0) for (let t = DRAIN_NS; t < duration; t += DRAIN_NS) drains.push(t);

    // BT139: usb assertions read the board's USB host at every stop and every 10 ms; an event's
    // line is timed by the event, typed text by the check that first saw it.
    const usbAssertions = assertions.filter((a): a is Extract<Assertion, { kind: 'usb' }> => a.kind === 'usb');
    const usbSeen = new Map<Assertion, number>();
    const checkUsb = (): void => {
      for (const a of usbAssertions) {
        if (usbSeen.has(a)) continue;
        const host = bench.usbOf(a.board as string);
        if (host === null) continue;
        const event = host.events.find((e) => e.text.includes(a.needle));
        if (event !== undefined) usbSeen.set(a, event.at);
        else if (host.typed.includes(a.needle)) usbSeen.set(a, bench.now());
      }
    };
    if (usbAssertions.length > 0) for (let t = USB_CHECK_NS; t < duration; t += USB_CHECK_NS) drains.push(t);

    // BT100: network assertions listen to the bench's network; each is satisfied by the first
    // event that matches it (a board connected, a server part's answer, a client part's response).
    const netAssertions = assertions.filter(isNetAssertion);
    const netSeen = new Map<Assertion, { at: number; detail: string }>();
    const netNotes = new Map<Assertion, string>();
    if (netAssertions.length > 0) {
      bench.network?.listen((e) => {
        for (const a of netAssertions) {
          if (netSeen.has(a)) continue;
          const detail = netMatch(a, e);
          if (detail === null) continue;
          if (detail.startsWith('!')) netNotes.set(a, detail.slice(1));
          else netSeen.set(a, { at: e.at, detail });
        }
      });
    }

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
    const budget = options.maxWallMs;
    const advance = (t: number): void => {
      if (budget === undefined) {
        bench.runUntil(t);
        return;
      }
      while (bench.now() < t) {
        bench.runUntil(Math.min(t, bench.now() + WALL_SLICE_NS));
        if (io.now() - start > budget) throw new UsageError(`the run used up its ${budget} ms wall-clock budget at ${formatNs(bench.now())} of simulated time`);
      }
    };
    for (const t of stops) {
      advance(t);
      for (const w of windows) drainWindow(bench, w);
      drainBus();
      checkFiles();
      checkUsb();
      for (const step of script.steps) {
        if (step.at !== t) continue;
        if (step.kind === 'serial') bench.sendSerial(step.board, encoder.encode(step.text));
        else if (step.kind === 'reset') bench.resetBoard(step.board);
        else if (step.kind === 'write' || step.kind === 'remove') applyFileStep(bench, step);
        else if (step.kind === 'midi') {
          const why = bench.usbMidi(step.board, step.bytes);
          if (why !== null) throw new Error(`${step.where} (midi to ${step.board}) at ${formatNs(step.at)}: ${why}`);
        } else if (step.kind === 'locks') bench.setUsbLocks(step.board, step.locks);
        else bench.input(step.part, step.input);
      }
      checkFiles(); // BT144: a file step at this time counts for the assertions due now
      collect();
      for (const a of assertions) {
        if (a.kind === 'serial' || a.kind === 'match' || a.kind === 'bus' || a.kind === 'file' || a.kind === 'usb' || isNetAssertion(a) || decidedAt(a) !== t) continue;
        if (a.kind === 'frequency' || a.kind === 'duty') {
          const w = windows.find((x) => x.a === a) as Window;
          results.set(a, { text: a.text, atNs: t, ...closeWindow(w) });
        } else if (a.kind === 'pin') {
          const state = bench.pinState(a.part, a.pin);
          const level = state === undefined ? 'z' : levelOf(state);
          results.set(a, { text: a.text, ok: level === a.level, atNs: t, detail: `level ${level}` });
        } else if (a.kind === 'volts') {
          const volts = bench.pinState(a.part, a.pin)?.volts ?? Number.NaN;
          results.set(a, { text: a.text, ok: Math.abs(volts - a.volts) <= a.tolerance, atNs: t, detail: `${Number.isNaN(volts) ? 'no net' : `${volts.toFixed(3)} V`}` });
        } else if (a.kind === 'env') {
          results.set(a, { text: a.text, atNs: t, ...checkEnv(a, bench.envSample(a.part, a.field)) });
        } else {
          const type = doc.parts.find((p) => p.id === a.part)?.type ?? '';
          results.set(a, { text: a.text, atNs: t, ...checkVisual(a, latest.get(a.part), type) });
        }
      }
    }
    report.simulatedNs = bench.now();
    if (busAssertions.length > 0) {
      drainBus();
      checkBus(busDecoder.pending()); // a transaction still open at the end counts too
    }
    for (const a of fileAssertions) {
      const at = fileSeen.get(a);
      const ok = at !== undefined && at <= a.by;
      const why = fileNotes.get(a) ?? 'not checked';
      const detail = at === undefined ? `not seen by ${formatNs(a.by)}: ${why}` : ok ? `seen at ${formatNs(at)}` : `seen at ${formatNs(at)}, after ${formatNs(a.by)}`;
      results.set(a, { text: a.text, ok, atNs: at ?? null, detail });
    }
    for (const a of usbAssertions) {
      const at = usbSeen.get(a);
      const ok = at !== undefined && at <= a.by;
      const detail = at === undefined ? `not received by ${formatNs(a.by)}` : ok ? `received at ${formatNs(at)}` : `received at ${formatNs(at)}, after ${formatNs(a.by)}`;
      results.set(a, { text: a.text, ok, atNs: at ?? null, detail });
    }
    for (const a of netAssertions) {
      const seenAt = netSeen.get(a);
      const ok = seenAt !== undefined && seenAt.at <= a.by;
      const why = netNotes.get(a);
      const detail = seenAt === undefined ? `not seen by ${formatNs(a.by)}${why === undefined ? '' : ` (last: ${why})`}` : ok ? `${seenAt.detail} at ${formatNs(seenAt.at)}` : `${seenAt.detail} at ${formatNs(seenAt.at)}, after ${formatNs(a.by)}`;
      results.set(a, { text: a.text, ok, atNs: seenAt?.at ?? null, detail });
    }
    for (const a of busAssertions) {
      const at = busSeen.get(a);
      const ok = at !== undefined && at <= a.by;
      const detail = at === undefined ? `not seen by ${formatNs(a.by)}` : ok ? `seen at ${formatNs(at)}` : `seen at ${formatNs(at)}, after ${formatNs(a.by)}`;
      results.set(a, { text: a.text, ok, atNs: at ?? null, detail });
    }
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
