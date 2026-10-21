import { describe, expect, it } from 'vitest';
import { disassemble } from './disasm.ts';
import { HAZARD3, RV32IMAC } from './isa.ts';
import { loadRiscvCorpus, riscvCorpusManifest } from './test-support/corpus.test-helper.ts';

// The differential disassembly test (BT64): every row the arduino-pico toolchain's objdump
// (binutils 2.43) printed for the committed corpora, assembled for the Hazard3 ISA minus its
// custom extension, in both of its forms, against disassemble() with the HAZARD3 profile.
// Tolerated, and counted: what that objdump doesn't know — Hazard3's Xh3bextm (custom-0) and
// Zcmp's cm.mvsa01/cm.mva01s, which it prints as `.insn` (the spec-derived table below checks
// them) — and what it decodes that this RV32 core must reject as illegal: RV64 shift amounts
// (≥ 32), Zcmp's reserved register lists 0–3 (it prints `{ra},0`), c.addi16sp with 0 and
// sfence.vma (no supervisor mode).

const KNOWN_ONLY_HERE = new Set(['h3.bextm', 'h3.bextmi', 'cm.mvsa01', 'cm.mva01s']);
const SHIFTS = new Set(['slli', 'srli', 'srai', 'c.slli', 'c.srli', 'c.srai', 'rori', 'bclri', 'bexti', 'binvi', 'bseti']);
function rejectedHere(mnemonic: string, operands: string, word: number): boolean {
  if (SHIFTS.has(mnemonic)) return Number.parseInt(operands.slice(operands.lastIndexOf(',') + 1), 16) >= 32;
  if (mnemonic.startsWith('cm.p')) return ((word >>> 4) & 15) < 4;
  return mnemonic === 'sfence.vma' || (mnemonic === 'c.addi16sp' && operands === 'sp,0');
}

describe('disassemble vs objdump', () => {
  it('records which objdump made the corpora', () => {
    expect(riscvCorpusManifest().objdump).toMatch(/GNU objdump .* 2\.43/);
  });

  for (const name of ['narrow16', 'wide32', 'csr', 'text'] as const) {
    it(`${name}: every row, both forms`, () => {
      const rows = loadRiscvCorpus(name);
      const mismatches: string[] = [];
      const tolerated = { notInObjdump: 0, rejectedHere: 0 };
      const report = (row: (typeof rows)[number], form: string, want: string, got: string): void => {
        if (mismatches.length < 40) mismatches.push(`${row.address.toString(16)} ${row.word.toString(16).padStart(row.length * 2, '0')} ${form}: objdump "${want}" ours "${got}"`);
        else if (mismatches.length === 40) mismatches.push('…');
      };
      for (const row of rows) {
        const raw = disassemble(row.word, row.address, HAZARD3, false);
        const alias = disassemble(row.word, row.address, HAZARD3, true);
        if (raw.length !== row.length) report(row, 'length', `${row.length}`, `${raw.length}`);
        if (row.mnemonic === '.insn' && KNOWN_ONLY_HERE.has(raw.mnemonic)) {
          tolerated.notInObjdump++;
          continue;
        }
        if (rejectedHere(row.mnemonic, row.operands, row.word)) {
          tolerated.rejectedHere++;
          if (raw.mnemonic !== '.insn' || alias.mnemonic !== '.insn') report(row, 'tolerated', 'invalid here', `${raw.mnemonic} / ${alias.mnemonic}`);
          continue;
        }
        const want = `${row.mnemonic} ${row.operands}`;
        const got = `${raw.mnemonic} ${raw.operands}`;
        if (got !== want) report(row, 'no-aliases', want, got);
        const wantAlias = `${row.aliasMnemonic} ${row.aliasOperands}`;
        const gotAlias = `${alias.mnemonic} ${alias.operands}`;
        if (gotAlias !== wantAlias) report(row, 'aliases', wantAlias, gotAlias);
      }
      console.info(`${name}: ${rows.length} rows; tolerated ${JSON.stringify(tolerated)}`);
      expect(mismatches).toEqual([]);
    });
  }
});

// The Hazard3 extensions, encoded from the specs' tables (bit-manipulation 1.0.0, Zc 1.0.4,
// Hazard3's Xh3bextm): the corpora check what objdump 2.43 knows of them; this table also
// covers h3.bextm/h3.bextmi and cm.mvsa01/cm.mva01s, which it doesn't (binutils' operand
// conventions: shift amounts in hex, register lists in braces). Each row: word, no-aliases
// text, alias text.
const EXTENSIONS: [number, string, string][] = [
  [0x20b522b3, 'sh1add t0,a0,a1', 'sh1add t0,a0,a1'],
  [0x20b542b3, 'sh2add t0,a0,a1', 'sh2add t0,a0,a1'],
  [0x20b562b3, 'sh3add t0,a0,a1', 'sh3add t0,a0,a1'],
  [0x40b572b3, 'andn t0,a0,a1', 'andn t0,a0,a1'],
  [0x40b562b3, 'orn t0,a0,a1', 'orn t0,a0,a1'],
  [0x40b542b3, 'xnor t0,a0,a1', 'xnor t0,a0,a1'],
  [0x60059513, 'clz a0,a1', 'clz a0,a1'],
  [0x60159513, 'ctz a0,a1', 'ctz a0,a1'],
  [0x60259513, 'cpop a0,a1', 'cpop a0,a1'],
  [0x60459513, 'sext.b a0,a1', 'sext.b a0,a1'],
  [0x60559513, 'sext.h a0,a1', 'sext.h a0,a1'],
  [0x0805c533, 'zext.h a0,a1', 'zext.h a0,a1'],
  [0x0ac5c533, 'min a0,a1,a2', 'min a0,a1,a2'],
  [0x0ac5d533, 'minu a0,a1,a2', 'minu a0,a1,a2'],
  [0x0ac5e533, 'max a0,a1,a2', 'max a0,a1,a2'],
  [0x0ac5f533, 'maxu a0,a1,a2', 'maxu a0,a1,a2'],
  [0x60c59533, 'rol a0,a1,a2', 'rol a0,a1,a2'],
  [0x60c5d533, 'ror a0,a1,a2', 'ror a0,a1,a2'],
  [0x6075d513, 'rori a0,a1,0x7', 'rori a0,a1,0x7'],
  [0x2875d513, 'orc.b a0,a1', 'orc.b a0,a1'],
  [0x6985d513, 'rev8 a0,a1', 'rev8 a0,a1'],
  [0x6875d513, 'brev8 a0,a1', 'brev8 a0,a1'],
  [0x08f59513, 'zip a0,a1', 'zip a0,a1'],
  [0x08f5d513, 'unzip a0,a1', 'unzip a0,a1'],
  [0x48c59533, 'bclr a0,a1,a2', 'bclr a0,a1,a2'],
  [0x48c5d533, 'bext a0,a1,a2', 'bext a0,a1,a2'],
  [0x68c59533, 'binv a0,a1,a2', 'binv a0,a1,a2'],
  [0x28c59533, 'bset a0,a1,a2', 'bset a0,a1,a2'],
  [0x48d59513, 'bclri a0,a1,0xd', 'bclri a0,a1,0xd'],
  [0x49f5d513, 'bexti a0,a1,0x1f', 'bexti a0,a1,0x1f'],
  [0x68059513, 'binvi a0,a1,0x0', 'binvi a0,a1,0x0'],
  [0x29f59513, 'bseti a0,a1,0x1f', 'bseti a0,a1,0x1f'],
  [0x08c5c533, 'pack a0,a1,a2', 'pack a0,a1,a2'],
  [0x08c5f533, 'packh a0,a1,a2', 'packh a0,a1,a2'],
  [0x1cc5850b, 'h3.bextm a0,a1,a2,8', 'h3.bextm a0,a1,a2,8'],
  [0x0c35c50b, 'h3.bextmi a0,a1,3,4', 'h3.bextmi a0,a1,3,4'],
  [0x82d0, 'c.lbu a2,1(a3)', 'lbu a2,1(a3)'],
  [0x86b0, 'c.lhu a2,2(a3)', 'lhu a2,2(a3)'],
  [0x86f0, 'c.lh a2,2(a3)', 'lh a2,2(a3)'],
  [0x8af8, 'c.sb a4,3(a3)', 'sb a4,3(a3)'],
  [0x8eb8, 'c.sh a4,2(a3)', 'sh a4,2(a3)'],
  [0x9de1, 'c.zext.b a1', 'zext.b a1,a1'],
  [0x9de5, 'c.sext.b a1', 'sext.b a1,a1'],
  [0x9de9, 'c.zext.h a1', 'zext.h a1,a1'],
  [0x9ded, 'c.sext.h a1', 'sext.h a1,a1'],
  [0x9df5, 'c.not a1', 'not a1,a1'],
  [0x9dd1, 'c.mul a1,a2', 'mul a1,a1,a2'],
  [0xb8f2, 'cm.push {ra,s0-s11},-64', 'cm.push {ra,s0-s11},-64'],
  [0xb842, 'cm.push {ra},-16', 'cm.push {ra},-16'],
  [0xb84e, 'cm.push {ra},-64', 'cm.push {ra},-64'],
  [0xbae2, 'cm.pop {ra,s0-s9},48', 'cm.pop {ra,s0-s9},48'],
  [0xba62, 'cm.pop {ra,s0-s1},16', 'cm.pop {ra,s0-s1},16'],
  [0xbe72, 'cm.popret {ra,s0-s2},16', 'cm.popret {ra,s0-s2},16'],
  [0xbc56, 'cm.popretz {ra,s0},32', 'cm.popretz {ra,s0},32'],
  [0xad2e, 'cm.mvsa01 s2,s3', 'cm.mvsa01 s2,s3'],
  [0xae76, 'cm.mva01s s4,s5', 'cm.mva01s s4,s5'],
];

describe('the Hazard3 extensions', () => {
  it('disassemble as the spec-derived table says', () => {
    const got = EXTENSIONS.map(([word]) => {
      const raw = disassemble(word, 0x10000000, HAZARD3, false);
      const alias = disassemble(word, 0x10000000, HAZARD3, true);
      return [word, `${raw.mnemonic} ${raw.operands}`, `${alias.mnemonic} ${alias.operands}`];
    });
    expect(got).toEqual(EXTENSIONS);
    // Without the extensions every one of them is an invalid word.
    for (const [word] of EXTENSIONS) expect(disassemble(word, 0, RV32IMAC).mnemonic).toBe('.insn');
  });

  it('change nothing that decodes without them: every corpus row valid for RV32IMAC disassembles the same with HAZARD3', () => {
    let compared = 0;
    for (const name of ['narrow16', 'wide32', 'text'] as const) {
      for (const row of loadRiscvCorpus(name)) {
        const base = disassemble(row.word, row.address, RV32IMAC, false);
        if (base.mnemonic === '.insn') continue;
        compared++;
        const hazard3 = disassemble(row.word, row.address, HAZARD3, false);
        if (`${hazard3.mnemonic} ${hazard3.operands}` !== `${base.mnemonic} ${base.operands}`) expect(`${row.word.toString(16)}: ${hazard3.mnemonic} ${hazard3.operands}`).toBe(`${row.word.toString(16)}: ${base.mnemonic} ${base.operands}`);
      }
    }
    expect(compared).toBeGreaterThan(40_000);
  });
});
