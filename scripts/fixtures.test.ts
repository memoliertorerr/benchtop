import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ADDR2LINE_ORACLES, FIXTURE_BOARDS, type Manifest, sketchOutputs } from './fixture-boards.ts';

// Checks the committed fixture firmware against its manifest. Never runs the compiler:
// `npm run fixtures` (and `npm run fixtures -- --check`) is the only thing that does.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIRMWARE = join(ROOT, 'fixtures', 'firmware');
const SKETCHES = join(ROOT, 'fixtures', 'sketches');
const manifest = JSON.parse(readFileSync(join(FIRMWARE, 'manifest.json'), 'utf8')) as Manifest;

describe('fixture firmware manifest', () => {
  it('records the arduino-cli, core and library versions', () => {
    expect(manifest.arduinoCli).toMatch(/^\d+\.\d+\.\d+/);
    for (const board of Object.values(FIXTURE_BOARDS)) {
      const core = board.fqbn.split(':').slice(0, 2).join(':');
      expect(manifest.cores[core]).toMatch(/^\d+\.\d+\.\d+/);
    }
    expect(typeof manifest.libraries).toBe('object');
    for (const version of Object.values(manifest.libraries)) expect(typeof version).toBe('string');
  });

  it('matches every output on disk byte for byte', () => {
    expect(manifest.outputs.length).toBeGreaterThan(0);
    for (const output of manifest.outputs) {
      const path = join(FIRMWARE, output.file);
      expect(existsSync(path), output.file).toBe(true);
      const bytes = readFileSync(path);
      expect(bytes.length, output.file).toBe(output.bytes);
      expect(createHash('sha256').update(bytes).digest('hex'), output.file).toBe(output.sha256);
      expect(output.fqbn).toBe(FIXTURE_BOARDS[output.board]?.fqbn);
      const core = output.fqbn.split(':').slice(0, 2).join(':');
      expect(output.core, output.file).toBe(`${core}@${manifest.cores[core]}`);
      expect(typeof output.libraries).toBe('object');
    }
  });

  it('has exactly the outputs of every sketch under fixtures/sketches/', () => {
    const expected: string[] = [];
    for (const board of readdirSync(SKETCHES)) {
      if (!statSync(join(SKETCHES, board)).isDirectory()) continue;
      for (const name of readdirSync(join(SKETCHES, board))) {
        if (!statSync(join(SKETCHES, board, name)).isDirectory()) continue;
        expected.push(...sketchOutputs(board, name));
      }
    }
    for (const oracle of ADDR2LINE_ORACLES) expected.push(`${oracle}.addr2line.txt`);
    expect(manifest.outputs.map((o) => o.file).sort()).toEqual(expected.sort());
  });

  it('records the libraries a sketch used', () => {
    const scan = manifest.outputs.find((o) => o.file === 'uno/i2c-scan.hex');
    expect(scan?.libraries).toHaveProperty('Wire');
    const eeprom = manifest.outputs.find((o) => o.file === 'uno/eeprom.hex');
    expect(eeprom?.libraries).toHaveProperty('EEPROM');
  });
});

describe('Xtensa test programs and decode corpora', () => {
  const XTENSA = join(ROOT, 'fixtures', 'xtensa');

  it('every fixtures/xtensa/*.S has its committed .bin and .lst; the listing starts at 0x40080000', () => {
    const programs = readdirSync(XTENSA).filter((f) => f.endsWith('.S'));
    expect(programs).toContain('smoke.S');
    for (const source of programs) {
      const name = source.slice(0, -2);
      expect(existsSync(join(XTENSA, `${name}.bin`)), name).toBe(true);
      const listing = readFileSync(join(XTENSA, `${name}.lst`), 'utf8');
      expect(listing, name).toMatch(/^40080000 <_start>:$/m);
      expect(listing, name).not.toMatch(/\/Users\//); // no machine paths
    }
    // smoke.bin ends with `break 1, 15` (bytes f0 41 00).
    const smoke = readFileSync(join(XTENSA, 'smoke.bin'));
    expect(Array.from(smoke.subarray(smoke.length - 3))).toEqual([0xf0, 0x41, 0x00]);
  });

  it('the corpora match their manifest and stay within 1.5 MB', () => {
    const corpus = join(XTENSA, 'corpus');
    const manifest = JSON.parse(readFileSync(join(corpus, 'manifest.json'), 'utf8')) as {
      corpora: { name: string; rows: number; raw: { file: string; bytes: number }[] }[];
      isaAllDropped: string[];
    };
    expect(manifest.corpora.map((c) => c.name)).toEqual(['isa-all', 'narrow16', 'wide24', 'serial-hello']);
    let total = statSync(join(corpus, 'manifest.json')).size;
    for (const c of manifest.corpora) {
      const tsv = gunzipSync(readFileSync(join(corpus, `${c.name}.tsv.gz`))).toString('utf8');
      const rows = tsv.split('\n').filter((l) => l !== '' && !l.startsWith('#'));
      expect(rows.length, c.name).toBe(c.rows);
      for (const row of rows.slice(0, 50)) expect(row, c.name).toMatch(/^[0-9a-f]{8}\t[0-9a-f]{2,6}\t\S+\t.*$/);
      total += statSync(join(corpus, `${c.name}.tsv.gz`)).size;
      for (const raw of c.raw) {
        expect(gunzipSync(readFileSync(join(corpus, raw.file))).length, raw.file).toBe(raw.bytes);
        total += statSync(join(corpus, raw.file)).size;
      }
    }
    expect(manifest.corpora.find((c) => c.name === 'narrow16')?.rows).toBe(65536);
    expect(manifest.corpora.find((c) => c.name === 'wide24')?.rows).toBe(65536);
    expect(manifest.isaAllDropped).toEqual([]);
    expect(total).toBeLessThanOrEqual(1.5 * 1024 * 1024);
  });
});

describe('RP2040 test programs', () => {
  it('every fixtures/rp2040/*.c has its linker script, .elf and .lst, with no machine paths', () => {
    const dir = join(ROOT, 'fixtures', 'rp2040');
    const programs = readdirSync(dir).filter((f) => f.endsWith('.c'));
    expect(programs).toContain('romcalls.c');
    for (const source of programs) {
      const name = source.slice(0, -2);
      for (const ext of ['ld', 'elf', 'lst']) expect(existsSync(join(dir, `${name}.${ext}`)), `${name}.${ext}`).toBe(true);
      expect(readFileSync(join(dir, `${name}.lst`), 'utf8')).not.toMatch(/\/Users\//);
      expect(readFileSync(join(dir, `${name}.elf`)).includes(Buffer.from('/Users/'))).toBe(false);
    }
  });
});

describe('RISC-V test programs and decode corpora', () => {
  const RISCV = join(ROOT, 'fixtures', 'riscv');

  it('every fixtures/riscv/programs/*.S has its committed .bin and .lst; the listing starts at 0x80000000', () => {
    const dir = join(RISCV, 'programs');
    const programs = readdirSync(dir).filter((f) => f.endsWith('.S'));
    expect(programs).toContain('traps.S');
    for (const source of programs) {
      const name = source.slice(0, -2);
      expect(existsSync(join(dir, `${name}.bin`)), name).toBe(true);
      const listing = readFileSync(join(dir, `${name}.lst`), 'utf8');
      expect(listing, name).toMatch(/^80000000 <_start>:$/m);
      expect(listing, name).not.toMatch(/\/Users\//); // no machine paths
    }
  });

  it('the corpora match their manifest and stay within 1 MB', () => {
    const corpus = join(RISCV, 'corpus');
    const manifest = JSON.parse(readFileSync(join(corpus, 'manifest.json'), 'utf8')) as { objdump: string; corpora: Record<string, { file: string; rows: number; base: string }> };
    expect(Object.keys(manifest.corpora)).toEqual(['narrow16', 'wide32', 'csr', 'text']);
    let total = statSync(join(corpus, 'manifest.json')).size;
    for (const [name, c] of Object.entries(manifest.corpora)) {
      const rows = gunzipSync(readFileSync(join(corpus, c.file))).toString('utf8').split('\n').filter((l) => l !== '');
      expect(rows.length, name).toBe(c.rows);
      for (const row of rows.slice(0, 50)) expect(row, name).toMatch(/^([0-9a-f]{4}|[0-9a-f]{8})(\/\d)?\t\S+(\t.*)?$/);
      total += statSync(join(corpus, c.file)).size;
    }
    expect(manifest.corpora.narrow16.rows).toBe(49152);
    expect(total).toBeLessThanOrEqual(1024 * 1024);
  });
});
