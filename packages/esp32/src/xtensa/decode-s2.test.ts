import { describe, expect, it } from 'vitest';
import { loadCorpus } from '../test-support/corpus.test-helper.ts';
import { D_LEN, D_OP, decode, DESCRIPTOR_SIZE } from './decode.ts';
import { operandText } from './disasm.ts';
import { OP_INVALID, OPS } from './isa.ts';

// BT148: the ESP32-S2's LX7 against its own objdump (xtensa-esp32s2-elf-objdump): every line it
// printed for the IRAM sections of the S2 serial-hello (fixtures/xtensa/corpus/s2-serial-hello,
// scripts/xtensa-corpus.ts writeS2Corpus) — the vectors and FreeRTOS's port — decoded with the
// S2's set; and the options its core-isa.h leaves out (loops, MAC16, FPU, booleans, S32C1I) decode
// invalid — illegal instructions — where the ESP32's and the S3's decoders know them.

const desc = new Int32Array(DESCRIPTOR_SIZE);
const nameOf = (bytes: number[], s3: boolean, s2: boolean): string => {
  decode(bytes[0], bytes[1] ?? 0, bytes[2] ?? 0, desc, s3, s2);
  return desc[D_OP] === OP_INVALID ? 'invalid' : OPS[desc[D_OP]].name;
};

describe('decode + disasm vs the ESP32-S2 objdump (BT148)', () => {
  it('s2-serial-hello: every line matches', () => {
    const corpus = loadCorpus('s2-serial-hello', 's2-manifest.json');
    const mismatches: string[] = [];
    let tieRows = 0;
    let lx7 = 0;
    for (const row of corpus.rows) {
      const [b0, b1, b2] = corpus.bytesAt(row.address);
      decode(b0, b1, b2, desc, false, true);
      const truncated = desc[D_LEN] > corpus.available(row.address);
      const ours = desc[D_OP] === OP_INVALID || truncated ? 'invalid' : OPS[desc[D_OP]].name;
      const text = ours === 'invalid' ? '' : operandText(desc, row.address);
      // The S2's own TIE (the dedicated GPIO's *_gpio_out / gpio_in ops) isn't decoded: it faults as
      // unimplemented. In this corpus it is only where the raw decode ran through data or the middle
      // of an instruction.
      const tie = /gpio_(out|in)\b/.test(row.mnemonic);
      if (tie) tieRows++;
      const ok = row.mnemonic === 'invalid' || row.mnemonic === '.byte' || tie ? ours === 'invalid' : ours === row.mnemonic && text === row.operands && desc[D_LEN] * 2 === row.bytes.length;
      if (ok && (ours === 'salt' || ours === 'saltu')) lx7++;
      if (!ok && mismatches.length < 30) mismatches.push(`${row.address.toString(16)} objdump "${row.mnemonic} ${row.operands}" ours "${ours} ${text}"`);
    }
    expect(mismatches).toEqual([]);
    expect(corpus.rows.length).toBeGreaterThan(10_000);
    expect(tieRows).toBeLessThan(10);
    expect(lx7).toBeGreaterThanOrEqual(10); // LX7's SALT/SALTU, which the S2's compiler emits
  }, 60_000);

  it('the options the S2 lacks are illegal there, and known to the ESP32 and the S3', () => {
    const lacking: [string, number[]][] = [
      ['loop', [0x76, 0x82, 0x10]], // loop a2, …
      ['loopnez', [0x76, 0x92, 0x10]],
      ['mul.aa.ll', [0x34, 0x02, 0x74]],
      ['add.s', [0x00, 0x12, 0x0a]],
      ['lsi', [0x03, 0x02, 0x00]],
      ['andb', [0x00, 0x12, 0x02]],
      ['s32c1i', [0x22, 0xe3, 0x00]],
      ['rsr.lbeg', [0x20, 0x00, 0x03]],
      ['wsr.scompare1', [0x20, 0x0c, 0x13]],
    ];
    for (const [name, bytes] of lacking) {
      expect(nameOf(bytes, false, false), name).toBe(name);
      expect(nameOf(bytes, true, false), name).toBe(name);
      expect(nameOf(bytes, false, true), name).toBe('invalid');
    }
    // LX7's SALT/SALTU: the S2's (and the S3's), not the ESP32's.
    expect(nameOf([0x30, 0x12, 0x72], false, true)).toBe('salt');
    expect(nameOf([0x30, 0x12, 0x72], false, false)).toBe('invalid');
  });
});
