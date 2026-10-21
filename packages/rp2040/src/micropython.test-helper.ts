/**
 * The cached MicroPython UF2 for tests (Node-only; BT63). Tests that need it fail loudly through
 * this — never skip: without the cache they say how to get it (a human-approved download).
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, readFixtureText } from '../../core/src/firmware/fixtures.test-helper.ts';
import { MICROPYTHON_CACHE_DIR, MICROPYTHON_PICO, type MicroPythonBuild } from './micropython-manifest.ts';
import type { MicroPythonSketch } from './micropython.ts';

/** A cached MicroPython build's bytes, size- and hash-checked. */
export function cachedMicroPython(build: MicroPythonBuild = MICROPYTHON_PICO): Uint8Array {
  const path = join(REPO_ROOT, MICROPYTHON_CACHE_DIR, build.name);
  if (!existsSync(path)) throw new Error(`MicroPython not found at ${path}: run npm run fetch:micropython (needs a human-approved download)`);
  const bytes = new Uint8Array(readFileSync(path));
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (bytes.length !== build.bytes || hash !== build.sha256) throw new Error(`${path} is ${bytes.length} bytes with SHA-256 ${hash}, expected ${build.bytes} bytes and ${build.sha256}: delete it and run npm run fetch:micropython again`);
  return bytes;
}

/** A MicroPython fixture (fixtures/micropython/<name>/main.py) as a sketch. */
export function micropythonFixture(name: string): MicroPythonSketch {
  return { format: 'micropython', files: { 'main.py': readFixtureText(`fixtures/micropython/${name}/main.py`) }, main: 'main.py' };
}
