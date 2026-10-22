/**
 * An SD card in SPI mode (BT89; SD Physical Layer Simplified Specification 9.10, §7 "SPI Mode"):
 * an 8 GB SDHC card — block addressed, CMD8 answered, OCR's CCS set, CSD version 2 — over a
 * sparse block store. An `SpiDevice`: the controller calls `transfer` once per byte while the
 * card's CS is low, and the MISO byte it returns was decided before the MOSI byte arrived (the
 * two shift at once), so a response always starts on a later byte than its command's last.
 *
 * Until a CMD0 with its CRC the card is in SD mode and stays silent. Commands are six bytes
 * (01, index, argument big-endian, CRC7 << 1 | 1); the response follows one fill byte (NCR = 1),
 * which every library polls for. CRC7 is checked on CMD0 before SPI mode and on CMD8 always;
 * CMD59 turns checking on for every command and written block. Initialization: CMD0 → idle;
 * ACMD41 (HCS set) leaves idle on the second poll; commands that move data are illegal while
 * idle. Reads answer R1, a fill byte, the 0xFE start token, the data and its CRC16; CMD18 streams
 * blocks until CMD12. Writes take a token (0xFE single; 0xFC each block of CMD25, 0xFD to stop),
 * 512 bytes and a CRC16, answer the data response (0x05 accepted, 0x0B CRC error, 0x0D write
 * error) on the very next byte, then hold MISO low (busy) for `WRITE_BUSY_NS` of simulated time.
 * A rising CS drops a half-received command; the card's state (a stream, a write, busy) stays.
 *
 * The transfer path doesn't allocate: responses go through one preallocated queue.
 */

import type { Nanos, SpiDevice } from '@benchtop/core';
import { BLOCK, type SparseBlocks } from './blocks.ts';

/** 8 GB as sold: C_SIZE 15159, (15159 + 1) × 512 KiB = 15,523,840 blocks. */
export const SD_C_SIZE = 15159;
export const SD_BLOCKS = (SD_C_SIZE + 1) * 1024;
/** How long a block takes to program, ns (cards take 0.2–2 ms; the libraries poll for it). */
export const WRITE_BUSY_NS = 250_000;
/** How long CMD12, the stop token and an erase hold busy, ns. */
const SHORT_BUSY_NS = 20_000;

const R1_IDLE = 0x01;
const R1_ILLEGAL = 0x04;
const R1_CRC = 0x08;
const R1_PARAMETER = 0x40;
const TOKEN_START = 0xfe;
const TOKEN_MULTI = 0xfc;
const TOKEN_STOP = 0xfd;

const CRC7 = new Uint8Array(256);
const CRC16 = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  // x^7 + x^3 + 1 (0x89), the register's 7 bits kept in the low bits of a byte.
  let c = i & 0x80 ? i ^ 0x89 : i;
  for (let b = 1; b < 8; b++) {
    c = (c << 1) & 0xff;
    if (c & 0x80) c ^= 0x89;
  }
  CRC7[i] = c;
  let d = i << 8;
  for (let b = 0; b < 8; b++) d = d & 0x8000 ? ((d << 1) ^ 0x1021) & 0xffff : (d << 1) & 0xffff;
  CRC16[i] = d;
}

/** CRC7 of `length` bytes from `offset`, as the 7-bit value (send it as `crc << 1 | 1`). */
export function crc7(bytes: Uint8Array, offset: number, length: number): number {
  let crc = 0;
  for (let i = 0; i < length; i++) crc = CRC7[(crc << 1) ^ bytes[offset + i]];
  return crc;
}

/** CRC16-CCITT (polynomial 0x1021, initial 0), as data blocks carry it. */
export function crc16(bytes: Uint8Array, offset: number, length: number): number {
  let crc = 0;
  for (let i = 0; i < length; i++) crc = ((crc << 8) ^ CRC16[((crc >> 8) ^ bytes[offset + i]) & 0xff]) & 0xffff;
  return crc;
}

/** The card's CSD (version 2.0: SDHC), with its CRC7. */
function makeCsd(): Uint8Array {
  const c = SD_C_SIZE;
  const csd = Uint8Array.of(0x40, 0x0e, 0x00, 0x32, 0x5b, 0x59, 0x00, (c >> 16) & 0x3f, (c >> 8) & 0xff, c & 0xff, 0x7f, 0x80, 0x0a, 0x40, 0x00, 0);
  csd[15] = (crc7(csd, 0, 15) << 1) | 1;
  return csd;
}

/** The card's CID: manufacturer 0x42, OEM "BT", product "BENCH", revision 1.0, made 2026-01. */
function makeCid(): Uint8Array {
  const cid = Uint8Array.of(0x42, 0x42, 0x54, 0x42, 0x45, 0x4e, 0x43, 0x48, 0x10, 0x00, 0x00, 0xbe, 0x7c, 0x01, 0xa1, 0);
  cid[15] = (crc7(cid, 0, 15) << 1) | 1;
  return cid;
}

/** SCR: SD 3.0 spec, SDHC security, 1- and 4-bit bus, data after erase reads 0. */
const SCR = Uint8Array.of(0x02, 0x35, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00);

export class SdCard implements SpiDevice {
  /** False: the socket is empty, MISO floats high (every byte reads 0xFF). */
  inserted = true;
  /** Bumped by every block written or erased. */
  writes = 0;
  /** Called after a block is written or erased. */
  onWrite: (() => void) | null = null;
  private readonly blocks: SparseBlocks;
  private readonly now: () => Nanos;
  private readonly csd = makeCsd();
  private readonly cid = makeCid();
  /** The response queue: MISO bytes waiting to go out. */
  private readonly out = new Uint8Array(1024);
  private head = 0;
  private tail = 0;
  private readonly cmd = new Uint8Array(6);
  private cmdLength = 0;
  /** Write data being received: 512 bytes and the CRC16. */
  private readonly rx = new Uint8Array(BLOCK + 2);
  private rxLength = -1;
  private spiMode = false;
  private idle = true;
  private appCmd = false;
  private crcOn = false;
  private opPolls = 0;
  /** CMD18's next block, or -1. */
  private streamAt = -1;
  /** 1: CMD24 waits for its token; 2: CMD25 waits for a block or the stop token; 0: no write. */
  private writeMode = 0;
  private writeAt = 0;
  private wellWritten = 0;
  private busyUntil = 0;
  private eraseFirst = 0;
  private eraseLast = 0;

  constructor(blocks: SparseBlocks, now: () => Nanos) {
    if (blocks.count !== SD_BLOCKS) throw new Error(`an SD card holds ${SD_BLOCKS} blocks, not ${blocks.count}`);
    this.blocks = blocks;
    this.now = now;
  }

  /** Power-on: back in SD mode, uninitialized. The blocks keep what they hold. */
  powerOn(): void {
    this.head = this.tail = 0;
    this.cmdLength = 0;
    this.rxLength = -1;
    this.spiMode = false;
    this.idle = true;
    this.appCmd = false;
    this.crcOn = false;
    this.opPolls = 0;
    this.streamAt = -1;
    this.writeMode = 0;
    this.busyUntil = 0;
  }

  /** CS went high: a half-received command is dropped, unread response bytes too. */
  deselect(): void {
    this.cmdLength = 0;
    this.head = this.tail = 0;
  }

  transfer(mosi: number): number {
    if (!this.inserted) return 0xff;
    const miso = this.next();
    this.take(mosi & 0xff);
    return miso;
  }

  private next(): number {
    if (this.head < this.tail) return this.out[this.head++];
    if (this.streamAt >= 0) {
      this.queueBlock(this.streamAt);
      this.streamAt = this.streamAt + 1 < SD_BLOCKS ? this.streamAt + 1 : -1;
      return this.out[this.head++];
    }
    return this.now() < this.busyUntil ? 0x00 : 0xff;
  }

  private take(mosi: number): void {
    if (this.rxLength >= 0) {
      this.rx[this.rxLength++] = mosi;
      if (this.rxLength === BLOCK + 2) this.blockReceived();
      return;
    }
    if (this.cmdLength === 0 && this.writeMode !== 0 && this.now() >= this.busyUntil) {
      if ((mosi === TOKEN_START && this.writeMode === 1) || (mosi === TOKEN_MULTI && this.writeMode === 2)) {
        this.rxLength = 0;
        return;
      }
      if (mosi === TOKEN_STOP && this.writeMode === 2) {
        this.writeMode = 0;
        this.busyUntil = this.now() + SHORT_BUSY_NS;
        this.push(0xff); // one byte before busy shows
        return;
      }
    }
    if (this.cmdLength > 0 || (mosi & 0xc0) === 0x40) {
      this.cmd[this.cmdLength++] = mosi;
      if (this.cmdLength === 6) {
        this.cmdLength = 0;
        this.command();
      }
    }
  }

  private push(byte: number): void {
    if (this.tail < this.out.length) this.out[this.tail++] = byte;
  }

  private reset(): void {
    this.head = this.tail = 0;
  }

  /** R1 after the fill byte. */
  private r1(flags: number): void {
    this.reset();
    this.push(0xff);
    this.push(flags | (this.idle ? R1_IDLE : 0));
  }

  /** A data block from `bytes` (start token, the bytes, CRC16) after a fill byte. */
  private queueData(bytes: Uint8Array, length: number): void {
    this.push(0xff);
    this.push(TOKEN_START);
    for (let i = 0; i < length; i++) this.push(bytes[i]);
    const crc = crc16(bytes, 0, length);
    this.push(crc >> 8);
    this.push(crc & 0xff);
  }

  private queueBlock(lba: number): void {
    this.reset();
    this.queueData(this.blocks.peek(lba), BLOCK);
  }

  private command(): void {
    const c = this.cmd;
    const index = c[0] & 0x3f;
    const arg = ((c[1] << 24) | (c[2] << 16) | (c[3] << 8) | c[4]) >>> 0;
    const crcOk = c[5] === ((crc7(c, 0, 5) << 1) | 1);
    if (!this.spiMode) {
      if (index !== 0 || !crcOk) return; // SD mode: only a good CMD0 is heard
      this.spiMode = true;
    } else if (!crcOk && (this.crcOn || index === 8)) {
      this.r1(R1_CRC);
      this.appCmd = false;
      return;
    }
    const app = this.appCmd;
    this.appCmd = false;
    this.streamAt = -1; // a command ends a CMD18 stream (CMD12 is the one meant to)
    if (app && this.appCommand(index, arg)) return;
    switch (index) {
      case 0:
        this.writeMode = 0;
        this.idle = true;
        this.opPolls = 0;
        this.crcOn = false;
        this.r1(0);
        return;
      case 8:
        this.r1(0);
        this.push(0x00);
        this.push(0x00);
        this.push((arg >> 8) & 0x0f);
        this.push(arg & 0xff);
        return;
      case 55:
        this.appCmd = true;
        this.r1(0);
        return;
      case 58: {
        const ocr = (this.idle ? 0 : 0xc0000000) | 0x00ff8000;
        this.r1(0);
        this.push(ocr >>> 24);
        this.push((ocr >>> 16) & 0xff);
        this.push((ocr >>> 8) & 0xff);
        this.push(ocr & 0xff);
        return;
      }
      case 59:
        this.crcOn = (arg & 1) === 1;
        this.r1(0);
        return;
      case 12:
        this.reset();
        this.push(0xff); // the stuff byte
        this.push(0xff);
        this.push(this.idle ? R1_IDLE : 0);
        this.busyUntil = this.now() + SHORT_BUSY_NS;
        return;
      case 13:
        this.r1(0);
        this.push(0x00);
        return;
    }
    if (this.idle) {
      this.r1(R1_ILLEGAL);
      return;
    }
    switch (index) {
      case 6: // SWITCH_FUNC: 100 mA, group 1 offers default speed only, so a high-speed request fails (0xF)
        this.r1(0);
        this.rx.fill(0, 0, 64);
        this.rx[1] = 100;
        this.rx[12] = 0x80;
        this.rx[13] = 0x01;
        this.rx[16] = (arg & 0x0f) === 0 || (arg & 0x0f) === 0x0f ? 0 : 0x0f;
        this.queueData(this.rx, 64);
        return;
      case 9:
        this.r1(0);
        this.queueData(this.csd, 16);
        return;
      case 10:
        this.r1(0);
        this.queueData(this.cid, 16);
        return;
      case 16:
        this.r1(arg === BLOCK ? 0 : R1_PARAMETER);
        return;
      case 17:
        if (arg >= SD_BLOCKS) this.r1(R1_PARAMETER);
        else {
          this.r1(0);
          this.queueData(this.blocks.peek(arg), BLOCK);
        }
        return;
      case 18:
        if (arg >= SD_BLOCKS) this.r1(R1_PARAMETER);
        else {
          this.r1(0);
          this.streamAt = arg;
        }
        return;
      case 24:
      case 25:
        if (arg >= SD_BLOCKS) this.r1(R1_PARAMETER);
        else {
          this.r1(0);
          this.writeMode = index === 24 ? 1 : 2;
          this.writeAt = arg;
          this.wellWritten = 0;
        }
        return;
      case 32:
        this.eraseFirst = arg;
        this.r1(arg >= SD_BLOCKS ? R1_PARAMETER : 0);
        return;
      case 33:
        this.eraseLast = arg;
        this.r1(arg >= SD_BLOCKS ? R1_PARAMETER : 0);
        return;
      case 38:
        if (this.eraseFirst <= this.eraseLast && this.eraseLast < SD_BLOCKS) {
          this.blocks.erase(this.eraseFirst, this.eraseLast);
          this.wrote();
        }
        this.r1(0);
        this.busyUntil = this.now() + SHORT_BUSY_NS;
        return;
      default:
        this.r1(R1_ILLEGAL);
    }
  }

  /** An ACMD (after CMD55); false when `index` isn't one, so it runs as the plain command. */
  private appCommand(index: number, arg: number): boolean {
    switch (index) {
      case 41:
        // HCS must be set for an SDHC card to leave idle; it does on the second poll.
        if ((arg & 0x40000000) !== 0 && ++this.opPolls >= 2) this.idle = false;
        this.r1(0);
        return true;
      case 42:
      case 23:
        this.r1(this.idle && index === 23 ? R1_ILLEGAL : 0);
        return true;
      case 13:
        if (this.idle) return false;
        this.r1(0);
        this.push(0x00);
        this.rx.fill(0, 0, 64);
        this.queueData(this.rx, 64);
        return true;
      case 22:
        if (this.idle) return false;
        this.r1(0);
        this.rx[0] = this.wellWritten >>> 24;
        this.rx[1] = (this.wellWritten >>> 16) & 0xff;
        this.rx[2] = (this.wellWritten >>> 8) & 0xff;
        this.rx[3] = this.wellWritten & 0xff;
        this.queueData(this.rx, 4);
        return true;
      case 51:
        if (this.idle) return false;
        this.r1(0);
        this.queueData(SCR, 8);
        return true;
    }
    return false;
  }

  private blockReceived(): void {
    this.rxLength = -1;
    this.reset();
    const crc = (this.rx[BLOCK] << 8) | this.rx[BLOCK + 1];
    if (this.crcOn && crc !== crc16(this.rx, 0, BLOCK)) {
      this.push(0x0b);
      if (this.writeMode === 1) this.writeMode = 0;
      return;
    }
    if (this.writeAt >= SD_BLOCKS) {
      this.push(0x0d);
      this.writeMode = 0;
      return;
    }
    this.blocks.write(this.writeAt, this.rx);
    this.writeAt++;
    this.wellWritten++;
    this.push(0x05);
    this.busyUntil = this.now() + WRITE_BUSY_NS;
    if (this.writeMode === 1) this.writeMode = 0;
    this.wrote();
  }

  private wrote(): void {
    this.writes++;
    this.onWrite?.();
  }
}
