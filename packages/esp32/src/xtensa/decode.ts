/**
 * Xtensa instruction decoding into a caller-owned descriptor — no object per instruction.
 * `decode(b0, b1, b2, out)` reads up to three bytes (little-endian, memory order) and writes:
 *   out[D_OP]   the OPS index (OP.*), or OP_INVALID
 *   out[D_LEN]  2 or 3 bytes — from op0, per tie.h XCHAL_OP0_FORMAT_LENGTHS: op0 0–7 → 3,
 *               8–0xD → 2, 0xE–0xF → 3 (also for an invalid word)
 *   out[D_R/S/T] the r, s and t fields (bits 12–15, 8–11, 4–7)
 *   out[D_IMM/IMM2] the immediates as the instruction uses them (sign-extended, scaled, mapped
 *               through B4CONST, …)
 *   out[D_OFF]  the raw PC-relative offset of a branch, jump, call, loop or l32r; `target()`
 *               turns it into an address.
 * Candidates are bucketed by op0/op1/op2 (24-bit) or op0 (16-bit) at module load and tried most
 * specific first.
 */

import * as isa from './isa.ts';

// Module constants, not imported bindings, in the hot path (vitest's transform makes each
// imported-name access a getter call).
const B4CONST = isa.B4CONST;
const B4CONSTU = isa.B4CONSTU;
const IMM = isa.IMM;
const OP_INVALID = isa.OP_INVALID;
const OPS = isa.OPS;

export const D_OP = 0;
export const D_LEN = 1;
export const D_R = 2;
export const D_S = 3;
export const D_T = 4;
export const D_IMM = 5;
export const D_IMM2 = 6;
export const D_OFF = 7;
export const DESCRIPTOR_SIZE = 8;

/** Bits of a 24-bit word that pick its bucket: op0, op1, op2. */
const KEY_MASK = 0xff000f;
const popcount = (n: number): number => {
  let c = 0;
  for (let v = n >>> 0; v !== 0; v &= v - 1) c++;
  return c;
};

function buildBuckets(): { wide: Int16Array[]; narrow: Int16Array[] } {
  const wide: number[][] = Array.from({ length: 4096 }, () => []);
  const narrow: number[][] = Array.from({ length: 16 }, () => []);
  OPS.forEach((op, index) => {
    if (op.length === 2) {
      narrow[op.match & 0xf].push(index);
      return;
    }
    for (let key = 0; key < 4096; key++) {
      const keyWord = (key & 0xf) | ((key & 0xf0) << 12) | ((key & 0xf00) << 12);
      if (((keyWord ^ op.match) & op.mask & KEY_MASK) === 0) wide[key].push(index);
    }
  });
  const order = (list: number[]): Int16Array => Int16Array.from(list.sort((a, b) => popcount(OPS[b].mask) - popcount(OPS[a].mask)));
  return { wide: wide.map(order), narrow: narrow.map(order) };
}

const BUCKETS = buildBuckets();
const MASKS = Int32Array.from(OPS, (op) => op.mask);
const MATCHES = Int32Array.from(OPS, (op) => op.match);
const IMMS = Uint8Array.from(OPS, (op) => op.imm);

/** Instruction length from the first byte (op0). */
export function lengthOf(b0: number): 2 | 3 {
  const op0 = b0 & 0xf;
  return op0 >= 8 && op0 <= 0xd ? 2 : 3;
}

const sext = (value: number, bits: number): number => (value << (32 - bits)) >> (32 - bits);

/** Decodes the instruction starting with b0 (b1, b2 follow in memory). */
export function decode(b0: number, b1: number, b2: number, out: Int32Array): void {
  const length = lengthOf(b0);
  const word = length === 2 ? b0 | (b1 << 8) : b0 | (b1 << 8) | (b2 << 16);
  const r = (word >> 12) & 0xf;
  const s = (word >> 8) & 0xf;
  const t = (word >> 4) & 0xf;
  out[D_LEN] = length;
  out[D_R] = r;
  out[D_S] = s;
  out[D_T] = t;
  out[D_IMM] = 0;
  out[D_IMM2] = 0;
  out[D_OFF] = 0;
  const bucket = length === 2 ? BUCKETS.narrow[b0 & 0xf] : BUCKETS.wide[(b0 & 0xf) | ((b2 & 0xff) << 4)];
  let op = OP_INVALID;
  for (let i = 0; i < bucket.length; i++) {
    const candidate = bucket[i];
    if ((word & MASKS[candidate]) === MATCHES[candidate]) {
      op = candidate;
      break;
    }
  }
  out[D_OP] = op;
  if (op === OP_INVALID) return;
  const imm8 = (word >>> 16) & 0xff;
  const op1 = (word >>> 16) & 0xf;
  const op2 = (word >>> 20) & 0xf;
  switch (IMMS[op]) {
    case IMM.NONE:
      break;
    case IMM.ADDI:
      out[D_IMM] = sext(imm8, 8);
      break;
    case IMM.ADDMI:
      out[D_IMM] = sext(imm8, 8) << 8;
      break;
    case IMM.MOVI:
      out[D_IMM] = sext((s << 8) | imm8, 12);
      break;
    case IMM.MOVIN: {
      const imm7 = ((t & 7) << 4) | r;
      out[D_IMM] = (imm7 & 0x60) === 0x60 ? imm7 - 128 : imm7;
      break;
    }
    case IMM.ADDIN:
      out[D_IMM] = t === 0 ? -1 : t;
      break;
    case IMM.OFF1:
      out[D_IMM] = imm8;
      break;
    case IMM.OFF2:
      out[D_IMM] = imm8 << 1;
      break;
    case IMM.OFF4:
      out[D_IMM] = imm8 << 2;
      break;
    case IMM.OFFN:
      out[D_IMM] = r << 2;
      break;
    case IMM.L32E:
      out[D_IMM] = (r << 2) - 64;
      break;
    case IMM.EXTUI:
      out[D_IMM] = s | ((op1 & 1) << 4);
      out[D_IMM2] = op2 + 1;
      break;
    case IMM.SLLI:
      out[D_IMM] = 32 - (t | ((op2 & 1) << 4));
      break;
    case IMM.SRAI:
      out[D_IMM] = s | ((op2 & 1) << 4);
      break;
    case IMM.SRLI:
      out[D_IMM] = s;
      break;
    case IMM.SSAI:
      out[D_IMM] = s | ((t & 1) << 4);
      break;
    case IMM.SEXT:
      out[D_IMM] = t + 7;
      break;
    case IMM.S:
      out[D_IMM] = s;
      break;
    case IMM.T:
      out[D_IMM] = t;
      break;
    case IMM.BREAK:
      out[D_IMM] = s;
      out[D_IMM2] = t;
      break;
    case IMM.ROTW:
      out[D_IMM] = sext(t, 4);
      break;
    case IMM.ENTRY:
      out[D_IMM] = (word >>> 12) << 3;
      break;
    case IMM.B4CONST:
      out[D_IMM] = B4CONST[r];
      out[D_OFF] = sext(imm8, 8);
      break;
    case IMM.B4CONSTU:
      out[D_IMM] = B4CONSTU[r];
      out[D_OFF] = sext(imm8, 8);
      break;
    case IMM.BBI:
      out[D_IMM] = t | ((r & 1) << 4);
      out[D_OFF] = sext(imm8, 8);
      break;
    case IMM.BR8:
      out[D_OFF] = sext(imm8, 8);
      break;
    case IMM.BR12:
      out[D_OFF] = sext(word >>> 12, 12);
      break;
    case IMM.LOOP:
      out[D_OFF] = imm8;
      break;
    case IMM.BRN:
      out[D_OFF] = r | ((t & 3) << 4);
      break;
    case IMM.J:
    case IMM.CALL:
      out[D_OFF] = sext(word >>> 6, 18);
      break;
    case IMM.L32R:
      out[D_OFF] = (0xffff0000 | (word >>> 8)) | 0;
      break;
    case IMM.F64C:
      out[D_IMM] = (r >> 1) & 3;
      out[D_IMM2] = r & 1;
      break;
    case IMM.OP2:
      out[D_IMM] = op2;
      break;
    case IMM.F64ITER:
      out[D_IMM] = op2 & 3;
      out[D_IMM2] = (op2 >> 2) & 1;
      break;
    case IMM.OP2B0:
      out[D_IMM] = op2 & 1;
      break;
    case IMM.OP2B01:
      out[D_IMM] = op2 & 3;
      break;
    case IMM.S0:
      out[D_IMM] = s & 1;
      break;
    case IMM.R0:
      out[D_IMM] = r & 1;
      break;
    case IMM.EXPST:
      out[D_IMM] = t | ((s & 1) << 4);
      break;
  }
}

/** The address a branch, jump, call, loop or l32r at `pc` refers to (descriptor from decode). */
export function target(desc: Int32Array, pc: number): number {
  const off = desc[D_OFF];
  switch (IMMS[desc[D_OP]]) {
    case IMM.CALL:
      return ((pc & ~3) + (off << 2) + 4) >>> 0;
    case IMM.L32R:
      return (((pc + 3) & ~3) + (off << 2)) >>> 0;
    default:
      return (pc + 4 + off) >>> 0;
  }
}
