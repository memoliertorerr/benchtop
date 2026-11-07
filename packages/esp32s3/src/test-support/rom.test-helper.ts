/**
 * The cached ESP32-S3 ROM for tests (Node-only). As for the ESP32 and the C3, ROM tests fail
 * loudly — never skip: without the cache they say how to get it (`npm run fetch:esp32-rom`
 * extracts it from the same pinned tarball as the ESP32's).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256Hex } from '@benchtop/esp32';
import { REPO_ROOT } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { parseS3Rom, type S3Rom } from '../boot/rom.ts';
import { S3_ROM_CACHE_DIR, S3_ROM_ELF_NAME, S3_ROM_ELF_SHA256 } from '../rom-manifest.ts';

export const DEFAULT_S3_ROM_DIR = join(REPO_ROOT, S3_ROM_CACHE_DIR);

/** The S3 ROM ELF's bytes from `dir` (default: the repo's .cache/esp32s3-rom), hash-checked. */
export function loadCachedS3Rom(dir: string = DEFAULT_S3_ROM_DIR): Uint8Array {
  const path = join(dir, S3_ROM_ELF_NAME);
  if (!existsSync(path)) throw new Error(`ESP32-S3 ROM not found in ${dir}: run npm run fetch:esp32-rom (needs a human-approved download unless the tarball is cached)`);
  const bytes = new Uint8Array(readFileSync(path));
  const hash = sha256Hex(bytes);
  if (hash !== S3_ROM_ELF_SHA256) throw new Error(`ESP32-S3 ROM at ${path} has SHA-256 ${hash}, expected ${S3_ROM_ELF_SHA256}: delete it and run npm run fetch:esp32-rom again`);
  return bytes;
}

let rom: S3Rom | undefined;
export function cachedS3Rom(): S3Rom {
  rom ??= parseS3Rom(loadCachedS3Rom());
  return rom;
}
