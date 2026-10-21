/**
 * RISC-V decode corpora for BT64's decoder and disassembler (`node scripts/riscv-corpus.ts`, also
 * run by `npm run fixtures -- --only riscv/corpus`): what the arduino-pico core's RISC-V objdump
 * (binutils 2.43, scripts/arduino-cli.ts findRiscvTool) says, for RISCV_MARCH, about
 *   narrow16  every 16-bit word that isn't the start of a 32-bit one (low bits ≠ 11): 49,152;
 *   wide32    for every 32-bit major opcode and funct3, 48 words from a fixed-seed PRNG, plus every
 *             funct7 for the register-register opcodes (OP, OP-IMM, AMO, custom-0…2);
 *   csr       `csrrs a0, <csr>, a1` and `csrrwi a0, <csr>, 5` for all 4,096 CSR numbers;
 *   text      real compiled code: fixtures/riscv/corpus-text.c (TEXT_MARCH, -Os) linked with
 *             newlib's printf, strtod, qsort … and libgcc's soft-float helpers, its whole .text.
 * wide32 also carries probes for the pseudo-instructions of the alias form. In the first three
 * each word sits in its own labelled slot (objdump restarts decoding at every symbol), assembled
 * with `.insn` at 0x20000000. Everything is disassembled twice (`-z`, so zero words
 * print): with `-M no-aliases` and in the default (alias) form.
 * Rows: "bytes[/length]\tmnemonic\toperands", plus "\talias mnemonic\talias operands" where
 * the alias form differs — bytes in memory order,
 * "/length" where objdump stepped a different length (it steps a word with the ≥ 80-bit prefix
 * as one halfword); a row's address is the base plus the sizes of the slots before it; comments
 * after `#` and ` <sym>` are dropped. Gzipped into fixtures/riscv/corpus/<name>.tsv.gz;
 * corpus/manifest.json records the objdump that made them and each corpus's base address.
 * `--check` rebuilds and compares without writing.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { findRiscvTool } from './arduino-cli.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const RISCV_CORPUS_DIR = join(ROOT, 'fixtures', 'riscv', 'corpus');
const WORK = join(ROOT, 'fixtures', '.build', 'riscv', 'corpus');
const BASE = 0x20000000;
/**
 * What the corpora are assembled and compiled for: the Hazard3 ISA minus its custom Xh3bextm
 * (no toolchain knows it). objdump decodes per the ELF's .riscv.attributes, so this also
 * selects what it disassembles.
 */
export const RISCV_MARCH = 'rv32imac_zicsr_zifencei_zba_zbb_zbs_zbkb_zcb_zcmp';
/** The text corpus's -march: gcc 16 emits cm.mvsa01/cm.mva01s, which this as (2.43) rejects — so no Zcmp there. */
const TEXT_MARCH = 'rv32imac_zicsr_zifencei_zba_zbb_zbs_zbkb_zcb';

export function riscvTool(name: string): string {
  const found = findRiscvTool(name);
  if (found === undefined) throw new Error(`a RISC-V ${name} wasn't found (set BENCHTOP_RISCV_BIN and BENCHTOP_RISCV_PREFIX)`);
  return found.path;
}

/** mulberry32: a small fixed-seed PRNG, so the corpus is the same every run. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}

interface Word {
  value: number;
  /** 2 or 4 bytes. */
  size: 2 | 4;
}

function corpusWords(name: string): Word[] {
  const words: Word[] = [];
  if (name === 'narrow16') {
    for (let w = 0; w < 0x10000; w++) if ((w & 3) !== 3) words.push({ value: w, size: 2 });
  } else if (name === 'wide32') {
    const rand = prng(0x5eed64);
    for (let major = 0; major < 32; major++) {
      const opcode = (major << 2) | 3;
      // Major opcodes 0x1f and 0x3f (and 0x7f) start 48-, 64- and ≥ 80-bit instructions: not 32-bit words.
      if ((opcode & 0x1f) === 0x1f) continue;
      for (let funct3 = 0; funct3 < 8; funct3++) {
        for (let k = 0; k < 48; k++) words.push({ value: ((rand() & ~0x707f) | (funct3 << 12) | opcode) >>> 0, size: 4 });
      }
    }
    // Every funct7 for the opcodes whose funct7 selects the operation.
    for (const opcode of [0x33, 0x13, 0x2f, 0x0b, 0x2b, 0x5b]) {
      for (let funct3 = 0; funct3 < 8; funct3++) {
        for (let funct7 = 0; funct7 < 128; funct7++) {
          const fill = rand() & 0x01ff8f80; // rs2, rs1, rd
          words.push({ value: ((funct7 << 25) | fill | (funct3 << 12) | opcode) >>> 0, size: 4 });
        }
      }
    }
    // The unary Zbb/Zbkb forms live in the rs2 field of OP-IMM funct3 1 and 5.
    for (const top of [0x60, 0x28, 0x68, 0x08, 0x48]) {
      for (const funct3 of [1, 5]) {
        for (let rs2 = 0; rs2 < 32; rs2++) words.push({ value: ((top << 25) | (rs2 << 20) | (11 << 15) | (funct3 << 12) | (10 << 7) | 0x13) >>> 0, size: 4 });
      }
    }
    // Fences, system words.
    for (let pred = 0; pred < 16; pred++) for (let succ = 0; succ < 16; succ++) words.push({ value: ((pred << 24) | (succ << 20) | 0x0f) >>> 0, size: 4 });
    for (const w of [0x00000073, 0x00100073, 0x30200073, 0x10500073, 0x7b200073, 0x10200073, 0x8330000f, 0x0100000f, 0x0000100f]) words.push({ value: w, size: 4 });
    // The pseudo-instructions objdump prints in its alias form (li, mv, not, neg, seqz …, ret,
    // jr, csrr/csrw/…, rdcycle …, unimp), each with its x0 corner cases.
    for (const w of ALIAS_PROBES) words.push({ value: w, size: 4 });
  } else if (name === 'csr') {
    for (let csr = 0; csr < 4096; csr++) {
      words.push({ value: ((csr << 20) | (11 << 15) | (2 << 12) | (10 << 7) | 0x73) >>> 0, size: 4 });
      words.push({ value: ((csr << 20) | (5 << 15) | (5 << 12) | (10 << 7) | 0x73) >>> 0, size: 4 });
    }
  } else throw new Error(`no corpus ${name}`);
  return words;
}

const ALIAS_PROBES = [
  0x00000513, 0x00000013, 0x00058513, 0xfff5c513, 0x40b00533, 0x0015b513, 0x00b03533, 0x0005a533,
  0x00b02533, 0x00055063, 0x00051063, 0x000000ef, 0x000500e7, 0x00008067, 0x004500e7, 0x00050067,
  0xc0001073, 0xc0002573, 0xc0102573, 0xc0202573, 0xc8002573, 0xc8102573, 0xc8202573, 0x00002073,
  0x00059073, 0x0005a073, 0x0005b073, 0x30002573, 0x30059073, 0x0ff5f513, 0x00001073, 0x0005d073,
  0x0002e073, 0x0002f073, 0xc0003573, 0x0ff0000f, 0x0330000f, 0x0000000f, 0x40a00533, 0x00a03533,
  0xc0101073, 0xfff00513, 0x00001037, 0x00001017, 0x00550013, 0xc0201573, 0x00500013, 0x00050013,
  0x00002033, 0x00002533, 0x00003533, 0x40000533, 0x00004063, 0x00005063, 0x00000063, 0x00001063,
  0x00000067, 0x00000fe7, 0x000000e7, 0xc0002073, 0x00051063, 0x00a5c063, 0x00b55063, 0xfff04513,
  0x0010b013,
];

export const RISCV_CORPORA = ['narrow16', 'wide32', 'csr', 'text'] as const;

const LINE = /^\s*([0-9a-f]+):\t([0-9a-f ]+?)\s*\t([^\t]*)(?:\t(.*))?$/;

interface ListingRow {
  mnemonic: string;
  operands: string;
  /** The instruction as objdump printed it: a halfword or word value, hex. */
  value: string;
}

/** objdump's listing → address → row (comments and symbols dropped). */
function parseListing(text: string): Map<number, ListingRow> {
  const rows = new Map<number, ListingRow>();
  for (const line of text.split('\n')) {
    const m = LINE.exec(line);
    if (m === null) continue;
    const address = Number.parseInt(m[1], 16);
    if (rows.has(address)) continue;
    const operands = (m[4] ?? '').replace(/\s*#.*$/, '').replace(/\s*<[^>]*>$/, '').trim();
    rows.set(address, { mnemonic: m[3].trim(), operands, value: m[2].replace(/ /g, '') });
  }
  return rows;
}

/** A value's bytes in memory order, hex. */
function memoryBytes(value: number, size: number): string {
  return Array.from({ length: size }, (_, k) => ((value >>> (8 * k)) & 0xff).toString(16).padStart(2, '0')).join('');
}

function row(field: string, r: ListingRow, a: ListingRow): string {
  return a.mnemonic === r.mnemonic && a.operands === r.operands ? `${field}\t${r.mnemonic}\t${r.operands}` : `${field}\t${r.mnemonic}\t${r.operands}\t${a.mnemonic}\t${a.operands}`;
}

interface Built {
  file: string;
  text: string;
  rows: number;
  base: number;
}

function workDir(name: string): string {
  const dir = join(WORK, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

const runIn = (dir: string) => (tool: string, args: string[]): string => execFileSync(riscvTool(tool), args, { cwd: dir, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });

/** A corpus of chosen words, each in its own slot. */
function buildWordCorpus(name: string): Built {
  const dir = workDir(name);
  const words = corpusWords(name);
  const lines = ['.text', '.globl _start', '_start:'];
  const addresses: number[] = [];
  let at = BASE;
  words.forEach((w, i) => {
    addresses.push(at);
    // .insn, not .half/.word: data directives get a $d mapping symbol and objdump dumps them as data.
    lines.push(`w${i}: .insn ${w.size}, 0x${w.value.toString(16)}`);
    at += w.size;
  });
  writeFileSync(join(dir, `${name}.S`), `${lines.join('\n')}\n`);
  const run = runIn(dir);
  run('as', [`-march=${RISCV_MARCH}`, '-o', `${name}.o`, `${name}.S`]);
  run('ld', [`-Ttext=0x${BASE.toString(16)}`, '-e', '_start', '-o', `${name}.elf`, `${name}.o`]);
  const raw = parseListing(run('objdump', ['-d', '-z', '-M', 'no-aliases', `${name}.elf`]));
  const alias = parseListing(run('objdump', ['-d', '-z', `${name}.elf`]));
  const out = words.map((w, i) => {
    const missing = { mnemonic: '?', operands: '', value: '' };
    const r = raw.get(addresses[i]) ?? missing;
    const a = alias.get(addresses[i]) ?? missing;
    // objdump steps a word with the ≥ 80-bit length prefix as one halfword: "<bytes>/2".
    const stepped = r.value.length / 2;
    const bytes = memoryBytes(w.value, w.size);
    return row(stepped === w.size ? bytes : `${bytes}/${stepped}`, r, a);
  });
  return { file: `${name}.tsv.gz`, text: `${out.join('\n')}\n`, rows: out.length, base: BASE };
}

/**
 * Real compiled code: fixtures/riscv/corpus-text.c (built for TEXT_MARCH at -Os, so gcc uses the
 * bit-manipulation and Zcb instructions) with newlib and libgcc (their rv32imac multilib), .text.
 */
function buildTextCorpus(name: string): Built {
  const dir = workDir(name);
  const base = 0x42000000;
  const run = runIn(dir);
  run('gcc', [`-march=${TEXT_MARCH}`, '-mabi=ilp32', '-Os', '-nostartfiles', '-ffunction-sections', `-Wl,-Ttext=0x${base.toString(16)}`, '-Wl,--gc-sections', '-o', `${name}.elf`, join(ROOT, 'fixtures', 'riscv', 'corpus-text.c'), '-lm', '-lc', '-lgcc', '-lnosys']);
  const raw = parseListing(run('objdump', ['-d', '-z', '-j', '.text', '-M', 'no-aliases', `${name}.elf`]));
  const alias = parseListing(run('objdump', ['-d', '-z', '-j', '.text', `${name}.elf`]));
  const out: string[] = [];
  let expected = base;
  for (const [address, r] of [...raw].sort((x, y) => x[0] - y[0])) {
    if (address !== expected) throw new Error(`${name}: a gap at 0x${expected.toString(16)}`);
    const size = r.value.length / 2;
    out.push(row(memoryBytes(Number.parseInt(r.value, 16), size), r, alias.get(address) ?? r));
    expected += size;
  }
  return { file: `${name}.tsv.gz`, text: `${out.join('\n')}\n`, rows: out.length, base };
}

/** Builds every corpus into fixtures/riscv/corpus, or with check compares them. Returns mismatches. */
export function writeRiscvCorpora(check = false): number {
  mkdirSync(RISCV_CORPUS_DIR, { recursive: true });
  const version = execFileSync(riscvTool('objdump'), ['--version'], { encoding: 'utf8' }).split('\n')[0];
  const corpora: Record<string, { file: string; rows: number; base: string }> = {};
  let mismatches = 0;
  for (const name of RISCV_CORPORA) {
    const built = name === 'text' ? buildTextCorpus(name) : buildWordCorpus(name);
    corpora[name] = { file: built.file, rows: built.rows, base: `0x${built.base.toString(16)}` };
    const path = join(RISCV_CORPUS_DIR, built.file);
    if (check) {
      const same = existsSync(path) && gunzipSync(readFileSync(path)).toString('utf8') === built.text;
      if (!same) mismatches++;
      console.info(`${same ? 'same   ' : 'CHANGED'} riscv corpus ${name}: ${built.rows} rows`);
      continue;
    }
    const bytes = gzipSync(Buffer.from(built.text, 'utf8'), { level: 9 });
    writeFileSync(path, bytes);
    console.info(`riscv corpus ${name}: ${built.rows} rows, ${bytes.length} bytes gzipped`);
  }
  if (!check) writeFileSync(join(RISCV_CORPUS_DIR, 'manifest.json'), `${JSON.stringify({ objdump: version, corpora }, null, 2)}\n`);
  return mismatches;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = writeRiscvCorpora(process.argv.includes('--check')) === 0 ? 0 : 1;
