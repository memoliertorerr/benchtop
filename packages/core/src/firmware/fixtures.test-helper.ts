/**
 * Reads committed fixtures (fixtures/…) for tests. Node-only: tests and other packages' tests
 * import it by relative path; production code never does.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository root (this file is packages/core/src/firmware/). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** The bytes of a file, by path from the repository root. */
export function readFixture(pathFromRepoRoot: string): Uint8Array {
  const buffer = readFileSync(resolve(REPO_ROOT, pathFromRepoRoot));
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

/** The text of a file (UTF-8), by path from the repository root. */
export function readFixtureText(pathFromRepoRoot: string): string {
  return readFileSync(resolve(REPO_ROOT, pathFromRepoRoot), 'utf8');
}
