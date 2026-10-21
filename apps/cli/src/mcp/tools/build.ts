/**
 * Tools that make files (BT70): `compile_sketch` (arduino-cli through scripts/compile.ts — the
 * bridge's code, FQBN allowlist and sketch rules) and the PCB pair `pcb_check` (DRC of a
 * project's board) and `pcb_export` (the fabrication files). Output goes only to
 * `<root>/.benchtop/` (`writeOutputs`).
 */

import { existsSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { benchEnvParts } from '@benchtop/parts';
import { fabricationFiles, fabricationZip, fileBase } from '@benchtop/pcb';
import { type CompileResult, compile, compileInlineSketch, FQBN_ALLOWLIST, findArduinoCli, isAllowedFqbn, validateInlineSketch } from '../../../../../scripts/compile.ts';
import { parseJson, projectFromJson, readText } from '../../load.ts';
import { projectPcb } from '../../pcb.ts';
import { type Tool, ToolError } from '../server.ts';
import { PROJECT_ARGS, projectJsonArg, safeName, type ToolContext, writeOutputs } from './context.ts';

/** The FQBN a board part type compiles with (the web app's editor/fqbn.ts names the same; a test checks). */
const FQBN_BY_TYPE: Readonly<Record<string, string>> = { 'arduino-nano': 'arduino:avr:nano' };
const FQBN_BY_MCU: Readonly<Record<string, string>> = {
  atmega328p: 'arduino:avr:uno',
  atmega2560: 'arduino:avr:mega',
  esp32: 'esp32:esp32:esp32',
  rp2040: 'rp2040:rp2040:rpipico',
  rp2350: 'rp2040:rp2040:rpipico2:arch=riscv',
};

export function fqbnOfBoard(type: string): string | undefined {
  const mcu = benchEnvParts(type)?.board?.mcu;
  return mcu === undefined ? undefined : (FQBN_BY_TYPE[type] ?? FQBN_BY_MCU[mcu]);
}

/** The firmware file a run should load: an .elf for AVR (it carries the debug symbols), else the image. */
function firmwareOf(written: readonly string[]): string | undefined {
  const find = (ext: string): string | undefined => written.find((p) => p.endsWith(ext));
  if (find('.hex') !== undefined) return find('.elf') ?? find('.hex');
  return find('.uf2') ?? written.find((p) => p.endsWith('.bin') && !p.endsWith('.partitions.bin'));
}

export const compileSketch: Tool<ToolContext> = {
  name: 'compile_sketch',
  title: 'Compile an Arduino sketch',
  description:
    'Compiles an Arduino sketch with the arduino-cli installed on this machine (the one bundled with Arduino IDE 2, with the board\'s core installed) — a sketch folder under the root (holding <folder name>.ino) or the files given inline — for a board part type ("arduino-uno", "esp32-devkit-v1", "raspberry-pi-pico-2", …) or an FQBN. Returns the compiler\'s diagnostics (file, line, column, severity, message) and, when it builds, the firmware written under .benchtop/build/<name>/ — "firmware" is the path to pass to run_simulation or sim_open (an .elf for AVR boards, so debug_* tools see symbols).',
  inputSchema: {
    type: 'object',
    properties: {
      sketch: { type: 'string', maxLength: 1024, description: 'A sketch folder under the root.' },
      files: { type: 'object', additionalProperties: { type: 'string', maxLength: 256 * 1024 }, description: 'Inline sketch files: name → source (.ino, .h, .hpp, .c, .cpp).' },
      main: { type: 'string', maxLength: 64, description: 'The inline sketch\'s main .ino (default: its only .ino).' },
      board: { type: 'string', maxLength: 64, description: 'The board part type to compile for.' },
      fqbn: { type: 'string', enum: FQBN_ALLOWLIST, description: 'An FQBN instead of a board type.' },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async run(args, context) {
    const fqbn = typeof args.fqbn === 'string' ? args.fqbn : typeof args.board === 'string' ? fqbnOfBoard(args.board) : undefined;
    if (fqbn === undefined) throw new ToolError(typeof args.board === 'string' ? `"${args.board}" is not a board part type` : 'give "board" (a board part type) or "fqbn"');
    if (!isAllowedFqbn(fqbn)) throw new ToolError(`fqbn must be one of ${FQBN_ALLOWLIST.join(', ')}`);
    if ((args.sketch === undefined) === (args.files === undefined)) throw new ToolError('give exactly one of "sketch" (a folder under the root) or "files" (inline)');
    const cli = findArduinoCli();
    if (cli === undefined) throw new ToolError('arduino-cli not found: install Arduino IDE 2 (its bundled arduino-cli is used) with the board\'s core');
    let result: CompileResult;
    let name: string;
    if (typeof args.sketch === 'string') {
      const dir = context.sandbox.resolve(args.sketch, 'sketch');
      if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new ToolError(`sketch ${args.sketch} is not a folder`);
      name = basename(dir);
      if (!existsSync(join(dir, `${name}.ino`))) throw new ToolError(`the folder has no ${name}.ino`);
      result = await compile(cli, dir, fqbn);
    } else {
      const files = args.files as Record<string, string>;
      const inos = Object.keys(files).filter((f) => f.endsWith('.ino'));
      const main = typeof args.main === 'string' ? args.main : inos.length === 1 ? inos[0] : undefined;
      if (main === undefined) throw new ToolError('say which .ino is the main file ("main")');
      const check = validateInlineSketch({ fqbn, files, main });
      if (!check.ok) throw new ToolError(check.error);
      name = main.slice(0, -'.ino'.length);
      result = await compileInlineSketch((dir, f, key) => compile(cli, dir, f, undefined, key), fqbn, check.files, check.main);
    }
    const a = result.artifacts;
    const base = `${name}.ino`;
    const outputs: { name: string; data: string | Uint8Array }[] = [];
    if (a.hex !== undefined) outputs.push({ name: `${base}.hex`, data: a.hex });
    if (a.elf !== undefined) outputs.push({ name: `${base}.elf`, data: a.elf });
    if (a.bin !== undefined) outputs.push({ name: `${base}.bin`, data: a.bin });
    if (a.partitions !== undefined) outputs.push({ name: `${base}.partitions.bin`, data: a.partitions });
    if (a.uf2 !== undefined) outputs.push({ name: `${base}.uf2`, data: a.uf2 });
    const written = result.ok ? writeOutputs(context, join('build', safeName(name)), outputs) : [];
    const firmware = firmwareOf(written);
    return {
      ok: result.ok,
      fqbn,
      durationMs: result.durationMs,
      diagnostics: result.diagnostics,
      ...(result.error === undefined ? {} : { error: result.error }),
      ...(firmware === undefined ? {} : { firmware }),
      files: written,
      ...(result.ok ? {} : { output: result.stderr.slice(-4000) }),
    };
  },
};

const LAYOUT_ARG = { type: 'string', maxLength: 1024, description: 'A PCB layout (.pcb.json) under the root; without it one is seeded from the project.' } as const;

function loadBoard(args: Record<string, unknown>, context: ToolContext) {
  const { json, label } = projectJsonArg(args, context);
  const { doc } = projectFromJson(json);
  const layout = typeof args.pcb === 'string' ? { json: parseJson(readText(context.io, args.pcb, 'PCB layout'), args.pcb), label: args.pcb } : undefined;
  return { doc, label, ...projectPcb(doc, layout) };
}

export const pcbCheck: Tool<ToolContext> = {
  name: 'pcb_check',
  title: 'Check a PCB',
  description:
    'Design-rule check of a project\'s printed circuit board: its layout (a .pcb.json under the root) reconciled with the project, or one seeded from the bench (footprints placed, nothing routed). Returns each violation (code, severity, message, where in mm, what it is about), the connections still unrouted, and the footprint and net counts.',
  inputSchema: { type: 'object', properties: { ...PROJECT_ARGS, pcb: LAYOUT_ARG }, additionalProperties: false },
  annotations: { readOnlyHint: true, openWorldHint: false },
  run(args, context) {
    const { label, board, result } = loadBoard(args, context);
    const errors = result.violations.filter((v) => v.severity === 'error').length;
    return {
      ok: errors === 0,
      project: label,
      errors,
      warnings: result.violations.length - errors,
      unrouted: result.unrouted,
      footprints: board.placed.length,
      nets: board.routable.length,
      violations: result.violations.map((v) => ({ code: v.code, severity: v.severity, message: v.message, at: v.at, items: v.items })),
    };
  },
};

export const pcbExport: Tool<ToolContext> = {
  name: 'pcb_export',
  title: 'Export fabrication files',
  description: 'Writes a project\'s PCB fabrication files under .benchtop/pcb/<name>/: Gerbers (copper, mask, silkscreen, outline), the Excellon drill file, the BOM (CSV), the KiCad netlist and footprints, and the layout — or one ZIP with "zip". Run pcb_check first: the files are written whatever DRC says.',
  inputSchema: { type: 'object', properties: { ...PROJECT_ARGS, pcb: LAYOUT_ARG, zip: { type: 'boolean' } }, additionalProperties: false },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  run(args, context) {
    const { doc, pcb, board, result } = loadBoard(args, context);
    const base = fileBase(pcb.name || doc.name);
    const files = args.zip === true ? [{ name: `${base}-fab.zip`, data: fabricationZip(board) }] : fabricationFiles(board).map((f) => ({ name: f.name, data: f.text }));
    const written = writeOutputs(context, join('pcb', safeName(base)), files);
    return { files: written, drcErrors: result.violations.filter((v) => v.severity === 'error').length, unrouted: result.unrouted };
  },
};

export const BUILD_TOOLS: readonly Tool<ToolContext>[] = [compileSketch, pcbCheck, pcbExport];
