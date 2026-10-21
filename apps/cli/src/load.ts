/**
 * Loading what a CLI command runs: the project (validated), each board's firmware from
 * `--firmware <board>=<path>` (format from the extension), and the bench built from the catalog,
 * the AVR factory and the analog specs. Shared by `run` and `gdb`; file access goes through
 * `io`, so tests run in-process.
 */

import { avrMcuFactory } from '@benchtop/avr';
import { esp32McuFactory } from '@benchtop/esp32';
import { assembleBench, type Bench, type BenchEnv, type FirmwareImage, type Mcu, type ProjectDoc, validateProject } from '@benchtop/core';
import { analogSpecFor, benchEnvParts, envSpecFor } from '@benchtop/parts';

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

/** The firmware image a file's extension says it is. */
function firmwareImage(path: string, bytes: Uint8Array): FirmwareImage {
  const lower = path.toLowerCase();
  if (lower.endsWith('.hex')) return { format: 'hex', text: new TextDecoder().decode(bytes) };
  if (lower.endsWith('.elf')) return { format: 'elf', bytes };
  if (lower.endsWith('.bin')) return { format: 'esp32-bin', app: bytes };
  throw new UsageError(`${path}: firmware must be .hex, .elf or .bin`);
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
    if (ref.kind === 'inline') throw new UsageError(`board "${board}" holds its sketch (${ref.main}) in the project: compile it in the app or with arduino-cli and pass --firmware ${board}=<file>`);
    throw new UsageError(`board "${board}" names the dropped file ${ref.name}: pass --firmware ${board}=<path>`);
  }
  return images;
}

/** The bench, reset, with the MCUs it created (for the simulated clock rate). */
export function buildBench(doc: ProjectDoc, images: Readonly<Record<string, FirmwareImage>>, esp32Rom?: Uint8Array): { bench: Bench; mcus: Mcu[] } {
  const mcus: Mcu[] = [];
  const esp32 = esp32McuFactory(esp32Rom);
  const env: BenchEnv = {
    part: benchEnvParts,
    createMcu(board, partId, report) {
      const mcu = avrMcuFactory(board) ?? esp32(board, partId, report);
      if (mcu !== undefined) mcus.push(mcu);
      return mcu;
    },
  };
  return { bench: assembleBench(doc, env, images, { analogSpecFor, envSpecFor }), mcus };
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
