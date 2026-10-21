/**
 * The MAC16 option: a 40-bit accumulator (ACCLO = SR 16, ACCHI = SR 17 holding bits 39–32,
 * read back sign-extended), four 32-bit MAC registers M0–M3 (SR 32–35), and 16 × 16-bit
 * multiplies into, onto or off the accumulator.
 *
 * Mnemonics spell the operation: MUL (ACC ←), MULA (ACC +=), MULS (ACC −=) with a signed
 * product, UMUL with an unsigned one; .AA/.AD/.DA/.DD say whether the first (x) and second (y)
 * operand come from address registers (A: as, at) or MAC registers (D: x from M0/M1, y from
 * M2/M3); .LL/.LH/.HL/.HH pick the low or high 16 bits of x and of y in that order.
 * LDINC/LDDEC mw, as add/subtract 4 from as and load mw from the new address; the
 * MULA.DA/DD.*.LDINC/LDDEC forms do both, the multiply using mx's old value. The load happens
 * first, so a bus error leaves the accumulator untouched.
 *
 * The table below is built from the mnemonics once; the accumulator is two numbers and the sum
 * is exact in a double (|ACC| < 2^40, |product| < 2^32) — no BigInt.
 */

import type { XtensaCore } from '../cpu.ts';
import * as isa from '../isa.ts';
import { SR } from '../regs.ts';

const SR_ACCLO = SR.ACCLO;
const SR_ACCHI = SR.ACCHI;
const SR_M0 = SR.M0;
const TWO_32 = 2 ** 32;

/** Per op: 0 not MAC16; 1 MUL, 2 MULA, 3 MULS, 4 UMUL, 5 LDINC/LDDEC alone. */
export const MAC_KIND = new Uint8Array(isa.OPS.length);
/** Bits: 1 x from M, 2 y from M, 4 x high half, 8 y high half, 16 load +4, 32 load −4. */
const MAC_FLAGS = new Uint8Array(isa.OPS.length);

isa.OPS.forEach((op, i) => {
  const m = /^(mul|mula|muls|umul)\.(aa|ad|da|dd)\.([lh])([lh])(?:\.(ldinc|lddec))?$/.exec(op.name);
  if (m !== null) {
    MAC_KIND[i] = m[1] === 'mul' ? 1 : m[1] === 'mula' ? 2 : m[1] === 'muls' ? 3 : 4;
    let flags = 0;
    if (m[2][0] === 'd') flags |= 1;
    if (m[2][1] === 'd') flags |= 2;
    if (m[3] === 'h') flags |= 4;
    if (m[4] === 'h') flags |= 8;
    if (m[5] === 'ldinc') flags |= 16;
    if (m[5] === 'lddec') flags |= 32;
    MAC_FLAGS[i] = flags;
  } else if (op.name === 'ldinc' || op.name === 'lddec') {
    MAC_KIND[i] = 5;
    MAC_FLAGS[i] = op.name === 'ldinc' ? 16 : 32;
  }
});

/** The accumulator as a signed number (exact). */
export function accumulator(core: XtensaCore): number {
  return ((core.sr[SR_ACCHI] << 24) >> 24) * TWO_32 + core.sr[SR_ACCLO];
}

function setAccumulator(core: XtensaCore, acc: number): void {
  const hi = Math.floor(acc / TWO_32);
  core.sr[SR_ACCLO] = acc - hi * TWO_32;
  core.sr[SR_ACCHI] = hi & 0xff; // wraps at 40 bits
}

/** Executes MAC16 instruction `op` (fields r, s, t); bus errors propagate (thrown) before any state changes. */
export function executeMac16(core: XtensaCore, op: number, r: number, s: number, t: number): void {
  const ar = core.ar;
  const wb = core.windowBase << 2;
  const kind = MAC_KIND[op];
  const flags = MAC_FLAGS[op];

  let loadAddress = 0;
  let loaded = 0;
  if ((flags & 48) !== 0) {
    loadAddress = (ar[(wb + s) & 63] + ((flags & 16) !== 0 ? 4 : -4)) >>> 0;
    loaded = core.bus.read32(loadAddress);
  }

  if (kind !== 5) {
    const x = (flags & 1) !== 0 ? core.sr[SR_M0 + ((r >> 2) & 1)] : ar[(wb + s) & 63];
    const y = (flags & 2) !== 0 ? core.sr[SR_M0 + 2 + ((t >> 2) & 1)] : ar[(wb + t) & 63];
    let xh = (flags & 4) !== 0 ? x >>> 16 : x & 0xffff;
    let yh = (flags & 8) !== 0 ? y >>> 16 : y & 0xffff;
    if (kind !== 4) {
      xh = (xh << 16) >> 16;
      yh = (yh << 16) >> 16;
    }
    const p = xh * yh; // exact: |p| ≤ 2^32
    setAccumulator(core, kind === 1 || kind === 4 ? p : kind === 2 ? accumulator(core) + p : accumulator(core) - p);
  }

  if ((flags & 48) !== 0) {
    core.sr[SR_M0 + (r & 3)] = loaded;
    ar[(wb + s) & 63] = loadAddress;
  }
}
