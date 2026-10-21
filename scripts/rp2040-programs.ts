/**
 * The RP2040 test-program pipeline (BT60; part of `npm run fixtures`): every
 * fixtures/rp2040/<name>.c →
 *   arm-none-eabi-gcc -mcpu=cortex-m0plus -mthumb -O1 -ffreestanding -nostdlib -T <name>.ld →
 *   <name>.elf (no debug info), objdump -d <name>.lst
 * with the arduino-pico core's Arm toolchain (scripts/arduino-cli.ts findArmTool). Freestanding
 * programs (no SDK) that exercise our bootrom and the ELF loader; only the .c, .ld, .elf and
 * .lst are committed. Builds run in fixtures/.build/rp2040/<name> with relative file names, so
 * the outputs carry no machine path.
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findArmTool } from './arduino-cli.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const RP2040_PROGRAMS_DIR = join(ROOT, 'fixtures', 'rp2040');
const BUILD = join(ROOT, 'fixtures', '.build', 'rp2040');

function armTool(name: string): string {
  const path = findArmTool(`arm-none-eabi-${name}`);
  if (path === undefined) throw new Error(`arm-none-eabi-${name} not found (install the arduino-pico core or set BENCHTOP_ARM_BIN)`);
  return path;
}

/** Builds one program; returns its .elf and .lst without writing them to fixtures/. */
export function buildRp2040Program(name: string): { file: string; bytes: Uint8Array }[] {
  const dir = join(BUILD, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(RP2040_PROGRAMS_DIR, `${name}.c`), join(dir, `${name}.c`));
  copyFileSync(join(RP2040_PROGRAMS_DIR, `${name}.ld`), join(dir, `${name}.ld`));
  const run = (tool: string, args: string[]): string => execFileSync(armTool(tool), args, { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  run('gcc', ['-mcpu=cortex-m0plus', '-mthumb', '-O1', '-ffreestanding', '-nostdlib', '-fno-builtin', '-Wall', '-Wextra', '-Werror', '-T', `${name}.ld`, '-o', `${name}.elf`, `${name}.c`]);
  const listing = run('objdump', ['-d', `${name}.elf`]);
  return [
    { file: `${name}.elf`, bytes: readFileSync(join(dir, `${name}.elf`)) },
    { file: `${name}.lst`, bytes: Buffer.from(listing, 'utf8') },
  ];
}

export function listRp2040Programs(): string[] {
  if (!existsSync(RP2040_PROGRAMS_DIR)) return [];
  return readdirSync(RP2040_PROGRAMS_DIR)
    .filter((f) => f.endsWith('.c'))
    .map((f) => f.slice(0, -2))
    .sort();
}

/** Builds the programs (all, or `only`): writes them, or with `check` compares. Returns mismatches. */
export function buildRp2040Programs(check: boolean, only?: string): number {
  let mismatches = 0;
  const names = listRp2040Programs().filter((n) => only === undefined || n === only);
  if (only !== undefined && names.length === 0) throw new Error(`no fixtures/rp2040/${only}.c`);
  for (const name of names) {
    for (const output of buildRp2040Program(name)) {
      const path = join(RP2040_PROGRAMS_DIR, output.file);
      if (check) {
        const same = existsSync(path) && Buffer.compare(readFileSync(path), Buffer.from(output.bytes)) === 0;
        if (!same) mismatches++;
        console.info(`${same ? 'same   ' : 'CHANGED'} rp2040/${output.file}`);
      } else writeFileSync(path, output.bytes);
    }
    if (!check) console.info(`rp2040/${name}: .elf and .lst`);
  }
  return mismatches;
}
