/**
 * Test specs (BT48): `*.bench.json` files the `test` command runs. A spec is one headless run —
 * the `run` command's options as a file:
 *
 *   {
 *     "name": "blink toggles D13",            optional; default: the file name without .bench.json
 *     "project": "../projects/blink-led.json",   or the project document itself (BT50)
 *     "firmware": { "uno": "../firmware/uno/blink.hex" },
 *     "duration": "2s",                       optional; default: the latest step or assertion
 *     "steps": [{ "at": "100ms", "part": "btn1", "input": { "kind": "press" } },
 *               { "at": "200ms", "serial": "hello" }],
 *     "expect": ["pin uno:13 is 1 at 250ms", "serial contains \"hello\" by 1s"]
 *   }
 *
 * Paths are relative to the spec file (absolute ones are kept). Specs come from users' repos, so
 * they are parsed defensively: a size cap, no unknown fields, every field type-checked; step and
 * assertion grammar errors surface when the run parses them, naming the spec.
 */

import { dirname, isAbsolute, join } from 'node:path';
import { type CliIo, parseJson, UsageError } from './load.ts';
import type { RunOptions } from './run.ts';

/** Bytes a spec file may have. */
export const MAX_SPEC_BYTES = 1024 * 1024;
export const SPEC_SUFFIX = '.bench.json';

const FIELDS = new Set(['name', 'project', 'firmware', 'duration', 'steps', 'expect']);

export interface TestSpec {
  /** The spec file, as discovered. */
  file: string;
  name: string;
  options: RunOptions;
}

/** The spec's name when it gives none: its file name without `.bench.json`. */
export function defaultSpecName(file: string): string {
  const base = file.split(/[\\/]/).pop() ?? file;
  return base.endsWith(SPEC_SUFFIX) ? base.slice(0, -SPEC_SUFFIX.length) : base;
}

/** Reads and validates a spec file; throws UsageError naming the file and the field. */
export function loadSpec(io: CliIo, file: string): TestSpec {
  let bytes: Uint8Array;
  try {
    bytes = io.readFile(file);
  } catch (error) {
    throw new UsageError(`cannot read spec ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (bytes.length > MAX_SPEC_BYTES) throw new UsageError(`${file}: a spec may have at most ${MAX_SPEC_BYTES} bytes`);
  return parseSpec(parseJson(new TextDecoder().decode(bytes), file), file);
}

/** A parsed spec file's JSON → run options, paths resolved against the spec's folder. */
export function parseSpec(json: unknown, file: string): TestSpec {
  const fail = (message: string): never => {
    throw new UsageError(`${file}: ${message}`);
  };
  if (typeof json !== 'object' || json === null || Array.isArray(json)) fail('a spec is a JSON object');
  const spec = json as Record<string, unknown>;
  for (const key of Object.keys(spec)) if (!FIELDS.has(key)) fail(`unknown field "${key}" (expected ${[...FIELDS].join(', ')})`);
  const at = (path: string): string => (isAbsolute(path) ? path : join(dirname(file), path));
  const text = (key: string, value: unknown): string => {
    if (typeof value !== 'string' || value.length === 0) fail(`"${key}" must be a non-empty string`);
    return value as string;
  };

  const name = spec.name === undefined ? defaultSpecName(file) : text('name', spec.name);
  // A project document inline (recorded specs) goes through parseProject in the run, as a file would.
  const inline = typeof spec.project === 'object' && spec.project !== null && !Array.isArray(spec.project);
  const project = inline ? `${file} (inline project)` : at(text('project', spec.project));
  const firmware: Record<string, string> = {};
  if (spec.firmware !== undefined) {
    if (typeof spec.firmware !== 'object' || spec.firmware === null || Array.isArray(spec.firmware)) fail('"firmware" must map board ids to firmware paths');
    for (const [board, path] of Object.entries(spec.firmware as Record<string, unknown>)) firmware[board] = at(text(`firmware.${board}`, path));
  }
  const duration = spec.duration === undefined ? undefined : text('duration', spec.duration);
  if (spec.steps !== undefined && !Array.isArray(spec.steps)) fail('"steps" must be an array');
  const expect = spec.expect ?? [];
  if (!Array.isArray(expect) || expect.some((e) => typeof e !== 'string')) fail('"expect" must be an array of strings');
  return {
    file,
    name,
    options: {
      project,
      firmware,
      duration,
      expect: expect as string[],
      scriptJson: spec.steps === undefined ? undefined : { steps: spec.steps },
      ...(inline ? { projectJson: spec.project } : {}),
    },
  };
}
