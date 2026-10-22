import { describe, expect, it } from 'vitest';
import { BLOCK, SparseBlocks } from './blocks.ts';
import { crc7, crc16, SD_BLOCKS, SdCard, WRITE_BUSY_NS } from './sd-card.ts';

// BT89: the SD card's SPI mode, driven the way the Arduino SD library, the ESP32 core and
// SdFat drive it.

function rig() {
  let time = 0;
  const blocks = new SparseBlocks(SD_BLOCKS);
  const card = new SdCard(blocks, () => time);
  const x = (b: number): number => card.transfer(b);
  const packet = (index: number, arg: number, crc?: number): number[] => {
    const p = [0x40 | index, arg >>> 24, (arg >>> 16) & 0xff, (arg >>> 8) & 0xff, arg & 0xff];
    return [...p, crc ?? (crc7(Uint8Array.from(p), 0, 5) << 1) | 1];
  };
  /** Sends a command, polls up to 10 bytes for R1 (bit 7 clear); 0xFF if none came. */
  const cmd = (index: number, arg = 0, crc?: number): number => {
    for (const b of packet(index, arg, crc)) x(b);
    for (let i = 0; i < 10; i++) {
      const r = x(0xff);
      if ((r & 0x80) === 0) return r;
    }
    return 0xff;
  };
  const acmd = (index: number, arg = 0): number => {
    cmd(55);
    return cmd(index, arg);
  };
  const bytes = (n: number): number[] => Array.from({ length: n }, () => x(0xff));
  /** Waits for the 0xFE token, then reads `n` data bytes and the CRC16. */
  const data = (n: number): { data: Uint8Array; crc: number } => {
    let token = 0xff;
    for (let i = 0; i < 100 && token === 0xff; i++) token = x(0xff);
    expect(token).toBe(0xfe);
    const out = Uint8Array.from(bytes(n));
    const [hi, lo] = bytes(2);
    return { data: out, crc: (hi << 8) | lo };
  };
  const init = (): void => {
    expect(cmd(0)).toBe(0x01);
    expect(cmd(8, 0x1aa)).toBe(0x01);
    bytes(4);
    while (acmd(41, 0x40000000) !== 0);
  };
  const waitReady = (): number => {
    let polls = 0;
    while (x(0xff) !== 0xff) {
      polls++;
      time += 10_000;
      if (polls > 1000) throw new Error('busy forever');
    }
    return polls;
  };
  return { card, blocks, x, cmd, acmd, bytes, data, init, waitReady, advance: (ns: number) => (time += ns) };
}

function block(seed: number): Uint8Array {
  return Uint8Array.from({ length: BLOCK }, (_, i) => (i * 7 + seed) & 0xff);
}

describe('SD card protocol (BT89)', () => {
  it('CRCs: CMD0 and CMD8 carry 0x95 and 0x87; a block of 0xFF has CRC16 0x7FA1', () => {
    expect((crc7(Uint8Array.of(0x40, 0, 0, 0, 0), 0, 5) << 1) | 1).toBe(0x95);
    expect((crc7(Uint8Array.of(0x48, 0, 0, 1, 0xaa), 0, 5) << 1) | 1).toBe(0x87);
    expect(crc16(new Uint8Array(BLOCK).fill(0xff), 0, BLOCK)).toBe(0x7fa1);
  });

  it('is silent until a CMD0 with its CRC, then initializes like a real SDHC card', () => {
    const r = rig();
    expect(r.cmd(8, 0x1aa)).toBe(0xff); // SD mode: nothing
    expect(r.cmd(0, 0, 0xff)).toBe(0xff); // a bad CRC isn't heard
    expect(r.cmd(0)).toBe(0x01);
    expect(r.cmd(8, 0x1aa)).toBe(0x01);
    expect(r.bytes(4)).toEqual([0x00, 0x00, 0x01, 0xaa]);
    expect(r.cmd(58)).toBe(0x01);
    expect(r.bytes(4)).toEqual([0x00, 0xff, 0x80, 0x00]); // not powered up yet; 2.7–3.6 V
    expect(r.cmd(17, 0)).toBe(0x05); // idle: data commands are illegal
    expect(r.acmd(41, 0)).toBe(0x01); // without HCS an SDHC card never leaves idle
    expect(r.acmd(41, 0)).toBe(0x01);
    expect(r.acmd(41, 0x40000000)).toBe(0x01);
    expect(r.acmd(41, 0x40000000)).toBe(0x00);
    expect(r.cmd(58)).toBe(0x00);
    expect(r.bytes(4)).toEqual([0xc0, 0xff, 0x80, 0x00]); // busy bit and CCS (SDHC)
    expect(r.cmd(16, 512)).toBe(0x00);
    expect(r.cmd(16, 1024)).toBe(0x40);
    expect(r.cmd(1)).toBe(0x04);
    expect(r.acmd(42)).toBe(0x00);
  });

  it('CSD (version 2: the card size), CID and SCR read as data blocks with their CRCs', () => {
    const r = rig();
    r.init();
    expect(r.cmd(9)).toBe(0x00);
    const csd = r.data(16);
    expect(csd.crc).toBe(crc16(csd.data, 0, 16));
    expect(csd.data[0] >> 6).toBe(1);
    const cSize = ((csd.data[7] & 0x3f) << 16) | (csd.data[8] << 8) | csd.data[9];
    expect((cSize + 1) * 1024).toBe(SD_BLOCKS);
    expect(csd.data[15]).toBe((crc7(csd.data, 0, 15) << 1) | 1);
    expect(r.cmd(10)).toBe(0x00);
    const cid = r.data(16);
    expect(String.fromCharCode(...cid.data.subarray(3, 8))).toBe('BENCH');
    expect(r.acmd(51)).toBe(0x00);
    expect(r.data(8).data[0]).toBe(0x02);
  });

  it('writes a block (token, data, CRC → 0x05, busy) and reads it back with its CRC16', () => {
    const r = rig();
    r.init();
    const b = block(3);
    expect(r.cmd(24, 1234)).toBe(0x00);
    r.x(0xff);
    r.x(0xfe);
    for (const v of b) r.x(v);
    r.x(0xff);
    r.x(0xff);
    expect(r.x(0xff) & 0x1f).toBe(0x05); // the data response on the very next byte
    expect(r.x(0xff)).toBe(0x00); // programming
    const polls = r.waitReady();
    expect(polls).toBeGreaterThanOrEqual(WRITE_BUSY_NS / 10_000 - 1);
    expect(r.card.writes).toBe(1);
    expect(r.cmd(13)).toBe(0x00);
    expect(r.bytes(1)).toEqual([0x00]);
    expect(r.cmd(17, 1234)).toBe(0x00);
    const read = r.data(BLOCK);
    expect(read.data).toEqual(b);
    expect(read.crc).toBe(crc16(b, 0, BLOCK));
    expect(r.cmd(17, 99)).toBe(0x00);
    expect(r.data(BLOCK).data.every((v) => v === 0)).toBe(true); // never written: zeros
    expect(r.cmd(17, SD_BLOCKS)).toBe(0x40); // past the end
  });

  it('CMD25 writes blocks until the stop token; ACMD22 counts them; CMD18 streams them until CMD12', () => {
    const r = rig();
    r.init();
    expect(r.acmd(23, 3)).toBe(0x00);
    expect(r.cmd(25, 500)).toBe(0x00);
    for (let k = 0; k < 3; k++) {
      r.waitReady();
      r.x(0xfc);
      for (const v of block(k)) r.x(v);
      r.x(0xff);
      r.x(0xff);
      expect(r.x(0xff) & 0x1f).toBe(0x05);
    }
    r.waitReady();
    r.x(0xfd);
    r.x(0xff);
    expect(r.x(0xff)).toBe(0x00); // busy after the stop token
    r.waitReady();
    expect(r.acmd(22)).toBe(0x00);
    expect([...r.data(4).data]).toEqual([0, 0, 0, 3]);
    expect(r.cmd(18, 500)).toBe(0x00);
    for (let k = 0; k < 3; k++) expect(r.data(BLOCK).data).toEqual(block(k));
    r.bytes(5); // the next block is on its way when CMD12 comes
    for (const v of [0x4c, 0, 0, 0, 0, 0x61]) r.x(v);
    r.x(0xff); // the stuff byte
    let r1 = 0xff;
    for (let i = 0; i < 8 && (r1 & 0x80) !== 0; i++) r1 = r.x(0xff);
    expect(r1).toBe(0x00);
    r.waitReady();
    expect(r.cmd(13)).toBe(0x00); // back to commands
  });

  it('CMD59 turns CRC checking on: bad commands answer 0x08, bad blocks 0x0B and aren\'t written', () => {
    const r = rig();
    r.init();
    expect(r.cmd(13, 0, 0x01)).toBe(0x00); // CRC off: anything goes
    expect(r.cmd(8, 0x1aa, 0x01)).toBe(0x08); // CMD8's CRC is always checked
    r.bytes(4);
    expect(r.cmd(59, 1)).toBe(0x00);
    expect(r.cmd(13, 0, 0x01)).toBe(0x08);
    expect(r.cmd(24, 7)).toBe(0x00);
    r.x(0xfe);
    for (const v of block(9)) r.x(v);
    r.x(0x12);
    r.x(0x34);
    expect(r.x(0xff) & 0x1f).toBe(0x0b);
    expect(r.card.writes).toBe(0);
    const good = block(9);
    const crc = crc16(good, 0, BLOCK);
    expect(r.cmd(24, 7)).toBe(0x00);
    r.x(0xfe);
    for (const v of good) r.x(v);
    r.x(crc >> 8);
    r.x(crc & 0xff);
    expect(r.x(0xff) & 0x1f).toBe(0x05);
    expect(r.blocks.peek(7)).toEqual(good);
  });

  it('a rising CS drops a half-sent command; an empty socket reads 0xFF; erase clears blocks', () => {
    const r = rig();
    r.init();
    r.x(0x51);
    r.x(0);
    r.card.deselect();
    expect(r.cmd(13)).toBe(0x00); // a fresh command, not the tail of CMD17
    r.blocks.write(10, block(1));
    r.blocks.write(11, block(2));
    expect(r.cmd(32, 10)).toBe(0x00);
    expect(r.cmd(33, 11)).toBe(0x00);
    expect(r.cmd(38)).toBe(0x00);
    r.waitReady();
    expect(r.blocks.used).toBe(0);
    r.card.inserted = false;
    expect(r.cmd(0)).toBe(0xff);
    expect(r.x(0xff)).toBe(0xff);
  });
});
