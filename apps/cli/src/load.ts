/**
 * Loading what a CLI command runs: the project (validated), each board's firmware from
 * `--firmware <board>=<path>` (format from the extension), and the bench built from the catalog,
 * the AVR factory and the analog specs. Shared by `run` and `gdb`; file access goes through
 * `io`, so tests run in-process.
 */

import { avrMcuFactory } from '@benchtop/avr';
import { esp32McuFactory } from '@benchtop/esp32';
import { esp32c3McuFactory } from '@benchtop/esp32c3';
import { esp32s2McuFactory } from '@benchtop/esp32s2';
import { esp32s3McuFactory } from '@benchtop/esp32s3';
import { rp2040McuFactory } from '@benchtop/rp2040';
import { rp2350McuFactory } from '@benchtop/rp2350';
import { type AllowEntry, assembleBench, type Bench, type BenchCarry, type BenchEnv, type DebugTables, type FirmwareImage, isMicroPythonFqbn, lineTableFromElf, type Mcu, parseElf32, type ProjectDoc, SymbolTable, type Uplink, usesSymbols, validateProject } from '@benchtop/core';
import { analogSpecFor, benchEnvParts, envSpecFor, netSpecFor } from '@benchtop/parts';

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export interface CliIo {
  /** A file's bytes; throws when it can't be read. */
  readFile(path: string): Uint8Array;
  /** Wall clock, ms. */
  now(): number;
  /** The ESP32 ROM ELF (BT34), if this machine has it; ESP32 boards report it missing otherwise. */
  esp32Rom?(): Uint8Array | undefined;
  /** The stock MicroPython UF2 for the Pico (BT63), if cached; MicroPython sketches report it missing otherwise. */
  micropython?(): Uint8Array | undefined;
  /** The RP2350 bootrom (BT66), if cached; Pico 2 boards report it missing otherwise. */
  rp2350Rom?(): Uint8Array | undefined;
  /** BT94: the ESP32-C3 ROM ELF, if cached; ESP32-C3 boards report it missing otherwise. */
  esp32c3Rom?(): Uint8Array | undefined;
  /** BT126: the ESP32-S3 ROM ELF, if cached; ESP32-S3 boards report it missing otherwise. */
  esp32s3Rom?(): Uint8Array | undefined;
  /** BT150: the ESP32-S2 ROM ELF, if cached; ESP32-S2 boards report it missing otherwise. */
  esp32s2Rom?(): Uint8Array | undefined;
  /** The stock MicroPython UF2 for the Pico 2's RISC-V cores (BT67), if cached. */
  micropythonPico2?(): Uint8Array | undefined;
  /**
   * BT101: the hosts `--network` lets a project's access point reach (absent or empty: none —
   * nothing leaves the machine).
   */
  network?: readonly AllowEntry[];
  /** BT101, tests only: `host:port` → `address:port` the uplink connects to instead. */
  networkRedirect?: Readonly<Record<string, string>>;
}

/** The downloaded files boards need, each undefined when not cached (the board then says so). */
export interface BenchRoms {
  esp32Rom?: Uint8Array | undefined;
  micropython?: Uint8Array | undefined;
  rp2350Rom?: Uint8Array | undefined;
  micropythonPico2?: Uint8Array | undefined;
  esp32c3Rom?: Uint8Array | undefined;
  esp32s3Rom?: Uint8Array | undefined;
  esp32s2Rom?: Uint8Array | undefined;
}

/** Everything a CliIo has cached. */
export function cachedRoms(io: CliIo): BenchRoms {
  return { esp32Rom: io.esp32Rom?.(), micropython: io.micropython?.(), rp2350Rom: io.rp2350Rom?.(), micropythonPico2: io.micropythonPico2?.(), esp32c3Rom: io.esp32c3Rom?.(), esp32s3Rom: io.esp32s3Rom?.(), esp32s2Rom: io.esp32s2Rom?.() };
}

export function readText(io: CliIo, path: string, what: string): string {
  try {
    return new TextDecoder().decode(io.readFile(path));
  } catch (error) {
    throw new UsageError(`cannot read ${what} ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new UsageError(`${what} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The validated project and its board part ids. */
export function loadProject(io: CliIo, path: string): { doc: ProjectDoc; boards: string[] } {
  return projectFromJson(parseJson(readText(io, path, 'project'), path));
}

/** A project given as parsed JSON (BT50: a recorded spec carries its circuit inline). */
export function projectFromJson(json: unknown): { doc: ProjectDoc; boards: string[] } {
  const doc = validateProject(json);
  const boards = doc.parts.filter((p) => benchEnvParts(p.type)?.board !== undefined).map((p) => p.id);
  return { doc, boards };
}

/**
 * The firmware image a file's extension says it is. A `.py` (BT63) is a one-file MicroPython
 * sketch: it runs as main.py on the board's stock interpreter.
 */
function firmwareImage(path: string, bytes: Uint8Array): FirmwareImage {
  const lower = path.toLowerCase();
  if (lower.endsWith('.hex')) return { format: 'hex', text: new TextDecoder().decode(bytes) };
  if (lower.endsWith('.elf')) return { format: 'elf', bytes };
  if (lower.endsWith('.bin')) return { format: 'esp32-bin', app: bytes };
  if (lower.endsWith('.uf2')) return { format: 'uf2', bytes };
  if (lower.endsWith('.py')) return { format: 'micropython', files: { 'main.py': new TextDecoder().decode(bytes) }, main: 'main.py' };
  throw new UsageError(`${path}: firmware must be .hex, .elf, .bin, .uf2 or a MicroPython .py`);
}

/**
 * Each board's firmware from `--firmware`. A board whose project entry names a sketch or a
 * dropped file and gets no `--firmware` is an error: the CLI can't compile or reach browser
 * storage.
 */
export function loadFirmware(io: CliIo, doc: ProjectDoc, boards: readonly string[], firmware: Readonly<Record<string, string>>): Record<string, FirmwareImage> {
  const images: Record<string, FirmwareImage> = {};
  for (const [board, path] of Object.entries(firmware)) {
    if (!boards.includes(board)) throw new UsageError(`--firmware ${board}=…: no board "${board}" in the project`);
    let bytes: Uint8Array;
    try {
      bytes = io.readFile(path);
    } catch (error) {
      throw new UsageError(`cannot read firmware ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    images[board] = firmwareImage(path, bytes);
  }
  for (const [board, ref] of Object.entries(doc.firmware)) {
    if (images[board] !== undefined) continue;
    if (ref.kind === 'sketch') throw new UsageError(`board "${board}" names sketch ${ref.path}: compile it and pass --firmware ${board}=<file>`);
    if (ref.kind === 'inline' && isMicroPythonFqbn(ref.fqbn)) {
      images[board] = { format: 'micropython', files: ref.files, main: ref.main }; // nothing to compile
      continue;
    }
    if (ref.kind === 'inline') throw new UsageError(`board "${board}" holds its sketch (${ref.main}) in the project: compile it in the app or with arduino-cli and pass --firmware ${board}=<file>`);
    throw new UsageError(`board "${board}" names the dropped file ${ref.name}: pass --firmware ${board}=<path>`);
  }
  return images;
}

/** Symbols from an nm listing (`.syms.tsv`); Arm Thumb functions lose bit 0. */
export function nmTables(text: string, doc: ProjectDoc, board: string): DebugTables {
  const type = doc.parts.find((p) => p.id === board)?.type ?? '';
  return { symbols: SymbolTable.fromNm(text, benchEnvParts(type)?.board?.mcu === 'rp2040'), lines: null };
}

/**
 * BT74: debug tables for a board whose firmware file isn't an ELF — the compiler's `.elf` beside
 * it (arduino-cli and compile_sketch write `<name>.ino.elf` next to `<name>.ino.bin`/`.uf2`), else
 * an nm listing (`.syms.tsv`, as the fixtures keep). Undefined when there's neither.
 */
export function tablesBeside(io: CliIo, doc: ProjectDoc, board: string, path: string): DebugTables | undefined {
  if (/\.(elf|py)$/i.test(path)) return undefined;
  const base = path.replace(/\.(hex|uf2|bin)$/i, '');
  const read = (p: string): Uint8Array | undefined => {
    try {
      return io.readFile(p);
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

/** tablesBeside for every `--firmware` file. */
export function loadTables(io: CliIo, doc: ProjectDoc, firmware: Readonly<Record<string, string>>): Record<string, DebugTables> {
  const tables: Record<string, DebugTables> = {};
  for (const [board, path] of Object.entries(firmware)) {
    const found = tablesBeside(io, doc, board, path);
    if (found !== undefined) tables[board] = found;
  }
  return tables;
}

/**
 * The bench, reset, with the MCUs it created (for the simulated clock rate). BT79: with `carry`
 * (the previous bench's `carry()`), a rebuild that keeps time, running boards (but those in
 * `restart`) and unchanged parts; `images` then reach only the boards that start afresh. BT97:
 * `tables` give MCUs that use symbols (the ESP32's WiFi) their board's, as they are created.
 */
export function buildBench(
  doc: ProjectDoc,
  images: Readonly<Record<string, FirmwareImage>>,
  roms: BenchRoms = {},
  carry?: { carry: BenchCarry; restart: readonly string[] },
  tables: Readonly<Record<string, DebugTables>> = {},
  uplink?: Uplink,
): { bench: Bench; mcus: Mcu[] } {
  const mcus: Mcu[] = [];
  const esp32 = esp32McuFactory(roms.esp32Rom);
  const esp32c3 = esp32c3McuFactory(roms.esp32c3Rom);
  const esp32s3 = esp32s3McuFactory(roms.esp32s3Rom);
  const esp32s2 = esp32s2McuFactory(roms.esp32s2Rom);
  const env: BenchEnv = {
    part: benchEnvParts,
    createMcu(board, partId, report, props) {
      const mcu = avrMcuFactory(board) ?? esp32(board, partId, report, props) ?? esp32c3(board, partId, report) ?? esp32s3(board, partId, report, props) ?? esp32s2(board, partId, report, props) ?? rp2040McuFactory(board, partId, report, roms.micropython) ?? rp2350McuFactory(board, partId, report, { rom: roms.rp2350Rom, micropython: roms.micropythonPico2 });
      if (mcu !== undefined) mcus.push(mcu);
      const symbols = tables[partId]?.symbols;
      if (mcu !== undefined && symbols != null && usesSymbols(mcu)) mcu.useSymbols(symbols);
      return mcu;
    },
  };
  return { bench: assembleBench(doc, env, images, { analogSpecFor, envSpecFor, netSpecFor, ...carry, ...(uplink === undefined ? {} : { uplink }) }), mcus };
}

/** A board part's pin name as the definition spells it (13 ↔ D13 on boards), or undefined. */
export function resolvePin(doc: ProjectDoc, part: string, pin: string): string | undefined {
  const instance = doc.parts.find((p) => p.id === part);
  const def = instance && benchEnvParts(instance.type);
  if (def === undefined) return undefined;
  const names = new Set(def.pins.map((p) => p.name));
  if (names.has(pin)) return pin;
  if (def.board === undefined) return undefined;
  const digits = /^D(\d+)$/.exec(pin)?.[1] ?? (/^\d+$/.test(pin) ? `D${pin}` : undefined);
  return digits !== undefined && names.has(digits) ? digits : undefined;
}
