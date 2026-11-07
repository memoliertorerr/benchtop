import { describe, expect, it } from 'vitest';
import { BareMachine, IRAM_BASE } from '../test-support/bare-machine.test-helper.ts';
import { HALT } from './cpu.ts';
import { D_OP, DESCRIPTOR_SIZE, decode } from './decode.ts';
import { disasm } from './disasm.ts';
import { EXCCAUSE } from './exceptions.ts';
import { OP, OP_INVALID } from './isa.ts';
import { SR } from './regs.ts';

// BT124: the ESP32-S3's PIE coprocessor (coprocessor 3) state moves on the shared Xtensa core —
// FreeRTOS saves and restores it lazily on the S3. Encodings as the S3 toolchain's assembler wrote
// them (xtensa-esp32s3-elf-as + objdump; the 24-bit word MSB first, as objdump prints it).

const CORPUS: readonly [word: number, text: string][] = [
  [0xcd2024, 'ld.qr\tq0, a2, 0'],
  [0xcda024, 'ld.qr\tq1, a2, 0'],
  [0xdd2024, 'ld.qr\tq2, a2, 0'],
  [0xdda024, 'ld.qr\tq3, a2, 0'],
  [0xed2024, 'ld.qr\tq4, a2, 0'],
  [0xeda024, 'ld.qr\tq5, a2, 0'],
  [0xfd2024, 'ld.qr\tq6, a2, 0'],
  [0xfda024, 'ld.qr\tq7, a2, 0'],
  [0xcd20f4, 'ld.qr\tq0, a15, 0'],
  [0xcd2724, 'ld.qr\tq0, a2, 112'],
  [0xcd2f24, 'ld.qr\tq0, a2, -16'],
  [0xcd2824, 'ld.qr\tq0, a2, -128'],
  [0xcd2524, 'ld.qr\tq0, a2, 80'],
  [0xcd6024, 'st.qr\tq0, a2, 0'],
  [0xfdeff4, 'st.qr\tq7, a15, -16'],
  [0xdde744, 'st.qr\tq3, a4, 112'],
  [0xede894, 'st.qr\tq5, a9, -128'],
  [0xe33000, 'rur.accx_0\ta3'],
  [0xe330d0, 'rur.sar_byte\ta3'],
  [0xe33120, 'rur.ua_state_3\ta3'],
  [0xf30030, 'wur.accx_0\ta3'],
  [0xf30b30, 'wur.qacc_l_4\ta3'],
  [0xf31230, 'wur.ua_state_3\ta3'],
  [0x721230, 'salt\ta1, a2, a3'],
  [0x621230, 'saltu\ta1, a2, a3'],
  [0x72f070, 'salt\ta15, a0, a7'],
  [0x6249e0, 'saltu\ta4, a9, a14'],
];

const bytesOf = (word: number): number[] => [word & 0xff, (word >>> 8) & 0xff, (word >>> 16) & 0xff];

describe('the ESP32-S3 PIE state on the Xtensa core (BT124)', () => {
  it('decodes and disassembles as the S3 objdump does; the ESP32 decoder leaves them invalid', () => {
    const d = new Int32Array(DESCRIPTOR_SIZE);
    for (const [word, text] of CORPUS) {
      const [b0, b1, b2] = bytesOf(word);
      decode(b0, b1, b2, d, true);
      expect(disasm(d, IRAM_BASE), word.toString(16)).toBe(text);
      decode(b0, b1, b2, d);
      expect(d[D_OP], word.toString(16)).toBe(OP_INVALID);
    }
    // An ESP32 instruction decodes the same on both.
    decode(0x22, 0xa1, 0x00, d, true);
    expect(disasm(d, IRAM_BASE)).toBe('movi\ta2, 0x100');
  });

  it('st.qr then ld.qr move 128 bits through 16-byte-aligned memory', () => {
    const m = new BareMachine({ s3: true });
    const core = m.core;
    core.writeSpecial(SR.CPENABLE, 8);
    core.q.set([0x11111111, 0x22222222, 0x33333333, 0x44444444], 3 * 4); // q3
    // st.qr q3, a4, 112 ; ld.qr q5, a2, 0 (a2 = the same address)
    m.setIram([...bytesOf(0xdde744), ...bytesOf(0xeda024)]);
    const base = IRAM_BASE + 0x100;
    core.pc = IRAM_BASE;
    core.setReg(4, base - 112 + 5); // unaligned: the low four bits are dropped
    core.setReg(2, base);
    core.step();
    core.step();
    expect(core.halt).toBe(HALT.RUNNING);
    expect([...m.bus.iram.subarray(0x100, 0x110)]).toEqual([0x11, 0x11, 0x11, 0x11, 0x22, 0x22, 0x22, 0x22, 0x33, 0x33, 0x33, 0x33, 0x44, 0x44, 0x44, 0x44]);
    expect([...core.q.subarray(5 * 4, 6 * 4)]).toEqual([0x11111111, 0x22222222, 0x33333333, 0x44444444]);
  });

  it('with CPENABLE bit 3 clear, the PIE state raises Coprocessor3Disabled (FreeRTOS saves it lazily there)', () => {
    for (const word of [0xcd2024, 0xe33000, 0xf30030]) {
      const m = new BareMachine({ s3: true });
      const core = m.core;
      core.writeSpecial(SR.CPENABLE, 1); // the FPU only
      m.setIram(bytesOf(word));
      core.pc = IRAM_BASE;
      let cause = -1;
      core.exceptionHook = (c) => {
        if (cause < 0) cause = c; // the first (the vector then faults: nothing is mapped there)
      };
      core.step();
      expect(cause, word.toString(16)).toBe(EXCCAUSE.COPROCESSOR_DISABLED + 3);
    }
  });

  it('salt and saltu: signed and unsigned "set if less than"', () => {
    for (const [word, a, b, expected] of [
      [0x721230, -1, 1, 1], // salt a1, a2, a3: −1 < 1
      [0x621230, -1, 1, 0], // saltu: 0xFFFFFFFF < 1 is false
      [0x621230, 1, 2, 1],
      [0x721230, 5, 5, 0],
    ] as const) {
      const m = new BareMachine({ s3: true });
      m.setIram(bytesOf(word));
      m.core.pc = IRAM_BASE;
      m.core.setReg(2, a >>> 0);
      m.core.setReg(3, b >>> 0);
      m.core.step();
      expect(m.core.reg(1), `${word.toString(16)} ${a} ${b}`).toBe(expected);
    }
  });

  it('the op ids of the S3 rows come after every ESP32 row', () => {
    expect(OP.LD_QR).toBeGreaterThan(OP.XSR_WINDOWSTART);
    expect(OP.ST_QR).toBe(OP.LD_QR + 1);
  });
});
