/**
 * The cached ESP32-C3 ROM for tests (Node-only). As for the ESP32 (@benchtop/esp32's
 * rom.test-helper.ts), ROM tests fail loudly — never skip: without the cache they say how to get
 * it (`npm run fetch:esp32-rom` extracts it from the same pinned tarball as the ESP32's).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256Hex } from '@benchtop/esp32';
import { REPO_ROOT } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { type C3Rom, parseC3Rom } from '../boot/rom.ts';
import { C3_ROM_CACHE_DIR, C3_ROM_ELF_NAME, C3_ROM_ELF_SHA256 } from '../rom-manifest.ts';

export const DEFAULT_C3_ROM_DIR = join(REPO_ROOT, C3_ROM_CACHE_DIR);

/** The C3 ROM ELF's bytes from `dir` (default: the repo's .cache/esp32c3-rom), hash-checked. */
export function loadCachedC3Rom(dir: string = DEFAULT_C3_ROM_DIR): Uint8Array {
  const path = join(dir, C3_ROM_ELF_NAME);
  if (!existsSync(path)) throw new Error(`ESP32-C3 ROM not found in ${dir}: run npm run fetch:esp32-rom (needs a human-approved download unless the tarball is cached)`);
  const bytes = new Uint8Array(readFileSync(path));
  const hash = sha256Hex(bytes);
  if (hash !== C3_ROM_ELF_SHA256) throw new Error(`ESP32-C3 ROM at ${path} has SHA-256 ${hash}, expected ${C3_ROM_ELF_SHA256}: delete it and run npm run fetch:esp32-rom again`);
  return bytes;
}

let rom: C3Rom | undefined;
export function cachedC3Rom(): C3Rom {
  rom ??= parseC3Rom(loadCachedC3Rom());
  return rom;
}
