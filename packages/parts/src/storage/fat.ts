/**
 * A small FAT file system over a card's blocks (BT89): format (FAT32 in one MBR partition, the
 * way an SD card ships), mount (an MBR's first partition or a bare volume; FAT16 and FAT32),
 * list, read, write (8.3 names, with long-name entries when a name needs them), make
 * directories, remove. DOM-free: the card model formats with it at power-up, and the worker, the
 * MCP server and test specs read what firmware wrote through it.
 *
 * Layout (Microsoft's "FAT: General Overview of On-Disk Format" 1.03): sector 0 of the volume is
 * the boot sector (BPB), then the reserved sectors (FSInfo at 1, a backup boot sector at 6), the
 * FATs, FAT16's fixed root directory, and the data area of clusters numbered from 2. A directory
 * entry is 32 bytes; a long name precedes its short entry as 13-character pieces (attribute
 * 0x0F) in reverse order, tied to it by a checksum of the 11-byte short name.
 */

import type { StoredFile } from '@benchtop/core';
import { BLOCK, type SparseBlocks } from './blocks.ts';

const ATTR_VOLUME = 0x08;
const ATTR_DIR = 0x10;
const ATTR_ARCHIVE = 0x20;
const ATTR_LFN = 0x0f;
const DELETED = 0xe5;
/** NT case flags in a short entry's byte 12: base and extension shown in lower case. */
const NT_LOWER_BASE = 0x08;
const NT_LOWER_EXT = 0x10;
/** Characters an 8.3 name may hold besides letters and digits. */
const SHORT_CHARS = /^[A-Z0-9!#$%&'()\-@^_`{}~]+$/;
/** Where the stamp goes for files this library writes: 2026-01-01 00:00:00. */
const STAMP_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
const STAMP_TIME = 0;

const u16 = (b: Uint8Array, o: number): number => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number): number => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
function put16(b: Uint8Array, o: number, v: number): void {
  b[o] = v & 0xff;
  b[o + 1] = (v >>> 8) & 0xff;
}
function put32(b: Uint8Array, o: number, v: number): void {
  b[o] = v & 0xff;
  b[o + 1] = (v >>> 8) & 0xff;
  b[o + 2] = (v >>> 16) & 0xff;
  b[o + 3] = (v >>> 24) & 0xff;
}
function putText(b: Uint8Array, o: number, text: string, length: number): void {
  for (let i = 0; i < length; i++) b[o + i] = i < text.length ? text.charCodeAt(i) & 0xff : 0x20;
}

export interface FormatOptions {
  /** Up to 11 characters (upper-cased); default `NO NAME`. */
  label?: string;
  /** The volume serial number. */
  volumeId?: number;
  /** First sector of the partition (default 8192: 4 MiB, as the SD Association's formatter aligns). */
  partitionStart?: number;
  /** Default 64 (32 KiB clusters, what cards of 8–32 GB ship with). */
  sectorsPerCluster?: number;
}

/** Erases `blocks` and writes an MBR with one FAT32 partition filling the card, and an empty volume. */
export function formatFat32(blocks: SparseBlocks, options: FormatOptions = {}): void {
  const start = options.partitionStart ?? 8192;
  const spc = options.sectorsPerCluster ?? 64;
  const total = blocks.count - start;
  const reserved = 32;
  const fats = 2;
  const fatSize = Math.ceil((total - reserved) / ((256 * spc + fats) / 2));
  const clusters = Math.floor((total - reserved - fats * fatSize) / spc);
  if (clusters < 65525) throw new Error(`a ${blocks.count}-block card is too small for FAT32 with ${spc}-sector clusters`);
  const label = (options.label ?? 'NO NAME').toUpperCase().slice(0, 11);
  blocks.clear();

  const mbr = blocks.writable(0);
  mbr.set([0x00, 0xfe, 0xff, 0xff, 0x0c, 0xfe, 0xff, 0xff], 446); // active no, CHS beyond range, type FAT32 (LBA)
  put32(mbr, 454, start);
  put32(mbr, 458, total);
  mbr[510] = 0x55;
  mbr[511] = 0xaa;

  const boot = blocks.writable(start);
  boot.set([0xeb, 0x58, 0x90], 0);
  putText(boot, 3, 'BENCHTOP', 8);
  put16(boot, 11, BLOCK);
  boot[13] = spc;
  put16(boot, 14, reserved);
  boot[16] = fats;
  boot[21] = 0xf8; // fixed media
  put16(boot, 24, 63); // sectors per track
  put16(boot, 26, 255); // heads
  put32(boot, 28, start); // hidden sectors
  put32(boot, 32, total);
  put32(boot, 36, fatSize);
  put32(boot, 44, 2); // root directory cluster
  put16(boot, 48, 1); // FSInfo sector
  put16(boot, 50, 6); // backup boot sector
  boot[64] = 0x80; // drive number
  boot[66] = 0x29; // extended boot signature
  put32(boot, 67, options.volumeId ?? 0x2026be7c);
  putText(boot, 71, label, 11);
  putText(boot, 82, 'FAT32', 8);
  boot[510] = 0x55;
  boot[511] = 0xaa;

  const info = blocks.writable(start + 1);
  put32(info, 0, 0x41615252);
  put32(info, 484, 0x61417272);
  put32(info, 488, clusters - 1); // the root directory has cluster 2
  put32(info, 492, 3);
  put32(info, 508, 0xaa550000);
  blocks.write(start + 6, boot);
  blocks.write(start + 7, info);

  for (let f = 0; f < fats; f++) {
    const fat = blocks.writable(start + reserved + f * fatSize);
    put32(fat, 0, 0x0ffffff8);
    put32(fat, 4, 0x0fffffff);
    put32(fat, 8, 0x0fffffff); // the root directory: one cluster
  }
  const root = blocks.writable(start + reserved + fats * fatSize);
  putText(root, 0, label, 11);
  root[11] = ATTR_VOLUME;
  put16(root, 22, STAMP_TIME);
  put16(root, 24, STAMP_DATE);
}

interface DirEntry {
  /** The long name when there is one, else the short name as shown. */
  readonly name: string;
  /** The 11 raw bytes of the short name, as a string. */
  readonly key: string;
  readonly attr: number;
  readonly cluster: number;
  readonly size: number;
  readonly date: number;
  readonly time: number;
  /** [sector, byte offset] of every slot the entry uses: long-name pieces, then the short entry. */
  readonly slots: readonly (readonly [number, number])[];
}

/** A mounted FAT16 or FAT32 volume. Cheap to mount; holds no state the blocks don't. */
export class FatVolume {
  readonly type: 16 | 32;
  /** Bytes in a cluster. */
  readonly clusterBytes: number;
  /** Data clusters (numbered 2 … clusters + 1). */
  readonly clusters: number;
  readonly label: string;
  private readonly blocks: SparseBlocks;
  private readonly spc: number;
  private readonly fatStart: number;
  private readonly fatSize: number;
  private readonly fats: number;
  private readonly rootStart: number;
  private readonly rootSectors: number;
  private readonly dataStart: number;
  /** The root directory's first cluster; 0 = FAT16's fixed root. */
  private readonly root: number;
  private readonly infoSector: number;
  private free = -1;
  private hint = 2;

  /** Mounts the volume `blocks` hold (an MBR's first partition, or a volume from sector 0), or null. */
  static mount(blocks: SparseBlocks): FatVolume | null {
    const first = blocks.peek(0);
    if (first[510] !== 0x55 || first[511] !== 0xaa) return null;
    let start = 0;
    if (!isBootSector(first)) {
      const type = first[450];
      start = u32(first, 454);
      if (type === 0 || type === 0xee || start === 0 || start >= blocks.count) return null;
    }
    const boot = blocks.peek(start);
    if (!isBootSector(boot)) return null;
    const volume = new FatVolume(blocks, start, boot);
    return volume.clusters >= 4085 ? volume : null; // FAT12 isn't written by any card
  }

  private constructor(blocks: SparseBlocks, start: number, boot: Uint8Array) {
    this.blocks = blocks;
    this.spc = boot[13];
    this.clusterBytes = this.spc * BLOCK;
    const reserved = u16(boot, 14);
    this.fats = boot[16];
    const rootEntries = u16(boot, 17);
    const total = u16(boot, 19) || u32(boot, 32);
    this.fatSize = u16(boot, 22) || u32(boot, 36);
    this.rootSectors = Math.ceil((rootEntries * 32) / BLOCK);
    this.fatStart = start + reserved;
    this.rootStart = this.fatStart + this.fats * this.fatSize;
    this.dataStart = this.rootStart + this.rootSectors;
    this.clusters = Math.max(0, Math.floor((total - (reserved + this.fats * this.fatSize + this.rootSectors)) / this.spc));
    this.type = this.clusters < 65525 ? 16 : 32;
    this.root = this.type === 32 ? u32(boot, 44) : 0;
    this.infoSector = this.type === 32 ? start + u16(boot, 48) : -1;
    const labelAt = this.type === 32 ? 71 : 43;
    this.label = String.fromCharCode(...boot.subarray(labelAt, labelAt + 11)).trimEnd();
    if (this.infoSector >= 0) {
      const info = blocks.peek(this.infoSector);
      const next = u32(info, 492);
      if (u32(info, 0) === 0x41615252 && next >= 2 && next < this.clusters + 2) this.hint = next;
    }
  }

  /** Free clusters, counted from the FAT (FSInfo's count isn't kept by every library). */
  freeClusters(): number {
    if (this.free < 0) {
      let free = 0;
      const perSector = BLOCK / (this.type === 32 ? 4 : 2);
      const end = this.clusters + 2;
      for (let s = 0; s * perSector < end; s++) {
        const from = Math.max(2, s * perSector);
        const to = Math.min(end, (s + 1) * perSector);
        if (!this.blocks.has(this.fatStart + s)) free += Math.max(0, to - from); // never written: all free
        else for (let c = from; c < to; c++) if (this.fat(c) === 0) free++;
      }
      this.free = free;
    }
    return this.free;
  }

  /** Every file and directory, depth first. */
  list(): StoredFile[] {
    const out: StoredFile[] = [];
    const walk = (cluster: number, prefix: string, depth: number): void => {
      if (depth > 16) return;
      for (const e of this.readDir(cluster)) {
        if (e.name === '.' || e.name === '..') continue;
        const path = prefix + e.name;
        const dir = (e.attr & ATTR_DIR) !== 0;
        out.push({ path, dir, size: dir ? 0 : e.size, modified: stamp(e.date, e.time) });
        if (dir && e.cluster >= 2) walk(e.cluster, `${path}/`, depth + 1);
      }
    };
    walk(this.root, '', 0);
    return out;
  }

  /** A file's bytes, or undefined. */
  read(path: string): Uint8Array | undefined {
    const e = this.find(path);
    if (e === undefined || (e.attr & ATTR_DIR) !== 0) return undefined;
    const out = new Uint8Array(e.size);
    let at = 0;
    for (const c of this.chain(e.cluster)) {
      for (let s = 0; s < this.spc && at < e.size; s++) {
        const n = Math.min(BLOCK, e.size - at);
        out.set(this.blocks.peek(this.sector(c) + s).subarray(0, n), at);
        at += n;
      }
      if (at >= e.size) break;
    }
    return at === e.size ? out : out.subarray(0, at);
  }

  /** Creates or replaces a file, making directories on the way. False when it can't (full, a name taken by a directory). */
  write(path: string, bytes: Uint8Array): boolean {
    const parts = splitPath(path);
    if (parts.length === 0) return false;
    const dir = this.dirFor(parts.slice(0, -1), true);
    if (dir < 0) return false;
    const name = parts[parts.length - 1];
    const existing = this.lookup(dir, name);
    if (existing !== undefined && (existing.attr & ATTR_DIR) !== 0) return false;
    const need = Math.ceil(bytes.length / this.clusterBytes);
    const old = existing === undefined ? [] : this.chain(existing.cluster);
    if (need > this.freeClusters() + old.length) return false;
    if (existing !== undefined) this.freeChain(existing.cluster);
    const first = need === 0 ? 0 : this.allocate(need);
    if (first < 0) return false;
    let at = 0;
    for (const c of this.chain(first)) {
      for (let s = 0; s < this.spc; s++) {
        const lba = this.sector(c) + s;
        if (at >= bytes.length) this.blocks.erase(lba, lba);
        else {
          const block = this.blocks.writable(lba);
          block.fill(0);
          block.set(bytes.subarray(at, Math.min(at + BLOCK, bytes.length)));
        }
        at += BLOCK;
      }
    }
    if (existing !== undefined) {
      const [sector, offset] = existing.slots[existing.slots.length - 1];
      const b = this.blocks.writable(sector);
      setCluster(b, offset, first);
      put32(b, offset + 28, bytes.length);
      put16(b, offset + 22, STAMP_TIME);
      put16(b, offset + 24, STAMP_DATE);
      b[offset + 11] |= ATTR_ARCHIVE;
      this.syncInfo();
      return true;
    }
    const ok = this.createEntry(dir, name, ATTR_ARCHIVE, first, bytes.length);
    if (!ok && first !== 0) this.freeChain(first);
    this.syncInfo();
    return ok;
  }

  /** Makes a directory (and its parents). True when it exists afterwards. */
  mkdir(path: string): boolean {
    const parts = splitPath(path);
    return parts.length > 0 && this.dirFor(parts, true) >= 0;
  }

  /** Removes a file, or a directory with everything in it. */
  remove(path: string): boolean {
    const parts = splitPath(path);
    if (parts.length === 0) return false;
    const dir = this.dirFor(parts.slice(0, -1), false);
    if (dir < 0) return false;
    const e = this.lookup(dir, parts[parts.length - 1]);
    if (e === undefined) return false;
    this.removeEntry(e, 0);
    this.syncInfo();
    return true;
  }

  private removeEntry(e: DirEntry, depth: number): void {
    if ((e.attr & ATTR_DIR) !== 0 && e.cluster >= 2 && depth < 16) {
      for (const child of this.readDir(e.cluster)) if (child.name !== '.' && child.name !== '..') this.removeEntry(child, depth + 1);
    }
    if (e.cluster >= 2) this.freeChain(e.cluster);
    for (const [sector, offset] of e.slots) this.blocks.writable(sector)[offset] = DELETED;
  }

  // ---- directories ----

  /** Walks (and with `make`, creates) the directories `parts`; their last cluster, or -1. */
  private dirFor(parts: readonly string[], make: boolean): number {
    let dir = this.root;
    for (const name of parts) {
      const e = this.lookup(dir, name);
      if (e !== undefined) {
        if ((e.attr & ATTR_DIR) === 0) return -1;
        dir = e.cluster < 2 ? this.root : e.cluster;
      } else if (!make) return -1;
      else {
        dir = this.makeDir(dir, name);
        if (dir < 0) return -1;
      }
    }
    return dir;
  }

  private makeDir(parent: number, name: string): number {
    if (this.freeClusters() < 1) return -1;
    const c = this.allocate(1);
    if (c < 0) return -1;
    const lba = this.sector(c);
    this.blocks.erase(lba, lba + this.spc - 1);
    const b = this.blocks.writable(lba);
    writeShort(b, 0, '.          ', ATTR_DIR, c, 0, 0);
    writeShort(b, 32, '..         ', ATTR_DIR, parent === this.root ? 0 : parent, 0, 0);
    if (!this.createEntry(parent, name, ATTR_DIR, c, 0)) {
      this.freeChain(c);
      return -1;
    }
    return c;
  }

  private lookup(dir: number, name: string): DirEntry | undefined {
    const want = name.toUpperCase();
    for (const e of this.readDir(dir)) if (e.name.toUpperCase() === want || shortShown(e.key, 0).toUpperCase() === want) return e;
    return undefined;
  }

  private find(path: string): DirEntry | undefined {
    const parts = splitPath(path);
    if (parts.length === 0) return undefined;
    const dir = this.dirFor(parts.slice(0, -1), false);
    return dir < 0 ? undefined : this.lookup(dir, parts[parts.length - 1]);
  }

  /** The sectors of a directory: FAT16's fixed root, or a cluster chain's. */
  private dirSectors(dir: number): number[] {
    const out: number[] = [];
    if (dir === 0) {
      for (let s = 0; s < this.rootSectors; s++) out.push(this.rootStart + s);
      return out;
    }
    for (const c of this.chain(dir)) for (let s = 0; s < this.spc; s++) out.push(this.sector(c) + s);
    return out;
  }

  private readDir(dir: number): DirEntry[] {
    const out: DirEntry[] = [];
    let pieces: string[] = [];
    let slots: (readonly [number, number])[] = [];
    let sum = -1;
    for (const sector of this.dirSectors(dir)) {
      const b = this.blocks.peek(sector);
      for (let o = 0; o < BLOCK; o += 32) {
        const first = b[o];
        if (first === 0) return out;
        const attr = b[o + 11];
        if (first === DELETED) {
          pieces = [];
          slots = [];
          continue;
        }
        if ((attr & 0x3f) === ATTR_LFN) {
          if ((first & 0x40) !== 0) {
            pieces = [];
            slots = [];
            sum = b[o + 13];
          }
          const ordinal = first & 0x1f;
          if (ordinal >= 1 && ordinal <= 20) pieces[ordinal - 1] = longPiece(b, o);
          slots.push([sector, o]);
          continue;
        }
        if ((attr & ATTR_VOLUME) !== 0) {
          pieces = [];
          slots = [];
          continue;
        }
        const key = String.fromCharCode(...b.subarray(o, o + 11));
        const long = pieces.length > 0 && sum === checksum(b, o) ? pieces.join('') : '';
        const cluster = (this.type === 32 ? u16(b, o + 20) << 16 : 0) | u16(b, o + 26);
        out.push({
          name: long !== '' ? long : shortShown(key, b[o + 12]),
          key,
          attr,
          cluster: cluster >>> 0,
          size: u32(b, o + 28),
          date: u16(b, o + 24),
          time: u16(b, o + 22),
          slots: [...slots, [sector, o]],
        });
        pieces = [];
        slots = [];
      }
    }
    return out;
  }

  /** Writes the entries for `name` into `dir` (long-name pieces when the name needs them). */
  private createEntry(dir: number, name: string, attr: number, cluster: number, size: number): boolean {
    if (name.length > 255 || name === '.' || name === '..' || /[\\/:*?"<>|\x00-\x1f]/.test(name)) return false;
    const taken = new Set(this.readDir(dir).map((e) => e.key));
    const fit = fits83(name);
    let key: string;
    let nt = 0;
    let long = false;
    if (fit !== null) {
      key = fit.key;
      nt = fit.nt;
      if (taken.has(key)) return false;
    } else {
      key = basisName(name, taken);
      long = true;
    }
    const pieces = long ? Math.ceil(name.length / 13) : 0;
    let slots = this.freeSlots(dir, pieces + 1);
    if (slots === null && dir !== 0) {
      if (!this.extendDir(dir)) return false;
      slots = this.freeSlots(dir, pieces + 1);
    }
    if (slots === null) return false;
    const short = Uint8Array.from(key, (ch) => ch.charCodeAt(0));
    const sum = checksumOf(short);
    for (let i = 0; i < pieces; i++) {
      const ordinal = pieces - i;
      const [sector, offset] = slots[i];
      writeLongPiece(this.blocks.writable(sector), offset, name, ordinal, ordinal === pieces, sum);
    }
    const [sector, offset] = slots[pieces];
    const b = this.blocks.writable(sector);
    writeShort(b, offset, key, attr, cluster, size, nt);
    return true;
  }

  /** `count` consecutive free slots in a directory, or null. */
  private freeSlots(dir: number, count: number): [number, number][] | null {
    let run: [number, number][] = [];
    for (const sector of this.dirSectors(dir)) {
      const b = this.blocks.peek(sector);
      for (let o = 0; o < BLOCK; o += 32) {
        const first = b[o];
        if (first === 0 || first === DELETED) {
          run.push([sector, o]);
          if (run.length === count) return run;
        } else run = [];
      }
    }
    return null;
  }

  private extendDir(dir: number): boolean {
    const chain = this.chain(dir);
    if (this.freeClusters() < 1) return false;
    const c = this.allocate(1);
    if (c < 0) return false;
    const lba = this.sector(c);
    this.blocks.erase(lba, lba + this.spc - 1);
    this.setFat(chain[chain.length - 1], c);
    return true;
  }

  // ---- clusters ----

  private sector(cluster: number): number {
    return this.dataStart + (cluster - 2) * this.spc;
  }

  private fat(cluster: number): number {
    if (this.type === 32) {
      const at = cluster * 4;
      return u32(this.blocks.peek(this.fatStart + (at >>> 9)), at & 511) & 0x0fffffff;
    }
    const at = cluster * 2;
    return u16(this.blocks.peek(this.fatStart + (at >>> 9)), at & 511);
  }

  private setFat(cluster: number, value: number): void {
    const width = this.type === 32 ? 4 : 2;
    const at = cluster * width;
    for (let f = 0; f < this.fats; f++) {
      const b = this.blocks.writable(this.fatStart + f * this.fatSize + (at >>> 9));
      if (width === 4) put32(b, at & 511, (u32(b, at & 511) & 0xf0000000) | (value & 0x0fffffff));
      else put16(b, at & 511, value);
    }
  }

  private isEnd(value: number): boolean {
    return this.type === 32 ? value >= 0x0ffffff8 : value >= 0xfff8;
  }

  /** The clusters of a chain from `first` (none for 0), guarded against loops. */
  private chain(first: number): number[] {
    const out: number[] = [];
    let c = first;
    while (c >= 2 && c < this.clusters + 2 && out.length <= this.clusters) {
      out.push(c);
      const next = this.fat(c);
      if (this.isEnd(next) || next < 2) break;
      c = next;
    }
    return out;
  }

  /** Links `count` free clusters into a chain; its first cluster, or -1 (nothing changed). */
  private allocate(count: number): number {
    const found: number[] = [];
    const span = this.clusters;
    for (let i = 0; i < span && found.length < count; i++) {
      const c = 2 + ((this.hint - 2 + i) % span);
      if (this.fat(c) === 0) found.push(c);
    }
    if (found.length < count) return -1;
    const end = this.type === 32 ? 0x0fffffff : 0xffff;
    for (let i = 0; i < found.length; i++) this.setFat(found[i], i + 1 < found.length ? found[i + 1] : end);
    this.hint = found[found.length - 1] + 1 < this.clusters + 2 ? found[found.length - 1] + 1 : 2;
    if (this.free >= 0) this.free -= count;
    return found[0];
  }

  private freeChain(first: number): void {
    const chain = this.chain(first);
    for (const c of chain) this.setFat(c, 0);
    if (this.free >= 0) this.free += chain.length;
  }

  /** Keeps FAT32's FSInfo in step with what this library changed. */
  private syncInfo(): void {
    if (this.infoSector < 0) return;
    const info = this.blocks.writable(this.infoSector);
    if (u32(info, 0) !== 0x41615252) return;
    put32(info, 488, this.freeClusters());
    put32(info, 492, this.hint);
  }
}

function isBootSector(b: Uint8Array): boolean {
  return (b[0] === 0xeb || b[0] === 0xe9) && u16(b, 11) === BLOCK && b[13] !== 0 && (b[13] & (b[13] - 1)) === 0 && u16(b, 14) !== 0 && b[16] !== 0;
}

function splitPath(path: string): string[] {
  return path.split('/').filter((p) => p !== '' && p !== '.');
}

function setCluster(b: Uint8Array, offset: number, cluster: number): void {
  put16(b, offset + 20, cluster >>> 16);
  put16(b, offset + 26, cluster & 0xffff);
}

function writeShort(b: Uint8Array, offset: number, key: string, attr: number, cluster: number, size: number, nt: number): void {
  b.fill(0, offset, offset + 32);
  for (let i = 0; i < 11; i++) b[offset + i] = key.charCodeAt(i) & 0xff;
  b[offset + 11] = attr;
  b[offset + 12] = nt;
  put16(b, offset + 14, STAMP_TIME); // created
  put16(b, offset + 16, STAMP_DATE);
  put16(b, offset + 18, STAMP_DATE); // accessed
  setCluster(b, offset, cluster);
  put16(b, offset + 22, STAMP_TIME);
  put16(b, offset + 24, STAMP_DATE);
  put32(b, offset + 28, size);
}

/** Byte offsets of a long-name piece's 13 UCS-2 characters. */
const LONG_AT = [1, 3, 5, 7, 9, 14, 16, 18, 20, 22, 24, 28, 30];

function longPiece(b: Uint8Array, o: number): string {
  let s = '';
  for (const at of LONG_AT) {
    const ch = u16(b, o + at);
    if (ch === 0 || ch === 0xffff) break;
    s += String.fromCharCode(ch);
  }
  return s;
}

function writeLongPiece(b: Uint8Array, o: number, name: string, ordinal: number, last: boolean, sum: number): void {
  b.fill(0, o, o + 32);
  b[o] = ordinal | (last ? 0x40 : 0);
  b[o + 11] = ATTR_LFN;
  b[o + 13] = sum;
  const base = (ordinal - 1) * 13;
  for (let i = 0; i < 13; i++) {
    const at = base + i;
    put16(b, o + LONG_AT[i], at < name.length ? name.charCodeAt(at) : at === name.length ? 0 : 0xffff);
  }
}

function checksum(b: Uint8Array, o: number): number {
  return checksumOf(b.subarray(o, o + 11));
}

function checksumOf(short: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < 11; i++) sum = (((sum & 1) << 7) + (sum >> 1) + short[i]) & 0xff;
  return sum;
}

/** A short entry's name as shown: `LOG.TXT`, or `log.txt` with the NT lower-case flags. */
function shortShown(key: string, nt: number): string {
  let base = key.slice(0, 8).trimEnd();
  let ext = key.slice(8, 11).trimEnd();
  if (base.charCodeAt(0) === 0x05) base = `\xe5${base.slice(1)}`;
  if ((nt & NT_LOWER_BASE) !== 0) base = base.toLowerCase();
  if ((nt & NT_LOWER_EXT) !== 0) ext = ext.toLowerCase();
  return ext === '' ? base : `${base}.${ext}`;
}

/** The 8.3 entry for a name that fits one as it is (one case per part), or null. */
function fits83(name: string): { key: string; nt: number } | null {
  const dot = name.lastIndexOf('.');
  const base = dot < 0 ? name : name.slice(0, dot);
  const ext = dot < 0 ? '' : name.slice(dot + 1);
  if (base.length < 1 || base.length > 8 || ext.length > 3 || (dot >= 0 && ext === '')) return null;
  const B = base.toUpperCase();
  const E = ext.toUpperCase();
  if (!SHORT_CHARS.test(B) || (E !== '' && !SHORT_CHARS.test(E))) return null;
  let nt = 0;
  if (base !== B) {
    if (base !== base.toLowerCase()) return null;
    nt |= NT_LOWER_BASE;
  }
  if (ext !== E) {
    if (ext !== ext.toLowerCase()) return null;
    nt |= NT_LOWER_EXT;
  }
  return { key: B.padEnd(8) + E.padEnd(3), nt };
}

/** A unique `BASIS~N.EXT` short name for a long name. */
function basisName(name: string, taken: ReadonlySet<string>): string {
  const clean = (s: string): string => s.toUpperCase().replace(/[ .]/g, '').replace(/[^A-Z0-9!#$%&'()\-@^_`{}~]/g, '_');
  const trimmed = name.replace(/^\.+/, '');
  const dot = trimmed.lastIndexOf('.');
  const base = clean(dot < 0 ? trimmed : trimmed.slice(0, dot)) || '_';
  const ext = clean(dot < 0 ? '' : trimmed.slice(dot + 1)).slice(0, 3);
  for (let n = 1; n < 1_000_000; n++) {
    const tail = `~${n}`;
    const key = (base.slice(0, 8 - tail.length) + tail).padEnd(8) + ext.padEnd(3);
    if (!taken.has(key)) return key;
  }
  throw new Error('no short name left');
}

function stamp(date: number, time: number): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${1980 + (date >>> 9)}-${p((date >>> 5) & 15)}-${p(date & 31)} ${p(time >>> 11)}:${p((time >>> 5) & 63)}:${p((time & 31) * 2)}`;
}
