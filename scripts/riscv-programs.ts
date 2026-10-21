/**
 * The RISC-V test-program pipeline (BT64; part of `npm run fixtures`): every
 * fixtures/riscv/programs/<name>.S →
 *   as -march=<RISCV_MARCH: the Hazard3 ISA> → ld -Ttext=0x80000000 --no-relax -e _start →
 *   objcopy -O binary <name>.bin, objdump -d <name>.lst
 * with the arduino-pico core's RISC-V toolchain (scripts/arduino-cli.ts findRiscvTool). Only the
 * .S, .bin and .lst are committed. Builds run in fixtures/.build/riscv/programs/<name> with
 * relative file names, so the .lst header carries no machine path. Conventions:
 * programs/harness.inc.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RISCV_MARCH, riscvTool } from './riscv-corpus.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const RISCV_PROGRAMS_DIR = join(ROOT, 'fixtures', 'riscv', 'programs');
const BUILD = join(ROOT, 'fixtures', '.build', 'riscv', 'programs');

export interface RiscvProgramOutput {
  /** Path under fixtures/riscv/programs/. */
  file: string;
  bytes: Uint8Array;
}

/** Builds one program; returns its .bin and .lst without writing them to fixtures/. */
export function buildRiscvProgram(name: string): RiscvProgramOutput[] {
  const dir = join(BUILD, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const run = (tool: string, args: string[]): string => execFileSync(riscvTool(tool), args, { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  run('as', [`-march=${RISCV_MARCH}`, '-mabi=ilp32', '-I', RISCV_PROGRAMS_DIR, '-o', `${name}.o`, join(RISCV_PROGRAMS_DIR, `${name}.S`)]);
  run('ld', ['-Ttext=0x80000000', '--no-relax', '-e', '_start', '-o', `${name}.elf`, `${name}.o`]);
  run('objcopy', ['-O', 'binary', `${name}.elf`, `${name}.bin`]);
  const listing = run('objdump', ['-d', `${name}.elf`]);
  return [
    { file: `${name}.bin`, bytes: readFileSync(join(dir, `${name}.bin`)) },
    { file: `${name}.lst`, bytes: Buffer.from(listing, 'utf8') },
  ];
}

/** Every program's name (fixtures/riscv/programs/*.S). */
export function listRiscvPrograms(): string[] {
  if (!existsSync(RISCV_PROGRAMS_DIR)) return [];
  return readdirSync(RISCV_PROGRAMS_DIR)
    .filter((f) => f.endsWith('.S'))
    .map((f) => f.slice(0, -2))
    .sort();
}

/** Builds the programs (all, or `only`): writes them, or with `check` compares. Returns mismatches. */
export function buildRiscvPrograms(check: boolean, only?: string): number {
  let mismatches = 0;
  const names = listRiscvPrograms().filter((n) => only === undefined || n === only);
  if (only !== undefined && names.length === 0) throw new Error(`no fixtures/riscv/programs/${only}.S`);
  for (const name of names) {
    for (const output of buildRiscvProgram(name)) {
      const path = join(RISCV_PROGRAMS_DIR, output.file);
      if (check) {
        const same = existsSync(path) && Buffer.compare(readFileSync(path), Buffer.from(output.bytes)) === 0;
        if (!same) mismatches++;
        console.info(`${same ? 'same   ' : 'CHANGED'} riscv/programs/${output.file}`);
      } else writeFileSync(path, output.bytes);
    }
    if (!check) console.info(`riscv/${name}: .bin and .lst`);
  }
  return mismatches;
}
