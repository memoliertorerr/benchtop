import { describe, expect, it } from 'vitest';
import { IN_BASE, OUT_BASE, RiscvBareMachine } from './test-support/bare-machine.test-helper.ts';

// BT64 execution tests: alu.S and bitmanip.S run every op over a table of operand pairs (edge
// values crossed with each other, plus fixed-seed random pairs) and the results are compared
// with references written with BigInt straight from the specs' definitions (bit by bit where
// the spec defines it so) — independent of the core's 32-bit tricks.

const M32 = (1n << 32n) - 1n;
const u = (v: number): bigint => BigInt(v >>> 0);
const s = (v: number): bigint => BigInt(v | 0);
const w = (b: bigint): number => Number(b & M32);
const bit = (v: bigint, i: number): bigint => (v >> BigInt(i)) & 1n;

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

const EDGES = [0, 1, 2, 31, 32, 0xff, 0x8000, 0x7fffffff, 0x80000000, 0xfffffffe, 0xffffffff, 0xdeadbeef];

function pairs(seed: number, randomCount: number): [number, number][] {
  const out: [number, number][] = [];
  for (const a of EDGES) for (const b of EDGES) out.push([a, b]);
  const rand = prng(seed);
  for (let i = 0; i < randomCount; i++) {
    // Mix small shift-like values in: bit-index operands use only their low 5 bits.
    const b = i % 4 === 0 ? rand() & 63 : rand();
    out.push([rand(), b]);
  }
  return out;
}

type Ref = (a: number, b: number) => number;

const ALU: [string, Ref][] = [
  ['add', (a, b) => w(s(a) + s(b))],
  ['sub', (a, b) => w(s(a) - s(b))],
  ['sll', (a, b) => w(u(a) << (u(b) & 31n))],
  ['slt', (a, b) => (s(a) < s(b) ? 1 : 0)],
  ['sltu', (a, b) => (u(a) < u(b) ? 1 : 0)],
  ['xor', (a, b) => w(u(a) ^ u(b))],
  ['srl', (a, b) => w(u(a) >> (u(b) & 31n))],
  ['sra', (a, b) => w(s(a) >> (u(b) & 31n))],
  ['or', (a, b) => w(u(a) | u(b))],
  ['and', (a, b) => w(u(a) & u(b))],
  ['mul', (a, b) => w(s(a) * s(b))],
  ['mulh', (a, b) => w((s(a) * s(b)) >> 32n)],
  ['mulhsu', (a, b) => w((s(a) * u(b)) >> 32n)],
  ['mulhu', (a, b) => w((u(a) * u(b)) >> 32n)],
  // Division by zero and overflow per the M chapter's table 7.1.
  ['div', (a, b) => (s(b) === 0n ? 0xffffffff : s(a) === -(1n << 31n) && s(b) === -1n ? a >>> 0 : w(s(a) / s(b)))],
  ['divu', (a, b) => (u(b) === 0n ? 0xffffffff : w(u(a) / u(b)))],
  ['rem', (a, b) => (s(b) === 0n ? a >>> 0 : s(a) === -(1n << 31n) && s(b) === -1n ? 0 : w(s(a) % s(b)))],
  ['remu', (a, b) => (u(b) === 0n ? a >>> 0 : w(u(a) % u(b)))],
  ['addi 2047', (a) => w(s(a) + 2047n)],
  ['addi -2048', (a) => w(s(a) - 2048n)],
  ['slti 5', (a) => (s(a) < 5n ? 1 : 0)],
  ['sltiu -1', (a) => (u(a) < M32 ? 1 : 0)],
  ['sltiu 1', (a) => (u(a) < 1n ? 1 : 0)],
  ['xori -1', (a) => w(~s(a))],
  ['ori 0x7ff', (a) => w(u(a) | 0x7ffn)],
  ['andi -16', (a) => w(s(a) & -16n)],
  ['slli 1', (a) => w(u(a) << 1n)],
  ['slli 31', (a) => w(u(a) << 31n)],
  ['srli 1', (a) => w(u(a) >> 1n)],
  ['srli 31', (a) => w(u(a) >> 31n)],
  ['srai 1', (a) => w(s(a) >> 1n)],
  ['srai 31', (a) => w(s(a) >> 31n)],
  ['li 0x12345678', () => 0x12345678],
];

function count(v: bigint, from: 'high' | 'low', ones: boolean): number {
  let n = 0;
  for (let k = 0; k < 32; k++) {
    const b = bit(v, from === 'high' ? 31 - k : k);
    if (ones) n += Number(b);
    else if (b === 0n) n++;
    else break;
  }
  return n;
}

function bytes(v: bigint, f: (byte: bigint) => bigint): bigint {
  let r = 0n;
  for (let i = 0; i < 4; i++) r |= (f((v >> BigInt(8 * i)) & 0xffn) & 0xffn) << BigInt(8 * i);
  return r;
}

function rotl(v: bigint, n: bigint): bigint {
  return ((v << n) | (v >> ((32n - n) & 31n))) & M32;
}

const extract = (a: number, shift: bigint, size: number): number => w((u(a) >> shift) & ((1n << BigInt(size)) - 1n));

const BITMANIP: [string, Ref][] = [
  ['sh1add', (a, b) => w((u(a) << 1n) + u(b))],
  ['sh2add', (a, b) => w((u(a) << 2n) + u(b))],
  ['sh3add', (a, b) => w((u(a) << 3n) + u(b))],
  ['andn', (a, b) => w(u(a) & ~u(b))],
  ['orn', (a, b) => w(u(a) | (~u(b) & M32))],
  ['xnor', (a, b) => w(~(u(a) ^ u(b)))],
  ['clz', (a) => count(u(a), 'high', false)],
  ['ctz', (a) => count(u(a), 'low', false)],
  ['cpop', (a) => count(u(a), 'low', true)],
  ['max', (a, b) => (s(a) > s(b) ? a : b) >>> 0],
  ['maxu', (a, b) => (u(a) > u(b) ? a : b) >>> 0],
  ['min', (a, b) => (s(a) < s(b) ? a : b) >>> 0],
  ['minu', (a, b) => (u(a) < u(b) ? a : b) >>> 0],
  ['sext.b', (a) => w(BigInt.asIntN(8, u(a)))],
  ['sext.h', (a) => w(BigInt.asIntN(16, u(a)))],
  ['zext.h', (a) => w(u(a) & 0xffffn)],
  ['rol', (a, b) => w(rotl(u(a), u(b) & 31n))],
  ['ror', (a, b) => w(rotl(u(a), (32n - (u(b) & 31n)) & 31n))],
  ['rori 7', (a) => w(rotl(u(a), 25n))],
  ['rori 0', (a) => a >>> 0],
  ['orc.b', (a) => w(bytes(u(a), (x) => (x === 0n ? 0n : 0xffn)))],
  ['rev8', (a) => w(((u(a) & 0xffn) << 24n) | (((u(a) >> 8n) & 0xffn) << 16n) | (((u(a) >> 16n) & 0xffn) << 8n) | (u(a) >> 24n))],
  ['bclr', (a, b) => w(u(a) & ~(1n << (u(b) & 31n)))],
  ['bclri 13', (a) => w(u(a) & ~(1n << 13n))],
  ['bext', (a, b) => Number(bit(u(a), Number(u(b) & 31n)))],
  ['bexti 31', (a) => Number(bit(u(a), 31))],
  ['binv', (a, b) => w(u(a) ^ (1n << (u(b) & 31n)))],
  ['binvi 0', (a) => w(u(a) ^ 1n)],
  ['bset', (a, b) => w(u(a) | (1n << (u(b) & 31n)))],
  ['bseti 31', (a) => w(u(a) | (1n << 31n))],
  ['pack', (a, b) => w((u(a) & 0xffffn) | ((u(b) & 0xffffn) << 16n))],
  ['packh', (a, b) => w((u(a) & 0xffn) | ((u(b) & 0xffn) << 8n))],
  [
    'brev8',
    (a) =>
      w(
        bytes(u(a), (x) => {
          let r = 0n;
          for (let i = 0; i < 8; i++) r |= bit(x, i) << BigInt(7 - i);
          return r;
        }),
      ),
  ],
  [
    'zip',
    (a) => {
      let r = 0n;
      for (let i = 0; i < 16; i++) r |= (bit(u(a), i) << BigInt(2 * i)) | (bit(u(a), i + 16) << BigInt(2 * i + 1));
      return w(r);
    },
  ],
  [
    'unzip',
    (a) => {
      let r = 0n;
      for (let i = 0; i < 16; i++) r |= (bit(u(a), 2 * i) << BigInt(i)) | (bit(u(a), 2 * i + 1) << BigInt(i + 16));
      return w(r);
    },
  ],
  ['h3.bextm size 1', (a, b) => extract(a, u(b) & 31n, 1)],
  ['h3.bextm size 8', (a, b) => extract(a, u(b) & 31n, 8)],
  ['h3.bextm size 5', (a, b) => extract(a, u(b) & 31n, 5)],
  ['h3.bextmi 3 size 8', (a) => extract(a, 3n, 8)],
  ['h3.bextmi 31 size 4', (a) => extract(a, 31n, 4)],
  ['h3.bextmi 0 size 1', (a) => extract(a, 0n, 1)],
];

function runTable(program: string, refs: [string, Ref][], input: [number, number][], predecode: boolean): string[] {
  const machine = new RiscvBareMachine();
  machine.core.predecode = predecode;
  machine.loadProgram(program).writeWords(IN_BASE, [input.length, ...input.flat()]);
  machine.run();
  expect(machine.exitCode).toBe(0);
  const out = machine.readWords(OUT_BASE, input.length * refs.length);
  const wrong: string[] = [];
  input.forEach(([a, b], i) => {
    refs.forEach(([name, ref], j) => {
      const got = out[i * refs.length + j];
      const want = ref(a, b) >>> 0;
      if (got !== want && wrong.length < 30) wrong.push(`${name}(0x${(a >>> 0).toString(16)}, 0x${(b >>> 0).toString(16)}) = 0x${got.toString(16)}, want 0x${want.toString(16)}`);
    });
  });
  return wrong;
}

describe('RV32IM and the bit-manipulation extensions against BigInt references', () => {
  for (const predecode of [true, false]) {
    it(`alu.S: ${ALU.length} ops × 400 pairs (${predecode ? 'predecoded' : 'decoded every time'})`, () => {
      expect(runTable('alu', ALU, pairs(0xa1, 256), predecode)).toEqual([]);
    });
    it(`bitmanip.S: ${BITMANIP.length} ops × 400 pairs (${predecode ? 'predecoded' : 'decoded every time'})`, () => {
      expect(runTable('bitmanip', BITMANIP, pairs(0xb17, 256), predecode)).toEqual([]);
    });
  }
});
