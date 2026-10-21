/**
 * Fetches the stock MicroPython UF2s Benchtop runs on the Picos (BT63; micropython.org, MIT):
 *   npm run fetch:micropython                  exit 0 if every cached UF2 verifies; else print
 *                                              what would be downloaded and exit 2
 *   npm run fetch:micropython -- --yes         download (after a human approved it) and verify
 *   npm run fetch:micropython -- --yes --record  print the sizes and hashes instead of comparing
 *                                              them with the pinned ones (only for filling
 *                                              micropython-manifest.ts)
 * Integrity: each file's size and SHA-256 must equal MICROPYTHON_BUILDS' pinned values, and it
 * must parse as a UF2 for its family. Files are written under MICROPYTHON_CACHE_DIR
 * (git-ignored) and never committed.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MICROPYTHON_BUILDS, MICROPYTHON_CACHE_DIR, MICROPYTHON_VERSION, type MicroPythonBuild } from '../packages/rp2040/src/micropython-manifest.ts';
import { parseUf2 } from '../packages/core/src/firmware/uf2.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, MICROPYTHON_CACHE_DIR);
const MAX_BYTES = 4 * 1024 * 1024;

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

async function download(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || response.body === null) throw new Error(`${url}: HTTP ${response.status}`);
  const length = Number(response.headers.get('content-length') ?? '0');
  if (length > MAX_BYTES) throw new Error(`${url}: ${length} bytes is over the ${MAX_BYTES}-byte cap`);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > MAX_BYTES) throw new Error(`${url}: over the ${MAX_BYTES}-byte cap`);
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

const verified = (build: MicroPythonBuild, bytes: Uint8Array): boolean => bytes.length === build.bytes && sha256(bytes) === build.sha256;

function cached(build: MicroPythonBuild): boolean {
  const path = join(CACHE, build.name);
  return existsSync(path) && verified(build, new Uint8Array(readFileSync(path)));
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const yes = args.includes('--yes');
  const record = args.includes('--record');
  if (args.some((a) => a !== '--yes' && a !== '--record')) {
    console.error('usage: npm run fetch:micropython [-- --yes [--record]]');
    return 1;
  }
  const missing = record ? [...MICROPYTHON_BUILDS] : MICROPYTHON_BUILDS.filter((b) => !cached(b));
  if (missing.length === 0) {
    console.info(`MicroPython ${MICROPYTHON_VERSION}: ${MICROPYTHON_BUILDS.map((b) => b.name).join(', ')} cached and verified in ${MICROPYTHON_CACHE_DIR}.`);
    return 0;
  }
  if (!yes) {
    console.info(
      [
        `MicroPython ${MICROPYTHON_VERSION} (MIT) is not cached. Fetching it downloads:`,
        ...missing.map((b) => `  ${b.url}  (${b.bytes.toLocaleString('en-US')} bytes)`),
        `into ${CACHE} (git-ignored).`,
        'A human must approve this download. Then run: npm run fetch:micropython -- --yes',
      ].join('\n'),
    );
    return 2;
  }
  mkdirSync(CACHE, { recursive: true });
  for (const build of missing) {
    const bytes = await download(build.url);
    const hash = sha256(bytes);
    const uf2 = parseUf2(bytes); // throws on a file that isn't a UF2
    if (record) {
      console.info(`${build.name}: bytes ${bytes.length}, sha256 '${hash}', family 0x${(uf2.familyId ?? 0).toString(16)}`);
      writeFileSync(join(CACHE, build.name), bytes);
      continue;
    }
    if (!verified(build, bytes)) {
      console.error(`${build.name}: ${bytes.length} bytes, SHA-256 ${hash} — the pinned values are ${build.bytes} bytes, ${build.sha256}`);
      return 1;
    }
    writeFileSync(join(CACHE, build.name), bytes);
    console.info(`wrote ${MICROPYTHON_CACHE_DIR}/${build.name} (${bytes.length} bytes, SHA-256 ${hash})`);
  }
  return 0;
}

process.exitCode = await main();
