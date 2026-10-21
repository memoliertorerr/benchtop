import { describe, expect, it } from 'vitest';
import { bootFixture, runUntil } from '../test-support/boot.test-helper.ts';

// BT32: crc-bench computes a bitwise CRC-32 of 8 × 16 KB in setup() and prints it; the test
// computes the same CRC in JS.

function expectedCrc(): string {
  const buffer = new Uint8Array(16384);
  for (let i = 0; i < buffer.length; i++) buffer[i] = (i * 7 + 3) & 0xff;
  let crc = 0xffffffff;
  for (let round = 0; round < 8; round++) {
    for (const byte of buffer) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
      crc >>>= 0;
    }
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}

describe('crc-bench', () => {
  it('prints the CRC the test computes', () => {
    const { soc, uart } = bootFixture('crc-bench');
    const started = performance.now();
    runUntil(soc, 3, () => uart[0].includes('\n'));
    const wall = (performance.now() - started) / 1000;
    expect(soc.stopReason).toBe('');
    expect(uart[0]).toBe(`crc=${expectedCrc()}\n`);
    console.info(`crc-bench: printed at ${soc.seconds().toFixed(3)} s simulated, ${wall.toFixed(2)} s wall`);
  }, 60_000);
});
