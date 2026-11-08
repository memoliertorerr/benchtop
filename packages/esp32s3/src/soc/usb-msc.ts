/**
 * USB mass storage on the bench's host (BT141), written from the USB Mass Storage Class Bulk-Only
 * Transport 1.0 and the SCSI command layouts a computer sends (SPC/SBC: INQUIRY, TEST UNIT READY,
 * REQUEST SENSE, READ CAPACITY(10), MODE SENSE(6), READ(10), WRITE(10)). Chip-neutral, DOM-free.
 *
 * Bulk-Only: each command is a 31-byte CBW on the bulk OUT endpoint ("USBC", a tag, the data
 * length and direction, the LUN, a CDB), then the data stage, then a 13-byte CSW on the bulk IN
 * endpoint ("USBS", the tag, the residue, a status: 0 passed, 1 failed, 2 phase error). A failed
 * command is followed by REQUEST SENSE (what a computer logs); a stalled endpoint is cleared with
 * CLEAR_FEATURE(ENDPOINT_HALT) and the CSW read after.
 *
 * The drive: INQUIRY, TEST UNIT READY (again every 100 frames while the medium is absent),
 * READ CAPACITY(10), MODE SENSE(6) (write protect), then the mount. Reading is demand-paged: the
 * core's FAT library mounts and lists through `DriveBlocks`, a block cache that records the blocks
 * it lacked; the drive fetches them (READ(10), up to 8 blocks a command) and tries again. The
 * volume's system area (boot sector, FATs, a FAT12/16 root) comes whole first when it is at most
 * 4 MB — without it the bench doesn't write —, then the directories, then file data, at most 1 MB
 * of it per mount (a file past that is read when asked: `read` queues its blocks and answers
 * undefined until they are in). Like a computer, the host polls TEST UNIT READY every second: a
 * medium gone drops the cache, its return mounts it again. Writes go into the cache at once and
 * out as WRITE(10) commands, in block order. 512-byte blocks only.
 */

import { BLOCK, FatVolume, type PartStorage, SparseBlocks, type StoredFile } from '@benchtop/core';
import { USB_NAK, USB_STALL, type UsbDevicePort } from './usb-host.ts';

/** File data a mount reads before it is asked (bytes). */
export const MSC_DATA_LIMIT = 1024 * 1024;
/** The most of a volume's system area (boot sector, FATs, root) a mount reads whole (bytes). */
export const MSC_SYSTEM_LIMIT = 4 * 1024 * 1024;
/** Frames between TEST UNIT READY polls: mounted (a computer's 1 s) and while the medium is absent. */
const POLL_FRAMES = 1000;
const ABSENT_FRAMES = 100;
const BLOCKS_PER_COMMAND = 8;
const CBW_SIGNATURE = 0x43425355;
const CSW_SIGNATURE = 0x53425355;
/** Packets per endpoint per service call. */
const BURST = 4;

/** The block cache the FAT library reads through: what it lacked is recorded, what it changed is dirty. */
export class DriveBlocks extends SparseBlocks {
  /** Blocks the device has given (or the bench wrote). */
  readonly fetched = new Set<number>();
  /** Blocks asked for but not fetched since `missing` was last cleared. */
  readonly missing = new Set<number>();
  /** Blocks written here and not yet on the device. */
  readonly dirty = new Set<number>();

  override peek(lba: number): Uint8Array {
    if (!this.fetched.has(lba)) this.missing.add(lba);
    return super.peek(lba);
  }

  override writable(lba: number): Uint8Array {
    this.fetched.add(lba);
    this.dirty.add(lba);
    return super.writable(lba);
  }

  /** A block the device gave (a block written here since keeps its newer bytes). */
  fill(lba: number, data: Uint8Array, offset: number): void {
    if (this.fetched.has(lba)) return;
    this.fetched.add(lba);
    let zero = true;
    for (let i = 0; i < BLOCK; i++) if (data[offset + i] !== 0) zero = false;
    if (!zero) super.writable(lba).set(data.subarray(offset, offset + BLOCK));
  }
}

interface Command {
  readonly cdb: readonly number[];
  readonly length: number;
  readonly toHost: boolean;
  readonly out: Uint8Array | null;
  readonly done: (status: number, data: Uint8Array) => void;
}

/** Where the drive is: being probed, no medium, being read, mounted, not a FAT volume we read, or gone wrong. */
export type DriveState = 'probing' | 'no-medium' | 'reading' | 'mounted' | 'unreadable' | 'failed';

/** What a host does for the drive besides its bulk endpoints: control requests on endpoint 0. */
export interface DriveHost {
  request(bmRequestType: number, bRequest: number, wValue: number, wIndex: number, wLength: number, out: Uint8Array | null, done: (data: Uint8Array | null) => void): void;
  /** Frames since the host started (1 ms each). */
  frames(): number;
  /** Something worth naming once (`onNote`). */
  note(message: string): void;
}

export class MscDrive {
  readonly iface: number;
  readonly bulkIn: number;
  readonly bulkOut: number;
  private readonly outSize: number;
  private readonly host: DriveHost;
  state: DriveState = 'probing';
  /** Why the drive is unreadable or failed, for people. */
  problem = '';
  vendor = '';
  product = '';
  revision = '';
  /** Logical blocks and their size (READ CAPACITY). */
  blocks = 0;
  blockSize = 0;
  writeProtected = false;
  /** LUNs the device has (GET MAX LUN + 1); LUN 0 is read. */
  luns = 1;
  /** Bumped by every change: a mount, a drop, a write. */
  version = 0;
  /** Files whose data the mount didn't read (past MSC_DATA_LIMIT). */
  readonly unread = new Set<string>();
  private cache: DriveBlocks | null = null;
  private volume: FatVolume | null = null;
  /** The system area is cached whole: the bench may write. */
  private writable = false;
  private dataRead = 0;
  private readonly queue: Command[] = [];
  private current: Command | null = null;
  private phase: 'cbw' | 'data' | 'csw' = 'cbw';
  private tag = 0;
  private data = new Uint8Array(0);
  private dataLength = 0;
  private outSent = 0;
  private stalled = false;
  private readonly packet = new Uint8Array(64);
  private readonly cbw = new Uint8Array(31);
  /** Fetches in flight, and what runs when they are all in. */
  private fetching = 0;
  private afterFetch: (() => void) | null = null;
  private nextPoll = 0;
  private polling = false;
  /** A CLEAR_FEATURE(ENDPOINT_HALT) is in flight: the current command's status comes after it. */
  private halted = false;
  /** The drive as the board's storage (Bench.storage): its files while mounted. */
  readonly storage: PartStorage;

  constructor(iface: number, bulkIn: number, bulkOut: number, outSize: number, host: DriveHost) {
    this.iface = iface;
    this.bulkIn = bulkIn;
    this.bulkOut = bulkOut;
    this.outSize = outSize;
    this.host = host;
    const drive = this;
    this.storage = {
      get version(): number {
        return drive.version;
      },
      list: (): StoredFile[] => (drive.state === 'mounted' && drive.volume !== null ? drive.volume.list() : []),
      read: (path: string): Uint8Array | undefined => drive.read(path),
      write: (path: string, bytes: Uint8Array): boolean => drive.change((v) => v.write(path, bytes)),
      remove: (path: string): boolean => drive.change((v) => v.remove(path)),
    };
  }

  /** Starts: GET MAX LUN, then the probe. */
  start(): void {
    this.host.request(0xa1, 0xfe, 0, this.iface, 1, null, (data) => {
      // A device with one LUN may stall GET MAX LUN (the spec allows it).
      this.luns = data !== null && data.length > 0 ? data[0] + 1 : 1;
      if (this.luns > 1) this.host.note(`its mass storage has ${this.luns} units (LUNs): the bench's USB host reads the first`);
      this.probe();
    });
  }

  /** The volume's type, label and free space once mounted. */
  get fileSystem(): { type: 12 | 16 | 32; label: string } | null {
    return this.volume === null ? null : { type: this.volume.type, label: this.volume.label };
  }

  // ── Running ──────────────────────────────────────────────────────────────────────────────

  /** One service call: the current command's transactions, and the poll when it is due. */
  service(port: UsbDevicePort): void {
    const frames = this.host.frames();
    if (this.current === null && this.queue.length === 0 && !this.polling && frames >= this.nextPoll && (this.state === 'mounted' || this.state === 'no-medium')) this.poll();
    for (let i = 0; i < BURST * 4; i++) {
      if (this.current === null) {
        const next = this.queue.shift();
        if (next === undefined) return;
        this.current = next;
        this.phase = 'cbw';
      }
      if (!this.step(port)) return;
    }
  }

  private command(cdb: readonly number[], length: number, toHost: boolean, out: Uint8Array | null, done: Command['done']): void {
    this.queue.push({ cdb, length, toHost, out, done });
  }

  /** One transaction of the current command; false when the device NAKed (try on the next call). */
  private step(port: UsbDevicePort): boolean {
    if (this.halted) return false;
    const c = this.current as Command;
    if (this.phase === 'cbw') {
      const w = this.cbw;
      w.fill(0);
      this.tag = (this.tag + 1) >>> 0;
      put32le(w, 0, CBW_SIGNATURE);
      put32le(w, 4, this.tag);
      put32le(w, 8, c.length);
      w[12] = c.toHost ? 0x80 : 0;
      w[13] = 0; // LUN 0
      w[14] = c.cdb.length;
      for (let i = 0; i < c.cdb.length; i++) w[15 + i] = c.cdb[i];
      const result = port.out(this.bulkOut, w, 31);
      if (result === USB_NAK) return false;
      if (result === USB_STALL) return this.fail(`the drive stalled a command (${c.cdb[0].toString(16)})`);
      this.dataLength = 0;
      this.outSent = 0;
      if (c.toHost && this.data.length < c.length) this.data = new Uint8Array(Math.max(c.length, 512));
      this.phase = c.length === 0 ? 'csw' : 'data';
      return true;
    }
    if (this.phase === 'data') {
      if (c.toHost) {
        const n = port.in(this.bulkIn, this.packet);
        if (n === USB_NAK) return false;
        if (n === USB_STALL) return this.clearHalt(true);
        const take = Math.min(n, c.length - this.dataLength);
        this.data.set(this.packet.subarray(0, take), this.dataLength);
        this.dataLength += take;
        if (n < 64 || this.dataLength >= c.length) this.phase = 'csw';
        return true;
      }
      const out = c.out as Uint8Array;
      const n = Math.min(this.outSize, out.length - this.outSent);
      const result = port.out(this.bulkOut, out.subarray(this.outSent), n);
      if (result === USB_NAK) return false;
      if (result === USB_STALL) return this.clearHalt(false);
      this.outSent += n;
      if (this.outSent >= out.length) this.phase = 'csw';
      return true;
    }
    // CSW
    const n = port.in(this.bulkIn, this.packet);
    if (n === USB_NAK) return false;
    if (n === USB_STALL) {
      if (this.stalled) return this.fail('the drive stalled its status twice');
      return this.clearHalt(true);
    }
    this.stalled = false;
    if (n !== 13 || get32le(this.packet, 0) !== CSW_SIGNATURE || get32le(this.packet, 4) !== this.tag) return this.fail('the drive answered a command with a malformed status (CSW)');
    const status = this.packet[12];
    this.current = null;
    c.done(status === 0 ? 0 : status, this.data.subarray(0, this.dataLength));
    return true;
  }

  /** CLEAR_FEATURE(ENDPOINT_HALT) on a stalled endpoint, then the same command's CSW. */
  private clearHalt(inEndpoint: boolean): boolean {
    this.stalled = true;
    this.halted = true;
    this.host.request(0x02, 1, 0, inEndpoint ? 0x80 | this.bulkIn : this.bulkOut, 0, null, () => {
      this.halted = false;
      this.phase = 'csw';
    });
    return false;
  }

  private fail(why: string): boolean {
    this.state = 'failed';
    this.problem = why;
    this.queue.length = 0;
    this.current = null;
    this.halted = false;
    this.version++;
    this.host.note(why);
    return false;
  }

  // ── Probe and mount ──────────────────────────────────────────────────────────────────────

  private probe(): void {
    this.state = 'probing';
    this.command([0x12, 0, 0, 0, 36, 0], 36, true, null, (status, data) => {
      if (status === 0 && data.length >= 36) {
        this.vendor = ascii(data, 8, 8);
        this.product = ascii(data, 16, 16);
        this.revision = ascii(data, 32, 4);
      }
      this.ready();
    });
  }

  /** TEST UNIT READY until the medium is there, then its capacity and write protection. */
  private ready(): void {
    this.command([0, 0, 0, 0, 0, 0], 0, true, null, (status) => {
      if (status !== 0) {
        this.sense(() => {
          if (this.state !== 'no-medium') this.version++;
          this.state = 'no-medium';
          this.nextPoll = this.host.frames() + ABSENT_FRAMES;
        });
        return;
      }
      this.command([0x25, 0, 0, 0, 0, 0, 0, 0, 0, 0], 8, true, null, (s, cap) => {
        if (s !== 0 || cap.length < 8) {
          this.fail('the drive refused READ CAPACITY');
          return;
        }
        this.blocks = get32be(cap, 0) + 1;
        this.blockSize = get32be(cap, 4);
        this.command([0x1a, 0, 0x3f, 0, 4, 0], 4, true, null, (m, mode) => {
          this.writeProtected = m === 0 && mode.length >= 3 && (mode[2] & 0x80) !== 0;
          this.mount();
        });
      });
    });
  }

  /** REQUEST SENSE after a failed command (its answer only matters to a log). */
  private sense(then: () => void): void {
    this.command([0x03, 0, 0, 0, 18, 0], 18, true, null, () => then());
  }

  private mount(): void {
    if (this.blockSize !== BLOCK) {
      this.state = 'unreadable';
      this.problem = `its blocks are ${this.blockSize} bytes; the bench's USB host reads 512-byte blocks`;
      this.version++;
      this.host.note(this.problem);
      return;
    }
    this.state = 'reading';
    this.cache = new DriveBlocks(this.blocks);
    this.volume = null;
    this.writable = false;
    this.dataRead = 0;
    this.unread.clear();
    this.mountStep();
  }

  /** Tries the next mount stage over the cache; fetches what it lacked, then tries again. */
  private mountStep(): void {
    const cache = this.cache as DriveBlocks;
    cache.missing.clear();
    const volume = FatVolume.mount(cache);
    if (cache.missing.size > 0) return this.fetch(cache.missing, () => this.mountStep());
    if (volume === null) {
      this.state = 'unreadable';
      this.problem = "it holds no FAT volume the bench's USB host can read";
      this.version++;
      return;
    }
    if (!this.writable) {
      const area = volume.systemArea;
      if (area.count * BLOCK <= MSC_SYSTEM_LIMIT) {
        const all = new Set<number>();
        for (let lba = area.first; lba < area.first + area.count; lba++) if (!cache.fetched.has(lba)) all.add(lba);
        this.writable = true;
        if (all.size > 0) return this.fetch(all, () => this.mountStep());
      }
    }
    cache.missing.clear();
    const files = volume.list();
    if (cache.missing.size > 0) return this.fetch(cache.missing, () => this.mountStep());
    // File data, in listing order, up to the limit.
    for (const file of files) {
      if (file.dir || this.unread.has(file.path)) continue;
      cache.missing.clear();
      volume.read(file.path);
      if (cache.missing.size === 0) continue;
      const bytes = cache.missing.size * BLOCK;
      if (this.dataRead + bytes > MSC_DATA_LIMIT) {
        this.unread.add(file.path);
        continue;
      }
      this.dataRead += bytes;
      return this.fetch(cache.missing, () => this.mountStep());
    }
    cache.missing.clear();
    this.volume = volume;
    this.state = 'mounted';
    this.nextPoll = this.host.frames() + POLL_FRAMES;
    this.version++;
  }

  /** READ(10) commands for `lbas` (runs of up to 8), then `then` once all are in. */
  private fetch(lbas: ReadonlySet<number>, then: () => void): void {
    const sorted = [...lbas].sort((a, b) => a - b);
    this.afterFetch = then;
    for (let i = 0; i < sorted.length; ) {
      const first = sorted[i];
      let count = 1;
      while (i + count < sorted.length && count < BLOCKS_PER_COMMAND && sorted[i + count] === first + count) count++;
      i += count;
      if (first + count > this.blocks) continue;
      this.fetching++;
      const cdb = [0x28, 0, (first >>> 24) & 0xff, (first >>> 16) & 0xff, (first >>> 8) & 0xff, first & 0xff, 0, (count >>> 8) & 0xff, count & 0xff, 0];
      this.command(cdb, count * BLOCK, true, null, (status, data) => {
        if (status !== 0 || data.length < count * BLOCK) {
          this.sense(() => this.fail(`the drive failed READ(10) of blocks ${first}–${first + count - 1}`));
          return;
        }
        const cache = this.cache;
        if (cache !== null) for (let k = 0; k < count; k++) cache.fill(first + k, data, k * BLOCK);
        if (--this.fetching === 0) {
          const next = this.afterFetch;
          this.afterFetch = null;
          next?.();
        }
      });
    }
    if (this.fetching === 0) {
      this.afterFetch = null;
      then();
    }
  }

  /** The poll: TEST UNIT READY; a medium gone drops the cache, one back mounts again. */
  private poll(): void {
    this.polling = true;
    this.command([0, 0, 0, 0, 0, 0], 0, true, null, (status) => {
      this.polling = false;
      const frames = this.host.frames();
      if (status === 0) {
        if (this.state === 'no-medium') this.ready();
        else this.nextPoll = frames + POLL_FRAMES;
        return;
      }
      this.sense(() => {
        if (this.state === 'mounted') {
          this.cache = null;
          this.volume = null;
          this.writable = false;
          this.version++;
        }
        this.state = 'no-medium';
        this.nextPoll = this.host.frames() + ABSENT_FRAMES;
      });
    });
  }

  // ── Files ────────────────────────────────────────────────────────────────────────────────

  private read(path: string): Uint8Array | undefined {
    const volume = this.volume;
    const cache = this.cache;
    if (this.state !== 'mounted' || volume === null || cache === null) return undefined;
    cache.missing.clear();
    const bytes = volume.read(path);
    if (cache.missing.size === 0) return bytes;
    // Not read yet (past the mount's limit): fetch it now, answer once it is in.
    if (this.fetching === 0) {
      this.fetch(new Set(cache.missing), () => {
        this.unread.delete(path);
        this.version++;
      });
    }
    cache.missing.clear();
    return undefined;
  }

  /** A change to the files (the bench's): into the cache, then out as WRITE(10) commands. */
  private change(apply: (volume: FatVolume) => boolean): boolean {
    const volume = this.volume;
    const cache = this.cache;
    if (this.state !== 'mounted' || volume === null || cache === null || !this.writable || this.writeProtected) return false;
    cache.missing.clear();
    const ok = apply(volume);
    cache.missing.clear();
    if (cache.dirty.size > 0) this.flush();
    if (ok) this.version++;
    return ok;
  }

  /** WRITE(10) commands for the dirty blocks, in order (runs of up to 8). */
  private flush(): void {
    const cache = this.cache as DriveBlocks;
    const sorted = [...cache.dirty].sort((a, b) => a - b);
    cache.dirty.clear();
    for (let i = 0; i < sorted.length; ) {
      const first = sorted[i];
      let count = 1;
      while (i + count < sorted.length && count < BLOCKS_PER_COMMAND && sorted[i + count] === first + count) count++;
      i += count;
      const out = new Uint8Array(count * BLOCK);
      for (let k = 0; k < count; k++) out.set(cache.peek(first + k), k * BLOCK);
      const cdb = [0x2a, 0, (first >>> 24) & 0xff, (first >>> 16) & 0xff, (first >>> 8) & 0xff, first & 0xff, 0, (count >>> 8) & 0xff, count & 0xff, 0];
      this.command(cdb, out.length, false, out, (status) => {
        if (status !== 0) this.sense(() => this.host.note(`the drive refused a write to blocks ${first}–${first + count - 1}`));
      });
    }
  }
}

function ascii(b: Uint8Array, at: number, length: number): string {
  let s = '';
  for (let i = 0; i < length; i++) s += String.fromCharCode(b[at + i] >= 0x20 && b[at + i] < 0x7f ? b[at + i] : 0x20);
  return s.trim();
}

function put32le(b: Uint8Array, at: number, v: number): void {
  b[at] = v & 0xff;
  b[at + 1] = (v >>> 8) & 0xff;
  b[at + 2] = (v >>> 16) & 0xff;
  b[at + 3] = (v >>> 24) & 0xff;
}

function get32le(b: Uint8Array, at: number): number {
  return (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
}

function get32be(b: Uint8Array, at: number): number {
  return ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
}
