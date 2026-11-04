import { describe, expect, it } from 'vitest';
import { readFixture } from '../../core/src/firmware/fixtures.test-helper.ts';
import { createEsp32Mcu, type Esp32Mcu } from './esp32.ts';
import { decodeNvs, nvsCrc32, nvsPartitions } from './nvs.ts';
import { REF_HZ } from './soc/context.ts';
import { loadCachedRom } from './test-support/rom.test-helper.ts';

// BT119: ESP-IDF's NVS read from flash, on what fixtures/sketches/esp32/prefs-types writes with
// Preferences — one value of each type, strings over several entries, a 5000-byte blob in chunks
// on two pages — and on damaged copies (never thrown on: problems, the rest still read).

function boot(): { mcu: Esp32Mcu; text: () => string; run: (seconds: number, until: () => boolean) => void } {
  const mcu = createEsp32Mcu({ rom: loadCachedRom() });
  mcu.load({ format: 'esp32-bin', app: readFixture('fixtures/firmware/esp32/prefs-types.bin'), partitions: readFixture('fixtures/firmware/esp32/prefs-types.partitions.bin') });
  let text = '';
  mcu.uart(0)?.onTransmit((b) => (text += String.fromCharCode(b)));
  const run = (seconds: number, until: () => boolean): void => {
    const end = mcu.cycles + seconds * REF_HZ;
    while (mcu.cycles < end && !until()) mcu.runUntil(Math.min(end, mcu.cycles + REF_HZ / 100));
  };
  return { mcu, text: () => text, run };
}

function flashOf(mcu: Esp32Mcu): Uint8Array {
  const nvm = mcu.nonVolatile();
  if (nvm === null) throw new Error('no flash');
  return nvm.read(0, nvm.size);
}

const BIG = Uint8Array.from({ length: 5000 }, (_, i) => i & 0xff);
const LONG = Array.from({ length: 100 }, (_, i) => String.fromCharCode(97 + (i % 26))).join('');

describe('NVS (BT119)', () => {
  it('CRC32 is ESP-IDF’s crc32_le(0xFFFFFFFF, …)', () => {
    expect(nvsCrc32(Uint8Array.from([...'123456789'].map((c) => c.charCodeAt(0))))).toBe(0xd202d277);
  });

  it('reads back every type Preferences wrote, in their namespaces; a removed key is gone', () => {
    const { mcu, text, run } = boot();
    run(4, () => text().includes('written'));
    const flash = flashOf(mcu);
    expect(nvsPartitions(flash)).toEqual([{ label: 'nvs', offset: 0x9000, size: 0x5000 }]);
    const dump = decodeNvs(flash.subarray(0x9000, 0xe000));
    expect(dump.problems).toEqual([]);
    expect(dump.pages).toBe(2);
    const plain = dump.entries.map((e) => [e.namespace, e.key, e.type, e.value instanceof Uint8Array ? `${e.value.length} bytes` : e.value]);
    expect(plain).toEqual([
      ['other', 'n', 'u32', 7],
      ['types', 'big', 'blob', '5000 bytes'],
      ['types', 'bool', 'u8', 1],
      ['types', 'float', 'blob', '4 bytes'],
      ['types', 'i16', 'i16', -30000],
      ['types', 'i32', 'i32', -2000000000],
      ['types', 'i64', 'i64', '-9000000000000000000'],
      ['types', 'i8', 'i8', -100],
      ['types', 'long', 'string', LONG],
      ['types', 'short', 'string', 'hi'],
      ['types', 'u16', 'u16', 60000],
      ['types', 'u32', 'u32', 4000000000],
      ['types', 'u64', 'u64', '18000000000000000000'],
      ['types', 'u8', 'u8', 200],
    ]);
    expect(dump.entries.find((e) => e.key === 'big')?.value).toEqual(BIG);
    expect(dump.entries.find((e) => e.key === 'float')?.value).toEqual(Uint8Array.of(0, 0, 0xc0, 0x3f)); // 1.5f
    mcu.uart(0)?.receive(Uint8Array.from([...'erase u32\n'].map((c) => c.charCodeAt(0))));
    run(2, () => text().includes('removed'));
    const after = decodeNvs(flashOf(mcu).subarray(0x9000, 0xe000));
    expect(after.entries.map((e) => e.key)).not.toContain('u32');
    expect(after.entries).toHaveLength(13);
  }, 60_000);

  it('damage is reported, not thrown: a bad entry or page is skipped and the rest read', () => {
    const { mcu, text, run } = boot();
    run(4, () => text().includes('written'));
    const nvs = flashOf(mcu).slice(0x9000, 0xe000);
    // Entry 1 of page 0 ("u8"): a flipped bit in its value.
    const bad = nvs.slice();
    bad[64 + 32 + 24] ^= 1;
    const one = decodeNvs(bad);
    expect(one.problems).toEqual(['page 0 entry 1: CRC mismatch: skipped']);
    expect(one.entries.map((e) => e.key)).not.toContain('u8');
    expect(one.entries).toHaveLength(13);
    // Page 1's header: its items go (the namespace "other", n, big's second chunk and index).
    const page = nvs.slice();
    page[4096 + 4] ^= 1;
    const two = decodeNvs(page);
    expect(two.problems).toEqual(['page 1: header CRC mismatch: skipped']);
    expect(two.entries.map((e) => e.key)).toEqual(['bool', 'float', 'i16', 'i32', 'i64', 'i8', 'long', 'short', 'u16', 'u32', 'u64', 'u8']);
    // Nothing that parses at all, and short or empty input.
    let seed = 1;
    const noise = Uint8Array.from({ length: 0x5000 }, () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 24));
    expect(() => decodeNvs(noise)).not.toThrow();
    expect(decodeNvs(new Uint8Array(100))).toEqual({ entries: [], pages: 0, problems: [] });
    expect(decodeNvs(new Uint8Array(0x2000).fill(0xff))).toEqual({ entries: [], pages: 0, problems: [] });
    expect(nvsPartitions(new Uint8Array(0x1000))).toEqual([]);
  }, 60_000);
});
