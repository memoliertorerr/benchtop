import { describe, expect, it } from 'vitest';
import { BareMachine, IRAM_BASE } from '../test-support/bare-machine.test-helper.ts';
import { HALT } from './cpu.ts';

// BT30 (b): libgcc's float divide and square root are Newton sequences of FPU step instructions
// whose intermediate bits the ISA RM leaves open, so IEEE decides: on 5,000 seeded operands in
// the normal range __divsf3 must equal Math.fround(a / b) and __ieee754_sqrtf
// Math.fround(Math.sqrt(a)) bit for bit (round to nearest; double rounding is harmless for
// ÷ and √ since 53 ≥ 2·24 + 2). Beyond what the step asks: the same in the three directed
// modes (oracle: the sign of a − f·b, exact in float64), denormal and overflowing quotients,
// IEEE specials and the DivZero/Invalid/Inexact flags.

const CALL_ARGS = 0x3ffb0800;
const COUNT = 5000;
const FLAG = { I: 0x80, U: 0x100, O: 0x200, Z: 0x400, V: 0x800 };
const ROUTINE = { div: 0, sqrt: 1, recip: 2, rsqrt: 3 } as const;

const machine = BareMachine.load('fpu-libgcc');

const f32 = new Float32Array(1);
const w32 = new Uint32Array(f32.buffer);
const bitsOf = (v: number): number => {
  f32[0] = v;
  return w32[0];
};
const fromBits = (b: number): number => {
  w32[0] = b;
  return f32[0];
};
const hex = (b: number): string => (b >>> 0).toString(16).padStart(8, '0');

function run(routine: number, a: number, b: number, fcr = 0): { bits: number; fsr: number } {
  machine.bus.write32(CALL_ARGS, bitsOf(a));
  machine.bus.write32(CALL_ARGS + 4, bitsOf(b));
  machine.bus.write32(CALL_ARGS + 8, fcr);
  machine.bus.write32(CALL_ARGS + 16, routine);
  const core = machine.core;
  core.pc = IRAM_BASE;
  core.halt = HALT.RUNNING;
  core.run(10_000);
  if (core.halt !== HALT.BREAK) throw new Error(`routine ${routine}(${a}, ${b}): ${core.haltReason || 'did not return'}`);
  return { bits: machine.read32(CALL_ARGS + 20), fsr: machine.read32(CALL_ARGS + 24) };
}

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

/** A float32 with random significand and sign, and an exponent in [lo, hi]. */
function randomFloat(next: () => number, lo: number, hi: number, signed = true): number {
  const exponent = lo + (next() % (hi - lo + 1)) + 127;
  const sign = signed && (next() & 1) !== 0 ? 0x80000000 : 0;
  return fromBits((sign | (exponent << 23) | (next() & 0x7fffff)) >>> 0);
}

/** IEEE a ÷ b or √a in a directed mode, from the round-to-nearest result and the residual sign. */
function directed(nearest: number, residualSign: number, mode: number): number {
  if (residualSign === 0) return nearest; // exact
  const up = residualSign > 0; // the exact value lies above `nearest`
  const stepUp = (v: number): number => fromBits(v > 0 ? bitsOf(v) + 1 : v < 0 ? bitsOf(v) - 1 : 1);
  const stepDown = (v: number): number => -stepUp(-v);
  if (mode === 1) {
    // toward zero
    if (nearest > 0 && !up) return stepDown(nearest);
    if (nearest < 0 && up) return stepUp(nearest);
    return nearest;
  }
  if (mode === 2) return up ? stepUp(nearest) : nearest;
  return up ? nearest : stepDown(nearest);
}

describe('libgcc FPU sequences against IEEE', () => {
  it(`__divsf3 on ${COUNT} normal-range operand pairs, round to nearest`, () => {
    const next = prng(1);
    const bad: string[] = [];
    for (let i = 0; i < COUNT; i++) {
      const a = randomFloat(next, -60, 60);
      const b = randomFloat(next, -60, 60);
      const { bits } = run(ROUTINE.div, a, b);
      const expected = bitsOf(Math.fround(a / b));
      if (bits !== expected) bad.push(`${hex(bitsOf(a))} / ${hex(bitsOf(b))} → ${hex(bits)}, expected ${hex(expected)}`);
    }
    expect(bad.slice(0, 10), `${bad.length} of ${COUNT} differ`).toEqual([]);
  });

  it(`__ieee754_sqrtf on ${COUNT} normal-range operands, round to nearest`, () => {
    const next = prng(2);
    const bad: string[] = [];
    for (let i = 0; i < COUNT; i++) {
      const a = randomFloat(next, -126, 127, false);
      const { bits } = run(ROUTINE.sqrt, a, 0);
      const expected = bitsOf(Math.fround(Math.sqrt(a)));
      if (bits !== expected) bad.push(`√${hex(bitsOf(a))} → ${hex(bits)}, expected ${hex(expected)}`);
    }
    expect(bad.slice(0, 10), `${bad.length} of ${COUNT} differ`).toEqual([]);
  });

  it('both in the directed rounding modes (toward zero, +∞, −∞)', () => {
    const next = prng(3);
    const bad: string[] = [];
    for (let i = 0; i < 1500; i++) {
      const mode = 1 + (i % 3);
      const a = randomFloat(next, -40, 40);
      const b = randomFloat(next, -40, 40);
      const q = Math.fround(a / b);
      const qr = a - q * b; // q·b is exact in float64; the difference keeps its sign
      const qExpected = directed(q, qr === 0 ? 0 : Math.sign(qr) * Math.sign(b), mode);
      const div = run(ROUTINE.div, a, b, mode).bits;
      if (div !== bitsOf(qExpected)) bad.push(`mode ${mode}: ${a} / ${b} → ${fromBits(div)}, expected ${qExpected}`);
      const x = Math.abs(a);
      const s = Math.fround(Math.sqrt(x));
      const sExpected = directed(s, Math.sign(x - s * s), mode);
      const sqrt = run(ROUTINE.sqrt, x, 0, mode).bits;
      if (sqrt !== bitsOf(sExpected)) bad.push(`mode ${mode}: √${x} → ${fromBits(sqrt)}, expected ${sExpected}`);
    }
    expect(bad.slice(0, 10), `${bad.length} differ`).toEqual([]);
  });

  it('quotients that underflow to denormals or overflow, and denormal operands', () => {
    const next = prng(4);
    const bad: string[] = [];
    for (let i = 0; i < 2000; i++) {
      const [a, b] =
        i % 3 === 0
          ? [randomFloat(next, -126, -100), randomFloat(next, 10, 60)] // tiny quotients
          : i % 3 === 1
            ? [randomFloat(next, 90, 127), randomFloat(next, -60, -20)] // huge quotients
            : [fromBits(next() & 0x807fffff), randomFloat(next, -30, 30)]; // denormal dividends
      const { bits } = run(ROUTINE.div, a, b);
      const expected = bitsOf(Math.fround(a / b));
      if (bits !== expected) bad.push(`${hex(bitsOf(a))} / ${hex(bitsOf(b))} → ${hex(bits)}, expected ${hex(expected)}`);
      const d = Math.abs(fromBits(next() & 0x7fffff));
      const root = run(ROUTINE.sqrt, d, 0).bits;
      if (root !== bitsOf(Math.fround(Math.sqrt(d)))) bad.push(`√${hex(bitsOf(d))} → ${hex(root)}`);
    }
    expect(bad.slice(0, 10), `${bad.length} differ`).toEqual([]);
  });

  it('IEEE specials and flags', () => {
    const cases: [number, number][] = [
      [1, 0], [-1, 0], [0, 0], [0, 5], [-0, 5], [Infinity, 2], [2, Infinity], [Infinity, Infinity], [NaN, 1], [1, NaN], [-Infinity, -0],
    ];
    for (const [a, b] of cases) {
      const { bits, fsr } = run(ROUTINE.div, a, b);
      const expected = a / b;
      if (expected !== expected) expect(fromBits(bits), `${a} / ${b}`).toBeNaN();
      else expect(hex(bits), `${a} / ${b}`).toBe(hex(bitsOf(expected)));
      const z = Number.isFinite(a) && a !== 0 && b === 0;
      const v = (a === 0 && b === 0) || (!Number.isFinite(a) && !Number.isFinite(b) && a === a && b === b);
      expect({ z: (fsr & FLAG.Z) !== 0, v: (fsr & FLAG.V) !== 0 }, `${a} / ${b} flags ${fsr.toString(16)}`).toEqual({ z, v });
    }
    for (const a of [0, -0, Infinity, -1, -Infinity, NaN, 4]) {
      const { bits, fsr } = run(ROUTINE.sqrt, a, 0);
      const expected = Math.sqrt(a);
      if (expected !== expected) expect(fromBits(bits), `√${a}`).toBeNaN();
      else expect(hex(bits), `√${a}`).toBe(hex(bitsOf(expected)));
      expect((fsr & FLAG.V) !== 0, `√${a} invalid`).toBe(a < 0);
    }
    // Inexact exactly when the quotient is.
    expect(run(ROUTINE.div, 1, 4).fsr & FLAG.I).toBe(0);
    expect(run(ROUTINE.div, 1, 3).fsr & FLAG.I).toBe(FLAG.I);
    expect(run(ROUTINE.sqrt, 9, 0).fsr & FLAG.I).toBe(0);
    expect(run(ROUTINE.sqrt, 2, 0).fsr & FLAG.I).toBe(FLAG.I);
  });

  it('__recipsf2 and __rsqrtsf2 (approximations by design) land within an ulp', () => {
    const next = prng(5);
    for (let i = 0; i < 500; i++) {
      const a = randomFloat(next, -60, 60, false);
      const recip = fromBits(run(ROUTINE.recip, a, 0).bits);
      expect(Math.abs(recip - 1 / a) / (1 / a)).toBeLessThan(2 ** -22);
      const rsqrt = fromBits(run(ROUTINE.rsqrt, a, 0).bits);
      expect(Math.abs(rsqrt - 1 / Math.sqrt(a)) * Math.sqrt(a)).toBeLessThan(2 ** -22);
    }
  });
});
