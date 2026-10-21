/**
 * The bootrom's fast floating point library (RP2040 datasheet §2.8.3.2), computed in JS on the
 * functions' register arguments. The datasheet's rules (§2.8.3.2.1): IEEE single and double
 * formats; input denormals are treated as zero, input NaNs as infinities (of the NaN's sign),
 * output denormals are flushed to zero and output NaNs become infinities (+∞ here, the
 * datasheet giving no sign, except where it documents one: fsqrt/dsqrt of a negative and
 * fln/dln of v ≤ 0 return −∞); round to nearest, ties to even. The five basic operations are
 * correctly rounded (a double computation rounded once to single is: double has more than
 * 2·24 + 2 bits); the scientific functions use the host's Math (the ROM promises 1 ULP). Float
 * to integer conversions round toward −∞ and clamp; integer to float conversions round to
 * nearest even. Each table entry (§2.8.3.2.2, tables 169 and 170) is one ROM_FLOAT case.
 *
 * Arguments come in r0–r3 as raw bits (a double in r0:r1 low:high, a second double in r2:r3,
 * a 64-bit integer in r0:r1), results go to r0 (r0:r1 for doubles and 64-bit integers). fsin
 * also returns the cosine in r1 and dsin in r2:r3, as the V2/V3 ROM does (the SDK's sincosf
 * relies on it); offset 0x48 is V3's fsincos/dsincos.
 */

const f32 = new Float32Array(1);
const f32u = new Uint32Array(f32.buffer);
const f64 = new Float64Array(1);
const f64u = new Uint32Array(f64.buffer); // little-endian: [low word, high word]
const SMALLEST_NORMAL_F32 = 1.1754943508222875e-38;
const SMALLEST_NORMAL_F64 = 2.2250738585072014e-308;

/** A float argument: denormals → signed zero, NaN → infinity of its sign. */
export function floatArg(bits: number): number {
  const exponent = (bits >>> 23) & 0xff;
  const negative = (bits & 0x80000000) !== 0;
  if (exponent === 0) return negative ? -0 : 0;
  if (exponent === 0xff) return negative ? -Infinity : Infinity;
  f32u[0] = bits;
  return f32[0];
}

/** A float result's bits: rounded to single, denormals flushed to signed zero, NaN → +∞. */
export function floatBits(x: number): number {
  if (Number.isNaN(x)) return 0x7f800000;
  const r = Math.fround(x);
  if (r !== 0 && Math.abs(r) < SMALLEST_NORMAL_F32) return r < 0 ? 0x80000000 : 0;
  f32[0] = r;
  return f32u[0];
}

/** A double argument from (low, high) words, with the same input rules. */
export function doubleArg(lo: number, hi: number): number {
  const exponent = (hi >>> 20) & 0x7ff;
  const negative = (hi & 0x80000000) !== 0;
  if (exponent === 0) return negative ? -0 : 0;
  if (exponent === 0x7ff) return negative ? -Infinity : Infinity;
  f64u[0] = lo;
  f64u[1] = hi;
  return f64[0];
}

/** A double result's (low, high) words into `out`, denormals flushed, NaN → +∞. */
export function doubleBits(x: number, out: Uint32Array, at = 0): void {
  if (Number.isNaN(x)) x = Infinity;
  else if (x !== 0 && Math.abs(x) < SMALLEST_NORMAL_F64) x = x < 0 ? -0 : 0;
  f64[0] = x;
  out[at] = f64u[0];
  out[at + 1] = f64u[1];
}

/** floor(x), clamped to [lo, hi]. */
function floorClamp(x: number, lo: number, hi: number): number {
  if (x <= lo) return lo;
  if (x >= hi) return hi;
  return Math.floor(x);
}

/** A 64-bit value (low, high words) as a signed or unsigned BigInt. */
function int64(lo: number, hi: number, signed: boolean): bigint {
  const v = (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0);
  return signed ? BigInt.asIntN(64, v) : v;
}

/**
 * v × 2^−n rounded once to `bits` precision (24: single, 53: double): exact BigInt scaling,
 * then the rounding of the exact value (64-bit inputs exceed a double's 53 bits).
 */
function scaledToFloat(v: bigint, n: number, single: boolean): number {
  if (v === 0n) return 0;
  const negative = v < 0n;
  let m = negative ? -v : v;
  const precision = single ? 24 : 53;
  const width = m.toString(2).length;
  let exponent = -n;
  if (width > precision) {
    const shift = BigInt(width - precision);
    const rest = m & ((1n << shift) - 1n);
    const half = 1n << (shift - 1n);
    m >>= shift;
    exponent += width - precision;
    if (rest > half || (rest === half && (m & 1n) === 1n)) m += 1n;
  }
  // m now fits the precision (or is 2^precision after a carry): exact in a double.
  const value = Number(m) * 2 ** exponent;
  return negative ? -value : value;
}

/** A double's floor as a 64-bit integer clamped to the signed or unsigned range, into out[0..1]. */
function toInt64(x: number, signed: boolean, out: Uint32Array, at: number): void {
  const max = signed ? 9223372036854775807n : 18446744073709551615n;
  const min = signed ? -9223372036854775808n : 0n;
  let v: bigint;
  if (x === Infinity) v = max;
  else if (x === -Infinity) v = min;
  else {
    v = BigInt(Math.floor(x));
    if (v > max) v = max;
    if (v < min) v = min;
  }
  const u = BigInt.asUintN(64, v);
  out[at] = Number(u & 0xffffffffn);
  out[at + 1] = Number(u >> 32n);
}

/** Table offsets (tables 169 and 170): the same for both precisions. */
export const FP = {
  ADD: 0x00,
  SUB: 0x04,
  MUL: 0x08,
  DIV: 0x0c,
  SQRT: 0x18,
  TO_INT: 0x1c,
  TO_FIX: 0x20,
  TO_UINT: 0x24,
  TO_UFIX: 0x28,
  FROM_INT: 0x2c,
  FROM_FIX: 0x30,
  FROM_UINT: 0x34,
  FROM_UFIX: 0x38,
  COS: 0x3c,
  SIN: 0x40,
  TAN: 0x44,
  SINCOS: 0x48,
  EXP: 0x4c,
  LN: 0x50,
  CMP: 0x54,
  ATAN2: 0x58,
  FROM_INT64: 0x5c,
  FROM_FIX64: 0x60,
  FROM_UINT64: 0x64,
  FROM_UFIX64: 0x68,
  TO_INT64: 0x6c,
  TO_FIX64: 0x70,
  TO_UINT64: 0x74,
  TO_UFIX64: 0x78,
  /** float → double in the single table, double → float in the double table. */
  CONVERT: 0x7c,
} as const;

/** Offsets that hold a function in both tables (0x10, 0x14: deprecated, no entry). */
export const FP_OFFSETS: readonly number[] = Object.values(FP);

/**
 * Average cycles of each function on a V2/V3 ROM (tables 169, 170), charged as the call's
 * duration. Offset → [single, double].
 */
export const FP_CYCLES: Readonly<Record<number, readonly [number, number]>> = {
  0x00: [71, 91], 0x04: [74, 95], 0x08: [58, 155], 0x0c: [71, 183], 0x18: [63, 169],
  0x1c: [40, 75], 0x20: [39, 74], 0x24: [39, 63], 0x28: [38, 62], 0x2c: [55, 69], 0x30: [53, 68],
  0x34: [54, 64], 0x38: [52, 62], 0x3c: [587, 1617], 0x40: [577, 1618], 0x44: [653, 1891],
  0x48: [577, 1718], 0x4c: [524, 804], 0x50: [789, 428], 0x54: [25, 39], 0x58: [667, 2168],
  0x5c: [62, 55], 0x60: [60, 56], 0x64: [58, 50], 0x68: [57, 49], 0x6c: [54, 64], 0x70: [53, 63],
  0x74: [42, 53], 0x78: [41, 52], 0x7c: [15, 23],
};

/**
 * Runs the single-precision (`single`) or double-precision function at table `offset` on the
 * registers `r` (r0–r3, raw), writing the results back into `r`. Returns false for an offset
 * with no function. Integer inputs of 32 bits are exact in a double, so their conversions round
 * once (in floatBits/doubleBits); 64-bit ones go through scaledToFloat.
 */
export function runFloatFunction(offset: number, single: boolean, r: Uint32Array): boolean {
  const a = single ? floatArg(r[0]) : doubleArg(r[0], r[1]);
  const b = single ? floatArg(r[1]) : doubleArg(r[2], r[3]);
  // The fixed-point position n of the float → fixed conversions: r1 after a float, r2 after a double.
  const n = single ? r[1] | 0 : r[2] | 0;
  let x: number;
  switch (offset) {
    case FP.ADD:
      x = a + b;
      break;
    case FP.SUB:
      x = a - b;
      break;
    case FP.MUL:
      x = a * b;
      break;
    case FP.DIV:
      x = a / b;
      break;
    case FP.SQRT:
      x = a < 0 ? -Infinity : Math.sqrt(a);
      break;
    case FP.TO_INT:
      r[0] = floorClamp(a, -2147483648, 2147483647) >>> 0;
      return true;
    case FP.TO_FIX:
      r[0] = floorClamp(a * 2 ** n, -2147483648, 2147483647) >>> 0;
      return true;
    case FP.TO_UINT:
      r[0] = floorClamp(a, 0, 4294967295) >>> 0;
      return true;
    case FP.TO_UFIX:
      r[0] = floorClamp(a * 2 ** n, 0, 4294967295) >>> 0;
      return true;
    case FP.FROM_INT:
      x = r[0] | 0;
      break;
    case FP.FROM_FIX:
      x = (r[0] | 0) * 2 ** -(r[1] | 0);
      break;
    case FP.FROM_UINT:
      x = r[0] >>> 0;
      break;
    case FP.FROM_UFIX:
      x = (r[0] >>> 0) * 2 ** -(r[1] | 0);
      break;
    case FP.COS:
      x = Math.cos(a);
      break;
    case FP.SIN:
    case FP.SINCOS:
      if (single) {
        r[0] = floatBits(Math.sin(a));
        r[1] = floatBits(Math.cos(a));
      } else {
        const c = Math.cos(a);
        doubleBits(Math.sin(a), r, 0);
        doubleBits(c, r, 2);
      }
      return true;
    case FP.TAN:
      x = Math.tan(a);
      break;
    case FP.EXP:
      x = Math.exp(a);
      break;
    case FP.LN:
      x = a <= 0 ? -Infinity : Math.log(a);
      break;
    case FP.CMP:
      r[0] = (a === b ? 0 : a < b ? -1 : 1) >>> 0;
      return true;
    case FP.ATAN2:
      x = Math.atan2(a, b);
      break;
    case FP.FROM_INT64:
    case FP.FROM_FIX64:
    case FP.FROM_UINT64:
    case FP.FROM_UFIX64: {
      const signed = offset === FP.FROM_INT64 || offset === FP.FROM_FIX64;
      x = scaledToFloat(int64(r[0], r[1], signed), offset === FP.FROM_FIX64 || offset === FP.FROM_UFIX64 ? r[2] | 0 : 0, single);
      break;
    }
    case FP.TO_INT64:
    case FP.TO_FIX64:
    case FP.TO_UINT64:
    case FP.TO_UFIX64: {
      const signed = offset === FP.TO_INT64 || offset === FP.TO_FIX64;
      toInt64(a * 2 ** (offset === FP.TO_FIX64 || offset === FP.TO_UFIX64 ? n : 0), signed, r, 0);
      return true;
    }
    case FP.CONVERT:
      if (single) doubleBits(a, r, 0);
      else r[0] = floatBits(a);
      return true;
    default:
      return false;
  }
  if (single) r[0] = floatBits(x);
  else doubleBits(x, r, 0);
  return true;
}

/** The bits of a JS number as a float (tests). */
export function f32Bits(x: number): number {
  f32[0] = x;
  return f32u[0];
}

/** A float's bits as a JS number (tests). */
export function f32Value(bits: number): number {
  f32u[0] = bits;
  return f32[0];
}

/** A double's (low, high) words (tests). */
export function f64Words(x: number): [number, number] {
  f64[0] = x;
  return [f64u[0], f64u[1]];
}

/** The double in (low, high) words (tests). */
export function f64Value(lo: number, hi: number): number {
  f64u[0] = lo;
  f64u[1] = hi;
  return f64[0];
}
