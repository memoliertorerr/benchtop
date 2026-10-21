/**
 * Compiling sketches with the local arduino-cli, shared by the compile bridge (apps/bridge) and
 * the CLI's MCP server (BT70; both import this — moved from apps/bridge): the run itself
 * (`compile`, found the way the fixture build finds arduino-cli: arduino-cli.ts), arduino-cli's
 * diagnostics, inline sketches written into a fresh folder (`compileInlineSketch`), and the rules
 * on what may be compiled — the FQBN allowlist and an inline sketch's files.
 *
 * Each sketch gets its own build cache under <tmp>/benchtop-build/<sha1 of its key>, so rebuilds
 * are incremental; outputs go through a temp folder that is removed afterwards.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, sep } from 'node:path';
import { runArduinoCli } from './arduino-cli.ts';

export { arduinoCliCandidates, findArduinoCli } from './arduino-cli.ts';

/** The Pico 2 builds for its RISC-V cores only (BT66: the simulator has no Arm cores). */
export const FQBN_ALLOWLIST: readonly string[] = ['arduino:avr:uno', 'arduino:avr:nano', 'arduino:avr:mega', 'esp32:esp32:esp32', 'rp2040:rp2040:rpipico', 'rp2040:rp2040:rpipico2:arch=riscv'];
export function isAllowedFqbn(fqbn: unknown): fqbn is string {
  return typeof fqbn === 'string' && FQBN_ALLOWLIST.includes(fqbn);
}

/** An inline sketch's file names: a plain name, no folders, a C/C++/Arduino extension. */
export const SKETCH_FILE_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}\.(?:ino|h|hpp|c|cpp)$/;
export const MAX_SKETCH_FILES = 32;
/** UTF-8 bytes of source over an inline sketch's files. */
export const MAX_SKETCH_BYTES = 256 * 1024;

/** Compiler messages from arduino-cli's `--json` output, in the shape the UI shows. */
export interface Diagnostic {
  file: string;
  line: number;
  column: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
}

interface CliDiagnostic {
  severity?: string;
  message?: string;
  file?: string;
  line?: number;
  column?: number;
}

/**
 * Reads `builder_result.diagnostics` (arduino-cli ≥ 0.36). Only the message's first line is
 * kept: the rest repeats the source line and a caret.
 */
export function parseDiagnostics(json: unknown): Diagnostic[] {
  const list = (json as { builder_result?: { diagnostics?: unknown } } | null)?.builder_result?.diagnostics;
  if (!Array.isArray(list)) return [];
  return list.map((item: unknown) => {
    const raw = (typeof item === 'object' && item !== null ? item : {}) as CliDiagnostic;
    const severity = String(raw.severity ?? '').toLowerCase();
    return {
      file: String(raw.file ?? ''),
      line: Number.isInteger(raw.line) ? (raw.line as number) : 0,
      column: Number.isInteger(raw.column) ? (raw.column as number) : 0,
      severity: severity === 'error' ? 'error' : severity === 'warning' ? 'warning' : 'info',
      message: String(raw.message ?? '').split('\n')[0],
    };
  });
}

export const COMPILE_TIMEOUT_MS = 120_000;

export interface CompileArtifacts {
  /** Intel HEX text (AVR). */
  hex?: string;
  elf?: Uint8Array;
  /** ESP32 app image. */
  bin?: Uint8Array;
  /** ESP32 partition table. */
  partitions?: Uint8Array;
  /** RP2040 image (BT61). */
  uf2?: Uint8Array;
}

export interface CompileResult {
  ok: boolean;
  durationMs: number;
  diagnostics: Diagnostic[];
  stdout: string;
  stderr: string;
  artifacts: CompileArtifacts;
  /** Why it failed when there are no diagnostics to say so (timeout, missing tool). */
  error?: string;
}

/** The build cache for a key: a sketch folder's path, or an inline sketch's board and name. */
export function buildPathFor(key: string): string {
  return join(tmpdir(), 'benchtop-build', createHash('sha1').update(key).digest('hex'));
}

/**
 * `buildKey` names the build cache (default: the sketch folder). Inline sketches (BT42) compile
 * from a fresh temp folder each time but keep one cache per board and sketch name, so a
 * recompile is incremental.
 */
export async function compile(cli: string, sketchDir: string, fqbn: string, timeoutMs = COMPILE_TIMEOUT_MS, buildKey = sketchDir): Promise<CompileResult> {
  const start = performance.now();
  const outDir = mkdtempSync(join(tmpdir(), 'benchtop-out-'));
  try {
    const run = await runArduinoCli(
      cli,
      ['compile', '--fqbn', fqbn, '--build-path', buildPathFor(buildKey), '--output-dir', outDir, '--json', '--no-color', sketchDir],
      timeoutMs,
    );
    const durationMs = Math.round(performance.now() - start);
    let json: { success?: boolean; compiler_out?: string; compiler_err?: string; error?: string } | undefined;
    try {
      json = JSON.parse(run.stdout) as typeof json;
    } catch {
      json = undefined;
    }
    const ok = run.code === 0 && json?.success === true;
    const result: CompileResult = {
      ok,
      durationMs,
      diagnostics: parseDiagnostics(json),
      stdout: json?.compiler_out ?? run.stdout,
      stderr: json?.compiler_err ?? run.stderr,
      artifacts: ok ? readArtifacts(outDir, basename(sketchDir)) : {},
    };
    if (!ok) {
      result.error = run.code === null ? `compile timed out after ${timeoutMs / 1000} s` : (json?.error ?? (run.stderr.trim() || `arduino-cli exited with ${run.code}`));
    }
    return result;
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

function readArtifacts(dir: string, name: string): CompileArtifacts {
  const file = (ext: string): Uint8Array | undefined => {
    const path = join(dir, `${name}.ino.${ext}`);
    return existsSync(path) ? new Uint8Array(readFileSync(path)) : undefined;
  };
  const artifacts: CompileArtifacts = {};
  const hex = join(dir, `${name}.ino.hex`);
  if (existsSync(hex)) artifacts.hex = readFileSync(hex, 'utf8');
  const elf = file('elf');
  if (elf !== undefined) artifacts.elf = elf;
  const bin = file('bin');
  if (bin !== undefined) artifacts.bin = bin;
  const partitions = file('partitions.bin');
  if (partitions !== undefined) artifacts.partitions = partitions;
  const uf2 = file('uf2');
  if (uf2 !== undefined) artifacts.uf2 = uf2;
  return artifacts;
}

export type InlineCheck = { ok: true; fqbn: string; files: Record<string, string>; main: string } | { ok: false; error: string };

/**
 * An inline sketch (BT42): `{ fqbn, files: { name: text }, main }` — an allowed FQBN, 1–32 files
 * with safe names (written into a fresh folder, so a name can't leave it), at most 256 KB of
 * UTF-8 source, and `main` one of them ending in .ino.
 */
export function validateInlineSketch(body: unknown): InlineCheck {
  if (typeof body !== 'object' || body === null) return { ok: false, error: 'body must be an object' };
  const { fqbn, files, main } = body as { fqbn?: unknown; files?: unknown; main?: unknown };
  if (!isAllowedFqbn(fqbn)) return { ok: false, error: `fqbn must be one of ${FQBN_ALLOWLIST.join(', ')}` };
  if (typeof files !== 'object' || files === null || Array.isArray(files)) return { ok: false, error: 'files must be an object of name → text' };
  const names = Object.keys(files);
  if (names.length === 0 || names.length > MAX_SKETCH_FILES) return { ok: false, error: `a sketch has 1–${MAX_SKETCH_FILES} files` };
  const out: Record<string, string> = {};
  let bytes = 0;
  for (const name of names) {
    const text = (files as Record<string, unknown>)[name];
    if (!SKETCH_FILE_PATTERN.test(name)) return { ok: false, error: `bad file name ${JSON.stringify(name.slice(0, 80))}` };
    if (typeof text !== 'string') return { ok: false, error: `${name} must be text` };
    bytes += Buffer.byteLength(text, 'utf8');
    out[name] = text;
  }
  if (bytes > MAX_SKETCH_BYTES) return { ok: false, error: `the sketch is ${bytes} bytes, at most ${MAX_SKETCH_BYTES}` };
  if (typeof main !== 'string' || !main.endsWith('.ino') || !Object.hasOwn(out, main)) return { ok: false, error: 'main must name one of the files, a .ino' };
  return { ok: true, fqbn, files: out, main };
}

/**
 * An inline sketch compiled from a fresh folder named after its main .ino (arduino-cli wants
 * that), with one build cache per board and sketch name so a recompile is incremental; the
 * diagnostics name files as the sketch does, and the temp folder never shows in the output.
 * `run` compiles a folder (the bridge passes its queued compile; the CLI the plain one).
 */
export async function compileInlineSketch(run: (dir: string, fqbn: string, buildKey: string) => Promise<CompileResult>, fqbn: string, files: Record<string, string>, main: string): Promise<CompileResult> {
  const root = mkdtempSync(join(tmpdir(), 'benchtop-inline-'));
  const name = main.slice(0, -'.ino'.length);
  const dir = join(root, name);
  try {
    mkdirSync(dir);
    for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
    const result = await run(dir, fqbn, `inline\u0000${fqbn}\u0000${name}`);
    // Name the files as the editor does: macOS's temp dir also appears under /private.
    const roots = [realpathSync(dir), dir].sort((a, b) => b.length - a.length);
    const local = (file: string): string => {
      const inside = roots.find((r) => file.startsWith(r + sep));
      return inside === undefined ? file : relative(inside, file);
    };
    const scrub = (text: string): string => roots.reduce((t, r) => t.split(r + sep).join(''), text);
    return {
      ...result,
      diagnostics: result.diagnostics.map((d) => ({ ...d, file: local(d.file) })),
      stdout: scrub(result.stdout),
      stderr: scrub(result.stderr),
      ...(result.error === undefined ? {} : { error: scrub(result.error) }),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
