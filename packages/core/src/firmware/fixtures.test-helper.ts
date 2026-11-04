/**
 * Reads committed fixtures (fixtures/…) for tests. Node-only: tests and other packages' tests
 * import it by relative path; production code never does.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository root (this file is packages/core/src/firmware/). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** The bytes of a file, by path from the repository root. */
export function readFixture(pathFromRepoRoot: string): Uint8Array {
  const buffer = readFileSync(resolve(REPO_ROOT, pathFromRepoRoot));
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

/**
 * Why a firmware fixture is missing from this tree, or undefined. The published repository leaves
 * some out (the Pico W's and Pico 2 W's: they link code whose license doesn't allow redistributing
 * it — THIRD_PARTY_NOTICES.md); its snapshot lists them, with the reason, in
 * fixtures/withheld-firmware.json. A listed file that is missing is withheld — tests that need it
 * skip with this; built back (`npm run fixtures -- --only picow`), it runs. The private tree has
 * no such list: nothing is withheld there, and a missing fixture fails as it always did.
 * `file`: a path under fixtures/firmware ("picow/blink.uf2"), or from the repository root.
 */
export function withheldFirmware(file: string): string | undefined {
  const list = resolve(REPO_ROOT, 'fixtures/withheld-firmware.json');
  if (!existsSync(list)) return undefined;
  const { reason, files } = JSON.parse(readFileSync(list, 'utf8')) as { reason?: string; files?: string[] };
  const name = file.replace(/^fixtures\/firmware\//, '');
  if (files?.includes(name) !== true || existsSync(resolve(REPO_ROOT, 'fixtures/firmware', name))) return undefined;
  return reason ?? 'left out of this tree';
}

/** The text of a file (UTF-8), by path from the repository root. */
export function readFixtureText(pathFromRepoRoot: string): string {
  return readFileSync(resolve(REPO_ROOT, pathFromRepoRoot), 'utf8');
}
