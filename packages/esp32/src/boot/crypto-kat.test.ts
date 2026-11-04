import { createCipheriv, createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { bootFixture, runUntil } from '../test-support/boot.test-helper.ts';

// BT102: mbedTLS on the SHA and AES accelerators — the crypto-kat fixture (Arduino-ESP32
// 2.0.17 builds mbedTLS with CONFIG_MBEDTLS_HARDWARE_SHA/AES) prints hashes and ciphertexts that
// must be what Node's crypto computes.

const big = Buffer.from(Array.from({ length: 1000 }, (_, i) => (i * 7 + 3) & 0xff));
const key = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const plain = Buffer.from('00112233445566778899aabbccddeeff', 'hex');

function expected(): string[] {
  const lines: string[] = [];
  for (const [name, data] of [['abc', Buffer.from('abc')], ['empty', Buffer.alloc(0)], ['1000', big]] as const) {
    for (const algo of ['sha1', 'sha256', 'sha384', 'sha512']) lines.push(`${algo} ${name} ${createHash(algo).update(data).digest('hex')}`);
  }
  for (const bits of [128, 192, 256]) {
    const c = createCipheriv(`aes-${bits}-ecb`, key.subarray(0, bits / 8), null).setAutoPadding(false);
    lines.push(`aes${bits} ${Buffer.concat([c.update(plain), c.final()]).toString('hex')}`);
    lines.push(`aes${bits} back ${plain.toString('hex')}`);
  }
  const iv = Buffer.from(Array.from({ length: 16 }, (_, i) => 0xa0 + i));
  const cbc = createCipheriv('aes-256-cbc', key, iv).setAutoPadding(false);
  lines.push(`cbc256 ${Buffer.concat([cbc.update(big.subarray(0, 64)), cbc.final()]).toString('hex')}`);
  lines.push('cbc256 back ok', 'kat done');
  return lines;
}

describe('mbedTLS on the accelerators (BT102)', () => {
  it('crypto-kat prints what Node computes, through the SHA and AES blocks', () => {
    const { soc, uart } = bootFixture('crypto-kat');
    runUntil(soc, 5, () => uart[0].includes('kat done'));
    const lines = uart[0].split(/\r?\n/).filter((l) => /^(sha|aes|cbc|kat)/.test(l));
    expect(lines).toEqual(expected());
    expect(soc.sha.blocks).toBeGreaterThan(30); // the hashes ran on the accelerator, not in software
    expect(soc.aes.blocks).toBeGreaterThanOrEqual(14);
  }, 60_000);
});
