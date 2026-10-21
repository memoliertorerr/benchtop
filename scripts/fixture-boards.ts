/**
 * Which boards fixture sketches are built for: the folder name under fixtures/sketches/, its
 * FQBN, and which arduino-cli outputs are kept (`<name>.ino.<from>` → `<name>.<ext>`).
 * Shared by scripts/build-fixtures.ts and scripts/fixtures.test.ts.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** A sketch folder's source files: what arduino-cli compiles. */
export const SKETCH_SOURCE = /\.(?:ino|h|hpp|c|cpp)$/;

/**
 * SHA-256 over a sketch folder's source files (BT43), in name order: each file's name, a NUL,
 * its bytes, a NUL. The manifest records it per output, so a test can tell that a committed
 * firmware was built from the sketch as it is now.
 */
export function sketchSourceSha256(dir: string): string {
  const hash = createHash('sha256');
  for (const name of readdirSync(dir).filter((n) => SKETCH_SOURCE.test(n)).sort()) {
    hash.update(name);
    hash.update('\0');
    hash.update(readFileSync(join(dir, name)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export interface FixtureBoard {
  fqbn: string;
  outputs: readonly { from: string; ext: string }[];
  /**
   * Also write `<name>.syms.tsv` ("addr\tsize\ttype\tname", from `nm -S -n --defined-only` of
   * the full ELF) with this toolchain nm — for boards whose ELF isn't committed (ESP32: 6 MB,
   * mostly DWARF).
   */
  symbols?: string;
}

export const FIXTURE_BOARDS: Readonly<Record<string, FixtureBoard>> = {
  uno: {
    fqbn: 'arduino:avr:uno',
    outputs: [
      { from: 'hex', ext: 'hex' },
      { from: 'elf', ext: 'elf' },
    ],
  },
  nano: {
    fqbn: 'arduino:avr:nano',
    outputs: [
      { from: 'hex', ext: 'hex' },
      { from: 'elf', ext: 'elf' },
    ],
  },
  mega: {
    fqbn: 'arduino:avr:mega',
    outputs: [
      { from: 'hex', ext: 'hex' },
      { from: 'elf', ext: 'elf' },
    ],
  },
  esp32: {
    fqbn: 'esp32:esp32:esp32',
    outputs: [
      { from: 'bin', ext: 'bin' },
      { from: 'partitions.bin', ext: 'partitions.bin' },
    ],
    symbols: 'xtensa-esp32-elf-nm',
  },
  // BT60: the Raspberry Pi Pico with the arduino-pico core (6.2.0). The UF2 is what a user drops
  // on the board; the ELF (1.3 MB, mostly DWARF) isn't committed.
  pico: {
    fqbn: 'rp2040:rp2040:rpipico',
    outputs: [{ from: 'uf2', ext: 'uf2' }],
  },
};

/** Every committed output of one sketch, as paths under fixtures/firmware/. */
export function sketchOutputs(board: string, name: string): string[] {
  const def = FIXTURE_BOARDS[board];
  if (def === undefined) return [];
  return [...def.outputs.map((o) => `${board}/${name}.${o.ext}`), ...(def.symbols === undefined ? [] : [`${board}/${name}.syms.tsv`])];
}

/**
 * Sketches that also get an addr2line oracle, `<board>/<name>.addr2line.txt`: every FUNC symbol
 * start plus every 64th byte of .text, resolved by the local avr-addr2line (BT24's DWARF tests).
 */
export const ADDR2LINE_ORACLES: readonly string[] = ['uno/blink', 'uno/debug-demo'];

/** One built file, as recorded in fixtures/firmware/manifest.json. */
export interface ManifestOutput {
  board: string;
  name: string;
  fqbn: string;
  /** Path under fixtures/firmware/, e.g. "uno/blink.hex". */
  file: string;
  sha256: string;
  bytes: number;
  /** The platform that built it, "<id>@<version>". */
  core: string;
  /** Libraries the sketch used, name → version ("" when the library declares none). */
  libraries: Record<string, string>;
  /** sketchSourceSha256 of the sketch folder it was built from (BT43; absent before). */
  source?: string;
}

export interface Manifest {
  arduinoCli: string;
  /** Every installed platform, id → version. */
  cores: Record<string, string>;
  /** Every library installed in the sketchbook, name → version. */
  libraries: Record<string, string>;
  outputs: ManifestOutput[];
}
