import { describe, expect, it } from 'vitest';
import { loadCorpus } from '../test-support/corpus.test-helper.ts';
import { D_LEN, D_OP, decode, DESCRIPTOR_SIZE } from './decode.ts';
import { operandText } from './disasm.ts';
import { OP_INVALID, OPS } from './isa.ts';

// BT124: the ESP32-S3's LX7 against its own objdump (xtensa-esp32s3-elf-objdump): every line it
// printed for the IRAM sections of the S3 serial-hello (fixtures/xtensa/corpus/s3-serial-hello,
// scripts/xtensa-corpus.ts writeS3Corpus) — the vectors and FreeRTOS's port, with the PIE state
// saves — decoded with the S3 rows on. As decode.test.ts: objdump's `lsi` for words that aren't
// LSI must decode invalid here.

describe('decode + disasm vs the ESP32-S3 objdump (BT124)', () => {
  it('s3-serial-hello: every line matches', () => {
    const corpus = loadCorpus('s3-serial-hello', 's3-manifest.json');
    const desc = new Int32Array(DESCRIPTOR_SIZE);
    const mismatches: string[] = [];
    let pie = 0;
    let vectorRows = 0;
    for (const row of corpus.rows) {
      const [b0, b1, b2] = corpus.bytesAt(row.address);
      decode(b0, b1, b2, desc, true);
      const truncated = desc[D_LEN] > corpus.available(row.address);
      const ours = desc[D_OP] === OP_INVALID || truncated ? 'invalid' : OPS[desc[D_OP]].name;
      const text = ours === 'invalid' ? '' : operandText(desc, row.address);
      if (desc[D_OP] !== OP_INVALID && OPS[desc[D_OP]].s3) pie++;
      const lsiArtifact = row.mnemonic === 'lsi' && !((b0 & 0xf) === 3 && b1 >> 4 === 0);
      // The vector unit's compute ops (EE.*, mostly 4 bytes) aren't decoded: they fault as
      // unimplemented. In this corpus they are data the raw decode ran through.
      const vector = row.mnemonic.startsWith('ee.');
      if (vector) vectorRows++;
      const expected = lsiArtifact || vector ? 'invalid' : row.mnemonic;
      const ok = expected === 'invalid' ? ours === 'invalid' : ours === expected && text === row.operands && desc[D_LEN] * 2 === row.bytes.length;
      if (!ok && mismatches.length < 30) mismatches.push(`${row.address.toString(16)} objdump "${row.mnemonic} ${row.operands}" ours "${ours} ${text}"`);
    }
    expect(mismatches).toEqual([]);
    expect(corpus.rows.length).toBeGreaterThan(10_000);
    // FreeRTOS's PIE save and restore are in it: 18 rur, 18 wur, 8 st.qr, 8 ld.qr at least.
    expect(pie).toBeGreaterThanOrEqual(52);
  }, 60_000);
});
