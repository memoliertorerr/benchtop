import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { md5 } from './md5.ts';
import { sha256Hex } from './sha256.ts';
import { readTar, TarError } from './ustar.ts';

/** mulberry32, so the buffers are the same every run. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('sha256 / md5', () => {
  it('sha256 equals node:crypto on 1,000 seeded random buffers of 0–5,000 bytes', () => {
    const random = prng(2027);
    for (let k = 0; k < 1000; k++) {
      const bytes = Uint8Array.from({ length: Math.floor(random() * 5001) }, () => Math.floor(random() * 256));
      expect(sha256Hex(bytes), `buffer ${k} (${bytes.length} bytes)`).toBe(createHash('sha256').update(bytes).digest('hex'));
    }
    // Lengths around the 64-byte block and its 56-byte padding boundary.
    for (const n of [0, 55, 56, 63, 64, 65, 119, 120, 128]) {
      const bytes = new Uint8Array(n).fill(0x61);
      expect(sha256Hex(bytes)).toBe(createHash('sha256').update(bytes).digest('hex'));
    }
  });

  it('md5 equals node:crypto', () => {
    const random = prng(5);
    for (let k = 0; k < 200; k++) {
      const bytes = Uint8Array.from({ length: Math.floor(random() * 3100) }, () => Math.floor(random() * 256));
      expect(Buffer.from(md5(bytes)).toString('hex')).toBe(createHash('md5').update(bytes).digest('hex'));
    }
  });
});

/** A ustar archive of (name, data) files, built by hand. */
function tar(files: [string, string][]): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const [name, text] of files) {
    const header = new Uint8Array(512);
    const put = (offset: number, value: string): void => header.set(Buffer.from(value, 'latin1'), offset);
    put(0, name);
    put(100, '0000644\0');
    put(124, `${text.length.toString(8).padStart(11, '0')}\0`);
    put(136, '00000000000\0');
    put(156, '0');
    put(257, 'ustar\0');
    put(263, '00');
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i];
    put(148, `${sum.toString(8).padStart(6, '0')}\0 `);
    const data = new Uint8Array(Math.ceil(text.length / 512) * 512);
    data.set(Buffer.from(text, 'latin1'));
    blocks.push(header, data);
  }
  blocks.push(new Uint8Array(1024));
  return new Uint8Array(Buffer.concat(blocks));
}

describe('ustar reader', () => {
  it('reads names and data, and rejects a bad header checksum or a size past the end', () => {
    const archive = tar([
      ['esp-rom-elfs/esp32_rev0_rom.elf', 'ELF!'],
      ['esp-rom-elfs/README.md', 'x'.repeat(700)],
    ]);
    const entries = readTar(archive);
    expect(entries.map((e) => [e.name, e.type, e.data.length])).toEqual([
      ['esp-rom-elfs/esp32_rev0_rom.elf', '0', 4],
      ['esp-rom-elfs/README.md', '0', 700],
    ]);
    expect(Buffer.from(entries[0].data).toString()).toBe('ELF!');
    const corrupt = archive.slice();
    corrupt[10] ^= 1;
    expect(() => readTar(corrupt)).toThrow(TarError);
    // The README's header is at 1024 (after the ELF's header and one data block); cut inside its data.
    expect(() => readTar(archive.subarray(0, 1024 + 512 + 100))).toThrow(/past the end/);
  });
});
