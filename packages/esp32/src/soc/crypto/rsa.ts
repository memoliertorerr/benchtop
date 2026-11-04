/**
 * The ESP32's RSA (MPI) accelerator (BT103; 0x3FF02000, `soc/hwcrypto_reg.h`): four 512-byte
 * memory blocks — M (0x000), Z (0x200, also RB), Y (0x400), X (0x600) — of 32-bit words, least
 * significant first; M_DASH (0x800), MODEXP_MODE (0x804), MODEXP_START (0x808), MULT_MODE
 * (0x80C), MULT_START (0x810), INTERRUPT (0x814: reads 1 once an operation finished, a write of 1
 * clears it), CLEAN (0x818: reads 1 once the memories are ready after power-up).
 *
 * The operations, from the ROM's ets_bigint_* drivers (which program the same registers as
 * IDF's port): MULT with MULT_MODE = n/16 − 1 for n words is a Montgomery multiplication
 * Z ← X · Z · R⁻¹ mod M (R = 2^(32n)); IDF's modular multiplication and its Montgomery
 * exponentiation (ESP_MPI_USE_MONT_EXP on the ESP32) are made of these. MULT_MODE ≥ 8 is a plain
 * multiplication: L = 16 · (mode − 7) words, A in X's low half, B in Z's high half, the L-word
 * product into Z. MODEXP: Z ← X^Y mod M (n words from MODEXP_MODE). M' isn't needed by BigInt
 * arithmetic and is kept as written. Operations complete at once; INTERRUPT goes to 1 (IDF polls
 * it: CONFIG_MBEDTLS_MPI_USE_INTERRUPT is off in Arduino's build). Unclocked, in reset (DPORT
 * PERI_CLK_EN / PERI_RST_EN bit 2) or powered down (DPORT_RSA_PD_CTRL bit 0) the block reads 0.
 */

import type { Peripheral } from '../periph.ts';

export const RSA_BASE = 0x3ff02000;
const BLOCK_WORDS = 128;
const M = 0x000;
const Z = 0x200;
const Y = 0x400;
const X = 0x600;
const M_DASH = 0x800;
const MODEXP_MODE = 0x804;
const MODEXP_START = 0x808;
const MULT_MODE = 0x80c;
const MULT_START = 0x810;
const INTERRUPT = 0x814;
const CLEAN = 0x818;

export class RsaAccelerator implements Peripheral {
  private readonly mem = new Uint32Array(4 * BLOCK_WORDS);
  private mDash = 0;
  private modexpMode = 0;
  private multMode = 0;
  private done = 0;
  private readonly enabled: () => boolean;
  /** Operations run since reset (tests, docs). */
  operations = 0;

  constructor(enabled: () => boolean) {
    this.enabled = enabled;
  }

  implements(offset: number): boolean {
    return offset <= CLEAN;
  }

  read32(offset: number): number {
    if (!this.enabled()) return 0;
    if (offset < M_DASH) return this.mem[offset >>> 2];
    if (offset === M_DASH) return this.mDash;
    if (offset === MODEXP_MODE) return this.modexpMode;
    if (offset === MULT_MODE) return this.multMode;
    if (offset === INTERRUPT) return this.done;
    if (offset === CLEAN) return 1;
    return 0;
  }

  write32(offset: number, value: number): void {
    if (!this.enabled()) return;
    if (offset < M_DASH) this.mem[offset >>> 2] = value >>> 0;
    else if (offset === M_DASH) this.mDash = value >>> 0;
    else if (offset === MODEXP_MODE) this.modexpMode = value & 7;
    else if (offset === MULT_MODE) this.multMode = value & 15;
    else if (offset === INTERRUPT && (value & 1) !== 0) this.done = 0;
    else if (offset === MODEXP_START && (value & 1) !== 0) this.modexp();
    else if (offset === MULT_START && (value & 1) !== 0) this.mult();
  }

  private read(block: number, words: number): bigint {
    let v = 0n;
    for (let i = words - 1; i >= 0; i--) v = (v << 32n) | BigInt(this.mem[(block >>> 2) + i]);
    return v;
  }

  private write(block: number, words: number, value: bigint): void {
    let v = value;
    for (let i = 0; i < words; i++) {
      this.mem[(block >>> 2) + i] = Number(v & 0xffffffffn);
      v >>= 32n;
    }
  }

  private mult(): void {
    this.operations++;
    if (this.multMode < 8) {
      const words = 16 * (this.multMode + 1);
      const m = this.read(M, words);
      if (m === 0n) return;
      const rInv = modInverse(1n << BigInt(32 * words), m);
      this.write(Z, words, (this.read(X, words) * this.read(Z, words) * rInv) % m);
    } else {
      // The ROM's ets_bigint_mult_prepare: L = 16·(mode − 7) words; A in X's low half, B in Z's
      // high half; the L-word product into Z.
      const words = 16 * (this.multMode - 7);
      const half = words / 2;
      const a = this.read(X, half);
      const b = this.read(Z + 4 * half, half);
      this.write(Z, words, a * b);
    }
    this.done = 1;
  }

  private modexp(): void {
    this.operations++;
    const words = 16 * (this.modexpMode + 1);
    const m = this.read(M, words);
    if (m !== 0n) this.write(Z, words, modPow(this.read(X, words), this.read(Y, words), m));
    this.done = 1;
  }

  clear(): void {
    this.mem.fill(0);
    this.mDash = 0;
    this.modexpMode = 0;
    this.multMode = 0;
    this.done = 0;
  }

  systemReset(): void {
    this.clear();
    this.operations = 0;
  }
}

function modPow(base: bigint, exp: bigint, m: bigint): bigint {
  let result = 1n % m;
  let b = base % m;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return result;
}

function modInverse(a: bigint, m: bigint): bigint {
  let [oldR, r] = [a % m, m];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  return ((oldS % m) + m) % m;
}
