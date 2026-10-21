import { describe, expect, it } from 'vitest';
import { type Corpus, loadCorpus, loadRomCorpus } from '../test-support/corpus.test-helper.ts';
import { D_LEN, D_OP, decode, DESCRIPTOR_SIZE } from './decode.ts';
import { operandText } from './disasm.ts';
import { OP_INVALID, OPS } from './isa.ts';

// The differential decode test (BT28): every line objdump printed for the four committed corpora
// and the cached ROM, against decode() and disasm(). The one tolerated difference: objdump prints
// `lsi` for words that aren't LSI (op0 ≠ 3 or r ≠ 0: unassigned encodings, MAC16 holes, cache
// ops on this cacheless core, data) — those must decode invalid here, and are counted.

interface Result {
  lines: number;
  mismatches: string[];
  artifacts: number;
  artifactLines: number;
}

function differential(corpus: Corpus): Result {
  const desc = new Int32Array(DESCRIPTOR_SIZE);
  const result: Result = { lines: 0, mismatches: [], artifacts: 0, artifactLines: 0 };
  for (const row of corpus.rows) {
    result.lines++;
    const [b0, b1, b2] = corpus.bytesAt(row.address);
    decode(b0, b1, b2, desc);
    // An instruction running past the end of its section is data to objdump.
    const truncated = desc[D_LEN] > corpus.available(row.address);
    const ours = desc[D_OP] === OP_INVALID || truncated ? 'invalid' : OPS[desc[D_OP]].name;
    const oursText = ours === 'invalid' ? '' : operandText(desc, row.address);
    const op0 = b0 & 0xf;
    const r = b1 >> 4;
    const mismatch = (why: string): void => {
      if (result.mismatches.length < 40) {
        result.mismatches.push(`${corpus.name} ${row.address.toString(16)} [${b0.toString(16).padStart(2, '0')} ${b1.toString(16).padStart(2, '0')} ${b2.toString(16).padStart(2, '0')}] objdump "${row.mnemonic} ${row.operands}" ours "${ours} ${oursText}" (${why})`);
      } else result.mismatches.push('…');
    };
    if (row.mnemonic === 'lsi' && !(op0 === 3 && r === 0)) {
      result.artifactLines++;
      if (ours === 'invalid') result.artifacts++;
      else mismatch('lsi artifact must be invalid');
      continue;
    }
    if (row.mnemonic === 'invalid') {
      if (ours !== 'invalid') mismatch('objdump says invalid');
      continue;
    }
    if (ours === 'invalid') {
      mismatch('we say invalid');
      continue;
    }
    if (desc[D_LEN] * 2 !== row.bytes.length) mismatch(`length ${desc[D_LEN]}`);
    else if (ours !== row.mnemonic) mismatch('mnemonic');
    else if (oursText !== row.operands) mismatch('operands');
  }
  return result;
}

describe('decode + disasm vs objdump', () => {
  const report: string[] = [];
  for (const name of ['isa-all', 'narrow16', 'wide24', 'serial-hello', 'rom'] as const) {
    it(`${name}: every line matches (lsi artifacts counted)`, () => {
      const corpus = name === 'rom' ? loadRomCorpus() : loadCorpus(name);
      const result = differential(corpus);
      report.push(`${name}: ${result.lines} lines, ${result.mismatches.length} mismatches, ${result.artifacts} lsi artifacts`);
      console.info(report.at(-1));
      expect(result.mismatches).toEqual([]);
      expect(result.artifacts).toBe(result.artifactLines);
      expect(result.lines).toBe(corpus.rows.length);
    }, 60_000);
  }
});
