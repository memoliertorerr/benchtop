/**
 * The CLI's real file system and clock (main.ts and the test workers share it; tests use fakes).
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { MICROPYTHON_CACHE_DIR, MICROPYTHON_PICO } from '@benchtop/rp2040';
import type { SuiteIo } from './suite.ts';

const REPO = decodeURIComponent(new URL('../../..', import.meta.url).pathname);
/** The ESP32 ROM `npm run fetch:esp32-rom` caches in the repository (BT34). */
const ESP32_ROM = resolve(REPO, '.cache/esp32-rom/esp32_rev0_rom.elf');
/** The Pico's MicroPython UF2 `npm run fetch:micropython` caches (BT63). */
const MICROPYTHON = resolve(REPO, MICROPYTHON_CACHE_DIR, MICROPYTHON_PICO.name);

export const nodeIo: SuiteIo = {
  readFile: (path) => readFileSync(resolve(process.cwd(), path)),
  now: () => performance.now(),
  esp32Rom: () => (existsSync(ESP32_ROM) ? new Uint8Array(readFileSync(ESP32_ROM)) : undefined),
  micropython: () => (existsSync(MICROPYTHON) ? new Uint8Array(readFileSync(MICROPYTHON)) : undefined),
  isDirectory: (path) => {
    try {
      return statSync(resolve(process.cwd(), path)).isDirectory();
    } catch {
      return false;
    }
  },
  list: (dir) => readdirSync(resolve(process.cwd(), dir), { withFileTypes: true }).map((e) => ({ name: e.name, directory: e.isDirectory() })),
};
