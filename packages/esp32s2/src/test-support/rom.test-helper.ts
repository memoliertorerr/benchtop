/**
 * The cached ESP32-S2 ROM for tests (Node-only). As for the other chips, ROM tests fail loudly —
 * never skip: without the cache they say how to get it (`npm run fetch:esp32-rom` extracts it from
 * the same pinned tarball as the ESP32's).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256Hex } from '@benchtop/esp32';
import { REPO_ROOT } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { parseS2Rom, type S2Rom } from '../boot/rom.ts';
import { S2_ROM_CACHE_DIR, S2_ROM_ELF_NAME, S2_ROM_ELF_SHA256 } from '../rom-manifest.ts';

export const DEFAULT_S2_ROM_DIR = join(REPO_ROOT, S2_ROM_CACHE_DIR);

/** The S2 ROM ELF's bytes from `dir` (default: the repo's .cache/esp32s2-rom), hash-checked. */
export function loadCachedS2Rom(dir: string = DEFAULT_S2_ROM_DIR): Uint8Array {
  const path = join(dir, S2_ROM_ELF_NAME);
  if (!existsSync(path)) throw new Error(`ESP32-S2 ROM not found in ${dir}: run npm run fetch:esp32-rom (needs a human-approved download unless the tarball is cached)`);
  const bytes = new Uint8Array(readFileSync(path));
  const hash = sha256Hex(bytes);
  if (hash !== S2_ROM_ELF_SHA256) throw new Error(`ESP32-S2 ROM at ${path} has SHA-256 ${hash}, expected ${S2_ROM_ELF_SHA256}: delete it and run npm run fetch:esp32-rom again`);
  return bytes;
}

let rom: S2Rom | undefined;
export function cachedS2Rom(): S2Rom {
  rom ??= parseS2Rom(loadCachedS2Rom());
  return rom;
}
