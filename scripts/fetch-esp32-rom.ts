/**
 * Fetches the ESP32 mask ROM ELF from Espressif's esp-rom-elfs release (Apache-2.0):
 *   npm run fetch:esp32-rom                  exit 0 if the cached ELF verifies; else print what
 *                                            would be downloaded and exit 2
 *   npm run fetch:esp32-rom -- --yes         download (after a human approved it) and verify
 *   npm run fetch:esp32-rom -- --yes --record  print the hashes instead of comparing them with the
 *                                            pinned ones (only for filling rom-manifest.ts)
 *   npm run fetch:esp32-rom -- --corpus      rewrite the cached ROM's decode corpus
 * Integrity: the tarball's SHA-256 must equal BOTH the release's published checksum asset and
 * ROM_TARBALL_SHA256; only ROM_ELF_NAME is extracted (gunzip + a ustar reader that validates
 * headers) and checked against ROM_ELF_SHA256. Everything is written under ROM_CACHE_DIR
 * (git-ignored) — nothing ROM-derived is ever committed. With the Xtensa toolchain present it
 * also writes rom-corpus.tsv.gz there (the decode-corpus format of scripts/xtensa-corpus.ts).
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { parseElf32 } from '../packages/core/src/firmware/elf.ts';
import {
  ROM_CACHE_DIR,
  ROM_CHECKSUM_URL,
  ROM_ELF_NAME,
  ROM_ELF_SHA256,
  ROM_RELEASE,
  ROM_TARBALL_NAME,
  ROM_TARBALL_SHA256,
  ROM_TARBALL_URL,
} from '../packages/esp32/src/boot/rom-manifest.ts';
import { readTar } from '../packages/esp32/src/util/ustar.ts';
import { findXtensaTool } from './arduino-cli.ts';
import { decodeElfSections } from './xtensa-corpus.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, ROM_CACHE_DIR);
const ELF_PATH = join(CACHE, ROM_ELF_NAME);
const TARBALL_PATH = join(CACHE, ROM_TARBALL_NAME);
const MAX_TARBALL = 32 * 1024 * 1024;

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

async function download(url: string, maxBytes: number): Promise<Uint8Array> {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || response.body === null) throw new Error(`${url}: HTTP ${response.status}`);
  const length = Number(response.headers.get('content-length') ?? '0');
  if (length > maxBytes) throw new Error(`${url}: ${length} bytes is over the ${maxBytes}-byte cap`);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > maxBytes) throw new Error(`${url}: over the ${maxBytes}-byte cap`);
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

/** The hash the checksum asset lists for the tarball ("<64 hex>  <name>" lines). */
function publishedHash(text: string): { hash: string; line: string } | undefined {
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (m !== null && basename(m[2].trim()) === ROM_TARBALL_NAME) return { hash: m[1].toLowerCase(), line: line.trim() };
  }
  return undefined;
}

/** The ROM's executable sections through objdump, as rom-corpus.tsv.gz (BT28's ROM decode check). */
function writeRomCorpus(): void {
  if (findXtensaTool('xtensa-esp32-elf-objdump') === undefined) {
    console.info('xtensa-esp32-elf-objdump not found: rom-corpus.tsv.gz not written');
    return;
  }
  const elf = parseElf32(readFileSync(ELF_PATH));
  const sections = elf.sections.filter((s) => (s.flags & 4) !== 0 && s.size > 0).map((s) => s.name);
  const { rows } = decodeElfSections(ELF_PATH, sections); // raw bytes per section: no property tables
  const tsv = `# address\tbytes\tmnemonic\toperands\n${rows.map((r) => `${r.address.toString(16).padStart(8, '0')}\t${r.bytes}\t${r.mnemonic}\t${r.operands}`).join('\n')}\n`;
  writeFileSync(join(CACHE, 'rom-corpus.tsv.gz'), gzipSync(tsv, { level: 9 }));
  console.info(`wrote ${ROM_CACHE_DIR}/rom-corpus.tsv.gz (${rows.length} rows from ${sections.join(', ')})`);
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const yes = args.includes('--yes');
  const record = args.includes('--record');
  const unknown = args.filter((a) => a !== '--yes' && a !== '--record' && a !== '--corpus');
  if (unknown.length > 0) {
    console.error('usage: npm run fetch:esp32-rom [-- --yes [--record]]');
    return 1;
  }

  if (!record && existsSync(ELF_PATH) && sha256(readFileSync(ELF_PATH)) === ROM_ELF_SHA256) {
    console.info(`${ROM_CACHE_DIR}/${ROM_ELF_NAME} is cached and verified (SHA-256 ${ROM_ELF_SHA256}).`);
    if (!existsSync(join(CACHE, 'rom-corpus.tsv.gz')) || args.includes('--corpus')) writeRomCorpus();
    return 0;
  }

  const cachedTarball = existsSync(TARBALL_PATH) ? new Uint8Array(readFileSync(TARBALL_PATH)) : undefined;
  if (!yes) {
    console.info(
      [
        `The ESP32 ROM (esp-rom-elfs ${ROM_RELEASE}, Apache-2.0) is not cached. Fetching it downloads:`,
        `  ${ROM_TARBALL_URL}  (≈3.4 MB)`,
        `  ${ROM_CHECKSUM_URL}  (the published SHA-256)`,
        `into ${CACHE} (git-ignored; only ${ROM_ELF_NAME} is kept${cachedTarball === undefined ? '' : ', a tarball is already there'}).`,
        'A human must approve this download. Then run: npm run fetch:esp32-rom -- --yes',
      ].join('\n'),
    );
    return 2;
  }

  mkdirSync(CACHE, { recursive: true });
  const checksumText = new TextDecoder().decode(await download(ROM_CHECKSUM_URL, 64 * 1024));
  const published = publishedHash(checksumText);
  if (published === undefined) {
    console.error(`no line for ${ROM_TARBALL_NAME} in the checksum asset:\n${checksumText}`);
    return 1;
  }
  console.info(`published: ${published.line}`);
  const tarball = cachedTarball !== undefined && sha256(cachedTarball) === published.hash ? cachedTarball : await download(ROM_TARBALL_URL, MAX_TARBALL);
  const tarHash = sha256(tarball);
  if (tarHash !== published.hash) {
    console.error(`tarball SHA-256 ${tarHash} does not match the published ${published.hash}`);
    return 1;
  }
  if (record) {
    writeFileSync(TARBALL_PATH, tarball); // so the verifying run doesn't download it again
    console.info(`ROM_TARBALL_SHA256 = '${tarHash}'`);
  } else if (tarHash !== ROM_TARBALL_SHA256) {
    console.error(`tarball SHA-256 ${tarHash} does not match the pinned ROM_TARBALL_SHA256 ${ROM_TARBALL_SHA256}`);
    return 1;
  }

  const entries = readTar(new Uint8Array(gunzipSync(tarball, { maxOutputLength: 256 * 1024 * 1024 })));
  const entry = entries.find((e) => e.type === '0' && basename(e.name) === ROM_ELF_NAME);
  if (entry === undefined) {
    console.error(`${ROM_ELF_NAME} is not in the tarball. It holds:\n${entries.map((e) => `  ${e.name}`).join('\n')}`);
    return 1;
  }
  const elfHash = sha256(entry.data);
  if (record) {
    console.info(`ROM_ELF_SHA256 = '${elfHash}'  (${entry.name}, ${entry.data.length} bytes)`);
    return 0;
  }
  if (elfHash !== ROM_ELF_SHA256) {
    console.error(`${ROM_ELF_NAME} SHA-256 ${elfHash} does not match the pinned ROM_ELF_SHA256 ${ROM_ELF_SHA256}`);
    return 1;
  }
  writeFileSync(ELF_PATH, entry.data);
  console.info(`wrote ${ROM_CACHE_DIR}/${ROM_ELF_NAME} (${entry.data.length} bytes, SHA-256 ${elfHash})`);
  writeRomCorpus();
  return 0;
}

process.exitCode = await main();
