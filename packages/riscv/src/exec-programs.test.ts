import { describe, expect, it } from 'vitest';
import { IN_BASE, OUT_BASE, RiscvBareMachine } from './test-support/bare-machine.test-helper.ts';

// BT64 execution tests: memory.S, branches.S and atomics.S over input tables with references
// computed here (a DataView model, comparisons, the A chapter's definitions); compressed.S and
// zcmp.S against hand-derived values (listed with their reasons).

const EDGES = [0, 1, 0x7f, 0x80, 0xff, 0x7fff, 0x8000, 0xffff, 0x7fffffff, 0x80000000, 0xffffffff, 0x12345678, 0xdeadbeef, 0x80808080];

function run(program: string, input: number[], outputs: number, predecode = true): number[] {
  const machine = new RiscvBareMachine();
  machine.core.predecode = predecode;
  machine.loadProgram(program).writeWords(IN_BASE, input);
  machine.run();
  expect(machine.exitCode).toBe(0);
  return machine.readWords(OUT_BASE, outputs);
}

const hex = (values: number[]): string[] => values.map((v) => `0x${(v >>> 0).toString(16)}`);

describe('loads and stores', () => {
  it('memory.S: every width, signed and unsigned, positive and negative offsets', () => {
    const words = [...EDGES, 0x01020304, 0xa5a55a5a];
    const got = run('memory', [words.length, ...words], words.length * 17);
    const want: number[] = [];
    for (const w of words) {
      const view = new DataView(new ArrayBuffer(16));
      view.setUint32(0, w, true);
      for (let i = 0; i < 4; i++) want.push(view.getInt8(i));
      for (let i = 0; i < 4; i++) want.push(view.getUint8(i));
      want.push(view.getInt16(0, true), view.getInt16(2, true), view.getUint16(0, true), view.getUint16(2, true), view.getUint32(0, true));
      view.setUint32(4, 0, true);
      view.setUint8(5, w & 0xff);
      want.push(view.getUint32(4, true));
      view.setUint32(8, 0, true);
      view.setUint16(10, w & 0xffff, true);
      want.push(view.getUint32(8, true));
      want.push(w, w);
    }
    expect(hex(got)).toEqual(hex(want));
  });
});

describe('branches and jumps', () => {
  it('branches.S: six conditional branches and c.beqz/c.bnez over edge pairs, then the jumps', () => {
    const pairs: [number, number][] = [];
    for (const a of EDGES) for (const b of EDGES) pairs.push([a, b]);
    const got = run('branches', [pairs.length, ...pairs.flat()], pairs.length * 8 + 6);
    const want: number[] = [];
    for (const [a, b] of pairs) {
      const sa = a | 0;
      const sb = b | 0;
      want.push(+(a === b), +(a !== b), +(sa < sb), +(sa >= sb), +(a >>> 0 < b >>> 0), +(a >>> 0 >= b >>> 0), +(a === 0), +(a !== 0));
    }
    // jal and jalr link the next instruction; jalr clears bit 0 of its target; c.jal links pc + 2;
    // c.jr reaches its target; c.jalr links pc + 2.
    want.push(0, 0, 1, 0, 1, 0);
    expect(got).toEqual(want);
  });
});

describe('atomics', () => {
  it('atomics.S: every AMO (with aq/rl variants) and LR/SC, success and failure', () => {
    const pairs: [number, number][] = [];
    for (const a of EDGES) for (const b of [0, 1, 0x7fffffff, 0x80000000, 0xffffffff, 0x12345678]) pairs.push([a, b]);
    const got = run('atomics', [pairs.length, ...pairs.flat()], pairs.length * 22);
    const want: number[] = [];
    for (const [a, b] of pairs) {
      const amos = [b, a + b, a ^ b, a & b, a | b, (a | 0) < (b | 0) ? a : b, (a | 0) > (b | 0) ? a : b, a >>> 0 < b >>> 0 ? a : b, a >>> 0 > b >>> 0 ? a : b];
      for (const after of amos) want.push(a >>> 0, after >>> 0);
      want.push(0, b >>> 0, 1, b >>> 0);
    }
    expect(hex(got)).toEqual(hex(want));
  });
});

describe('compressed instructions', () => {
  for (const predecode of [true, false]) {
    it(`compressed.S: RVC and Zcb (${predecode ? 'predecoded' : 'decoded every time'})`, () => {
      const want = [
        5, // c.li a0, 5
        0xffffffe0, // c.li a1, −32
        36, // c.addi a0, 31
        4, // c.addi a0, −32
        0x1f000, // c.lui a2, 0x1f
        0xfffe0000, // c.lui a2, 0xfffe0 (the 6-bit −32 in bits 31:12)
        4, // c.mv a3, a0
        0xffffffe4, // c.add a3, a1: 4 − 32
        0xffffffe0, // c.sub a3, a0: −28 − 4
        0xffffffe4, // c.xor a3, a0
        0xffffffe4, // c.or a3, a0
        4, // c.and a3, a0
        0x0ffffffe, // c.srli a1, 4: 0xffffffe0 >>> 4
        0xe, // c.andi a1, 15
        32, // c.slli a0, 3
        0xfffffe00, // c.srai a2, 8: 0xfffe0000 >> 8
        0xffffffc0, // c.addi16sp sp, −64
        8, // c.addi4spn a4, sp, 8
        32, // c.swsp / c.lwsp
        32, // c.sw / c.lw
        0x80, // c.zext.b of 0x12345680
        0xffffff80, // c.sext.b
        0xf678, // c.zext.h of 0x1234f678
        0xfffff678, // c.sext.h
        0xedcb0987, // c.not
        0xffffffeb, // c.mul 7 × −3
        0xcc, // c.lbu +1 of 0xaabbccdd
        0xaa, // c.lbu +3
        0xffffaabb, // c.lh +2
        0xaabb, // c.lhu +2
        0xffffccdd, // c.lh +0
        0xccdd, // c.lhu +0
        0x5abbccdd, // c.sb 0x5a at +3
        0x5abb1234, // c.sh 0x1234 at +0
        0x5a341234, // c.sb 0x34 at +2
      ];
      expect(hex(run('compressed', [], want.length, predecode))).toEqual(hex(want));
    });
  }
});

describe('Zcmp', () => {
  it('zcmp.S: push/pop/popret/popretz and the register moves', () => {
    const s = (i: number): number => 0x100 + i;
    const want = [
      -64 >>> 0, // cm.push {ra,s0-s11},−64
      0, 0, 0, // below the 13 saved registers (52 of 64 bytes)
      0x1ff, // ra at the lowest address
      ...Array.from({ length: 12 }, (_, i) => s(i)), // s0 … s11, s11 at old sp − 4
      0, // cm.pop {ra,s0-s11},64: sp back
      0x1ff,
      ...Array.from({ length: 12 }, (_, i) => s(i)),
      -48 >>> 0, // cm.push {ra,s0},−48: 16 + spimm 2 × 16
      0x200, // s0 at old sp − 4 = sp + 44
      0x2ff, // ra at sp + 40
      0x200, // cm.pop restores s0
      0x2ff, // and ra
      0, // sp back
      77, // cm.popret: a0 from the function
      0x300, // s0 restored
      0x301, // s1 restored
      0, // cm.popretz: a0 = 0
      0, // sp back at STACK_TOP
      5, // cm.mvsa01 s2, s3: s2 = a0
      6, // s3 = a1
      7, // cm.mva01s s4, s5: a0 = s4
      8, // a1 = s5
      10, // cm.mva01s s1, s0: a0 = s1
      9, // a1 = s0
    ];
    expect(hex(run('zcmp', [], want.length))).toEqual(hex(want));
  });
});
