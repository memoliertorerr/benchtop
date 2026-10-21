/**
 * The Xtensa test-program pipeline (part of `npm run fixtures`): every fixtures/xtensa/<name>.S →
 *   xtensa-esp32-elf-as --text-section-literals → ld -Ttext=0x40080000 -e _start (+ -lgcc when
 *   line 1 is `# link: libgcc`) → objcopy -O binary <name>.bin, objdump -d <name>.lst.
 * Only the .S, .bin and .lst are committed. Builds run in fixtures/.build/xtensa/<name> with
 * relative file names, so the .lst header carries no machine path. Conventions: harness.inc.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findXtensaTool } from './arduino-cli.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const XTENSA_DIR = join(ROOT, 'fixtures', 'xtensa');
const BUILD = join(ROOT, 'fixtures', '.build', 'xtensa');

export function xtensaTool(name: string): string {
  const path = findXtensaTool(`xtensa-esp32-elf-${name}`);
  if (path === undefined) throw new Error(`xtensa-esp32-elf-${name} not found (set BENCHTOP_XTENSA_BIN to the toolchain's bin folder)`);
  return path;
}

/** libgcc.a's folder in the toolchain (lib/gcc/xtensa-esp32-elf/<version>). */
function libgccDir(): string {
  const gccRoot = resolve(dirname(xtensaTool('as')), '..', 'lib', 'gcc', 'xtensa-esp32-elf');
  const version = readdirSync(gccRoot).sort().at(-1);
  if (version === undefined) throw new Error(`no libgcc under ${gccRoot}`);
  return join(gccRoot, version);
}

export interface ProgramOutput {
  /** Path under fixtures/xtensa/. */
  file: string;
  bytes: Uint8Array;
}

/** Builds one program; returns its .bin and .lst without writing them to fixtures/. */
export function buildProgram(name: string): ProgramOutput[] {
  const dir = join(BUILD, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const source = join(XTENSA_DIR, `${name}.S`);
  const firstLine = readFileSync(source, 'utf8').split('\n')[0] ?? '';
  const run = (tool: string, args: string[]): string => execFileSync(xtensaTool(tool), args, { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  run('as', ['--text-section-literals', '-I', XTENSA_DIR, '-o', `${name}.o`, source]);
  const link = ['-Ttext=0x40080000', '-e', '_start', '-o', `${name}.elf`, `${name}.o`];
  if (/^#\s*link:\s*libgcc\b/.test(firstLine)) link.push('-L', libgccDir(), '-lgcc');
  run('ld', link);
  run('objcopy', ['-O', 'binary', `${name}.elf`, `${name}.bin`]);
  const listing = run('objdump', ['-d', `${name}.elf`]);
  return [
    { file: `${name}.bin`, bytes: readFileSync(join(dir, `${name}.bin`)) },
    { file: `${name}.lst`, bytes: Buffer.from(listing, 'utf8') },
  ];
}

/** Every program's name (fixtures/xtensa/*.S). */
export function listPrograms(): string[] {
  if (!existsSync(XTENSA_DIR)) return [];
  return readdirSync(XTENSA_DIR)
    .filter((f) => f.endsWith('.S'))
    .map((f) => f.slice(0, -2))
    .sort();
}

/**
 * Builds the programs (all, or `only`). Writes their outputs, or with `check` compares them
 * with the committed files. Returns the number of mismatches.
 */
export function buildPrograms(check: boolean, only?: string): number {
  let mismatches = 0;
  for (const name of listPrograms().filter((n) => only === undefined || n === only)) {
    for (const output of buildProgram(name)) {
      const path = join(XTENSA_DIR, output.file);
      if (check) {
        const same = existsSync(path) && Buffer.compare(readFileSync(path), Buffer.from(output.bytes)) === 0;
        if (!same) mismatches++;
        console.info(`${same ? 'same   ' : 'CHANGED'} xtensa/${output.file}`);
      } else {
        writeFileSync(path, output.bytes);
      }
    }
    if (!check) console.info(`xtensa/${name}: .bin and .lst`);
  }
  return mismatches;
}
