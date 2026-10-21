/**
 * The ESP32's single-precision FPU (coprocessor 0; core-isa.h XCHAL_HAVE_FP with DIV, RECIP,
 * SQRT and RSQRT step instructions, XCHAL_HAVE_DFPU_SINGLE_ONLY). f0–f15 are bits in
 * `core.f` (a Float32Array view `core.fv` for arithmetic), so MOV.S, LSI/SSI, RFR/WFR and the
 * conditional moves keep NaN payloads exactly. Every instruction here first checks CPENABLE
 * bit 0 and raises Coprocessor0Disabled (EXCCAUSE 32) with EPC1 at the instruction — FreeRTOS
 * switches FPU context lazily on that exception.
 *
 * Arithmetic rounds once, in the FCR rounding mode, through fp32.ts (exact in all four modes);
 * MADD.S, MSUB.S, MADDN.S and DIVN.S are fused. FSR collects the IEEE flags (sticky); the
 * enables in FCR are stored but never trap. A NaN operand propagates (the first one, quieted);
 * an invalid operation gives the default NaN 0x7FC00000; a signaling NaN operand raises Invalid.
 *
 * Divide and square root have no instruction: libgcc's __divsf3 and __ieee754_sqrtf run Newton
 * sequences of step instructions whose bit-level results the ISA RM leaves open. Benchtop's
 * definition (checked by running those libgcc routines against IEEE, fpu-libgcc tests):
 *   NEXP01.S  −(significand · 2^(E mod 2)): the operand scaled into [1, 4) with its exponent's
 *             parity kept, negated (zero, ∞ and NaN are just negated).
 *   DIV0.S    1 / |NEXP01.S| with the operand's sign, to float32 (hardware uses a short table;
 *             the sequence refines either). SQRT0.S 1 / √|NEXP01.S|. RECIP0.S 1 / x and
 *             RSQRT0.S 1 / √x at full scale. Non-finite or zero operands give ±1.0 (the
 *             adjust instructions decide those results).
 *   CONST.S   0 → +0.0, 1 → 1.0, 3 → 0.5 (the values libgcc's sequences need); other
 *             immediates fault, their constants being unknown.
 *   MADDN.S   fr + fs · ft, fused, rounded to nearest whatever FCR says, no flags.
 *   MKDADJ.S  fr ← the exponent adjustment of fs / fr: D = (Ea − Ea mod 2) − (Eb − Eb mod 2),
 *   MKSADJ.S  and of √fs: D = (E − E mod 2) / 2. For zero, ∞, NaN (and negative √) operands
 *             they compute the IEEE result R instead, raise DivZero/Invalid as IEEE does, and
 *             mark the register "special".
 *   ADDEXP.S  fr ← fr · 2^exponent(fs). ADDEXPM.S is the same here (hardware reads the
 *             adjustment from the mantissa field). A special fs makes fr special (carrying R).
 *   DIVN.S    fr ← fr + fs · ft, fused, in the FCR mode, with flags — or R when an operand is
 *             special.
 * The adjustment D can push a register past float32's exponent range (a quotient that will
 * underflow to a denormal, say). Such a register keeps its unscaled bits and the extra
 * exponent in `core.fx`, so DIVN.S still rounds the exact value once; anything else reading it
 * sees the value rounded to float32. Every other write clears `fx`.
 */

import type { XtensaCore } from '../cpu.ts';
import * as exc from '../exceptions.ts';
import * as fp from '../fp32.ts';
import * as isa from '../isa.ts';
import { SR, UR } from '../regs.ts';

const OP = isa.OP;
const SR_BR = SR.BR;
const SR_CPENABLE = SR.CPENABLE;
const UR_FCR = UR.FCR;
const UR_FSR = UR.FSR;
const CP0_DISABLED = exc.EXCCAUSE.COPROCESSOR_DISABLED;
const RM_NEAREST = fp.RM_NEAREST;
const FLAG_V = fp.FLAG_V;
const FLAG_Z = fp.FLAG_Z;
const FLAG_I = fp.FLAG_I;
const DEFAULT_NAN = fp.DEFAULT_NAN;
const bitsOf = fp.bitsOf;
const isNaNBits = fp.isNaNBits;
const isSignalingBits = fp.isSignalingBits;
const quiet = fp.quiet;

/** `fx` value of a register that carries a divide/sqrt special result. */
export const FX_SPECIAL = -32768;
/** The adjustment range that keeps every DIVN.S product exact in float64. */
const MAX_ADJUST = 200;

const ONE = 0x3f800000;
const CONST_BITS = [0, ONE, -1, 0x3f000000, -1, -1, -1, -1];

/** Is CPENABLE bit 0 (the FPU) set? */
export function fpuEnabled(core: XtensaCore): boolean {
  return (core.sr[SR_CPENABLE] & 1) !== 0;
}

/** The value of f`n` as float32 (an extra exponent is applied and rounded). */
function value(core: XtensaCore, n: number): number {
  const x = core.fx[n];
  if (x === 0 || x === FX_SPECIAL) return core.fv[n];
  return Math.fround(core.fv[n] * 2 ** x);
}

/** The exact value of f`n`: its bits times 2^fx (DIVN.S and the adjust instructions). */
function exact(core: XtensaCore, n: number): number {
  const x = core.fx[n];
  return x === 0 || x === FX_SPECIAL ? core.fv[n] : core.fv[n] * 2 ** x;
}

/** The bits of f`n` as a 32-bit register would hold them. */
function bits(core: XtensaCore, n: number): number {
  const x = core.fx[n];
  if (x === 0 || x === FX_SPECIAL) return core.f[n];
  return bitsOf(value(core, n));
}

function setBits(core: XtensaCore, n: number, b: number): void {
  core.f[n] = b;
  core.fx[n] = 0;
}

/** Writes an arithmetic result: a NaN result (∞ − ∞, 0 · ∞) is the default NaN. */
function setResult(core: XtensaCore, n: number, v: number): void {
  if (v !== v) core.f[n] = DEFAULT_NAN;
  else core.fv[n] = v;
  core.fx[n] = 0;
}

/**
 * NaN operands (registers a, b, c; −1 = unused): writes the first one, quieted, to f`dest` and
 * returns the flags (Invalid for a signaling NaN), or −1 when no operand is a NaN.
 */
function propagateNaN(core: XtensaCore, dest: number, a: number, b: number, c: number): number {
  let first = -1;
  let flags = 0;
  for (let i = 0; i < 3; i++) {
    const n = i === 0 ? a : i === 1 ? b : c;
    if (n < 0) continue;
    const v = bits(core, n);
    if (!isNaNBits(v)) continue;
    if (first < 0) first = v;
    if (isSignalingBits(v)) flags |= FLAG_V;
  }
  if (first < 0) return -1;
  setBits(core, dest, quiet(first));
  return flags;
}

function getBool(core: XtensaCore, n: number): boolean {
  return ((core.sr[SR_BR] >>> n) & 1) !== 0;
}

function setBool(core: XtensaCore, n: number, v: boolean): void {
  core.sr[SR_BR] = v ? core.sr[SR_BR] | (1 << n) : core.sr[SR_BR] & ~(1 << n);
}

/** float → integer with the instruction's rounding; saturates (NaN as +∞) and raises Invalid. */
function toInt(core: XtensaCore, v: number, how: number, unsigned: boolean): number {
  let i: number;
  if (v !== v) i = Number.POSITIVE_INFINITY;
  else if (how === 0) i = Math.trunc(v);
  else if (how === 1) i = Math.floor(v);
  else if (how === 2) i = Math.ceil(v);
  else {
    const fl = Math.floor(v);
    const diff = v - fl;
    i = diff > 0.5 || (diff === 0.5 && fl % 2 !== 0) ? fl + 1 : fl;
  }
  const lo = unsigned ? 0 : -2147483648;
  const hi = unsigned ? 4294967295 : 2147483647;
  if (i < lo || i > hi || v !== v) {
    core.ur[UR_FSR] |= FLAG_V;
    return (i < lo ? lo : hi) >>> 0;
  }
  return i >>> 0; // −0 → 0
}

/** Unbiased exponent of a finite nonzero f`n` (bits exponent + fx), or NaN otherwise. */
function exponentOf(core: XtensaCore, n: number): number {
  const b = core.f[n];
  if ((b & 0x7fffffff) === 0 || (b & 0x7f800000) === 0x7f800000) return Number.NaN;
  fp.decompose(b);
  const x = core.fx[n];
  return fp.decExp + (x === FX_SPECIAL ? 0 : x);
}

const clampAdjust = (d: number): number => (d > MAX_ADJUST ? MAX_ADJUST : d < -MAX_ADJUST ? -MAX_ADJUST : d);

/** f`n` ← 1.0 · 2^d: an adjustment register for ADDEXP.S/ADDEXPM.S. */
function setAdjust(core: XtensaCore, n: number, d: number): void {
  core.f[n] = ONE;
  core.fx[n] = clampAdjust(d);
}

/** f`n` ← special result R (IEEE value of the whole divide or square root). */
function setSpecial(core: XtensaCore, n: number, r: number): void {
  core.f[n] = r;
  core.fx[n] = FX_SPECIAL;
}

/** f`n` ← exact value v · 2^e, folded into the bits when that stays a normal float32. */
function setScaled(core: XtensaCore, n: number, v: number, e: number): void {
  const scaled = v * 2 ** e;
  const a = Math.abs(scaled);
  if (scaled === 0 || scaled !== scaled || (a >= 2 ** -126 && a <= fp.MAX_F32) || a === Number.POSITIVE_INFINITY) {
    core.fv[n] = scaled;
    core.fx[n] = 0;
    return;
  }
  core.fv[n] = v;
  core.fx[n] = clampAdjust(e);
}

/** `nexp01`: the significand scaled to [1, 4) keeping the exponent's parity, sign kept. */
function scaledSignificand(b: number): number {
  fp.decompose(b);
  const v = fp.decSig * ((fp.decExp & 1) !== 0 ? 2 : 1);
  return (b & 0x80000000) !== 0 ? -v : v;
}

const isFiniteNonzero = (b: number): boolean => (b & 0x7fffffff) !== 0 && (b & 0x7f800000) !== 0x7f800000;

/**
 * Executes FPU instruction `op` (fields r, s, t and the immediate from the decoder) at `pc`.
 * Returns false when it raised an exception (PC already redirected), true to continue with the
 * next instruction.
 */
export function executeFpu(core: XtensaCore, op: number, r: number, s: number, t: number, imm: number, pc: number): boolean {
  if ((core.sr[SR_CPENABLE] & 1) === 0) {
    core.raise(CP0_DISABLED, pc);
    return false;
  }
  const ar = core.ar;
  const wb = core.windowBase << 2;
  const mode = core.ur[UR_FCR] & 3;
  let flags = 0;
  switch (op) {
    // ── Arithmetic ─────────────────────────────────────────────────────────────────────
    case 4 /* OP.ADD_S */:
    case 351 /* OP.SUB_S */:
    case 149 /* OP.MUL_S */: {
      flags = propagateNaN(core, r, s, t, -1);
      if (flags >= 0) break;
      const a = value(core, s);
      const b = value(core, t);
      const v = op === OP.ADD_S ? fp.addF32(a, b, mode) : op === OP.SUB_S ? fp.addF32(a, -b, mode) : fp.mulF32(a, b, mode);
      flags = fp.lastFlags;
      setResult(core, r, v);
      break;
    }
    case 106 /* OP.MADD_S */:
    case 132 /* OP.MSUB_S */: {
      flags = propagateNaN(core, r, r, s, t);
      if (flags >= 0) break;
      const a = value(core, s);
      const v = fp.fmaF32(value(core, r), op === OP.MADD_S ? a : -a, value(core, t), mode);
      flags = fp.lastFlags;
      setResult(core, r, v);
      break;
    }
    case 107 /* OP.MADDN_S */: {
      if (propagateNaN(core, r, r, s, t) >= 0) break;
      setResult(core, r, fp.fmaF32(value(core, r), value(core, s), value(core, t), RM_NEAREST));
      break;
    }
    case 63 /* OP.DIVN_S */: {
      if (core.fx[r] === FX_SPECIAL) {
        core.fx[r] = 0; // R is already in fr
        break;
      }
      if (core.fx[t] === FX_SPECIAL) {
        setBits(core, r, core.f[t]);
        break;
      }
      flags = propagateNaN(core, r, r, s, t);
      if (flags >= 0) break;
      const p = exact(core, s) * exact(core, t); // exact: 24-bit significands, |adjust| ≤ 200
      const sum = fp.sumToOdd(exact(core, r), p, mode);
      if (sum !== sum) {
        flags = FLAG_V;
        setResult(core, r, sum);
        break;
      }
      setResult(core, r, fp.roundF32(sum, mode));
      flags = fp.lastFlags;
      break;
    }

    // ── Conversions ────────────────────────────────────────────────────────────────────
    case 79 /* OP.FLOAT_S */:
    case 358 /* OP.UFLOAT_S */: {
      const n = op === OP.FLOAT_S ? ar[(wb + s) & 63] | 0 : ar[(wb + s) & 63];
      setResult(core, r, fp.roundF32(n * 2 ** -imm, mode)); // exact in float64
      flags = fp.lastFlags;
      break;
    }
    case 356 /* OP.TRUNC_S */:
    case 366 /* OP.UTRUNC_S */:
    case 80 /* OP.FLOOR_S */:
    case 58 /* OP.CEIL_S */:
    case 243 /* OP.ROUND_S */: {
      const v = value(core, s) * 2 ** imm;
      const how = op === OP.FLOOR_S ? 1 : op === OP.CEIL_S ? 2 : op === OP.ROUND_S ? 3 : 0;
      ar[(wb + r) & 63] = toInt(core, v, how, op === OP.UTRUNC_S);
      if (isSignalingBits(bits(core, s))) flags = FLAG_V;
      break;
    }

    // ── Moves, signs, constants ────────────────────────────────────────────────────────
    case 116 /* OP.MOV_S */:
      core.f[r] = core.f[s];
      core.fx[r] = core.fx[s];
      break;
    case 1 /* OP.ABS_S */:
      setBits(core, r, (bits(core, s) & 0x7fffffff) >>> 0);
      break;
    case 204 /* OP.NEG_S */:
      setBits(core, r, (bits(core, s) ^ 0x80000000) >>> 0);
      break;
    case 61 /* OP.CONST_S */: {
      const c = CONST_BITS[imm & 7];
      if (c < 0) {
        core.fault(`unimplemented: const.s ${imm} (value unknown)`);
        return false;
      }
      setBits(core, r, c);
      break;
    }
    case 237 /* OP.RFR */:
      ar[(wb + r) & 63] = bits(core, s);
      break;
    case 371 /* OP.WFR */:
      setBits(core, r, ar[(wb + s) & 63]);
      break;
    case 118 /* OP.MOVEQZ_S */:
    case 128 /* OP.MOVNEZ_S */:
    case 126 /* OP.MOVLTZ_S */:
    case 122 /* OP.MOVGEZ_S */: {
      const v = ar[(wb + t) & 63] | 0;
      const take = op === OP.MOVEQZ_S ? v === 0 : op === OP.MOVNEZ_S ? v !== 0 : op === OP.MOVLTZ_S ? v < 0 : v >= 0;
      if (take) {
        core.f[r] = core.f[s];
        core.fx[r] = core.fx[s];
      }
      break;
    }
    case 131 /* OP.MOVT_S */:
    case 120 /* OP.MOVF_S */:
      if (getBool(core, t) === (op === OP.MOVT_S)) {
        core.f[r] = core.f[s];
        core.fx[r] = core.fx[s];
      }
      break;

    // ── Compares into booleans ─────────────────────────────────────────────────────────
    case 365 /* OP.UN_S */:
    case 210 /* OP.OEQ_S */:
    case 357 /* OP.UEQ_S */:
    case 212 /* OP.OLT_S */:
    case 360 /* OP.ULT_S */:
    case 211 /* OP.OLE_S */:
    case 359 /* OP.ULE_S */: {
      const bs = bits(core, s);
      const bt = bits(core, t);
      const unordered = isNaNBits(bs) || isNaNBits(bt);
      const a = value(core, s);
      const b = value(core, t);
      let v: boolean;
      if (op === OP.UN_S) v = unordered;
      else if (op === OP.OEQ_S) v = a === b;
      else if (op === OP.UEQ_S) v = unordered || a === b;
      else if (op === OP.OLT_S) v = a < b;
      else if (op === OP.ULT_S) v = unordered || a < b;
      else if (op === OP.OLE_S) v = a <= b;
      else v = unordered || a <= b;
      setBool(core, r, v);
      // Ordered less-than comparisons signal on any NaN, the rest only on signaling NaNs.
      if ((op === OP.OLT_S || op === OP.OLE_S) && unordered) flags = FLAG_V;
      else if (isSignalingBits(bs) || isSignalingBits(bt)) flags = FLAG_V;
      break;
    }

    // ── Loads and stores ───────────────────────────────────────────────────────────────
    case 102 /* OP.LSI */:
      setBits(core, t, core.bus.read32((ar[(wb + s) & 63] + imm) >>> 0));
      break;
    case 103 /* OP.LSIP */: {
      const base = ar[(wb + s) & 63];
      setBits(core, t, core.bus.read32(base));
      ar[(wb + s) & 63] = base + imm;
      break;
    }
    case 104 /* OP.LSX */:
      setBits(core, r, core.bus.read32((ar[(wb + s) & 63] + ar[(wb + t) & 63]) >>> 0));
      break;
    case 105 /* OP.LSXP */: {
      const base = ar[(wb + s) & 63];
      setBits(core, r, core.bus.read32(base));
      ar[(wb + s) & 63] = base + ar[(wb + t) & 63];
      break;
    }
    case 344 /* OP.SSI */:
      core.bus.write32((ar[(wb + s) & 63] + imm) >>> 0, bits(core, t));
      break;
    case 345 /* OP.SSIP */: {
      const base = ar[(wb + s) & 63];
      core.bus.write32(base, bits(core, t));
      ar[(wb + s) & 63] = base + imm;
      break;
    }
    case 348 /* OP.SSX */:
      core.bus.write32((ar[(wb + s) & 63] + ar[(wb + t) & 63]) >>> 0, bits(core, r));
      break;
    case 349 /* OP.SSXP */: {
      const base = ar[(wb + s) & 63];
      core.bus.write32(base, bits(core, r));
      ar[(wb + s) & 63] = base + ar[(wb + t) & 63];
      break;
    }

    // ── Divide and square-root steps (see the header) ──────────────────────────────────
    case 205 /* OP.NEXP01_S */: {
      const b = bits(core, s);
      if (isFiniteNonzero(b)) setResult(core, r, -scaledSignificand(b));
      else setBits(core, r, isNaNBits(b) ? b : (b ^ 0x80000000) >>> 0);
      break;
    }
    case 62 /* OP.DIV0_S */:
    case 335 /* OP.SQRT0_S */:
    case 223 /* OP.RECIP0_S */:
    case 245 /* OP.RSQRT0_S */: {
      const b = bits(core, s);
      const sign = (b & 0x80000000) !== 0 ? -1 : 1;
      let v = sign;
      if (isFiniteNonzero(b)) {
        if (op === OP.DIV0_S) v = 1 / scaledSignificand(b);
        else if (op === OP.SQRT0_S) v = 1 / Math.sqrt(Math.abs(scaledSignificand(b)));
        else if (op === OP.RECIP0_S) v = 1 / value(core, s);
        else v = 1 / Math.sqrt(Math.abs(value(core, s)));
      }
      setResult(core, r, Math.fround(v));
      break;
    }
    case 113 /* OP.MKDADJ_S */: {
      const bb = bits(core, r); // divisor
      const ba = bits(core, s); // dividend
      if (isFiniteNonzero(ba) && isFiniteNonzero(bb)) {
        fp.decompose(ba);
        const ea = fp.decExp;
        fp.decompose(bb);
        const eb = fp.decExp;
        setAdjust(core, r, ea - (ea & 1) - (eb - (eb & 1)));
        break;
      }
      const a = fp.fromBits(ba);
      const b = fp.fromBits(bb);
      if (isNaNBits(ba) || isNaNBits(bb)) {
        if (isSignalingBits(ba) || isSignalingBits(bb)) flags = FLAG_V;
        setSpecial(core, r, quiet(isNaNBits(ba) ? ba : bb));
      } else if ((a === 0 && b === 0) || (a !== 0 && b !== 0 && !Number.isFinite(a) && !Number.isFinite(b))) {
        flags = FLAG_V;
        setSpecial(core, r, DEFAULT_NAN);
      } else {
        if (b === 0 && Number.isFinite(a)) flags = FLAG_Z; // finite nonzero / 0 (∞ / 0 is exact)
        setSpecial(core, r, bitsOf(a / b)); // ±0 or ±∞, exact
      }
      break;
    }
    case 114 /* OP.MKSADJ_S */: {
      const ba = bits(core, s);
      if (isFiniteNonzero(ba) && (ba & 0x80000000) === 0) {
        fp.decompose(ba);
        setAdjust(core, r, (fp.decExp - (fp.decExp & 1)) / 2);
        break;
      }
      if (isNaNBits(ba)) {
        if (isSignalingBits(ba)) flags = FLAG_V;
        setSpecial(core, r, quiet(ba));
      } else if ((ba & 0x7fffffff) === 0 || ba === 0x7f800000) {
        setSpecial(core, r, ba); // √±0 = ±0, √+∞ = +∞
      } else {
        flags = FLAG_V; // negative
        setSpecial(core, r, DEFAULT_NAN);
      }
      break;
    }
    case 5 /* OP.ADDEXP_S */:
    case 6 /* OP.ADDEXPM_S */: {
      if (core.fx[s] === FX_SPECIAL) {
        setSpecial(core, r, core.f[s]);
        break;
      }
      if (core.fx[r] === FX_SPECIAL) break;
      const e = exponentOf(core, s);
      if (e !== e) {
        setResult(core, r, value(core, r)); // a zero, ∞ or NaN adjustment: leave fr's value
        break;
      }
      const base = core.fx[r];
      setScaled(core, r, core.fv[r], base + e);
      break;
    }
    default:
      core.fault(`unimplemented: ${isa.OPS[op].name}`);
      return false;
  }
  if (flags > 0) core.ur[UR_FSR] |= flags;
  return true;
}

/** Inexact etc. are the flags; re-exported for tests. */
export const FSR_FLAGS = { I: FLAG_I, U: fp.FLAG_U, O: fp.FLAG_O, Z: FLAG_Z, V: FLAG_V } as const;
