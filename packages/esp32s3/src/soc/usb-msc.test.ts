import { BLOCK, FatVolume, SparseBlocks, Strength } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { CODE_S3_USB_DEVICE, createEsp32s3Mcu } from '../esp32s3-mcu.ts';
import { s3FixtureImage } from '../test-support/boot.test-helper.ts';
import { loadCachedS3Rom } from '../test-support/rom.test-helper.ts';
import { REF_HZ } from './rtc-cntl.ts';
import { USB_ACK, USB_NAK, USB_STALL, type UsbDevicePort } from './usb-host.ts';
import { type DriveHost, MSC_DATA_LIMIT, MscDrive } from './usb-msc.ts';

// BT141: USB mass storage on the bench's host — Bulk-Only Transport and SCSI against a scripted
// target (written here from the BOT and SCSI layouts), the demand-paged mount over the core's FAT
// library, the data limit, writes, and the medium coming and going.

/** A bare FAT volume laid out from the FAT spec (boot sector, FATs, a fixed root, data). */
function volume(total: number, fatSectors: number, spc = 1): SparseBlocks {
  const blocks = new SparseBlocks(total);
  const b = blocks.writable(0);
  b.set([0xeb, 0x3c, 0x90], 0);
  const put16 = (o: number, v: number) => {
    b[o] = v & 0xff;
    b[o + 1] = v >>> 8;
  };
  put16(11, BLOCK);
  b[13] = spc;
  put16(14, 1);
  b[16] = 1;
  put16(17, 16);
  if (total < 0x10000) put16(19, total);
  else {
    b[32] = total & 0xff;
    b[33] = (total >>> 8) & 0xff;
    b[34] = (total >>> 16) & 0xff;
  }
  b[21] = 0xf8;
  put16(22, fatSectors);
  b.set(new TextEncoder().encode('TEST DRIVE '), 43);
  b[510] = 0x55;
  b[511] = 0xaa;
  return blocks;
}

/** A SCSI disk behind Bulk-Only endpoints 1 IN / 1 OUT, over `disk`'s blocks. */
class Target implements UsbDevicePort {
  readonly opcodes: string[] = [];
  present = true;
  writeProtect = false;
  blockSize = BLOCK;
  /** Stall the next data stage of this opcode (once). */
  stallData = -1;
  private reply: number[] = [];
  private csw: number[] | null = null;
  private expectOut = 0;
  private outOp: { lba: number; got: number[] } | null = null;
  private tag = 0;
  private halted = false;
  readonly disk: SparseBlocks;
  constructor(disk: SparseBlocks) {
    this.disk = disk;
  }
  attached(): boolean {
    return true;
  }
  busReset(): void {}
  enumDone(): void {}
  sof(): void {}
  setup(): void {}
  clearHalt(): void {
    this.halted = false;
  }
  in(ep: number, into: Uint8Array): number {
    if (ep !== 1) return USB_NAK;
    if (this.halted) return USB_STALL;
    if (this.reply.length > 0) {
      const n = Math.min(64, this.reply.length);
      into.set(this.reply.splice(0, n));
      return n;
    }
    if (this.csw !== null && this.expectOut === 0) {
      into.set(this.csw);
      this.csw = null;
      return 13;
    }
    return USB_NAK;
  }
  out(ep: number, data: Uint8Array, length: number): number {
    if (ep !== 1) return USB_NAK;
    if (this.expectOut > 0 && this.outOp !== null) {
      this.outOp.got.push(...data.subarray(0, length));
      this.expectOut -= length;
      if (this.expectOut <= 0) {
        for (let k = 0; k * BLOCK < this.outOp.got.length; k++) this.disk.write(this.outOp.lba + k, new Uint8Array(this.outOp.got), k * BLOCK);
        this.outOp = null;
        this.status(0, 0);
      }
      return USB_ACK;
    }
    const v = new DataView(data.buffer, data.byteOffset, length);
    if (length !== 31 || v.getUint32(0, true) !== 0x43425355) throw new Error('not a CBW');
    this.tag = v.getUint32(4, true);
    const wanted = v.getUint32(8, true);
    const cdb = data.subarray(15, 15 + data[14]);
    const op = cdb[0];
    this.opcodes.push(op.toString(16).padStart(2, '0'));
    const lba = (cdb[2] << 24) | (cdb[3] << 16) | (cdb[4] << 8) | cdb[5];
    const count = (cdb[7] << 8) | cdb[8];
    let reply: number[] = [];
    let status = 0;
    const blocks = this.disk.count;
    switch (op) {
      case 0x12:
        reply = [0, 0x80, 4, 2, 31, 0, 0, 0, ...ascii('Bench   '), ...ascii('Scripted Disk   '), ...ascii('1.0 ')];
        break;
      case 0x00:
        status = this.present ? 0 : 1;
        break;
      case 0x03:
        reply = [0x70, 0, this.present ? 0 : 2, 0, 0, 0, 0, 10, 0, 0, 0, 0, this.present ? 0 : 0x3a, 0, 0, 0, 0, 0];
        break;
      case 0x25: {
        const last = blocks - 1;
        reply = [last >>> 24, (last >>> 16) & 0xff, (last >>> 8) & 0xff, last & 0xff, 0, 0, (this.blockSize >>> 8) & 0xff, this.blockSize & 0xff];
        break;
      }
      case 0x1a:
        reply = [3, 0, this.writeProtect ? 0x80 : 0, 0];
        break;
      case 0x28:
        for (let k = 0; k < count; k++) reply.push(...this.disk.peek(lba + k));
        break;
      case 0x2a:
        this.expectOut = wanted;
        this.outOp = { lba, got: [] };
        return USB_ACK;
      default:
        status = 1;
    }
    if (op === this.stallData && reply.length > 0) {
      this.stallData = -1;
      this.halted = true;
      this.status(1, wanted);
      return USB_ACK;
    }
    this.reply = reply.slice(0, wanted);
    this.status(status, wanted - this.reply.length);
    return USB_ACK;
  }
  private status(status: number, residue: number): void {
    const csw = new Uint8Array(13);
    const v = new DataView(csw.buffer);
    v.setUint32(0, 0x53425355, true);
    v.setUint32(4, this.tag, true);
    v.setUint32(8, residue, true);
    csw[12] = status;
    this.csw = [...csw];
  }
}

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

function rig(disk: SparseBlocks) {
  const target = new Target(disk);
  let frames = 0;
  const notes: string[] = [];
  const requests: string[] = [];
  const host: DriveHost = {
    request(type, request, _value, index, _length, _out, done) {
      requests.push(`${type.toString(16)} ${request.toString(16)} ${index.toString(16)}`);
      if (type === 0xa1 && request === 0xfe) done(new Uint8Array([0]));
      else {
        if (type === 0x02 && request === 1) target.clearHalt();
        done(new Uint8Array(0));
      }
    },
    frames: () => frames,
    note: (m) => notes.push(m),
  };
  const drive = new MscDrive(0, 1, 1, 64, host);
  const run = (ms: number) => {
    for (let f = 0; f < ms; f++) {
      frames++;
      for (let i = 0; i < 50; i++) drive.service(target);
    }
  };
  return { target, drive, run, notes, requests };
}

describe('USB mass storage, Bulk-Only and SCSI (BT141)', () => {
  it('probes as a computer does (GET MAX LUN, INQUIRY, TEST UNIT READY, READ CAPACITY, MODE SENSE), then mounts a FAT12 drive and reads its files', () => {
    const disk = volume(128, 1);
    const fat = FatVolume.mount(disk) as FatVolume;
    fat.write('README.TXT', new TextEncoder().encode('hello drive'));
    const { target, drive, run, requests } = rig(disk);
    drive.start();
    run(5);
    expect(requests[0]).toBe('a1 fe 0');
    expect(target.opcodes.slice(0, 4)).toEqual(['12', '00', '25', '1a']);
    expect(target.opcodes.slice(4).every((op) => op === '28')).toBe(true);
    expect(drive).toMatchObject({ state: 'mounted', vendor: 'Bench', product: 'Scripted Disk', revision: '1.0', blocks: 128, blockSize: 512, writeProtected: false });
    expect(drive.fileSystem).toEqual({ type: 12, label: 'TEST DRIVE' });
    expect(drive.storage.list().map((f) => [f.path, f.size])).toEqual([['README.TXT', 11]]);
    expect(new TextDecoder().decode(drive.storage.read('readme.txt'))).toBe('hello drive');
  });

  it('a medium not there yet: REQUEST SENSE after each TEST UNIT READY, polled every 100 ms until it is', () => {
    const { target, drive, run } = rig(volume(128, 1));
    target.present = false;
    drive.start();
    run(5);
    expect(drive.state).toBe('no-medium');
    expect(target.opcodes).toEqual(['12', '00', '03']);
    run(120);
    expect(target.opcodes.slice(3, 5)).toEqual(['00', '03']);
    target.present = true;
    run(120);
    expect(drive.state).toBe('mounted');
  });

  it('a stalled data stage is cleared (CLEAR_FEATURE(ENDPOINT_HALT)) and its status read; the probe goes on', () => {
    const { target, drive, run, requests } = rig(volume(128, 1));
    target.stallData = 0x12;
    drive.start();
    run(5);
    expect(requests).toContain('2 1 81');
    expect(drive.vendor).toBe('');
    expect(drive.state).toBe('mounted');
  });

  it('a drive of 4,096-byte blocks is named, not read; nor is one without a FAT volume', () => {
    const big = rig(volume(128, 1));
    big.target.blockSize = 4096;
    big.drive.start();
    big.run(5);
    expect(big.drive.state).toBe('unreadable');
    expect(big.notes).toEqual(["its blocks are 4096 bytes; the bench's USB host reads 512-byte blocks"]);
    const raw = rig(new SparseBlocks(64));
    raw.drive.start();
    raw.run(5);
    expect(raw.drive.state).toBe('unreadable');
    expect(raw.drive.problem).toBe("it holds no FAT volume the bench's USB host can read");
  });

  it('demand-paged: a FAT16 drive mounts reading only its system area, directories and files; data past 1 MB waits to be asked for', () => {
    const disk = volume(12_000, 47); // FAT16: 11,951 clusters of one sector
    const fat = FatVolume.mount(disk) as FatVolume;
    expect(fat.type).toBe(16);
    const big = new Uint8Array(MSC_DATA_LIMIT + 4096).map((_, i) => (i * 13) & 0xff);
    fat.write('logs/small.txt', new TextEncoder().encode('first'));
    fat.write('big.bin', big);
    const { target, drive, run } = rig(disk);
    drive.start();
    run(20);
    expect(drive.state).toBe('mounted');
    expect(drive.storage.list().map((f) => f.path)).toEqual(['logs', 'logs/small.txt', 'big.bin']);
    expect(new TextDecoder().decode(drive.storage.read('LOGS/SMALL.TXT'))).toBe('first');
    expect([...drive.unread]).toEqual(['big.bin']);
    const readBefore = target.opcodes.filter((op) => op === '28').length;
    // System area (1 + 47 + 1) and the small file's cluster and directory: far from the 12,000 blocks.
    expect(readBefore).toBeLessThan(20);
    expect(drive.storage.read('big.bin')).toBeUndefined(); // asked: fetched now
    run(200);
    expect(drive.storage.read('big.bin')).toEqual(big);
  });

  it('writes go into the cache at once and out as WRITE(10), in block order; a write-protected drive refuses them', () => {
    const disk = volume(128, 1);
    const { target, drive, run } = rig(disk);
    drive.start();
    run(5);
    const version = drive.storage.version;
    expect(drive.storage.write('CONFIG.TXT', new TextEncoder().encode('led=red'))).toBe(true);
    expect(drive.storage.version).toBe(version + 1);
    expect(drive.storage.list().map((f) => f.path)).toEqual(['CONFIG.TXT']);
    run(5);
    expect(target.opcodes.filter((op) => op === '2a').length).toBeGreaterThan(0);
    // The target's own disk has it now.
    expect(new TextDecoder().decode((FatVolume.mount(disk) as FatVolume).read('CONFIG.TXT'))).toBe('led=red');
    const locked = rig(volume(128, 1));
    locked.target.writeProtect = true;
    locked.drive.start();
    locked.run(5);
    expect(locked.drive.writeProtected).toBe(true);
    expect(locked.drive.storage.write('X.TXT', new Uint8Array(1))).toBe(false);
  });

  it('like a computer, polls every second: a medium gone drops the files, its return mounts what it holds then', () => {
    const disk = volume(128, 1);
    const { target, drive, run } = rig(disk);
    drive.start();
    run(5);
    expect(drive.storage.list()).toEqual([]);
    target.present = false;
    (FatVolume.mount(disk) as FatVolume).write('NEW.TXT', new TextEncoder().encode('written by the device'));
    run(1100);
    expect(drive.state).toBe('no-medium');
    target.present = true;
    run(200);
    expect(drive.state).toBe('mounted');
    expect(new TextDecoder().decode(drive.storage.read('NEW.TXT'))).toBe('written by the device');
  });
});

describe('usb-drive: an S3 sketch\u2019s RAM disk over USBMSC (BT141)', () => {
  it('mounts as FAT12 with its files; a file the bench writes reaches the sketch; the sketch\u2019s own change shows once it toggles the medium', () => {
    const mcu = createEsp32s3Mcu({ rom: loadCachedS3Rom() });
    const notes: string[] = [];
    mcu.onProblem = (p) => {
      if (p.code === CODE_S3_USB_DEVICE) notes.push(p.message);
    };
    let serial = '';
    mcu.uart(0)!.onTransmit((b) => (serial += String.fromCharCode(b)));
    const set = (level: 0 | 1) => mcu.pins.get('GPIO4')!.setInput({ level, strength: Strength.strong, conflict: false, volts: level * 3.3 });
    set(1); // no bench here to apply INPUT_PULLUP
    mcu.load({ format: 'esp32-bin', ...s3FixtureImage('usb-drive') });
    const run = (ms: number) => {
      const end = mcu.cycles + (REF_HZ * ms) / 1000;
      while (mcu.cycles < end) mcu.runUntil(Math.min(end, mcu.cycles + REF_HZ / 1000));
    };
    expect(mcu.usbStorage()).toBeNull();
    run(600);
    expect(serial).toBe('usb drive ready\r\n');
    expect(mcu.usbHost()).toMatchObject({ functions: ['serial (CDC-ACM)', 'drive (mass storage)'] });
    expect(mcu.usbHost()?.drive).toEqual({ state: 'mounted', vendor: 'Benchtop', product: 'S3 RAM Drive', revision: '1.0', bytes: 65536, writeProtected: false, fileSystem: 'FAT12', label: 'S3 DRIVE', problem: '', unread: 0 });
    const drive = mcu.usbStorage()!;
    expect(drive.list().map((f) => [f.path, f.size])).toEqual([
      ['README.TXT', 129],
      ['COUNT.TXT', 9],
    ]);
    expect(new TextDecoder().decode(drive.read('README.TXT'))).toMatch(/^This drive is an ESP32-S3's RAM/);
    expect(new TextDecoder().decode(drive.read('count.txt'))).toBe('count=0\r\n');
    // The computer writes CONFIG.TXT: the sketch finds it in its RAM disk.
    expect(drive.write('CONFIG.TXT', new TextEncoder().encode('led=green\r\n'))).toBe(true);
    run(400);
    expect(serial).toBe('usb drive ready\r\nconfig led=green\nled green\n');
    // The button: the sketch rewrites COUNT.TXT and takes the medium away for 1.5 s; the host mounts it again.
    set(0);
    run(100);
    set(1);
    run(500);
    expect(mcu.usbHost()?.drive?.state).toBe('no-medium');
    expect(mcu.usbStorage()!.list()).toEqual([]);
    run(2000);
    const again = mcu.usbStorage()!;
    expect(mcu.usbHost()?.drive?.state).toBe('mounted');
    expect(new TextDecoder().decode(again.read('COUNT.TXT'))).toBe('count=1\r\n');
    expect(again.list().map((f) => f.path)).toEqual(['README.TXT', 'COUNT.TXT', 'CONFIG.TXT']);
    expect(notes).toEqual([]);
  }, 60_000);
});

