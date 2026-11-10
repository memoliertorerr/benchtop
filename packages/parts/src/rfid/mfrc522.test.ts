import { describe, expect, it } from 'vitest';
import { MFRC522_CMD as CMD, MFRC522_REG as REG, Mfrc522, type Mfrc522Host, RFID_ETU_NS, RFID_FDT_NS, rfidFrameNs } from './mfrc522.ts';
import { crcA, type Picc, type PiccAnswer, type PiccAuth } from './picc.ts';

// BT196: the MFRC522 against its datasheet (rev 3.9) with a scripted clock and a scripted card.

class Clock implements Mfrc522Host {
  t = 0;
  changes = 0;
  private events: { at: number; id: number; fn: () => void }[] = [];
  private nextId = 1;
  now(): number {
    return this.t;
  }
  schedule(delay: number, fn: () => void): number {
    const id = this.nextId++;
    this.events.push({ at: this.t + delay, id, fn });
    return id;
  }
  cancel(id: number): void {
    this.events = this.events.filter((e) => e.id !== id);
  }
  changed(): void {
    this.changes++;
  }
  /** Runs every event due by `until`, in order. */
  advance(until: number): void {
    for (;;) {
      this.events.sort((a, b) => a.at - b.at || a.id - b.id);
      const e = this.events[0];
      if (e === undefined || e.at > until) break;
      this.events.shift();
      this.t = e.at;
      e.fn();
    }
    this.t = until;
  }
}

function chip() {
  const clock = new Clock();
  const c = new Mfrc522(clock);
  c.power(true);
  /** One SPI frame (NSS low, the bytes, NSS high); returns MISO. */
  const frame = (...bytes: number[]): number[] => {
    c.select();
    const out = bytes.map((b) => c.transfer(b));
    c.select();
    return out;
  };
  const write = (reg: number, ...data: number[]): void => void frame(reg << 1, ...data);
  const read = (reg: number): number => frame(0x80 | (reg << 1), 0)[1];
  return { clock, c, frame, write, read };
}

/** A card that answers with `reply(frame)`, recording what it got. */
class ScriptedCard implements Picc {
  readonly got: { bytes: number[]; lastBits: number; encrypted: boolean }[] = [];
  fields: boolean[] = [];
  auth: PiccAuth = 'ok';
  authArgs: number[] = [];
  private readonly buffer = new Uint8Array(32);
  private readonly answer: PiccAnswer = { bytes: this.buffer, length: 0, lastBits: 8, delayNs: 0 };
  private readonly reply: (bytes: number[], lastBits: number) => { bytes: number[]; lastBits?: number; delayNs?: number } | null;
  constructor(reply: (bytes: number[], lastBits: number) => { bytes: number[]; lastBits?: number; delayNs?: number } | null) {
    this.reply = reply;
  }
  field(on: boolean): void {
    this.fields.push(on);
  }
  frame(data: Uint8Array, length: number, lastBits: number, encrypted: boolean): PiccAnswer | null {
    const bytes = [...data.subarray(0, length)];
    this.got.push({ bytes, lastBits, encrypted });
    const r = this.reply(bytes, lastBits);
    if (r === null) return null;
    this.buffer.set(r.bytes);
    this.answer.length = r.bytes.length;
    this.answer.lastBits = r.lastBits ?? 8;
    this.answer.delayNs = r.delayNs ?? 0;
    return this.answer;
  }
  authenticate(keyType: number, block: number, key: Uint8Array, keyAt: number, uid: Uint8Array, uidAt: number): PiccAuth {
    this.authArgs = [keyType, block, ...key.subarray(keyAt, keyAt + 6), ...uid.subarray(uidAt, uidAt + 4)];
    return this.auth;
  }
}

/** The MFRC522 library's PCD_Init settings: TAuto, f_timer 40 kHz, a 25 ms timeout, 100 % ASK, CRC preset 6363h, the antenna on. */
function init(write: (reg: number, ...data: number[]) => void): void {
  write(REG.TxMode, 0);
  write(REG.RxMode, 0);
  write(REG.ModWidth, 0x26);
  write(REG.TMode, 0x80);
  write(REG.TPrescaler, 0xa9);
  write(REG.TReloadH, 0x03);
  write(REG.TReloadL, 0xe8);
  write(REG.TxAsk, 0x40);
  write(REG.Mode, 0x3d);
  write(REG.TxControl, 0x83);
}

/** 25 ms: (2·169 + 1) · (1000 + 1) / 13.56 MHz. */
const TIMEOUT_NS = (339 * 1001 * 1e9) / 13.56e6;

describe('MFRC522 (BT196)', () => {
  it('(a) frames SPI as the datasheet does: an address byte, reads per address returning the previous one, writes to one address', () => {
    const { frame, read, write } = chip();
    expect(frame(0x80 | (REG.Version << 1), 0)).toEqual([0, 0x92]);
    // Reset values (Table 20).
    expect([REG.Command, REG.ComIEn, REG.ComIrq, REG.Status1, REG.WaterLevel, REG.Mode, REG.TxControl].map(read)).toEqual([0x20, 0x80, 0x14, 0x21, 0x08, 0x3f, 0x80]);
    // Several addresses in one frame, each byte returning the one before.
    expect(frame(0x80 | (REG.Version << 1), 0x80 | (REG.Mode << 1), 0x80 | (REG.WaterLevel << 1), 0)).toEqual([0, 0x92, 0x3f, 0x08]);
    // A write frame: every data byte goes to the one register (the FIFO here).
    write(REG.FifoData, 0x11, 0x22, 0x33);
    expect(read(REG.FifoLevel)).toBe(3);
    const fifo = 0x80 | (REG.FifoData << 1);
    expect(frame(fifo, fifo, fifo, 0)).toEqual([0, 0x11, 0x22, 0x33]);
    expect(read(REG.FifoLevel)).toBe(0);
    // Read-only registers ignore writes.
    write(REG.Version, 0x00);
    write(REG.Status1, 0xff);
    expect([read(REG.Version), read(REG.Status1)]).toEqual([0x92, 0x21]);
  });

  it('(b) the FIFO: its level, HiAlert and LoAlert against WaterLevel, their latched IRq bits, BufferOvfl, FlushBuffer', () => {
    const { read, write } = chip();
    write(REG.ComIrq, 0x7f); // clear all
    write(REG.WaterLevel, 8);
    write(REG.FifoData, ...Array.from({ length: 9 }, (_, i) => i));
    expect(read(REG.Status1) & 3).toBe(0); // 9 > 8 and 55 free > 8
    expect(read(REG.ComIrq) & 0x0c).toBe(0x04); // LoAlertIRq latched on the way up
    write(REG.ComIrq, 0x04); // Set1 = 0: clears LoAlertIRq
    write(REG.FifoData, ...Array.from({ length: 47 }, (_, i) => i)); // 56: 8 free
    expect(read(REG.FifoLevel)).toBe(56);
    expect(read(REG.Status1) & 3).toBe(2); // HiAlert
    expect(read(REG.ComIrq) & 0x0c).toBe(0x08);
    write(REG.FifoData, ...Array.from({ length: 8 }, () => 0xaa)); // full
    expect(read(REG.Error) & 0x10).toBe(0);
    write(REG.FifoData, 0xbb);
    expect(read(REG.Error) & 0x10).toBe(0x10); // BufferOvfl
    expect(read(REG.ComIrq) & 0x02).toBe(0x02); // ErrIRq
    expect(read(REG.FifoLevel)).toBe(64);
    write(REG.FifoLevel, 0x80);
    expect([read(REG.FifoLevel), read(REG.Error) & 0x10, read(REG.Status1) & 3]).toEqual([0, 0, 1]);
    // Set1 = 1 sets the marked bits.
    write(REG.ComIrq, 0x7f);
    write(REG.ComIrq, 0x81);
    expect(read(REG.ComIrq)).toBe(0x01);
  });

  it('(c) CalcCRC computes CRC_A (ISO 14443-3 Annex B’s vectors), from the preset, including bytes written while it runs', () => {
    const { read, write } = chip();
    write(REG.Mode, 0x3d); // CRCPreset 01: 6363h
    const calc = (...bytes: number[]): number => {
      write(REG.Command, CMD.Idle);
      write(REG.DivIrq, 0x04);
      write(REG.FifoLevel, 0x80);
      write(REG.FifoData, ...bytes);
      write(REG.Command, CMD.CalcCrc);
      expect(read(REG.DivIrq) & 0x04).toBe(0x04); // CRCIRq
      expect(read(REG.Status1) & 0x20).toBe(0x20); // CRCReady
      write(REG.Command, CMD.Idle);
      return (read(REG.CrcResultH) << 8) | read(REG.CrcResultL);
    };
    expect(calc(0x00, 0x00)).toBe(0x1ea0);
    expect(calc(0x12, 0x34)).toBe(0xcf26);
    expect(calc(0x30, 0x00)).toBe(0xa802); // READ block 0: 30 00 02 A8
    expect(calc(0x50, 0x00)).toBe(0xcd57); // HLTA: 50 00 57 CD
    expect(calc(0x60, 0x00)).toBe(0x7bf5); // AUTH: 60 00 F5 7B
    // The FIFO is the coprocessor's input: emptied as it goes; a frame with its CRC leaves zero (CRCOk).
    expect(calc(0x30, 0x00, 0x02, 0xa8)).toBe(0);
    expect(read(REG.Status1) & 0x40).toBe(0x40);
    expect(read(REG.FifoLevel)).toBe(0);
    // Bytes written while CalcCRC runs join the calculation.
    write(REG.FifoLevel, 0x80);
    write(REG.FifoData, 0x12);
    write(REG.Command, CMD.CalcCrc);
    write(REG.FifoData, 0x34);
    expect((read(REG.CrcResultH) << 8) | read(REG.CrcResultL)).toBe(0xcf26);
    write(REG.Command, CMD.Idle);
    // Other presets: 0000h and FFFFh.
    write(REG.Mode, 0x3c);
    expect(calc(0x12, 0x34)).toBe(crcA([0x12, 0x34], 0, 2, 0));
    write(REG.Mode, 0x3f);
    expect(calc(0x12, 0x34)).toBe(crcA([0x12, 0x34], 0, 2, 0xffff));
  });

  it('(d) Transceive with no card: TxIRq after the frame, then TimerIRq when TAuto’s timer runs out at the prescaler and reload', () => {
    const { clock, c, read, write } = chip();
    init(write);
    expect(c.field).toBe(true);
    write(REG.Command, CMD.Idle);
    write(REG.ComIrq, 0x7f);
    write(REG.FifoLevel, 0x80);
    write(REG.FifoData, 0x26); // REQA
    write(REG.BitFraming, 0x07);
    write(REG.Command, CMD.Transceive);
    write(REG.BitFraming, 0x87); // StartSend
    expect(read(REG.Status2) & 7).toBe(3); // transmitting
    const txEnd = rfidFrameNs(1, 7);
    expect(txEnd).toBeCloseTo(9 * RFID_ETU_NS, 6);
    clock.advance(txEnd - 1);
    expect(read(REG.ComIrq) & 0x40).toBe(0);
    clock.advance(Math.ceil(txEnd));
    expect(read(REG.ComIrq) & 0x41).toBe(0x40); // TxIRq, the timer running
    expect(read(REG.Status1) & 0x08).toBe(0x08); // TRunning
    const counter = (): number => (read(REG.TCounterH) << 8) | read(REG.TCounterL);
    clock.advance(txEnd + 12_500_000); // half way: 25 µs ticks
    expect(Math.abs(counter() - 500)).toBeLessThanOrEqual(1);
    clock.advance(txEnd + TIMEOUT_NS - 1000);
    expect(read(REG.ComIrq) & 0x01).toBe(0);
    clock.advance(txEnd + TIMEOUT_NS + 1000);
    expect(read(REG.ComIrq) & 0x31).toBe(0x01); // TimerIRq, no RxIRq, no IdleIRq
    expect(read(REG.Status1) & 0x08).toBe(0);
    expect(read(REG.Command) & 0x0f).toBe(CMD.Transceive); // still waiting
    expect(read(REG.FifoLevel)).toBe(0);
    // TAutoRestart: TimerIRq again each period.
    write(REG.ComIrq, 0x7f);
    write(REG.TMode, 0x10); // TAutoRestart, TPrescaler_Hi 0
    write(REG.TPrescaler, 0x00); // 13.56 MHz
    write(REG.TReloadH, 0);
    write(REG.TReloadL, 0x63); // 100 ticks: 7.37 µs
    write(REG.Control, 0x40); // TStartNow
    const period = (100 * 1e9) / 13.56e6;
    const from = clock.t;
    let fired = 0;
    for (let i = 1; i <= 5; i++) {
      clock.advance(from + i * period + 10);
      if (read(REG.ComIrq) & 1) fired++;
      write(REG.ComIrq, 0x01);
    }
    expect(fired).toBe(5);
    write(REG.Control, 0x80); // TStopNow
    clock.advance(clock.t + 10 * period);
    expect(read(REG.ComIrq) & 1).toBe(0);
  });

  it('(d) Transceive with a card: TxLastBits to the card, its answer into the FIFO after the frame delay, the timer stopped, RxLastBits, RxAlign', () => {
    const { clock, c, read, write } = chip();
    init(write);
    const card = new ScriptedCard((bytes) => (bytes[0] === 0x26 ? { bytes: [0x04, 0x00] } : bytes[0] === 0xa0 ? { bytes: [0x0a], lastBits: 4, delayNs: 2_000_000 } : { bytes: [0xb5] }));
    c.setPicc(card);
    expect(card.fields).toEqual([true]);
    const transceive = (bits: number, ...bytes: number[]): void => {
      write(REG.Command, CMD.Idle);
      write(REG.ComIrq, 0x7f);
      write(REG.FifoLevel, 0x80);
      write(REG.FifoData, ...bytes);
      write(REG.BitFraming, bits);
      write(REG.Command, CMD.Transceive);
      write(REG.BitFraming, 0x80 | bits);
    };
    transceive(0x07, 0x26);
    const txEnd = rfidFrameNs(1, 7);
    const rxEnd = txEnd + RFID_FDT_NS + rfidFrameNs(2, 8);
    clock.advance(rxEnd - 100);
    expect(read(REG.ComIrq) & 0x20).toBe(0);
    expect(read(REG.Status2) & 7).toBe(6); // receiving
    clock.advance(rxEnd + 100);
    expect(card.got).toEqual([{ bytes: [0x26], lastBits: 7, encrypted: false }]);
    expect(read(REG.ComIrq) & 0x61).toBe(0x60); // TxIRq, RxIRq, no TimerIRq
    expect(read(REG.Status1) & 0x08).toBe(0); // TAuto: stopped at the answer
    expect([read(REG.FifoLevel), read(REG.FifoData), read(REG.FifoData), read(REG.Control) & 7]).toEqual([2, 0x04, 0x00, 0]);
    expect(read(REG.Status2) & 7).toBe(1); // waiting for StartSend
    clock.advance(clock.t + TIMEOUT_NS);
    expect(read(REG.ComIrq) & 0x01).toBe(0); // the stopped timer never fires
    // A 4-bit answer after the card's own delay.
    transceive(0x00, 0xa0, 0x04);
    const t0 = clock.t;
    clock.advance(t0 + rfidFrameNs(2, 8) + RFID_FDT_NS + 1_500_000);
    expect(read(REG.ComIrq) & 0x20).toBe(0);
    clock.advance(t0 + rfidFrameNs(2, 8) + RFID_FDT_NS + 2_000_000 + rfidFrameNs(1, 4) + 100);
    expect([read(REG.FifoLevel), read(REG.Control) & 7, read(REG.FifoData)]).toEqual([1, 4, 0x0a]);
    // RxAlign 3: the answer's first bit lands at bit 3 (0xB5 → 1010_1000 then 0000_0101).
    transceive(0x30, 0x93);
    clock.advance(clock.t + 2_000_000);
    expect([read(REG.FifoLevel), read(REG.FifoData), read(REG.FifoData), read(REG.Control) & 7]).toEqual([2, (0xb5 << 3) & 0xff, 0xb5 >> 5, 3]);
    // RcvOff: the card is heard by nobody.
    write(REG.Command, 0x20 | CMD.Idle);
    write(REG.ComIrq, 0x7f);
    write(REG.FifoLevel, 0x80);
    write(REG.FifoData, 0x26);
    write(REG.BitFraming, 0x07);
    write(REG.Command, 0x20 | CMD.Transceive);
    write(REG.BitFraming, 0x87);
    clock.advance(clock.t + 2_000_000);
    expect(read(REG.ComIrq) & 0x20).toBe(0);
  });

  it('(d) TxCRCEn appends CRC_A; RxCRCEn checks the answer’s and removes it, CRCErr when wrong', () => {
    const { clock, c, read, write } = chip();
    init(write);
    let good = true;
    const card = new ScriptedCard((bytes) => {
      const crc = crcA(bytes, 0, 2);
      expect(bytes.slice(2)).toEqual([crc & 0xff, crc >> 8]);
      const sak = crcA([0x08], 0, 1);
      return { bytes: [0x08, sak & 0xff, (sak >> 8) ^ (good ? 0 : 1)] };
    });
    c.setPicc(card);
    write(REG.TxMode, 0x80);
    write(REG.RxMode, 0x80);
    for (const ok of [true, false]) {
      good = ok;
      write(REG.Command, CMD.Idle);
      write(REG.ComIrq, 0x7f);
      write(REG.FifoLevel, 0x80);
      write(REG.FifoData, 0x30, 0x04);
      write(REG.BitFraming, 0x00);
      write(REG.Command, CMD.Transceive);
      write(REG.BitFraming, 0x80);
      clock.advance(clock.t + 2_000_000);
      expect(card.got.at(-1)?.bytes).toHaveLength(4);
      if (ok) expect([read(REG.Error) & 0x04, read(REG.FifoLevel), read(REG.FifoData)]).toEqual([0, 1, 0x08]);
      else expect([read(REG.Error) & 0x04, read(REG.ComIrq) & 0x02]).toEqual([0x04, 0x02]);
    }
  });

  it('(d) MFAuthent: the FIFO’s 12 bytes to the card, MFCrypto1On and IdleIRq on success; a silent card leaves it to the timer; frames after it go encrypted', () => {
    const { clock, c, read, write } = chip();
    init(write);
    const card = new ScriptedCard(() => ({ bytes: [0x0a], lastBits: 4 }));
    c.setPicc(card);
    const authenticate = (): void => {
      write(REG.Command, CMD.Idle);
      write(REG.ComIrq, 0x7f);
      write(REG.FifoLevel, 0x80);
      write(REG.FifoData, 0x60, 0x04, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xde, 0xad, 0xbe, 0xef);
      write(REG.BitFraming, 0x00);
      write(REG.Command, CMD.MfAuthent);
    };
    authenticate();
    clock.advance(clock.t + 4_000_000);
    expect(card.authArgs).toEqual([0x60, 0x04, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xde, 0xad, 0xbe, 0xef]);
    expect([read(REG.ComIrq) & 0x71, read(REG.Status2) & 0x08, read(REG.Command) & 0x0f]).toEqual([0x10, 0x08, CMD.Idle]); // IdleIRq only: Tx/RxIRq blocked
    expect(c.cryptoOn).toBe(true);
    // The next frame goes encrypted; clearing MFCrypto1On stops that.
    write(REG.FifoData, 0xa0, 0x04);
    write(REG.Command, CMD.Transceive);
    write(REG.BitFraming, 0x80);
    clock.advance(clock.t + 2_000_000);
    expect(card.got.at(-1)?.encrypted).toBe(true);
    write(REG.Status2, 0x00);
    expect(c.cryptoOn).toBe(false);
    // Wrong key: silence; TimerIRq when TAuto's timer runs out, the command still running.
    card.auth = 'silent';
    authenticate();
    const t0 = clock.t;
    clock.advance(t0 + 20_000_000);
    expect(read(REG.ComIrq) & 0x11).toBe(0);
    clock.advance(t0 + rfidFrameNs(4, 8) + TIMEOUT_NS + 1000);
    expect([read(REG.ComIrq) & 0x11, read(REG.Status2) & 0x08, read(REG.Command) & 0x0f]).toEqual([0x01, 0, CMD.MfAuthent]);
    // An answer that isn't one (an NTAG's NAK): ProtocolErr and the command ends.
    card.auth = 'protocol';
    authenticate();
    clock.advance(clock.t + 2_000_000);
    expect([read(REG.ComIrq) & 0x13, read(REG.Error) & 0x01]).toEqual([0x12, 0x01]);
    // Data written to the FIFO during MFAuthent: WrErr.
    card.auth = 'ok';
    authenticate();
    write(REG.FifoData, 0x00);
    expect(read(REG.Error) & 0x80).toBe(0x80);
  });

  it('(e) the IRQ output: IRq from the enables, IRqInv and IRQPushPull; CRCIRq through DivIEnReg', () => {
    const { c, read, write } = chip();
    write(REG.ComIrq, 0x7f);
    expect(c.irqOutput()).toBe(-1); // open drain, inverted, nothing pending: released
    write(REG.ComIrq, 0x81); // TimerIRq pending, not enabled
    expect([c.irq, c.irqOutput(), read(REG.Status1) & 0x10]).toEqual([false, -1, 0]);
    write(REG.ComIEn, 0x81); // TimerIEn
    expect([c.irq, c.irqOutput(), read(REG.Status1) & 0x10]).toEqual([true, 0, 0x10]); // pulled low
    write(REG.DivIEn, 0x80); // push-pull
    expect(c.irqOutput()).toBe(0);
    write(REG.ComIrq, 0x01);
    expect(c.irqOutput()).toBe(1); // driven high
    write(REG.ComIEn, 0x01); // not inverted
    expect(c.irqOutput()).toBe(0);
    write(REG.ComIrq, 0x81);
    expect(c.irqOutput()).toBe(1);
    write(REG.DivIEn, 0x00); // open drain, not inverted: high is released
    expect(c.irqOutput()).toBe(-1);
    // CRCIRq, enabled in DivIEnReg.
    write(REG.ComIEn, 0x80);
    write(REG.ComIrq, 0x7f);
    write(REG.DivIEn, 0x04);
    write(REG.Command, CMD.CalcCrc);
    expect([c.irq, c.irqOutput()]).toEqual([true, 0]);
    write(REG.DivIrq, 0x04);
    expect(c.irq).toBe(false);
  });

  it('(f) SoftReset restores the reset values but keeps the internal buffer (Mem); a hard reset clears it; GenerateRandomID; an unknown command', () => {
    const { c, read, write, frame } = chip();
    init(write);
    write(REG.FifoData, ...Array.from({ length: 25 }, (_, i) => 0x40 + i));
    write(REG.ComIrq, 0x7f);
    write(REG.Command, CMD.Mem);
    expect([read(REG.FifoLevel), read(REG.ComIrq) & 0x10, read(REG.Command) & 0x0f]).toEqual([0, 0x10, CMD.Idle]);
    write(REG.Command, CMD.SoftReset);
    expect([REG.Command, REG.ComIrq, REG.TxControl, REG.Mode, REG.TMode, REG.TPrescaler].map(read)).toEqual([0x20, 0x14, 0x80, 0x3f, 0, 0]);
    expect(c.field).toBe(false);
    const memOut = (): number[] => {
      write(REG.FifoLevel, 0x80);
      write(REG.Command, CMD.Mem);
      const fifo = 0x80 | (REG.FifoData << 1);
      return frame(...Array.from({ length: 25 }, () => fifo), 0).slice(1);
    };
    expect(memOut()).toEqual(Array.from({ length: 25 }, (_, i) => 0x40 + i));
    write(REG.Command, CMD.GenerateRandomId);
    const random = memOut();
    expect(random.slice(10)).toEqual(Array.from({ length: 15 }, (_, i) => 0x4a + i));
    expect(new Set(random.slice(0, 10)).size).toBeGreaterThan(5);
    c.power(false);
    expect(frame(0x80 | (REG.Version << 1), 0)).toEqual([0xff, 0xff]); // hard power-down: no answer
    c.power(true);
    expect(memOut()).toEqual(Array.from({ length: 25 }, () => 0));
    // Soft power-down: the antenna off, the registers kept.
    init(write);
    expect(c.field).toBe(true);
    write(REG.Command, 0x10 | CMD.NoCmdChange);
    expect([c.field, read(REG.Command) & 0x10, read(REG.TxControl)]).toEqual([false, 0x10, 0x83]);
    write(REG.Command, CMD.NoCmdChange);
    expect([c.field, read(REG.Command) & 0x10]).toEqual([true, 0]);
    write(REG.ComIrq, 0x7f);
    write(REG.Command, 0x05); // reserved
    expect([read(REG.Command) & 0x0f, read(REG.ComIrq) & 0x10]).toEqual([CMD.Idle, 0x10]);
  });
});
