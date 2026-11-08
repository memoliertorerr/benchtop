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
  /** BT71: the nm that writes `<name>.syms.tsv` for this board's `SYMBOL_SKETCHES` only (the debugger's tests). */
  debugSymbols?: string;
  /** BT93: board menu options for single sketches, appended to the FQBN (`{ 'cdc-hello': 'CDCOnBoot=cdc' }`). */
  options?: Readonly<Record<string, string>>;
  /**
   * False: the outputs link code whose license doesn't allow redistributing them, so the public
   * repository leaves them out (the manifest marks them "redistributable": false; the snapshot drops
   * them and lists them in fixtures/withheld-firmware.json — THIRD_PARTY_NOTICES.md). Built and
   * committed here as any other.
   */
  redistributable?: false;
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
    // BT133: the board menu's PSRAM "Enabled" (a WROVER module's PSRAM, started by psramInit).
    options: { psram: 'PSRAM=enabled', 'psram-frame': 'PSRAM=enabled' },
  },
  // BT92: the ESP32-C3 (RISC-V) with the esp32 core (2.0.17), its Dev Module defaults: Serial on
  // UART0 (CDC on boot off), QIO 80 MHz flash, 160 MHz. Like the ESP32: the app image and the
  // partition table, symbols from the ELF (any RV32 nm reads it).
  esp32c3: {
    fqbn: 'esp32:esp32:esp32c3',
    outputs: [
      { from: 'bin', ext: 'bin' },
      { from: 'partitions.bin', ext: 'partitions.bin' },
    ],
    symbols: 'riscv32-unknown-elf-nm',
    // BT93: Serial over the C3's own USB (USB-Serial-JTAG), as on boards without a USB-UART chip.
    options: { 'cdc-hello': 'CDCOnBoot=cdc' },
  },
  // BT124: the ESP32-S3 (Xtensa LX7) with the esp32 core (2.0.17), its Dev Module defaults: Serial
  // on UART0 (USB mode Hardware CDC and JTAG, CDC on boot off), DIO 80 MHz flash, 240 MHz, no
  // PSRAM. As the ESP32 and C3: the app image and the partition table, symbols from the ELF.
  esp32s3: {
    fqbn: 'esp32:esp32:esp32s3',
    outputs: [
      { from: 'bin', ext: 'bin' },
      { from: 'partitions.bin', ext: 'partitions.bin' },
    ],
    symbols: 'xtensa-esp32s3-elf-nm',
    options: { 'cdc-hello': 'CDCOnBoot=cdc', 'psram-quad': 'PSRAM=enabled', 'psram-octal': 'PSRAM=opi', 'psram-frame': 'PSRAM=opi', 'usb-cdc': 'USBMode=default,CDCOnBoot=cdc', 'usb-rgb': 'USBMode=default,CDCOnBoot=cdc' },
  },
  // BT60: the Raspberry Pi Pico with the arduino-pico core (6.2.0). The UF2 is what a user drops
  // on the board; the ELF (1.3 MB, mostly DWARF) isn't committed.
  pico: {
    fqbn: 'rp2040:rp2040:rpipico',
    outputs: [{ from: 'uf2', ext: 'uf2' }],
    debugSymbols: 'arm-none-eabi-nm',
  },
  // BT110: the Raspberry Pi Pico W (arduino-pico 6.2.0): an RP2040 with the CYW43439, whose
  // driver the simulator answers at its API by name — every sketch keeps its symbols.
  picow: {
    fqbn: 'rp2040:rp2040:rpipicow',
    outputs: [{ from: 'uf2', ext: 'uf2' }],
    symbols: 'arm-none-eabi-nm',
    // The cyw43-driver (LICENSE.RP: Raspberry Pi devices only; LICENSE: non-commercial) and
    // Infineon's CYW43439 firmware are linked in: not redistributable.
    redistributable: false,
  },
  // BT113: the Raspberry Pi Pico 2 W on its RISC-V cores — the RP2350 with the CYW43439, answered
  // at its driver's API by name: every sketch keeps its symbols.
  pico2w: {
    fqbn: 'rp2040:rp2040:rpipico2w:arch=riscv',
    outputs: [{ from: 'uf2', ext: 'uf2' }],
    symbols: 'riscv32-unknown-elf-nm',
    redistributable: false, // as the Pico W's
  },
  // BT65: the Raspberry Pi Pico 2's RP2350 on its RISC-V cores (arduino-pico 6.2.0, arch=riscv).
  pico2: {
    fqbn: 'rp2040:rp2040:rpipico2:arch=riscv',
    outputs: [{ from: 'uf2', ext: 'uf2' }],
    debugSymbols: 'riscv32-unknown-elf-nm',
  },
};

/** BT71: sketches on boards with `debugSymbols` that get a `.syms.tsv` (the debugger's fixtures). */
export const SYMBOL_SKETCHES: readonly string[] = ['pico/debug-demo', 'pico2/debug-demo'];

/** The nm that writes a sketch's `.syms.tsv`, or undefined when it gets none. */
export function symbolsTool(board: string, name: string): string | undefined {
  const def = FIXTURE_BOARDS[board];
  return def?.symbols ?? (SYMBOL_SKETCHES.includes(`${board}/${name}`) ? def?.debugSymbols : undefined);
}

/** Every committed output of one sketch, as paths under fixtures/firmware/. */
export function sketchOutputs(board: string, name: string): string[] {
  const def = FIXTURE_BOARDS[board];
  if (def === undefined) return [];
  return [...def.outputs.map((o) => `${board}/${name}.${o.ext}`), ...(symbolsTool(board, name) === undefined ? [] : [`${board}/${name}.syms.tsv`])];
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
  /** False: the public repository leaves this file out (its board's `redistributable`). */
  redistributable?: false;
}

export interface Manifest {
  arduinoCli: string;
  /** Every installed platform, id → version. */
  cores: Record<string, string>;
  /** Every library installed in the sketchbook, name → version. */
  libraries: Record<string, string>;
  outputs: ManifestOutput[];
}

/** The FQBN a fixture sketch builds with: its board's, plus the sketch's menu options (BT93). */
export function fixtureFqbn(board: string, name: string): string {
  const b = FIXTURE_BOARDS[board];
  if (b === undefined) throw new Error(`unknown fixture board ${board}`);
  const options = b.options?.[name];
  return options === undefined ? b.fqbn : `${b.fqbn}:${options}`;
}
