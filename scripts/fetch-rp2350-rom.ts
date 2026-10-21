/**
 * Fetches the RP2350 bootrom (BT65; pico-bootrom-rp2350 release A4, BSD-3-Clause):
 *   npm run fetch:rp2350-rom           exit 0 if every cached asset verifies; else print what
 *                                      would be downloaded and exit 2
 *   npm run fetch:rp2350-rom -- --yes  download (after a human approved it) and verify
 * Integrity: each asset's size and SHA-256 must equal rom-manifest.ts' pinned values (GitHub's
 * published digests for the release). Files go under ROM_CACHE_DIR (git-ignored), never committed.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROM_ASSETS, ROM_CACHE_DIR, ROM_RELEASE, type RomAsset } from '../packages/rp2350/src/rom-manifest.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, ROM_CACHE_DIR);
const MAX_BYTES = 1024 * 1024;

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const verified = (asset: RomAsset, bytes: Uint8Array): boolean => bytes.length === asset.bytes && sha256(bytes) === asset.sha256;

async function download(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || response.body === null) throw new Error(`${url}: HTTP ${response.status}`);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > MAX_BYTES) throw new Error(`${url}: over the ${MAX_BYTES}-byte cap`);
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.some((a) => a !== '--yes')) {
    console.error('usage: npm run fetch:rp2350-rom [-- --yes]');
    return 1;
  }
  const missing = ROM_ASSETS.filter((a) => {
    const path = join(CACHE, a.name);
    return !existsSync(path) || !verified(a, new Uint8Array(readFileSync(path)));
  });
  if (missing.length === 0) {
    console.info(`RP2350 bootrom ${ROM_RELEASE}: ${ROM_ASSETS.map((a) => a.name).join(', ')} cached and verified in ${ROM_CACHE_DIR}.`);
    return 0;
  }
  if (!args.includes('--yes')) {
    console.info(
      [
        `The RP2350 bootrom (pico-bootrom-rp2350 ${ROM_RELEASE}, BSD-3-Clause) is not cached. Fetching it downloads:`,
        ...missing.map((a) => `  ${a.url}  (${a.bytes.toLocaleString('en-US')} bytes)`),
        `into ${CACHE} (git-ignored).`,
        'A human must approve this download. Then run: npm run fetch:rp2350-rom -- --yes',
      ].join('\n'),
    );
    return 2;
  }
  mkdirSync(CACHE, { recursive: true });
  for (const asset of missing) {
    const bytes = await download(asset.url);
    if (!verified(asset, bytes)) {
      console.error(`${asset.name}: ${bytes.length} bytes, SHA-256 ${sha256(bytes)} — the pinned values are ${asset.bytes} bytes, ${asset.sha256}`);
      return 1;
    }
    writeFileSync(join(CACHE, asset.name), bytes);
    console.info(`wrote ${ROM_CACHE_DIR}/${asset.name} (${bytes.length} bytes, SHA-256 ${asset.sha256})`);
  }
  return 0;
}

process.exitCode = await main();
