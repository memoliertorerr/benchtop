/**
 * Compiling a sketch with the local arduino-cli (found the same way the fixture build finds
 * it: scripts/arduino-cli.ts). Each sketch gets its own build cache under
 * <tmp>/benchtop-build/<sha1 of its path>, so rebuilds are incremental; outputs go through a
 * temp folder that is removed afterwards. The bridge writes nowhere else.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { runArduinoCli } from '../../../scripts/arduino-cli.ts';
import { type Diagnostic, parseDiagnostics } from './diagnostics.ts';

export { arduinoCliCandidates, findArduinoCli } from '../../../scripts/arduino-cli.ts';

export const COMPILE_TIMEOUT_MS = 120_000;

export interface CompileArtifacts {
  /** Intel HEX text (AVR). */
  hex?: string;
  elf?: Uint8Array;
  /** ESP32 app image. */
  bin?: Uint8Array;
  /** ESP32 partition table. */
  partitions?: Uint8Array;
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
  return artifacts;
}
