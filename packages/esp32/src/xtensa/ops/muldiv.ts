/**
 * MUL32_HIGH helpers: the high word of a 32 × 32-bit product without BigInt, from 16-bit limbs
 * (every partial product and sum stays below 2^53). MULL is Math.imul; MUL16S/U, QUOS/QUOU,
 * REMS/REMU live in cpu.ts's switch.
 */

/** High 32 bits of the unsigned product a · b (a, b as uint32). */
export function muluh(a: number, b: number): number {
  const a0 = a & 0xffff;
  const a1 = a >>> 16;
  const b0 = b & 0xffff;
  const b1 = b >>> 16;
  const lo = a0 * b0;
  const m1 = a1 * b0;
  const m2 = a0 * b1;
  const mid = (lo >>> 16) + (m1 & 0xffff) + (m2 & 0xffff);
  return (a1 * b1 + (m1 >>> 16) + (m2 >>> 16) + (mid >>> 16)) >>> 0;
}

/** High 32 bits of the signed product a · b (a, b as int32, passed as uint32 or int32). */
export function mulsh(a: number, b: number): number {
  // Signed high word = unsigned high word − (a < 0 ? b : 0) − (b < 0 ? a : 0), mod 2^32.
  let h = muluh(a >>> 0, b >>> 0);
  if ((a | 0) < 0) h -= b >>> 0;
  if ((b | 0) < 0) h -= a >>> 0;
  return h >>> 0;
}
