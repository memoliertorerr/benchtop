/**
 * The objdump decode corpora (BT27) for tests: each row's address, objdump's bytes, mnemonic and
 * operands, plus `bytesAt(address)` — the three bytes in memory there — from the committed raw
 * bytes (narrow16's are a formula), or for the ROM corpus from the cached ROM ELF.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { REPO_ROOT } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { parseRomElf } from '../boot/rom.ts';
import { DEFAULT_ROM_DIR, loadCachedRom } from './rom.test-helper.ts';

export interface CorpusRow {
  address: number;
  /** objdump's bytes, memory order, hex. */
  bytes: string;
  mnemonic: string;
  operands: string;
}

export interface Corpus {
  name: string;
  rows: CorpusRow[];
  /** b0, b1, b2 at `address` (0 past the end of its region). */
  bytesAt(address: number): [number, number, number];
  /** Bytes left in the region holding `address` (objdump won't decode across its end). */
  available(address: number): number;
}

const CORPUS_DIR = join(REPO_ROOT, 'fixtures', 'xtensa', 'corpus');

function parseTsv(text: string): CorpusRow[] {
  const rows: CorpusRow[] = [];
  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    const [address, bytes, mnemonic, operands] = line.split('\t');
    rows.push({ address: Number.parseInt(address, 16), bytes, mnemonic, operands: operands ?? '' });
  }
  return rows;
}

/** Memory made of (address, bytes) regions. */
function regions(list: { address: number; bytes: Uint8Array }[]): Pick<Corpus, 'bytesAt' | 'available'> {
  const find = (a: number) => list.find((r) => a >= r.address && a < r.address + r.bytes.length);
  return {
    bytesAt(address) {
      const region = find(address);
      if (region === undefined) return [0, 0, 0];
      const at = (a: number): number => (a < region.address + region.bytes.length ? region.bytes[a - region.address] : 0);
      return [at(address), at(address + 1), at(address + 2)];
    },
    available(address) {
      const region = find(address);
      return region === undefined ? 0 : region.address + region.bytes.length - address;
    },
  };
}

interface Manifest {
  corpora: { name: string; raw: { file: string; address: number }[] }[];
}

/** A committed corpus: isa-all, narrow16, wide24 or serial-hello. */
export function loadCorpus(name: string): Corpus {
  const manifest = JSON.parse(readFileSync(join(CORPUS_DIR, 'manifest.json'), 'utf8')) as Manifest;
  const entry = manifest.corpora.find((c) => c.name === name);
  if (entry === undefined) throw new Error(`no corpus ${name}`);
  const rows = parseTsv(gunzipSync(readFileSync(join(CORPUS_DIR, `${name}.tsv.gz`))).toString('utf8'));
  if (name === 'narrow16') {
    // Not committed: slot i at 3*i holds [i & 0xff, i >> 8, 0].
    return { name, rows, bytesAt: (a) => (a % 3 === 0 ? [(a / 3) & 0xff, (a / 3) >> 8, 0] : [0, 0, 0]), available: () => 3 };
  }
  const raw = entry.raw.map((r) => ({ address: r.address, bytes: new Uint8Array(gunzipSync(readFileSync(join(CORPUS_DIR, r.file)))) }));
  return { name, rows, ...regions(raw) };
}

/** The ROM corpus fetch:esp32-rom wrote into the cache; fails loudly when it's missing. */
export function loadRomCorpus(dir: string = DEFAULT_ROM_DIR): Corpus {
  const rom = parseRomElf(loadCachedRom(dir));
  const path = join(dir, 'rom-corpus.tsv.gz');
  if (!existsSync(path)) throw new Error(`${path} is missing: run npm run fetch:esp32-rom (it writes the ROM corpus when the Xtensa toolchain is installed)`);
  const rows = parseTsv(gunzipSync(readFileSync(path)).toString('utf8'));
  return { name: 'rom', rows, ...regions(rom.segments.map((s) => ({ address: s.address, bytes: s.data }))) };
}
