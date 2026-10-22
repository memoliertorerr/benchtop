import { describe, expect, it } from 'vitest';
import { BLOCK, SparseBlocks } from './blocks.ts';
import { FatVolume, formatFat32 } from './fat.ts';
import { SD_BLOCKS } from './sd-card.ts';
import { utf8Encode } from './text.ts';

// BT89: the FAT library — format, mount, write, read, list, remove.

const text = (s: string): Uint8Array => utf8Encode(s);
function pattern(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 31 + seed) & 0xff;
  return out;
}
/** Byte equality without vitest's element-by-element diff (slow on megabytes). */
const same = (a: Uint8Array | undefined, b: Uint8Array): boolean => a !== undefined && Buffer.from(a.buffer, a.byteOffset, a.length).equals(Buffer.from(b.buffer, b.byteOffset, b.length));

function card(): { blocks: SparseBlocks; volume: FatVolume } {
  const blocks = new SparseBlocks(SD_BLOCKS);
  formatFat32(blocks, { label: 'BENCHTOP' });
  const volume = FatVolume.mount(blocks);
  if (volume === null) throw new Error('no volume');
  return { blocks, volume };
}

/** A bare FAT16 volume (no MBR): 1-sector clusters, a 512-entry root, 10,000 sectors. */
function fat16(): { blocks: SparseBlocks; volume: FatVolume } {
  const blocks = new SparseBlocks(10_000);
  const boot = blocks.writable(0);
  boot.set([0xeb, 0x3c, 0x90], 0);
  boot[11] = 0x00;
  boot[12] = 0x02; // 512 bytes a sector
  boot[13] = 1;
  boot[14] = 1; // reserved
  boot[16] = 2;
  boot[17] = 0x00;
  boot[18] = 0x02; // 512 root entries
  boot[19] = 10_000 & 0xff;
  boot[20] = 10_000 >> 8;
  boot[21] = 0xf8;
  boot[22] = 40; // sectors a FAT
  boot.set([...'TESTVOL    '].map((c) => c.charCodeAt(0)), 43);
  boot[510] = 0x55;
  boot[511] = 0xaa;
  for (const fat of [1, 41]) blocks.writable(fat).set([0xf8, 0xff, 0xff, 0xff]);
  const volume = FatVolume.mount(blocks);
  if (volume === null) throw new Error('no volume');
  return { blocks, volume };
}

describe('FAT library (BT89)', () => {
  it('formats an 8 GB card as FAT32 in an MBR partition, sparsely', () => {
    const { blocks, volume } = card();
    expect(volume.type).toBe(32);
    expect(volume.clusterBytes).toBe(32 * 1024);
    expect(volume.clusters).toBeGreaterThan(240_000);
    expect(volume.label).toBe('BENCHTOP');
    expect(volume.list()).toEqual([]);
    expect(volume.freeClusters()).toBe(volume.clusters - 1);
    expect(blocks.used).toBeLessThan(10);
    expect(blocks.peek(0)[450]).toBe(0x0c);
  });

  it('writes and reads files: 8.3, lower case, long names, directories, a multi-cluster file', () => {
    const { blocks, volume } = card();
    const big = pattern(100_000);
    expect(volume.write('CONFIG.TXT', text('rate=10\n'))).toBe(true);
    expect(volume.write('readme.txt', text('hello'))).toBe(true);
    expect(volume.write('Long File Name.csv', text('t,v\n1,2\n'))).toBe(true);
    expect(volume.write('data/run 1/values.bin', big)).toBe(true);
    expect(volume.write('empty.txt', new Uint8Array(0))).toBe(true);
    const again = FatVolume.mount(blocks)!;
    expect(again.list().map((f) => [f.path, f.dir, f.size])).toEqual([
      ['CONFIG.TXT', false, 8],
      ['readme.txt', false, 5],
      ['Long File Name.csv', false, 8],
      ['data', true, 0],
      ['data/run 1', true, 0],
      ['data/run 1/values.bin', false, 100_000],
      ['empty.txt', false, 0],
    ]);
    expect(again.read('config.txt')).toEqual(text('rate=10\n')); // names match without case
    expect(again.read('LONGFI~1.CSV')).toEqual(text('t,v\n1,2\n')); // and by the short name
    expect(same(again.read('DATA/RUN1~1/VALUES.BIN'), big)).toBe(true);
    expect(again.read('empty.txt')).toEqual(new Uint8Array(0));
    expect(again.read('missing.txt')).toBeUndefined();
    expect(again.read('data')).toBeUndefined();
    expect(again.list()[0].modified).toBe('2026-01-01 00:00:00');
    expect(again.freeClusters()).toBe(volume.clusters - 1 - 2 - 4 - 3); // root, two directories, 100 kB, three small files
  });

  it('replacing and removing give clusters back; a directory grows past its first cluster', () => {
    const { volume } = card();
    const free = volume.freeClusters();
    expect(volume.write('log.txt', pattern(70_000))).toBe(true);
    expect(volume.freeClusters()).toBe(free - 3);
    expect(volume.write('log.txt', text('short'))).toBe(true);
    expect(volume.freeClusters()).toBe(free - 1);
    expect(volume.read('log.txt')).toEqual(text('short'));
    for (let i = 0; i < 600; i++) expect(volume.write(`many/sample number ${i}.txt`, text(String(i)))).toBe(true);
    expect(volume.read('many/sample number 599.txt')).toEqual(text('599'));
    expect(volume.list().filter((f) => f.path.startsWith('many/'))).toHaveLength(600);
    expect(volume.remove('many')).toBe(true);
    expect(volume.remove('log.txt')).toBe(true);
    expect(volume.remove('log.txt')).toBe(false);
    expect(volume.list()).toEqual([]);
    expect(volume.freeClusters()).toBe(free);
  });

  it('refuses names a FAT can\'t hold and a file where a directory is', () => {
    const { volume } = card();
    expect(volume.write('a:b.txt', text('x'))).toBe(false);
    expect(volume.write('dir/x.txt', text('x'))).toBe(true);
    expect(volume.write('dir', text('x'))).toBe(false);
    expect(volume.write('dir/x.txt/y.txt', text('x'))).toBe(false);
    expect(volume.write('', text('x'))).toBe(false);
  });

  it('mounts FAT16 (a bare volume, fixed root): writes until full, then refuses', () => {
    const { blocks, volume } = fat16();
    expect(volume.type).toBe(16);
    expect(volume.label).toBe('TESTVOL');
    const free = volume.freeClusters();
    expect(volume.write('A.BIN', pattern(free * BLOCK + 1))).toBe(false);
    expect(volume.write('A.BIN', pattern((free - 1) * BLOCK))).toBe(true);
    expect(volume.write('B.TXT', text('one more'))).toBe(true);
    expect(volume.write('C.TXT', text('no room'))).toBe(false);
    const again = FatVolume.mount(blocks)!;
    expect(same(again.read('A.BIN'), pattern((free - 1) * BLOCK))).toBe(true);
    expect(again.read('b.txt')).toEqual(text('one more'));
    expect(again.remove('A.BIN')).toBe(true);
    expect(again.write('C.TXT', text('room now'))).toBe(true);
  });

  it('mounts nothing on a blank or foreign card', () => {
    expect(FatVolume.mount(new SparseBlocks(SD_BLOCKS))).toBeNull();
    const blocks = new SparseBlocks(SD_BLOCKS);
    const mbr = blocks.writable(0);
    mbr[510] = 0x55;
    mbr[511] = 0xaa;
    mbr[450] = 0x07; // an NTFS partition with nothing in it
    mbr[454] = 0x00;
    mbr[455] = 0x20;
    expect(FatVolume.mount(blocks)).toBeNull();
  });
});
