/**
 * `benchtop pcb` (BT58): a project's PCB — the layout given with `--pcb` (reconciled with the
 * project) or a fresh one seeded from the bench — checked by DRC and exported: Gerbers, the
 * Excellon drill file, the BOM, the KiCad netlist and footprint library, and the layout itself,
 * into `--out` (or as one ZIP with `--zip`). File access goes through `io` and the returned
 * file list, so tests run it in-process.
 */

import { benchEnvParts } from '@benchtop/parts';
import type { ProjectDoc } from '@benchtop/core';
import { drc, type DrcResult, type DrcViolation, fabricationFiles, fabricationZip, fileBase, parsePcb, PcbBoard, type PcbDoc, reconcilePcb, seedPcb } from '@benchtop/pcb';
import { type CliIo, loadProject, parseJson, readText, UsageError } from './load.ts';

export interface PcbOptions {
  project: string;
  /** A layout to use (else one is seeded from the bench). */
  pcb?: string | undefined;
  /** Output folder. */
  out: string;
  /** One ZIP instead of loose files. */
  zip: boolean;
  /** Exit 1 when DRC finds an error. */
  drc: boolean;
}

export interface PcbResult {
  exitCode: 0 | 1 | 2;
  /** Lines for the terminal (DRC findings, a summary). */
  lines: string[];
  /** Files to write, relative to `out`. */
  files: { name: string; data: string | Uint8Array }[];
}

export function parsePcbArgs(argv: readonly string[]): PcbOptions {
  let project: string | undefined;
  let pcb: string | undefined;
  let out: string | undefined;
  let zip = false;
  let check = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`${arg} needs a value`);
      return v;
    };
    if (arg === '--pcb') pcb = value();
    else if (arg === '--out') out = value();
    else if (arg === '--zip') zip = true;
    else if (arg === '--drc') check = true;
    else if (arg.startsWith('--')) throw new UsageError(`unknown option ${arg}`);
    else if (project === undefined) project = arg;
    else throw new UsageError(`unexpected argument "${arg}"`);
  }
  if (project === undefined) throw new UsageError('no project file given');
  if (out === undefined) throw new UsageError('say where the files go: --out <folder>');
  return { project, pcb, out, zip, drc: check };
}

const where = (v: DrcViolation): string => `(${v.at.x.toFixed(2)}, ${v.at.y.toFixed(2)})`;

/**
 * A project's board: the layout given (parsed, then reconciled with the project) or one seeded
 * from the bench, and its DRC result. Shared with the MCP server's PCB tools (BT70).
 */
export function projectPcb(doc: ProjectDoc, layout: { json: unknown; label: string } | undefined): { pcb: PcbDoc; board: PcbBoard; result: DrcResult } {
  let pcb = seedPcb(doc, benchEnvParts);
  if (layout !== undefined) {
    const parsed = parsePcb(layout.json);
    if (!parsed.ok) throw new UsageError(`${layout.label}: ${parsed.errors.slice(0, 5).map((e) => `${e.path || '/'} ${e.message}`).join('; ')}`);
    pcb = reconcilePcb(parsed.doc, doc, benchEnvParts);
  }
  const board = new PcbBoard(doc, pcb, benchEnvParts);
  return { pcb, board, result: drc(board) };
}

export function runPcb(options: PcbOptions, io: CliIo): PcbResult {
  try {
    const { doc } = loadProject(io, options.project);
    const layout = options.pcb === undefined ? undefined : { json: parseJson(readText(io, options.pcb, 'PCB layout'), options.pcb), label: options.pcb };
    const { pcb, board, result } = projectPcb(doc, layout);
    const errors = result.violations.filter((v) => v.severity === 'error');
    const warnings = result.violations.filter((v) => v.severity === 'warning');
    const lines = result.violations.map((v) => `${v.severity} ${v.code} ${where(v)}: ${v.message}`);
    lines.push(`DRC: ${errors.length} error${errors.length === 1 ? '' : 's'}, ${warnings.length} warning${warnings.length === 1 ? '' : 's'}, ${result.unrouted} connection${result.unrouted === 1 ? '' : 's'} unrouted — ${board.placed.length} footprints, ${board.routable.length} nets`);
    const files = options.zip ? [{ name: `${fileBase(pcb.name || doc.name)}-fab.zip`, data: fabricationZip(board) }] : fabricationFiles(board).map((f) => ({ name: f.name, data: f.text }));
    return { exitCode: options.drc && errors.length > 0 ? 1 : 0, lines, files };
  } catch (error) {
    return { exitCode: 2, lines: [`error — ${error instanceof Error ? error.message : String(error)}`], files: [] };
  }
}
