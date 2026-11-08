import { describe, expect, it } from 'vitest';
import { BLOCK, SparseBlocks } from './blocks.ts';
import { FatVolume, formatFat32 } from './fat.ts';

/** The microSD card's blocks (@benchtop/parts SD_BLOCKS: (15159 + 1) · 1024, an 8 GB card). */
const SD_BLOCKS = (15159 + 1) * 1024;

// BT89: the FAT library — format, mount, write, read, list, remove.

const text = (s: string): Uint8Array => new TextEncoder().encode(s);
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

describe('FAT12 (BT140)', () => {
  /**
   * A bare FAT12 volume laid out from the FAT spec: a boot sector (BPB), `fats` FATs of
   * `fatSectors`, a fixed root directory of `rootEntries`, then the data clusters.
   */
  function fat12(options: { total: number; fatSectors: number; fats?: number; rootEntries?: number; spc?: number; label?: string }): SparseBlocks {
    const { total, fatSectors, fats = 1, rootEntries = 16, spc = 1, label = 'BENCH DISK ' } = options;
    const blocks = new SparseBlocks(total);
    const boot = blocks.writable(0);
    boot.set([0xeb, 0x3c, 0x90], 0);
    boot.set(new TextEncoder().encode('BENCHTOP'), 3);
    const put16 = (o: number, v: number) => {
      boot[o] = v & 0xff;
      boot[o + 1] = v >>> 8;
    };
    put16(11, BLOCK);
    boot[13] = spc;
    put16(14, 1); // reserved: the boot sector
    boot[16] = fats;
    put16(17, rootEntries);
    put16(19, total);
    boot[21] = 0xf8;
    put16(22, fatSectors);
    boot[38] = 0x29;
    boot.set(new TextEncoder().encode(label.padEnd(11).slice(0, 11)), 43);
    boot.set(new TextEncoder().encode('FAT12   '), 54);
    boot[510] = 0x55;
    boot[511] = 0xaa;
    for (let f = 0; f < fats; f++) blocks.writable(1 + f * fatSectors).set([0xf8, 0xff, 0xff], 0); // entries 0 and 1
    return blocks;
  }

  it('mounts a small volume as FAT12: writes, lists, reads back, removes; a long name too', () => {
    const blocks = fat12({ total: 128, fatSectors: 1 });
    const volume = FatVolume.mount(blocks) as FatVolume;
    expect(volume.type).toBe(12);
    expect(volume.label).toBe('BENCH DISK');
    expect(volume.clusters).toBe(125); // 128 − boot − FAT − root
    expect(volume.freeClusters()).toBe(125);
    expect(volume.write('README.TXT', text('Hello from a FAT12 disk\r\n'))).toBe(true);
    const big = new Uint8Array(3000).map((_, i) => (i * 7) & 0xff); // 6 clusters
    expect(volume.write('data/a long file name.bin', big)).toBe(true);
    expect(volume.list().map((f) => [f.path, f.dir, f.size])).toEqual([
      ['README.TXT', false, 25],
      ['data', true, 0],
      ['data/a long file name.bin', false, 3000],
    ]);
    expect(volume.freeClusters()).toBe(125 - 1 - 1 - 6);
    // A second mount reads it all from the blocks alone.
    const again = FatVolume.mount(blocks) as FatVolume;
    expect(again.read('readme.txt')).toEqual(text('Hello from a FAT12 disk\r\n'));
    expect(again.read('DATA/A LONG FILE NAME.BIN')).toEqual(big);
    expect(again.remove('data')).toBe(true);
    expect(again.list().map((f) => f.path)).toEqual(['README.TXT']);
    expect(again.freeClusters()).toBe(124);
    // The FAT's bytes as the spec packs them: cluster 2 (README, one cluster) ends the chain: 0xFFF.
    const fat = blocks.peek(1);
    expect([fat[3], fat[4] & 0x0f]).toEqual([0xff, 0x0f]);
  });

  it('entries that straddle a FAT sector boundary (cluster 341: bytes 511 and 512) read and write right', () => {
    const blocks = fat12({ total: 1200, fatSectors: 4, fats: 2 });
    const volume = FatVolume.mount(blocks) as FatVolume;
    expect(volume.type).toBe(12);
    const big = new Uint8Array(400 * BLOCK).map((_, i) => (i * 31 + (i >>> 9)) & 0xff); // clusters 2…401
    expect(volume.write('BIG.BIN', big)).toBe(true);
    const again = FatVolume.mount(blocks) as FatVolume;
    expect(again.read('BIG.BIN')).toEqual(big);
    // Cluster 341 → 342: 342 split as its low nibble in byte 511's high half and 8 bits in byte 512.
    const first = blocks.peek(1);
    const second = blocks.peek(2);
    expect(((first[511] >>> 4) | (second[0] << 4)) & 0xfff).toBe(342);
    // The second FAT holds the same.
    expect(blocks.peek(1 + 4)).toEqual(first);
    expect(again.remove('BIG.BIN')).toBe(true);
    expect(again.freeClusters()).toBe(again.clusters);
  });

  it('4,084 clusters is FAT12, 4,085 FAT16 — the spec’s rule', () => {
    // 1 boot + 12 FAT + 1 root sector, then the clusters.
    expect((FatVolume.mount(fat12({ total: 14 + 4084, fatSectors: 12 })) as FatVolume).type).toBe(12);
    expect((FatVolume.mount(fat12({ total: 14 + 4085, fatSectors: 12 })) as FatVolume).type).toBe(16);
  });
});
