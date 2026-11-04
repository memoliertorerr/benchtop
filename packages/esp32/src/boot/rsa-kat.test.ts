import { describe, expect, it } from 'vitest';
import { bootFixture, runUntil } from '../test-support/boot.test-helper.ts';

// BT103: mbedTLS's bignum on the RSA accelerator — the rsa-kat fixture (Arduino-ESP32 2.0.17
// builds mbedTLS with CONFIG_MBEDTLS_HARDWARE_MPI; IDF's port exponentiates with hardware
// Montgomery multiplications) prints X^E mod M and A·B, which BigInt recomputes from the same
// LCG the sketch draws its numbers from.

let lcg = 0;
function fill(bytes: number, top: boolean, odd: boolean): bigint {
  const b = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) {
    lcg = (Math.imul(lcg, 1103515245) + 12345) >>> 0;
    b[i] = (lcg >>> 16) & 0xff;
  }
  if (top) b[0] |= 0x80;
  else b[0] &= 0x7f;
  if (odd) b[bytes - 1] |= 1;
  return BigInt(`0x${Buffer.from(b).toString('hex')}`);
}

function modPow(base: bigint, exp: bigint, m: bigint): bigint {
  let r = 1n;
  let x = base % m;
  for (let e = exp; e > 0n; e >>= 1n) {
    if (e & 1n) r = (r * x) % m;
    x = (x * x) % m;
  }
  return r;
}

const hex = (v: bigint): string => v.toString(16).toUpperCase();

function expected(): string[] {
  const lines: string[] = [];
  for (const bits of [512, 1024, 2048, 3072]) {
    lcg = bits;
    const m = fill(bits / 8, true, true);
    const x = fill(bits / 8, false, false);
    lines.push(`exp ${bits} 65537 ${hex(modPow(x, 65537n, m))}`);
    const e = fill(bits / 8, true, false);
    lines.push(`exp ${bits} full ${hex(modPow(x, e, m))}`);
  }
  for (const bits of [512, 1024, 2048]) {
    lcg = (bits * 7) >>> 0;
    const a = fill(bits / 8, true, false);
    const b = fill(bits / 8, true, false);
    lines.push(`mul ${bits} ${hex(a * b)}`);
  }
  lines.push('kat done');
  return lines;
}

describe('mbedTLS bignum on the RSA accelerator (BT103)', () => {
  it('rsa-kat prints what BigInt computes, through the RSA block', () => {
    const { soc, uart } = bootFixture('rsa-kat');
    runUntil(soc, 20, () => uart[0].includes('kat done'));
    const lines = uart[0].split(/\r?\n/).filter((l) => /^(exp|mul|kat)/.test(l));
    expect(lines).toEqual(expected());
    expect(soc.rsa.operations).toBeGreaterThan(100); // the hardware path, not software bignum
  }, 120_000);
});
