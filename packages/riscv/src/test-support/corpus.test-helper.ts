/**
 * The RISC-V objdump corpora (BT64) for tests: each row's address, the instruction's bytes and
 * what objdump printed in its `-M no-aliases` and default (alias) forms. Rows carry no address;
 * it is the corpus base plus the sizes of the slots before it.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { REPO_ROOT } from '../../../core/src/firmware/fixtures.test-helper.ts';

export interface RiscvCorpusRow {
  address: number;
  /** The instruction as a little-endian number (16 or 32 bits). */
  word: number;
  /** The length objdump stepped: 2 or 4. */
  length: number;
  mnemonic: string;
  operands: string;
  aliasMnemonic: string;
  aliasOperands: string;
}

export const RISCV_CORPUS_DIR = join(REPO_ROOT, 'fixtures', 'riscv', 'corpus');

interface Manifest {
  objdump: string;
  corpora: Record<string, { file: string; rows: number; base: string }>;
}

export function riscvCorpusManifest(): Manifest {
  return JSON.parse(readFileSync(join(RISCV_CORPUS_DIR, 'manifest.json'), 'utf8')) as Manifest;
}

export function loadRiscvCorpus(name: string): RiscvCorpusRow[] {
  const manifest = riscvCorpusManifest();
  const entry = manifest.corpora[name];
  if (entry === undefined) throw new Error(`no RISC-V corpus ${name}`);
  const text = gunzipSync(readFileSync(join(RISCV_CORPUS_DIR, entry.file))).toString('utf8');
  const rows: RiscvCorpusRow[] = [];
  let address = Number.parseInt(entry.base, 16);
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const [field, mnemonic, operands, aliasMnemonic, aliasOperands] = line.split('\t');
    const [bytes, stepped] = field.split('/');
    const size = bytes.length / 2;
    let word = 0;
    for (let i = size - 1; i >= 0; i--) word = word * 256 + Number.parseInt(bytes.slice(2 * i, 2 * i + 2), 16);
    rows.push({
      address,
      word,
      length: stepped === undefined ? size : Number(stepped),
      mnemonic,
      operands: operands ?? '',
      aliasMnemonic: aliasMnemonic ?? mnemonic,
      aliasOperands: aliasMnemonic === undefined ? (operands ?? '') : (aliasOperands ?? ''),
    });
    address += size;
  }
  if (rows.length !== entry.rows) throw new Error(`${name}: ${rows.length} rows, manifest says ${entry.rows}`);
  return rows;
}
