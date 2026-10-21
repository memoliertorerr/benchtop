/**
 * IEEE-754 single precision for the Xtensa FPU, computed in float64 and rounded once, in all
 * four FCR rounding modes, with the FSR flags — no BigInt, no allocation.
 *
 * The rounding argument: a float64 value that is either exact or rounded to odd at 53 bits
 * carries enough information to round correctly to any precision of at most 51 bits, so float32
 * results are correct in every mode (Boldo & Melquiond, "Emulation of FMA and correctly rounded
 * sums: proved algorithms using rounding to odd"). Products of two float32 values are exact in
 * float64 (48 bits); sums go through TwoSum and are then rounded to odd; fused multiply-adds are
 * a product (exact) plus a sum.
 *
 * Flags follow the FSR layout (bit 7 Inexact, 8 Underflow, 9 Overflow, 10 DivZero, 11 Invalid).
 * Underflow is tininess before rounding (|exact| < 2^−126) together with inexactness.
 */

export const RM_NEAREST = 0;
export const RM_ZERO = 1;
export const RM_UP = 2;
export const RM_DOWN = 3;

export const FLAG_I = 0x80;
export const FLAG_U = 0x100;
export const FLAG_O = 0x200;
export const FLAG_Z = 0x400;
export const FLAG_V = 0x800;

export const MAX_F32 = 3.4028234663852886e38;
const TWO_128 = 2 ** 128;
const MIN_NORMAL = 2 ** -126;
/** The default quiet NaN an invalid operation produces. */
export const DEFAULT_NAN = 0x7fc00000;

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
const f64 = new Float64Array(1);
const w64 = new Uint32Array(f64.buffer); // [low, high] on little-endian hosts (all JS engines in use)

/** The bits of a float32 value. */
export function bitsOf(v: number): number {
  f32[0] = v;
  return u32[0];
}

/** The float32 value of some bits (NaN payloads don't survive a JS number: move bits instead). */
export function fromBits(bits: number): number {
  u32[0] = bits;
  return f32[0];
}

export const isNaNBits = (bits: number): boolean => (bits & 0x7fffffff) > 0x7f800000;
export const isSignalingBits = (bits: number): boolean => isNaNBits(bits) && (bits & 0x400000) === 0;
/** A NaN with its quiet bit set (payload kept). */
export const quiet = (bits: number): number => (bits | 0x400000) >>> 0;

/** The next float32 above v (v a float32 value, not NaN). */
export function nextUp(v: number): number {
  if (v === Number.POSITIVE_INFINITY) return v;
  if (v === 0) return 2 ** -149;
  const b = bitsOf(v);
  return fromBits(v > 0 ? b + 1 : b - 1);
}

export function nextDown(v: number): number {
  return -nextUp(-v);
}

/** One float32 step toward zero (v nonzero, may be infinite). */
function towardZero(v: number): number {
  if (v === Number.POSITIVE_INFINITY) return MAX_F32;
  if (v === Number.NEGATIVE_INFINITY) return -MAX_F32;
  return fromBits(bitsOf(v) - 1);
}

/** Flags raised by the last roundF32 / sum call. */
export let lastFlags = 0;

/**
 * Rounds `x` — exact, or rounded to odd at 53 bits — to float32 in `mode`, setting lastFlags
 * (I, U, O). x must not be NaN; ±0 and ±∞ pass through.
 */
export function roundF32(x: number, mode: number): number {
  let r = Math.fround(x);
  lastFlags = 0;
  if (r === x) return r; // exact (and ±0, ±∞)
  if (mode === RM_ZERO) {
    if (Math.abs(r) > Math.abs(x)) r = towardZero(r);
  } else if (mode === RM_UP) {
    if (r < x) r = nextUp(r);
  } else if (mode === RM_DOWN) {
    if (r > x) r = nextDown(r);
  }
  let flags = FLAG_I;
  const ax = Math.abs(x);
  if (ax > MAX_F32) {
    // Overflow when rounding with an unbounded exponent would pass MAX: the rounded result is
    // infinite, or the magnitude is already ≥ 2^128 (directed modes clamp to MAX).
    if (ax >= TWO_128 || r === Number.POSITIVE_INFINITY || r === Number.NEGATIVE_INFINITY) flags |= FLAG_O;
  } else if (ax < MIN_NORMAL) {
    flags |= FLAG_U;
  }
  lastFlags = flags;
  return r;
}

/** x moved one float64 ulp away from zero (x finite, nonzero). */
function awayFromZero64(x: number): number {
  f64[0] = x;
  const lo = w64[0];
  w64[0] = (lo + 1) >>> 0;
  if (w64[0] === 0) w64[1] = (w64[1] + 1) >>> 0;
  return f64[0];
}

/** x moved one float64 ulp toward zero (x finite, nonzero). */
function towardZero64(x: number): number {
  f64[0] = x;
  const lo = w64[0];
  w64[0] = (lo - 1) >>> 0;
  if (lo === 0) w64[1] = (w64[1] - 1) >>> 0;
  return f64[0];
}

/**
 * a + b (both float64, finite or not) rounded to odd at 53 bits; then roundF32 can round the
 * result once more without double-rounding error. Exact zero sums get IEEE's sign rule for `mode`.
 */
export function sumToOdd(a: number, b: number, mode: number): number {
  const s = a + b;
  if (s !== s || s === Number.POSITIVE_INFINITY || s === Number.NEGATIVE_INFINITY) return s;
  if (s === 0) {
    // Exact zero: −0 only for (−0) + (−0), or for opposite signs when rounding down.
    const negA = a === 0 ? 1 / a < 0 : a < 0;
    const negB = b === 0 ? 1 / b < 0 : b < 0;
    if (negA && negB) return -0;
    return mode === RM_DOWN && negA !== negB ? -0 : 0;
  }
  const bb = s - a;
  const err = a - (s - bb) + (b - bb);
  if (err === 0) return s;
  f64[0] = s;
  if ((w64[0] & 1) !== 0) return s; // already odd
  // The exact sum lies strictly between s and its neighbour on err's side: take the odd one.
  return (err > 0) === (s > 0) ? awayFromZero64(s) : towardZero64(s);
}

/** Float32 a + b in `mode`; sets lastFlags (including Invalid for ∞ − ∞). */
export function addF32(a: number, b: number, mode: number): number {
  if (a !== a || b !== b) {
    lastFlags = 0;
    return Number.NaN;
  }
  const s = sumToOdd(a, b, mode);
  if (s !== s) {
    lastFlags = FLAG_V;
    return s;
  }
  return roundF32(s, mode);
}

/** Float32 a × b in `mode`; Invalid for 0 × ∞. */
export function mulF32(a: number, b: number, mode: number): number {
  const p = a * b; // exact for float32 operands
  if (p !== p) {
    lastFlags = a !== a || b !== b ? 0 : FLAG_V;
    return p;
  }
  return roundF32(p, mode);
}

/** Float32 c + a × b with one rounding (fused) in `mode`; Invalid for 0 × ∞ and ∞ − ∞. */
export function fmaF32(c: number, a: number, b: number, mode: number): number {
  if (a !== a || b !== b || c !== c) {
    lastFlags = 0;
    return Number.NaN;
  }
  const p = a * b; // exact: 48 bits (or ±∞, or NaN for 0 × ∞)
  if (p !== p) {
    lastFlags = FLAG_V;
    return p;
  }
  const s = sumToOdd(c, p, mode);
  if (s !== s) {
    lastFlags = FLAG_V;
    return s;
  }
  return roundF32(s, mode);
}

/** Exponent and significand of a finite nonzero float32 (denormals normalized). */
export let decExp = 0;
export let decSig = 0;

/** Splits finite nonzero |v| into decSig ∈ [1, 2) and decExp with |v| = decSig · 2^decExp. */
export function decompose(bits: number): void {
  const e = (bits >>> 23) & 0xff;
  let m = bits & 0x7fffff;
  if (e !== 0) {
    decExp = e - 127;
    decSig = 1 + m / 0x800000;
    return;
  }
  // Denormal: shift the leading one up to bit 23.
  const shift = Math.clz32(m) - 8;
  m = (m << shift) & 0x7fffff;
  decExp = -126 - shift;
  decSig = 1 + m / 0x800000;
}
