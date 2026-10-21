/**
 * The cached ESP32 ROM for tests (Node-only). ROM tests fail loudly through this — never skip:
 * without the cache they say how to get it (a human-approved ≈3.4 MB download).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { ROM_CACHE_DIR, ROM_ELF_NAME, ROM_ELF_SHA256 } from '../boot/rom-manifest.ts';
import { sha256Hex } from '../util/sha256.ts';

export const DEFAULT_ROM_DIR = join(REPO_ROOT, ROM_CACHE_DIR);

/** The ROM ELF's bytes from `dir` (default: the repo's .cache/esp32-rom), hash-checked. */
export function loadCachedRom(dir: string = DEFAULT_ROM_DIR): Uint8Array {
  const path = join(dir, ROM_ELF_NAME);
  if (!existsSync(path)) throw new Error(`ESP32 ROM not found in ${dir}: run npm run fetch:esp32-rom (needs a human-approved download)`);
  const bytes = new Uint8Array(readFileSync(path));
  const hash = sha256Hex(bytes);
  if (hash !== ROM_ELF_SHA256) throw new Error(`ESP32 ROM at ${path} has SHA-256 ${hash}, expected ${ROM_ELF_SHA256}: delete it and run npm run fetch:esp32-rom again`);
  return bytes;
}
