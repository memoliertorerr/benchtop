/**
 * Xtensa decode corpora for BT28's decoder and disassembler (`node scripts/xtensa-corpus.ts`,
 * also run by `npm run fixtures`): what the local xtensa-esp32-elf-objdump says about
 *   isa-all       every mnemonic this objdump knows for the ESP32 core, assembled from
 *                 isa-all.S (generated here, under `.begin no-transform`) with operand variety;
 *   narrow16      all 65,536 16-bit words;
 *   wide24        one 24-bit word per (op0, op1, op2, r), s and t from a fixed-seed PRNG;
 *   serial-hello  the .iram0.vectors, .iram0.text and .flash.text of serial-hello's full ELF.
 * Code is decoded from raw bytes (objcopy -I binary), never from a linked ELF: there objdump
 * consults the .xt.prop property tables and prints padding and literals as data.
 * Each corpus is fixtures/xtensa/corpus/<name>.tsv.gz ("address\tbytes\tmnemonic\toperands", bytes
 * in memory order — objdump's hex column is MSB first: `024203` = 03 42 02 — operands without
 * ` <sym+off>`; invalid bytes are rows "invalid" of 1 byte) plus its raw bytes,
 * <name>.bin.gz (serial-hello: one per section; narrow16's are a formula and not committed),
 * described in corpus/manifest.json. Committed total ≤ 1.5 MB: serial-hello falls back to its
 * IRAM sections when .flash.text doesn't fit.
 *
 * Words are decoded in labelled slots: objdump restarts decoding at every symbol, so each slot
 * decodes on its own (the first row of each slot is the one recorded).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { findSection, parseElf32 } from '../packages/core/src/firmware/elf.ts';
import { xtensaTool } from './xtensa-programs.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CORPUS_DIR = join(ROOT, 'fixtures', 'xtensa', 'corpus');
const WORK = join(ROOT, 'fixtures', '.build', 'xtensa', 'corpus');
const SERIAL_HELLO_ELF = join(ROOT, 'fixtures', '.build', 'esp32', 'serial-hello', 'serial-hello.ino.elf');
/** Committed corpus budget (BT27). */
export const CORPUS_BUDGET = 1.5 * 1024 * 1024;

export interface Row {
  address: number;
  /** Hex, memory order. */
  bytes: string;
  mnemonic: string;
  operands: string;
}

const LINE = /^\s*([0-9a-f]+):\t([0-9a-f ]+?)\s*\t(.*)$/;
const SYMBOL = /^([0-9a-f]+) <([^>]+)>:$/;

/** objdump's instruction hex (MSB first) → memory-order hex. */
function memoryOrder(hex: string): string {
  let out = '';
  for (let i = hex.length - 2; i >= 0; i -= 2) out += hex.slice(i, i + 2);
  return out;
}

/** objdump -d output → rows (literal lines — bytes, no mnemonic — skipped), with each row's symbol. */
export function parseObjdump(text: string): (Row & { symbol: string })[] {
  const rows: (Row & { symbol: string })[] = [];
  let symbol = '';
  for (const line of text.split('\n')) {
    const sym = SYMBOL.exec(line);
    if (sym !== null) {
      symbol = sym[2];
      continue;
    }
    const m = LINE.exec(line);
    if (m === null) continue;
    const [, address, hex, rest] = m;
    const text = rest.trim();
    if (text === '') continue; // a literal: bytes with no mnemonic
    if (text.startsWith('.byte')) {
      rows.push({ address: Number.parseInt(address, 16), bytes: hex.trim(), mnemonic: 'invalid', operands: '', symbol });
      continue;
    }
    if (hex.includes(' ')) continue; // spaced bytes are data
    const tab = text.indexOf('\t');
    const mnemonic = tab < 0 ? text : text.slice(0, tab);
    const operands = tab < 0 ? '' : text.slice(tab + 1).replace(/\s*<[^>]*>$/, '').trim();
    rows.push({ address: Number.parseInt(address, 16), bytes: memoryOrder(hex), mnemonic, operands, symbol });
  }
  return rows;
}

function run(tool: string, args: string[], cwd = WORK): string {
  return execFileSync(xtensaTool(tool), args, { cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 });
}

/** Decodes each slot on its own; returns one row per slot (its first instruction). */
export function decodeSlots(name: string, slots: readonly Uint8Array[]): Row[] {
  mkdirSync(WORK, { recursive: true });
  const lines = ['    .text'];
  slots.forEach((bytes, i) => lines.push(`w${i}: .byte ${Array.from(bytes, (b) => `0x${b.toString(16)}`).join(', ')}`));
  writeFileSync(join(WORK, `${name}.S`), `${lines.join('\n')}\n`);
  run('as', ['-o', `${name}.o`, `${name}.S`]);
  const rows = parseObjdump(run('objdump', ['-d', '-z', `${name}.o`]));
  const first = new Map<string, Row>();
  for (const row of rows) if (!first.has(row.symbol)) first.set(row.symbol, { address: row.address, bytes: row.bytes, mnemonic: row.mnemonic, operands: row.operands });
  return slots.map((_, i) => {
    const row = first.get(`w${i}`);
    if (row === undefined) throw new Error(`${name}: objdump printed nothing for slot ${i}`);
    return row;
  });
}

/** mulberry32: a small fixed-seed PRNG, so the corpora are reproducible. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A 24-bit RRR-layout word as bytes: op0 | t<<4 | s<<8 | r<<12 | op1<<16 | op2<<20. */
function word24(op0: number, t: number, s: number, r: number, op1: number, op2: number): Uint8Array {
  return Uint8Array.of(op0 | (t << 4), s | (r << 4), op1 | (op2 << 4));
}

export function narrow16Slots(): Uint8Array[] {
  return Array.from({ length: 65536 }, (_, w) => Uint8Array.of(w & 0xff, w >> 8, 0));
}

export function wide24Slots(): Uint8Array[] {
  const random = prng(0x5eed2427);
  const slots: Uint8Array[] = [];
  for (let op2 = 0; op2 < 16; op2++)
    for (let op1 = 0; op1 < 16; op1++)
      for (let r = 0; r < 16; r++)
        for (let op0 = 0; op0 < 16; op0++) slots.push(word24(op0, Math.floor(random() * 16), Math.floor(random() * 16), r, op1, op2));
  return slots;
}

/**
 * Exploration words (not committed): every (s, t) where they select the operation rather than
 * name registers — QRST ST0/ST1/TLB/RT0 groups, RST3 (special and user registers), the FP
 * groups, LSCI, CACHE, SI and CALLN — so isa-all can include every mnemonic objdump knows.
 */
export function explorationSlots(): Uint8Array[] {
  const slots: Uint8Array[] = [];
  const all = (op0: number, op1: number, op2: number, r: number): void => {
    for (let s = 0; s < 16; s++) for (let t = 0; t < 16; t++) slots.push(word24(op0, t, s, r, op1, op2));
  };
  // s and t one at a time (the other 0): enough where one field selects the operation.
  const each = (op0: number, op1: number, op2: number, r: number): void => {
    for (let s = 0; s < 16; s++) slots.push(word24(op0, 0, s, r, op1, op2));
    for (let t = 1; t < 16; t++) slots.push(word24(op0, t, 0, r, op1, op2));
  };
  for (let r = 0; r < 16; r++) for (const op2 of [0, 4, 5, 6, 15]) all(0, 0, op2, r); // RST0: ST0, ST1, TLB, RT0 …
  for (let op2 = 0; op2 < 16; op2++) for (let r = 0; r < 16; r++) all(0, 3, op2, r); // RST3: RSR/WSR/XSR/RUR/WUR …
  for (let r = 0; r < 16; r++) all(0, 1, 6, r); // RST1 XSR
  for (const op1 of [1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]) for (let op2 = 0; op2 < 16; op2++) for (let r = 0; r < 16; r++) each(0, op1, op2, r); // shifts (SRA needs s = 0), CUST, FP, …
  for (let r = 0; r < 16; r++) all(2, 0, 0, r); // LSAI (CACHE at r = 7)
  for (let r = 0; r < 16; r++) all(3, 0, 0, r); // LSCI
  for (let op1 = 0; op1 < 16; op1++) for (let op2 = 0; op2 < 16; op2++) for (let r = 0; r < 16; r++) each(4, op1, op2, r); // MAC16: fields that must be 0
  for (let r = 0; r < 16; r++) all(6, 0, 0, r); // SI: n, m in t
  for (let r = 0; r < 16; r++) all(7, 0, 0, r); // B
  for (let t = 0; t < 16; t++) slots.push(word24(5, t, 0, 0, 0, 0)); // CALLN
  return slots;
}

const TSV_HEADER = '# address\tbytes\tmnemonic\toperands';

function tsv(rows: readonly Row[]): string {
  return `${TSV_HEADER}\n${rows.map((r) => `${r.address.toString(16).padStart(8, '0')}\t${r.bytes}\t${r.mnemonic}\t${r.operands}`).join('\n')}\n`;
}

/** Reads a committed corpus back (BT28's tests have their own reader; this one is for checks). */
export function readCorpus(name: string): Row[] {
  const text = gunzipSync(readFileSync(join(CORPUS_DIR, `${name}.tsv.gz`))).toString('utf8');
  return text
    .split('\n')
    .filter((l) => l !== '' && !l.startsWith('#'))
    .map((l) => {
      const [address, bytes, mnemonic, operands] = l.split('\t');
      return { address: Number.parseInt(address, 16), bytes, mnemonic, operands: operands ?? '' };
    });
}

// ── isa-all ────────────────────────────────────────────────────────────────────────────────

/** Mnemonics whose last operand is a PC-relative target objdump prints as an address. */
const PC_RELATIVE = /^(b(eq|ne|lt|ge|ltu|geu|any|none|all|nall|bc|bs|bci|bsi)|b(eq|ne|lt|ge|ltu|geu)i|beqz|bnez|bltz|bgez|beqz\.n|bnez\.n|bf|bt|bbci\.l|bbsi\.l|j|call(0|4|8|12)|loop|loopnez|loopgtz|l32r)$/;

/**
 * isa-all.S: up to three operand variants per mnemonic, PC-relative targets as local labels.
 * Laid out so a raw, purely sequential decode stays in step: the literal pool comes first and
 * every literal is 0xf03df03d (two nop.n), branches skip one nop.n, and all calls go to one
 * aligned label after the end (alignment padding would decode as instructions).
 */
export function isaAllSource(rows: readonly Row[]): string {
  const variants = new Map<string, string[]>();
  for (const row of rows) {
    if (row.mnemonic === 'invalid') continue;
    let list = variants.get(row.mnemonic);
    if (list === undefined) variants.set(row.mnemonic, (list = []));
    if (list.length < 3 && !list.includes(row.operands)) list.push(row.operands);
  }
  const out: string[] = [
    '# isa-all.S — generated by scripts/xtensa-corpus.ts from what the local objdump decodes; do not edit.',
    '    .text',
    '    .literal_position',
    '    .global _start',
    '    .align 4',
    '_start:',
    '    .begin no-transform',
  ];
  let label = 0;
  for (const mnemonic of [...variants.keys()].sort()) {
    for (const operands of variants.get(mnemonic) ?? []) {
      if (PC_RELATIVE.test(mnemonic)) {
        const head = operands.includes(',') ? `${operands.slice(0, operands.lastIndexOf(',') + 1)} ` : '';
        const target = `.Lt${label++}`;
        if (mnemonic === 'l32r') {
          out.push(`    .literal ${target}, 0xf03df03d`, `    l32r ${head}${target}`);
        } else if (mnemonic.startsWith('call')) {
          out.push(`    ${mnemonic} ${head}.Lcall`);
        } else {
          out.push(`    ${mnemonic} ${head}${target}`, '    nop.n', `${target}:`);
        }
      } else {
        out.push(`    ${mnemonic}${operands === '' ? '' : ` ${operands}`}`);
      }
    }
  }
  out.push('    .end no-transform', '    break 1, 15', '    .align 4', '.Lcall:', '    break 1, 15', '');
  return out.join('\n');
}

/**
 * Assembles isa-all.S, dropping lines the assembler rejects (reported); returns the decoded rows
 * and the mnemonics it couldn't keep.
 */
export function buildIsaAll(source: string): { rows: Row[]; dropped: string[]; bytes: Uint8Array } {
  mkdirSync(WORK, { recursive: true });
  let lines = source.split('\n');
  const dropped: string[] = [];
  for (let attempt = 0; attempt < 20; attempt++) {
    writeFileSync(join(WORK, 'isa-all.S'), lines.join('\n'));
    try {
      execFileSync(xtensaTool('as'), ['--text-section-literals', '-o', 'isa-all.o', 'isa-all.S'], { cwd: WORK, encoding: 'utf8', stdio: 'pipe' });
      break;
    } catch (error) {
      const stderr = String((error as { stderr?: unknown }).stderr ?? '');
      const bad = new Set<number>();
      for (const m of stderr.matchAll(/isa-all\.S:(\d+): Error/g)) bad.add(Number(m[1]) - 1);
      if (bad.size === 0) throw new Error(`isa-all.S failed to assemble:\n${stderr}`);
      for (const i of bad) dropped.push(lines[i].trim());
      lines = lines.map((l, i) => (bad.has(i) ? `#   dropped: ${l.trim()}` : l));
    }
  }
  execFileSync(xtensaTool('ld'), ['-Ttext=0x40080000', '-e', '_start', '-o', 'isa-all.elf', 'isa-all.o'], { cwd: WORK });
  execFileSync(xtensaTool('objcopy'), ['-O', 'binary', 'isa-all.elf', 'isa-all.bin'], { cwd: WORK });
  const bytes = readFileSync(join(WORK, 'isa-all.bin'));
  return { rows: decodeRaw('isa-all', 0x40080000, bytes), dropped, bytes };
}

// ── serial-hello ───────────────────────────────────────────────────────────────────────────

export const SERIAL_HELLO_SECTIONS = ['.iram0.vectors', '.iram0.text', '.flash.text'] as const;

/**
 * objdump of raw bytes at `address`: wrapped with `objcopy -I binary` into a code section, so
 * objdump decodes purely by encoding. (On a linked ELF it reads the .xt.prop property tables and
 * prints alignment fill and literals as `.byte` even where they encode instructions.)
 */
export function decodeRaw(name: string, address: number, bytes: Uint8Array): Row[] {
  mkdirSync(WORK, { recursive: true });
  writeFileSync(join(WORK, `${name}.raw`), bytes);
  run('objcopy', [
    '-I', 'binary', '-O', 'elf32-xtensa-le', '-B', 'xtensa',
    '--rename-section', '.data=.text,alloc,load,contents,code,readonly',
    `${name}.raw`, `${name}.raw.o`,
  ]);
  const text = run('objdump', ['-d', '-z', `--adjust-vma=0x${address.toString(16)}`, `${name}.raw.o`]);
  return parseObjdump(text).map(({ symbol: _symbol, ...row }) => row);
}

/** Named sections of an ELF, each decoded on its own as raw bytes at its load address. */
export function decodeElfSections(elfPath: string, sections: readonly string[]): { rows: Row[]; raw: { section: string; address: number; bytes: Uint8Array }[] } {
  const elf = parseElf32(readFileSync(elfPath));
  const raw = sections.map((name) => {
    const section = findSection(elf, name);
    if (section === undefined) throw new Error(`${elfPath} has no ${name}`);
    return { section: name, address: section.addr, bytes: section.data };
  });
  const rows = raw.flatMap((r) => decodeRaw(`section${r.section.replace(/\W/g, '_')}`, r.address, r.bytes));
  return { rows, raw };
}

// ── main ───────────────────────────────────────────────────────────────────────────────────

interface CorpusEntry {
  name: string;
  rows: number;
  raw: { file: string; address: number; bytes: number }[];
  /** How the raw bytes are laid out, or how to rebuild them when they aren't committed. */
  layout: string;
}

export interface CorpusManifest {
  objdump: string;
  corpora: CorpusEntry[];
  /** Mnemonics objdump decodes but GNU as would not assemble in isa-all (with the operand text objdump printed). */
  isaAllDropped: string[];
  isaAllMnemonics: number;
}

/** Every corpus file's bytes, keyed by file name under fixtures/xtensa/corpus/. */
export function buildCorpora(sections: readonly string[] = SERIAL_HELLO_SECTIONS): Map<string, Uint8Array> {
  rmSync(WORK, { recursive: true, force: true });
  const files = new Map<string, Uint8Array>();
  const corpora: CorpusEntry[] = [];
  const add = (name: string, rows: readonly Row[], raw: { file: string; address: number; bytes: Uint8Array }[], layout: string): void => {
    files.set(`${name}.tsv.gz`, gzipSync(tsv(rows), { level: 9 }));
    for (const r of raw) files.set(r.file, gzipSync(r.bytes, { level: 9 }));
    corpora.push({ name, rows: rows.length, raw: raw.map((r) => ({ file: r.file, address: r.address, bytes: r.bytes.length })), layout });
  };
  const concat = (slots: readonly Uint8Array[]): Uint8Array => {
    const out = new Uint8Array(slots.reduce((n, s) => n + s.length, 0));
    let at = 0;
    for (const s of slots) {
      out.set(s, at);
      at += s.length;
    }
    return out;
  };

  const narrow = narrow16Slots();
  const wide = wide24Slots();
  const narrowRows = decodeSlots('narrow16', narrow);
  const wideRows = decodeSlots('wide24', wide);
  const exploreRows = decodeSlots('explore', explorationSlots());
  const isa = buildIsaAll(isaAllSource([...narrowRows, ...wideRows, ...exploreRows]));
  add('isa-all', isa.rows, [{ file: 'isa-all.bin.gz', address: 0x40080000, bytes: isa.bytes }], 'the linked program at 0x40080000: the literal pool (each 0xf03df03d), then the instructions');
  // narrow16's bytes are a formula, so they aren't committed (corpus budget).
  add('narrow16', narrowRows, [], 'not committed: 3-byte slot i at address 3*i holds [i & 0xff, i >> 8, 0x00]');
  add('wide24', wideRows, [{ file: 'wide24.bin.gz', address: 0, bytes: concat(wide) }], '3-byte slot per word at address 3*i, order op2, op1, r, op0 (outer to inner)');
  if (!existsSync(SERIAL_HELLO_ELF)) throw new Error(`${SERIAL_HELLO_ELF} is missing: run npm run fixtures -- --only esp32/serial-hello first`);
  const hello = decodeElfSections(SERIAL_HELLO_ELF, sections);
  add(
    'serial-hello',
    hello.rows,
    hello.raw.map((r) => ({ file: `serial-hello${r.section}.bin.gz`, address: r.address, bytes: r.bytes })),
    'each section at its load address',
  );
  const manifest: CorpusManifest = {
    objdump: run('objdump', ['--version']).split('\n')[0] ?? '',
    corpora,
    isaAllDropped: isa.dropped,
    isaAllMnemonics: new Set(isa.rows.map((r) => r.mnemonic)).size,
  };
  files.set('manifest.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  return files;
}

/** Writes (or with `check`, compares) the corpora. Returns the number of mismatches. */
export function writeCorpora(check: boolean): number {
  let files = buildCorpora();
  let total = [...files.values()].reduce((n, b) => n + b.length, 0);
  if (total > CORPUS_BUDGET) {
    console.info(`corpora are ${(total / 1024).toFixed(0)} KB, over the ${CORPUS_BUDGET / 1024} KB budget: serial-hello cut to its IRAM sections`);
    files = buildCorpora(['.iram0.vectors', '.iram0.text']);
    total = [...files.values()].reduce((n, b) => n + b.length, 0);
  }
  let mismatches = 0;
  mkdirSync(CORPUS_DIR, { recursive: true });
  for (const [file, bytes] of files) {
    const path = join(CORPUS_DIR, file);
    if (check) {
      const same = existsSync(path) && Buffer.compare(readFileSync(path), Buffer.from(bytes)) === 0;
      if (!same) mismatches++;
      console.info(`${same ? 'same   ' : 'CHANGED'} xtensa/corpus/${file}`);
    } else {
      writeFileSync(path, bytes);
    }
  }
  console.info(`xtensa corpora: ${(total / 1024).toFixed(0)} KB`);
  return mismatches;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = writeCorpora(process.argv.includes('--check')) === 0 ? 0 : 1;
}
