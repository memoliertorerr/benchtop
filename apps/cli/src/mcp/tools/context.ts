/**
 * What every MCP tool gets (BT68): the root's sandbox, the CLI's file access confined to it, and
 * the per-call limits — plus the argument helpers the tools share (a project by path or inline,
 * inline MicroPython sketches, serial text cut to the limit).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { benchEnvParts } from '@benchtop/parts';
import { MAX_SKETCH_BYTES, MAX_SKETCH_FILES, MICROPYTHON_FILE_PATTERN } from '@benchtop/core';
import { parseJson, projectFromJson, readText } from '../../load.ts';
import type { SuiteIo } from '../../suite.ts';
import type { Sandbox } from '../sandbox.ts';
import type { JsonSchema } from '../schema.ts';
import { type McpLimits, ToolError } from '../server.ts';

export interface ToolContext {
  sandbox: Sandbox;
  /** The CLI's file access, confined to the root. */
  io: SuiteIo;
  limits: McpLimits;
}

export const PROJECT_ARGS: Readonly<Record<string, JsonSchema>> = {
  project: { type: 'string', maxLength: 1024, description: 'A project file (.json), relative to the root folder.' },
  projectJson: { type: 'object', description: 'The project document itself, instead of a file: { format: 1, name, parts: [{ id, type, x, y, rotation, props }], wires: [{ id, from: { part, pin }, to: { part, pin } }], firmware: {} }.' },
};

/** The project document a tool's arguments name (exactly one of `project`, `projectJson`). */
export function projectJsonArg(args: Record<string, unknown>, context: ToolContext): { json: unknown; label: string } {
  const { project, projectJson } = args;
  if ((project === undefined) === (projectJson === undefined)) throw new ToolError('give exactly one of "project" (a file under the root) or "projectJson" (the document)');
  if (typeof project === 'string') return { json: parseJson(readText(context.io, project, 'project'), project), label: project };
  return { json: projectJson, label: '<projectJson>' };
}

export const MICROPYTHON_ARG: JsonSchema = {
  type: 'object',
  description:
    'Inline MicroPython sketches by board part id (Raspberry Pi Pico or Pico 2 boards only): { "<board>": { "files": { "main.py": "<source>", …more .py modules }, "main": "main.py" } }. They run on the stock MicroPython firmware, installed over USB serial as an IDE does; the serial output starts with main.py\'s first print.',
  additionalProperties: {
    type: 'object',
    properties: {
      files: { type: 'object', additionalProperties: { type: 'string', maxLength: MAX_SKETCH_BYTES }, description: 'File name → Python source.' },
      main: { type: 'string', maxLength: 64, description: 'The file that runs (default main.py).' },
    },
    required: ['files'],
    additionalProperties: false,
  },
};

/** MicroPython's sketch FQBN per MCU (the web app's editor/fqbn.ts names the same). */
const MICROPYTHON_FQBN: Readonly<Record<string, string>> = { rp2040: 'micropython:rp2:pico', rp2350: 'micropython:rp2:pico2' };

/**
 * The project with inline MicroPython sketches put into its firmware table (what the app's Code
 * tab stores), so `runHeadless` and the bench load them like any inline sketch.
 */
export function withMicroPython(json: unknown, sketches: unknown): unknown {
  if (sketches === undefined) return json;
  const { doc } = projectFromJson(json);
  const firmware: Record<string, unknown> = { ...doc.firmware };
  for (const [board, raw] of Object.entries(sketches as Record<string, { files: Record<string, string>; main?: string }>)) {
    const part = doc.parts.find((p) => p.id === board);
    if (part === undefined) throw new ToolError(`micropython: no part "${board}" in the project`);
    const mcu = benchEnvParts(part.type)?.board?.mcu;
    const fqbn = mcu === undefined ? undefined : MICROPYTHON_FQBN[mcu];
    if (fqbn === undefined) throw new ToolError(`micropython: "${board}" is a ${part.type}; MicroPython runs on the Raspberry Pi Pico and Pico 2`);
    const names = Object.keys(raw.files);
    if (names.length === 0 || names.length > MAX_SKETCH_FILES) throw new ToolError(`micropython.${board}: between 1 and ${MAX_SKETCH_FILES} files`);
    for (const name of names) if (!MICROPYTHON_FILE_PATTERN.test(name)) throw new ToolError(`micropython.${board}: "${name}" is not a module file name (letters, digits, _ . -, ending in .py)`);
    const main = raw.main ?? 'main.py';
    if (!names.includes(main)) throw new ToolError(`micropython.${board}: main "${main}" is not one of its files`);
    firmware[board] = { kind: 'inline', fqbn, files: raw.files, main };
  }
  return { ...(json as Record<string, unknown>), firmware };
}

/** Each board's serial text cut to the limit; the boards cut. */
export function trimSerial(serial: Record<string, string>, limit: number): { serial: Record<string, string>; truncated: string[] } {
  const out: Record<string, string> = {};
  const truncated: string[] = [];
  for (const [board, text] of Object.entries(serial)) {
    if (text.length > limit) {
      out[board] = text.slice(0, limit);
      truncated.push(board);
    } else out[board] = text;
  }
  return { serial: out, truncated };
}

/** A time as the CLI's grammar writes it ("2500ms", "3s", "250us"): exact, no spaces. */
export function timeText(ns: number): string {
  const n = Math.round(ns);
  if (n % 1e9 === 0) return `${n / 1e9}s`;
  if (n % 1e6 === 0) return `${n / 1e6}ms`;
  if (n % 1e3 === 0) return `${n / 1e3}us`;
  return `${n}ns`;
}

/** Where the server writes (BT70): `<root>/.benchtop/`, nowhere else. */
export const OUTPUT_DIR = '.benchtop';

/**
 * Writes files into `<root>/.benchtop/<folder>/` (created as needed) and returns their paths
 * relative to the root. Names come from the server's own code (a sketch's or project's name
 * reduced to safe characters), and every path is checked against the root once more.
 */
export function writeOutputs(context: ToolContext, folder: string, files: readonly { name: string; data: string | Uint8Array }[]): string[] {
  const written: string[] = [];
  for (const file of files) {
    const path = context.sandbox.resolve(join(OUTPUT_DIR, folder, file.name), 'output');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.data);
    written.push(context.sandbox.display(path));
  }
  return written;
}

/** A name safe as one folder or file name part. */
export const safeName = (name: string): string => name.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^[.-]+/, '').slice(0, 64) || 'out';
