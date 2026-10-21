import { describe, expect, it } from 'vitest';
import { f32Bits, f32Value, f64Value, f64Words, FP, runFloatFunction } from './float.ts';

// The bootrom's floating point rules (RP2040 datasheet §2.8.3.2.1 and tables 169/170): correct
// rounding of the basic operations, denormals in and out as zero, NaNs in as infinities and out
// as infinities, conversions to integers rounding toward −∞ and clamping.

function single(offset: number, ...args: number[]): Uint32Array {
  const r = Uint32Array.from([0, 0, 0, 0]);
  args.forEach((a, i) => (r[i] = a >>> 0));
  expect(runFloatFunction(offset, true, r)).toBe(true);
  return r;
}

function double(offset: number, a: number, b = 0, extra?: number): Uint32Array {
  const r = Uint32Array.from([...f64Words(a), ...f64Words(b)]);
  if (extra !== undefined) r[2] = extra >>> 0;
  expect(runFloatFunction(offset, false, r)).toBe(true);
  return r;
}

const F = (x: number): number => f32Bits(x);
const D = (r: Uint32Array): number => f64Value(r[0], r[1]);

describe('the soft float table', () => {
  it('basic operations round correctly (to nearest, ties to even)', () => {
    expect(f32Value(single(FP.ADD, F(1), F(2 ** -24))[0])).toBe(1); // a tie: rounds to even
    expect(f32Value(single(FP.ADD, F(1), F(2 ** -24 + 2 ** -40))[0])).toBe(1 + 2 ** -23); // past the tie
    expect(f32Value(single(FP.DIV, F(1), F(3))[0])).toBe(Math.fround(1 / 3));
    expect(f32Value(single(FP.MUL, F(1.1), F(1.1))[0])).toBe(Math.fround(Math.fround(1.1) * Math.fround(1.1)));
    expect(single(FP.SQRT, F(-4))[0]).toBe(0xff800000); // −∞ for a negative
  });

  it('treats denormal inputs as zero and flushes denormal results', () => {
    const denormal = 0x00000001;
    expect(single(FP.ADD, denormal, F(1))[0]).toBe(F(1));
    expect(single(FP.MUL, F(2 ** -100), F(2 ** -40))[0]).toBe(0); // 2^-140 is denormal: flushed
    expect(single(FP.MUL, F(-(2 ** -100)), F(2 ** -40))[0]).toBe(0x80000000); // signed zero
  });

  it('treats NaN inputs as infinities and renders NaN results as infinities', () => {
    expect(single(FP.ADD, 0x7fc00000, F(1))[0]).toBe(0x7f800000); // NaN in: +∞ + 1
    expect(single(FP.ADD, 0xffc00000, F(1))[0]).toBe(0xff800000); // a negative NaN: −∞
    expect(single(FP.SUB, 0x7f800000, 0x7f800000)[0]).toBe(0x7f800000); // ∞ − ∞ = NaN → ∞
    expect(single(FP.CMP, 0x7fc00000, F(1e30))[0]).toBe(1); // NaN compares as +∞
  });

  it('converts to integers rounding toward −∞, clamping', () => {
    expect(single(FP.TO_INT, F(-2.5))[0] | 0).toBe(-3);
    expect(single(FP.TO_INT, F(3e9))[0] | 0).toBe(0x7fffffff);
    expect(single(FP.TO_INT, F(-3e9))[0] | 0).toBe(-0x80000000);
    expect(single(FP.TO_FIX, F(0.5), 16)[0]).toBe(0x8000);
    expect(single(FP.TO_UINT, F(-0.5))[0]).toBe(0);
    expect(single(FP.TO_UFIX, F(1e10), 4)[0]).toBe(0xffffffff);
  });

  it('converts integers and fixed point to the nearest float', () => {
    expect(f32Value(single(FP.FROM_INT, -7)[0])).toBe(-7);
    expect(f32Value(single(FP.FROM_UINT, 0xffffffff)[0])).toBe(4294967296); // rounds up
    expect(f32Value(single(FP.FROM_FIX, 0x8000, 16)[0])).toBe(0.5);
    expect(f32Value(single(FP.FROM_UFIX, 3, 1)[0])).toBe(1.5);
    // 2^53 + 1 doesn't fit a double: rounding the exact value (not a double) to single.
    expect(f32Value(single(FP.FROM_UINT64, 1, 0x00200000)[0])).toBe(2 ** 53);
    expect(f32Value(single(FP.FROM_INT64, 0xffffffff, 0xffffffff)[0])).toBe(-1);
    expect(f32Value(single(FP.FROM_FIX64, 0, 1, 32)[0])).toBe(1);
    // 2^24 + 1 + 2^-30-ish: 0x0100_0001 is a tie at 24 bits, 0x0100_0001_0 past it.
    expect(f32Value(single(FP.FROM_UINT64, 0x01000001, 0)[0])).toBe(16777216);
    expect(f32Value(single(FP.FROM_UFIX64, 0x10000010, 0, 4)[0])).toBe(Math.fround(0x10000010 / 16));
  });

  it('converts to 64-bit integers rounding toward −∞, clamping', () => {
    const r = single(FP.TO_INT64, F(-1.5));
    expect([r[0], r[1]]).toEqual([0xfffffffe, 0xffffffff]); // −2
    const big = single(FP.TO_UINT64, F(1e30));
    expect([big[0], big[1]]).toEqual([0xffffffff, 0xffffffff]);
    const fix = single(FP.TO_FIX64, F(0.25), 40);
    expect([fix[0], fix[1]]).toEqual([0, 0x40]); // 2^38
  });

  it('returns sine and cosine together from fsin (r0, r1) and fsincos', () => {
    for (const offset of [FP.SIN, FP.SINCOS]) {
      const r = single(offset, F(0.5));
      expect(f32Value(r[0])).toBe(Math.fround(Math.sin(Math.fround(0.5))));
      expect(f32Value(r[1])).toBe(Math.fround(Math.cos(Math.fround(0.5))));
    }
    expect(single(FP.LN, F(-1))[0]).toBe(0xff800000);
    expect(f32Value(single(FP.ATAN2, F(1), F(-1))[0])).toBe(Math.fround(Math.atan2(1, -1)));
    expect(f64Value(...(single(FP.CONVERT, F(0.1)).slice(0, 2) as unknown as [number, number]))).toBe(Math.fround(0.1));
  });

  it('has no functions at the deprecated offsets', () => {
    expect(runFloatFunction(0x10, true, new Uint32Array(4))).toBe(false);
    expect(runFloatFunction(0x14, false, new Uint32Array(4))).toBe(false);
  });
});

describe('the soft double table', () => {
  it('computes in double precision with the same rules', () => {
    expect(D(double(FP.ADD, 0.1, 0.2))).toBe(0.1 + 0.2);
    expect(D(double(FP.DIV, 1, 0))).toBe(Infinity);
    expect(D(double(FP.SUB, Infinity, Infinity))).toBe(Infinity); // NaN out → ∞
    expect(D(double(FP.MUL, 1e-300, 1e-10))).toBe(0); // denormal out → 0
    expect(double(FP.TO_INT, -0.5)[0] | 0).toBe(-1);
    expect(double(FP.TO_FIX, 0.5, 0, 16)[0]).toBe(0x8000);
    const r = double(FP.SIN, 0.25);
    expect(f64Value(r[0], r[1])).toBe(Math.sin(0.25));
    expect(f64Value(r[2], r[3])).toBe(Math.cos(0.25));
    expect(f32Value(double(FP.CONVERT, 1 / 3)[0])).toBe(Math.fround(1 / 3));
    const big = double(FP.TO_INT64, -(2 ** 51) - 0.5);
    expect([big[0], big[1]]).toEqual([0xffffffff, 0xfff7ffff]); // floor(−2^51 − 0.5) = −2^51 − 1
  });
});
