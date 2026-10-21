/**
 * The CLI's real file system and clock (main.ts and the test workers share it; tests use fakes).
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { MICROPYTHON_CACHE_DIR, MICROPYTHON_PICO, MICROPYTHON_PICO2_RISCV } from '@benchtop/rp2040';
import { ROM_CACHE_DIR, ROM_IMAGE } from '@benchtop/rp2350';
import type { SuiteIo } from './suite.ts';

/** The Benchtop repository (its caches and, BT69, the gallery's examples for the MCP server). */
export const REPO = decodeURIComponent(new URL('../../..', import.meta.url).pathname);
/** The ESP32 ROM `npm run fetch:esp32-rom` caches in the repository (BT34). */
const ESP32_ROM = resolve(REPO, '.cache/esp32-rom/esp32_rev0_rom.elf');
/** The Pico's MicroPython UF2 `npm run fetch:micropython` caches (BT63). */
const MICROPYTHON = resolve(REPO, MICROPYTHON_CACHE_DIR, MICROPYTHON_PICO.name);
/** The Pico 2's (RISC-V) MicroPython UF2, from the same fetch (BT67). */
const MICROPYTHON_PICO2 = resolve(REPO, MICROPYTHON_CACHE_DIR, MICROPYTHON_PICO2_RISCV.name);
/** The RP2350 bootrom `npm run fetch:rp2350-rom` caches (BT65). */
const RP2350_ROM = resolve(REPO, ROM_CACHE_DIR, ROM_IMAGE.name);

export const nodeIo: SuiteIo = {
  readFile: (path) => readFileSync(resolve(process.cwd(), path)),
  now: () => performance.now(),
  esp32Rom: () => (existsSync(ESP32_ROM) ? new Uint8Array(readFileSync(ESP32_ROM)) : undefined),
  micropython: () => (existsSync(MICROPYTHON) ? new Uint8Array(readFileSync(MICROPYTHON)) : undefined),
  rp2350Rom: () => (existsSync(RP2350_ROM) ? new Uint8Array(readFileSync(RP2350_ROM)) : undefined),
  micropythonPico2: () => (existsSync(MICROPYTHON_PICO2) ? new Uint8Array(readFileSync(MICROPYTHON_PICO2)) : undefined),
  isDirectory: (path) => {
    try {
      return statSync(resolve(process.cwd(), path)).isDirectory();
    } catch {
      return false;
    }
  },
  list: (dir) => readdirSync(resolve(process.cwd(), dir), { withFileTypes: true }).map((e) => ({ name: e.name, directory: e.isDirectory() })),
};
