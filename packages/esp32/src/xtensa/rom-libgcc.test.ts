import { describe, expect, it } from 'vitest';
import { parseRomElf } from '../boot/rom.ts';
import { BareMachine, IRAM_BASE } from '../test-support/bare-machine.test-helper.ts';
import { loadCachedRom } from '../test-support/rom.test-helper.ts';
import { HALT } from './cpu.ts';

// BT30 (a): the ESP32 ROM's own libgcc routines, run on the core through fixtures/xtensa/
// romcall.S, must agree bit for bit with JS float64 / Math.fround (IEEE round-to-nearest-even)
// and with BigInt, on 2,000 seeded operand sets per routine plus the specials. They are
// integer-only soft-float code (no FPU ops: checked with objdump on the ROM ELF), so they
// exercise MULL/MULUH/MULSH/QUOU/REMU/NSAU and the windowed calls through the ROM's own window
// vectors. NaN results only need to be NaN. Float→int conversions are checked inside their
// defined range (C leaves the rest undefined).

const CALL_ARGS = 0x3ffb0800;
const COUNT = 2000;
/** Frames of `nest` below the call: enough that the call chain wraps the register file. */
const DEPTH = 6;

const rom = parseRomElf(loadCachedRom());
const machine = BareMachine.load('romcall', { rom: true });

// Count arrivals at the ROM's window vectors (VECBASE 0x40000000), to show they did the spilling.
const windowVectors = new Map<number, number>([0x00, 0x40, 0x80, 0xc0, 0x100, 0x140].map((offset) => [0x40000000 + offset, 0]));
{
  const bus = machine.bus;
  const fetch = bus.fetch.bind(bus);
  bus.fetch = (addr: number): number => {
    const n = windowVectors.get(addr);
    if (n !== undefined) windowVectors.set(addr, n + 1);
    return fetch(addr);
  };
}

function call(name: string, args: readonly number[]): [number, number] {
  const address = rom.symbols.get(name);
  if (address === undefined) throw new Error(`${name} is not a ROM symbol`);
  for (let i = 0; i < 4; i++) machine.bus.write32(CALL_ARGS + i * 4, (args[i] ?? 0) >>> 0);
  machine.bus.write32(CALL_ARGS + 16, address);
  machine.bus.write32(CALL_ARGS + 28, DEPTH);
  const core = machine.core;
  core.pc = IRAM_BASE;
  core.halt = HALT.RUNNING;
  core.haltReason = '';
  core.run(100_000);
  if (core.halt !== HALT.BREAK) throw new Error(`${name}(${args.map((a) => a.toString(16)).join(', ')}): ${core.haltReason || 'did not return'}`);
  return [machine.read32(CALL_ARGS + 20), machine.read32(CALL_ARGS + 24)];
}

// ── Seeded operands ─────────────────────────────────────────────────────────────────────────

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

const f64 = new Float64Array(1);
const w64 = new Uint32Array(f64.buffer);
const f32 = new Float32Array(1);
const w32 = new Uint32Array(f32.buffer);
const words = (d: number): [number, number] => {
  f64[0] = d;
  return [w64[0], w64[1]];
};
const double = (lo: number, hi: number): number => {
  w64[0] = lo;
  w64[1] = hi;
  return f64[0];
};
const floatBits = (v: number): number => {
  f32[0] = v;
  return w32[0];
};
const float = (bits: number): number => {
  w32[0] = bits;
  return f32[0];
};

const DOUBLE_SPECIALS = [0, -0, Infinity, -Infinity, NaN, Number.MAX_VALUE, -Number.MAX_VALUE, 2 ** -1022, -(2 ** -1022), 5e-324, 1, -1.5];
const FLOAT_SPECIALS = [0, -0, Infinity, -Infinity, NaN, 3.4028234663852886e38, -3.4028234663852886e38, 2 ** -126, -(2 ** -126), 2 ** -149, 1, -1.5];

/** Random doubles: raw bit patterns, moderate magnitudes, and near-equal pairs for cancellation. */
function doublePairs(seed: number): [number, number][] {
  const next = prng(seed);
  const pairs: [number, number][] = [];
  for (const a of DOUBLE_SPECIALS) for (const b of DOUBLE_SPECIALS) pairs.push([a, b]);
  for (let i = 0; i < COUNT; i++) {
    const mode = i % 3;
    if (mode === 0) pairs.push([double(next(), next()), double(next(), next())]);
    else {
      const a = (next() / 2 ** 32 - 0.5) * 2 ** ((next() % 81) - 40);
      const b = mode === 1 ? (next() / 2 ** 32 - 0.5) * 2 ** ((next() % 81) - 40) : a * (1 + (next() / 2 ** 32 - 0.5) * 2 ** -((next() % 50) + 1));
      pairs.push([a, b]);
    }
  }
  return pairs;
}

function floatPairs(seed: number): [number, number][] {
  const next = prng(seed);
  const pairs: [number, number][] = [];
  for (const a of FLOAT_SPECIALS) for (const b of FLOAT_SPECIALS) pairs.push([a, b]);
  for (let i = 0; i < COUNT; i++) {
    const mode = i % 3;
    if (mode === 0) pairs.push([float(next()), float(next())]);
    else {
      const a = Math.fround((next() / 2 ** 32 - 0.5) * 2 ** ((next() % 61) - 30));
      const b = mode === 1 ? Math.fround((next() / 2 ** 32 - 0.5) * 2 ** ((next() % 61) - 30)) : Math.fround(a * (1 + (next() / 2 ** 32 - 0.5) * 2 ** -((next() % 30) + 1)));
      pairs.push([a, b]);
    }
  }
  return pairs;
}

/** Collects mismatches instead of failing on the first, so a report shows the pattern. */
function check(name: string, cases: number, mismatches: string[]): void {
  expect(mismatches.slice(0, 10), `${name}: ${mismatches.length} of ${cases} differ`).toEqual([]);
}

const sameDouble = (lo: number, hi: number, expected: number): boolean => {
  const got = double(lo, hi);
  if (expected !== expected) return got !== got;
  const [elo, ehi] = words(expected);
  return lo === elo && hi === ehi;
};
const sameFloat = (bits: number, expected: number): boolean => (expected !== expected ? float(bits) !== float(bits) : bits === floatBits(expected));
const hexDouble = (d: number): string => {
  const [lo, hi] = words(d);
  return `${hi.toString(16).padStart(8, '0')}${lo.toString(16).padStart(8, '0')}`;
};

describe('ROM libgcc against IEEE and BigInt', () => {
  const binaryDouble: [string, (a: number, b: number) => number][] = [
    ['__adddf3', (a, b) => a + b],
    ['__subdf3', (a, b) => a - b],
    ['__muldf3', (a, b) => a * b],
    ['__divdf3', (a, b) => a / b],
  ];
  binaryDouble.forEach(([name, op], index) => {
    it(`${name}: bit-identical to float64`, () => {
      const pairs = doublePairs(100 + index);
      const bad: string[] = [];
      for (const [a, b] of pairs) {
        const [lo, hi] = call(name, [...words(a), ...words(b)]);
        if (!sameDouble(lo, hi, op(a, b))) bad.push(`${hexDouble(a)} ${hexDouble(b)} → ${hexDouble(double(lo, hi))}, expected ${hexDouble(op(a, b))}`);
      }
      check(name, pairs.length, bad);
    }, 60_000);
  });

  it('__eqdf2, __ltdf2, __gedf2: the comparisons C makes of them', () => {
    const pairs = doublePairs(200);
    pairs.push(...pairs.slice(0, 200).map(([a]): [number, number] => [a, a])); // equal operands
    const bad: string[] = [];
    for (const [a, b] of pairs) {
      const args = [...words(a), ...words(b)];
      const eq = call('__eqdf2', args)[0] | 0;
      const lt = call('__ltdf2', args)[0] | 0;
      const ge = call('__gedf2', args)[0] | 0;
      if ((eq === 0) !== (a === b) || lt < 0 !== a < b || ge >= 0 !== a >= b) bad.push(`${a} ${b}: eq ${eq} lt ${lt} ge ${ge}`);
    }
    check('compare', pairs.length, bad);
  }, 60_000);

  it('__fixdfsi, __fixunsdfsi, __truncdfsf2 from doubles', () => {
    const values = doublePairs(300).flatMap(([a, b]) => [a, b, a * 2 ** 20]);
    const bad: string[] = [];
    for (const d of values) {
      const [lo, hi] = words(d);
      const t = Math.trunc(d);
      if (t >= -(2 ** 31) && t < 2 ** 31) {
        const got = call('__fixdfsi', [lo, hi])[0] | 0;
        if (got !== (t | 0)) bad.push(`__fixdfsi ${d} → ${got}`);
      }
      if (t > -1 && t < 2 ** 32) {
        const got = call('__fixunsdfsi', [lo, hi])[0] >>> 0;
        if (got !== t + 0) bad.push(`__fixunsdfsi ${d} → ${got}`);
      }
      const r = call('__truncdfsf2', [lo, hi])[0];
      if (!sameFloat(r, Math.fround(d))) bad.push(`__truncdfsf2 ${hexDouble(d)} → ${r.toString(16)}`);
    }
    check('double conversions', values.length, bad);
  }, 60_000);

  it('__floatsidf, __floatunsidf, __extendsfdf2, __fixsfsi, __floatsisf', () => {
    const next = prng(400);
    const ints = [0, 1, -1, 0x7fffffff, -0x80000000, 0x80000000, 0xffffffff, 0x01000001, 0x7fffff80, -0x7fffffc0];
    for (let i = 0; i < COUNT; i++) ints.push(i % 2 === 0 ? next() : next() >>> (next() % 32));
    const bad: string[] = [];
    for (const n of ints) {
      const [lo, hi] = call('__floatsidf', [n]);
      if (!sameDouble(lo, hi, n | 0)) bad.push(`__floatsidf ${n | 0}`);
      const [ulo, uhi] = call('__floatunsidf', [n]);
      if (!sameDouble(ulo, uhi, n >>> 0)) bad.push(`__floatunsidf ${n >>> 0}`);
      const f = call('__floatsisf', [n])[0];
      if (!sameFloat(f, Math.fround(n | 0))) bad.push(`__floatsisf ${n | 0} → ${f.toString(16)}`);
    }
    for (const [a, b] of floatPairs(401)) {
      for (const v of [a, b]) {
        const [lo, hi] = call('__extendsfdf2', [floatBits(v)]);
        if (!sameDouble(lo, hi, v)) bad.push(`__extendsfdf2 ${v}`);
        const t = Math.trunc(v);
        if (t >= -(2 ** 31) && t < 2 ** 31) {
          const got = call('__fixsfsi', [floatBits(v)])[0] | 0;
          if (got !== (t | 0)) bad.push(`__fixsfsi ${v} → ${got}`);
        }
      }
    }
    check('int/float conversions', ints.length, bad);
  }, 60_000);

  const binaryFloat: [string, (a: number, b: number) => number][] = [
    ['__addsf3', (a, b) => Math.fround(a + b)],
    ['__subsf3', (a, b) => Math.fround(a - b)],
    ['__mulsf3', (a, b) => Math.fround(a * b)],
  ];
  binaryFloat.forEach(([name, op], index) => {
    it(`${name}: bit-identical to Math.fround`, () => {
      const pairs = floatPairs(500 + index);
      const bad: string[] = [];
      for (const [a, b] of pairs) {
        const r = call(name, [floatBits(a), floatBits(b)])[0];
        if (!sameFloat(r, op(a, b))) bad.push(`${floatBits(a).toString(16)} ${floatBits(b).toString(16)} → ${r.toString(16)}, expected ${floatBits(op(a, b)).toString(16)}`);
      }
      check(name, pairs.length, bad);
    }, 60_000);
  });

  it('64-bit integer routines against BigInt', () => {
    const next = prng(600);
    const M = 2n ** 64n;
    const s64 = (v: bigint): bigint => BigInt.asIntN(64, v);
    const u64 = (v: bigint): bigint => BigInt.asUintN(64, v);
    const pack = (v: bigint): [number, number] => [Number(u64(v) & 0xffffffffn), Number(u64(v) >> 32n)];
    const unpack = (lo: number, hi: number): bigint => (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0);
    const random64 = (): bigint => {
      const v = (BigInt(next()) << 32n) | BigInt(next());
      return next() % 4 === 0 ? v >> BigInt(next() % 64) : v; // also small magnitudes
    };
    const edge = [0n, 1n, M - 1n, 1n << 63n, (1n << 63n) - 1n, 0xffffffffn, 1n << 32n];
    const pairs: [bigint, bigint][] = [];
    for (const a of edge) for (const b of edge) pairs.push([a, b]);
    for (let i = 0; i < COUNT; i++) pairs.push([random64(), random64()]);
    const bad: string[] = [];
    for (const [a, b] of pairs) {
      const args = [...pack(a), ...pack(b)];
      const result = (name: string): bigint => {
        const [lo, hi] = call(name, args);
        return unpack(lo, hi);
      };
      if (result('__muldi3') !== u64(a * b)) bad.push(`__muldi3 ${a} ${b}`);
      if (b !== 0n) {
        if (result('__udivdi3') !== a / b) bad.push(`__udivdi3 ${a} ${b}`);
        if (result('__umoddi3') !== a % b) bad.push(`__umoddi3 ${a} ${b}`);
        const sa = s64(a);
        const sb = s64(b);
        if (!(sa === -(1n << 63n) && sb === -1n)) {
          if (result('__divdi3') !== u64(sa / sb)) bad.push(`__divdi3 ${sa} ${sb}`);
          if (result('__moddi3') !== u64(sa % sb)) bad.push(`__moddi3 ${sa} ${sb}`);
        }
      }
      const n = Number(b & 63n);
      const shiftArgs = [...pack(a), n];
      const shift = (name: string): bigint => {
        const [lo, hi] = call(name, shiftArgs);
        return unpack(lo, hi);
      };
      if (shift('__ashldi3') !== u64(a << BigInt(n))) bad.push(`__ashldi3 ${a} ${n}`);
      if (shift('__lshrdi3') !== a >> BigInt(n)) bad.push(`__lshrdi3 ${a} ${n}`);
      if (shift('__ashrdi3') !== u64(s64(a) >> BigInt(n))) bad.push(`__ashrdi3 ${a} ${n}`);
    }
    check('64-bit integers', pairs.length, bad);
  }, 60_000);

  it('the calls went through the ROM window vectors (overflows and underflows of every size the chain makes)', () => {
    // Counted at fetch(), which the predecode cache doesn't call per instruction: this call runs without it.
    machine.core.predecode = false;
    call('__adddf3', [...words(1), ...words(2)]);
    machine.core.predecode = true;
    const at = (offset: number): number => windowVectors.get(0x40000000 + offset) ?? 0;
    expect(at(0x80)).toBeGreaterThan(0); // _WindowOverflow8
    expect(at(0xc0)).toBeGreaterThan(0); // _WindowUnderflow8
    expect(machine.core.windowBase).toBe(0);
    expect(machine.core.windowStart).toBe(1);
  });
});
