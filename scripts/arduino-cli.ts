/**
 * Finding and running the local arduino-cli. Shared by the fixture build (BT6) and, later, the
 * compile bridge (BT14). Zero dependencies; runs under plain Node type stripping.
 */

import { execFile } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

/** The arduino-cli bundled with Arduino IDE 2.x on macOS. */
export const IDE_BUNDLED_CLI = '/Applications/Arduino IDE.app/Contents/Resources/app/lib/backend/resources/arduino-cli';

/** Where to look, in order: $BENCHTOP_ARDUINO_CLI, `arduino-cli` on PATH, the IDE's bundled copy. */
export function arduinoCliCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const candidates: string[] = [];
  if (env.BENCHTOP_ARDUINO_CLI) candidates.push(env.BENCHTOP_ARDUINO_CLI);
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir) candidates.push(join(dir, 'arduino-cli'));
  }
  candidates.push(IDE_BUNDLED_CLI);
  return candidates;
}

/** The first candidate that is an existing file, or undefined. */
export function findArduinoCli(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return arduinoCliCandidates(env).find((path) => existsSync(path) && statSync(path).isFile());
}

/**
 * The IDE's built-in libraries folder (LiquidCrystal, Servo, Stepper, …): Arduino IDE 2 tells
 * its bundled CLI about it in ~/.arduinoIDE/arduino-cli.yaml, which a plain arduino-cli run
 * doesn't read. Undefined when it doesn't exist.
 */
export function builtinLibrariesDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string | undefined {
  if (env.ARDUINO_DIRECTORIES_BUILTIN_LIBRARIES) return env.ARDUINO_DIRECTORIES_BUILTIN_LIBRARIES;
  const dataDir = env.ARDUINO_DIRECTORIES_DATA || (process.platform === 'darwin' ? join(home, 'Library', 'Arduino15') : join(home, '.arduino15'));
  const dir = join(dataDir, 'libraries');
  return existsSync(dir) ? dir : undefined;
}

/**
 * An AVR binutils program (`avr-addr2line`, `avr-nm`, …) from the avr-gcc the Arduino AVR core
 * installed (the newest version folder), or $BENCHTOP_AVR_BIN/<name>. Undefined when missing.
 */
export function findAvrTool(name: string, env: NodeJS.ProcessEnv = process.env, home = homedir()): string | undefined {
  const dirs: string[] = [];
  if (env.BENCHTOP_AVR_BIN) dirs.push(env.BENCHTOP_AVR_BIN);
  const dataDir = env.ARDUINO_DIRECTORIES_DATA || (process.platform === 'darwin' ? join(home, 'Library', 'Arduino15') : join(home, '.arduino15'));
  const gccDir = join(dataDir, 'packages', 'arduino', 'tools', 'avr-gcc');
  if (existsSync(gccDir)) for (const version of readdirSync(gccDir).sort().reverse()) dirs.push(join(gccDir, version, 'bin'));
  return dirs.map((dir) => join(dir, name)).find((path) => existsSync(path) && statSync(path).isFile());
}

/**
 * An ESP32 (Xtensa) toolchain program (`xtensa-esp32-elf-as`, `-objdump`, `-nm`, …) from the
 * esp32 core's xtensa-esp32-elf-gcc (the newest version folder), or $BENCHTOP_XTENSA_BIN/<name>.
 */
export function findXtensaTool(name: string, env: NodeJS.ProcessEnv = process.env, home = homedir()): string | undefined {
  const dirs: string[] = [];
  if (env.BENCHTOP_XTENSA_BIN) dirs.push(env.BENCHTOP_XTENSA_BIN);
  const dataDir = env.ARDUINO_DIRECTORIES_DATA || (process.platform === 'darwin' ? join(home, 'Library', 'Arduino15') : join(home, '.arduino15'));
  const gccDir = join(dataDir, 'packages', 'esp32', 'tools', 'xtensa-esp32-elf-gcc');
  if (existsSync(gccDir)) for (const version of readdirSync(gccDir).sort().reverse()) dirs.push(join(gccDir, version, 'bin'));
  return dirs.map((dir) => join(dir, name)).find((path) => existsSync(path) && statSync(path).isFile());
}

/**
 * An Arm toolchain program (BT60: `arm-none-eabi-gcc`, `-objdump`, …) from the arduino-pico
 * core's pqt-gcc (the newest version folder), or $BENCHTOP_ARM_BIN/<name>.
 */
export function findArmTool(name: string, env: NodeJS.ProcessEnv = process.env, home = homedir()): string | undefined {
  const dirs: string[] = [];
  if (env.BENCHTOP_ARM_BIN) dirs.push(env.BENCHTOP_ARM_BIN);
  const dataDir = env.ARDUINO_DIRECTORIES_DATA || (process.platform === 'darwin' ? join(home, 'Library', 'Arduino15') : join(home, '.arduino15'));
  const gccDir = join(dataDir, 'packages', 'rp2040', 'tools', 'pqt-gcc');
  if (existsSync(gccDir)) for (const version of readdirSync(gccDir).sort().reverse()) dirs.push(join(gccDir, version, 'bin'));
  return dirs.map((dir) => join(dir, name)).find((path) => existsSync(path) && statSync(path).isFile());
}

/**
 * A RISC-V toolchain program (BT64): `$BENCHTOP_RISCV_BIN/<prefix><name>` (prefix
 * `$BENCHTOP_RISCV_PREFIX`, default `riscv32-unknown-elf-`), else the arduino-pico core's
 * pqt-gcc-riscv (the newest version folder). Its binutils (2.43) know the RP2350's extensions
 * (Zba, Zbb, Zbs, Zbkb, Zcb, Zcmp); the esp32 core's older riscv32-esp-elf binutils don't, so
 * they aren't used. Returns the path and its prefix.
 */
export function findRiscvTool(name: string, env: NodeJS.ProcessEnv = process.env, home = homedir()): { path: string; prefix: string } | undefined {
  const dataDir = env.ARDUINO_DIRECTORIES_DATA || (process.platform === 'darwin' ? join(home, 'Library', 'Arduino15') : join(home, '.arduino15'));
  const candidates: { dir: string; prefix: string }[] = [];
  if (env.BENCHTOP_RISCV_BIN) candidates.push({ dir: env.BENCHTOP_RISCV_BIN, prefix: env.BENCHTOP_RISCV_PREFIX ?? 'riscv32-unknown-elf-' });
  const tools = join(dataDir, 'packages', 'rp2040', 'tools', 'pqt-gcc-riscv');
  if (existsSync(tools)) for (const version of readdirSync(tools).sort().reverse()) candidates.push({ dir: join(tools, version, 'bin'), prefix: 'riscv32-unknown-elf-' });
  for (const { dir, prefix } of candidates) {
    const path = join(dir, `${prefix}${name}`);
    if (existsSync(path) && statSync(path).isFile()) return { path, prefix };
  }
  return undefined;
}

export interface CliResult {
  /** Exit code; null when killed (timeout). */
  code: number | null;
  stdout: string;
  stderr: string;
}

function cliEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ARDUINO_UPDATER_ENABLE_NOTIFICATION: 'false' };
  const builtin = builtinLibrariesDir();
  if (builtin !== undefined) env.ARDUINO_DIRECTORIES_BUILTIN_LIBRARIES = builtin;
  return env;
}

/**
 * Runs arduino-cli with an argument array (never a shell). Update notifications are turned
 * off so a run never reaches the network for them, and the IDE's built-in libraries are
 * visible (see `builtinLibrariesDir`). Resolves even on a non-zero exit.
 */
export function runArduinoCli(cli: string, args: readonly string[], timeoutMs = 600_000): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    execFile(
      cli,
      [...args],
      {
        env: cliEnv(),
        maxBuffer: 64 * 1024 * 1024,
        timeout: timeoutMs,
      },
      (error, stdout, stderr) => {
        if (error !== null && typeof error.code !== 'number' && !error.killed) {
          reject(error);
          return;
        }
        resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : null, stdout, stderr });
      },
    );
  });
}
