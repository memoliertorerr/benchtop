import { describe, expect, it } from 'vitest';
import { accessBytes, CLASSIC_WRITE_NS, formatUid, type Iso14443Card, MifareClassic1k, NTAG_WRITE_NS, Ntag213, PICC_ACK, PICC_NAK, parseUid } from './cards.ts';
import { crcA, type PiccAnswer } from './picc.ts';

// BT197: the cards on their own, frame by frame — ISO/IEC 14443-3 type A, MIFARE Classic 1K
// (MF1S50) and NTAG213, as the MFRC522 hands them frames.

interface Heard {
  bytes: number[];
  lastBits: number;
  delayNs: number;
}

function heard(a: PiccAnswer | null): Heard | null {
  return a === null ? null : { bytes: [...a.bytes.subarray(0, a.length)], lastBits: a.lastBits, delayNs: a.delayNs };
}

/** A frame to the card: `bytes` (CRC_A appended when `crc`), its last byte `lastBits` valid. */
function send(card: Iso14443Card, bytes: number[], options: { crc?: boolean; lastBits?: number; encrypted?: boolean } = {}): Heard | null {
  const frame = [...bytes];
  if (options.crc === true) {
    const c = crcA(frame, 0, frame.length);
    frame.push(c & 0xff, c >> 8);
  }
  return heard(card.frame(Uint8Array.from(frame), frame.length, options.lastBits ?? 8, options.encrypted ?? false));
}

const withCrc = (bytes: number[]): number[] => {
  const c = crcA(bytes, 0, bytes.length);
  return [...bytes, c & 0xff, c >> 8];
};
const REQA = (card: Iso14443Card): Heard | null => send(card, [0x26], { lastBits: 7 });
const WUPA = (card: Iso14443Card): Heard | null => send(card, [0x52], { lastBits: 7 });

/** Anticollision and SELECT through every cascade level; returns the final SAK. */
function select(card: Iso14443Card): number {
  for (let level = 0; level < 3; level++) {
    const sel = 0x93 + 2 * level;
    const cl = send(card, [sel, 0x20]);
    if (cl === null) throw new Error(`no answer at level ${level + 1}`);
    const sak = send(card, [sel, 0x70, ...cl.bytes], { crc: true });
    if (sak === null) throw new Error('no SAK');
    expect(crcA(sak.bytes, 0, 3)).toBe(0);
    if ((sak.bytes[0] & 0x04) === 0) return sak.bytes[0];
  }
  throw new Error('UID never complete');
}

const UID4 = Uint8Array.of(0xa3, 0xf1, 0xc5, 0x2e);
const UID7 = Uint8Array.of(0x04, 0x3c, 0x8a, 0x52, 0xb1, 0x6e, 0x80);
const KEY = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
const ack = { bytes: [PICC_ACK], lastBits: 4, delayNs: 0 };
const nak = { bytes: [PICC_NAK], lastBits: 4, delayNs: 0 };

function authenticate(card: MifareClassic1k, keyType: number, block: number, key: number[] = KEY, uid: ArrayLike<number> = card.uid.subarray(card.uid.length - 4)) {
  return card.authenticate(keyType, block, Uint8Array.from(key), 0, Uint8Array.from(uid), 0);
}

describe('ISO 14443-3 type A (BT197)', () => {
  it('(a) REQA, anticollision and SELECT for a 4-byte UID: ATQA 0004h, the UID with its BCC, SAK 08h', () => {
    const card = new MifareClassic1k(UID4);
    expect(REQA(card)).toBeNull(); // no field: off
    card.field(true);
    expect(card.status).toBe('idle');
    expect(REQA(card)).toEqual({ bytes: [0x04, 0x00], lastBits: 8, delayNs: 0 });
    expect(card.status).toBe('ready');
    expect(send(card, [0x93, 0x20])?.bytes).toEqual([0xa3, 0xf1, 0xc5, 0x2e, 0xa3 ^ 0xf1 ^ 0xc5 ^ 0x2e]);
    // SELECT with a wrong CRC: back to IDLE, silent.
    expect(send(card, [0x93, 0x70, 0xa3, 0xf1, 0xc5, 0x2e, 0xa3 ^ 0xf1 ^ 0xc5 ^ 0x2e, 0x00, 0x00])).toBeNull();
    expect(card.status).toBe('idle');
    REQA(card);
    expect(select(card)).toBe(0x08);
    expect(card.status).toBe('active');
  });

  it('(a) a 7-byte UID takes two levels — the cascade tag 88h, SAK 04h — and an NTAG213 answers ATQA 0044h, SAK 00h', () => {
    for (const [card, sak] of [
      [new MifareClassic1k(UID7), 0x08],
      [new Ntag213(UID7), 0x00],
    ] as const) {
      card.field(true);
      expect(REQA(card)?.bytes).toEqual([0x44, 0x00]);
      expect(send(card, [0x93, 0x20])?.bytes).toEqual([0x88, 0x04, 0x3c, 0x8a, 0x88 ^ 0x04 ^ 0x3c ^ 0x8a]);
      const cl1 = send(card, [0x93, 0x70, 0x88, 0x04, 0x3c, 0x8a, 0x88 ^ 0x04 ^ 0x3c ^ 0x8a], { crc: true });
      expect(cl1?.bytes[0]).toBe(0x04);
      expect(send(card, [0x95, 0x20])?.bytes).toEqual([0x52, 0xb1, 0x6e, 0x80, 0x52 ^ 0xb1 ^ 0x6e ^ 0x80]);
      const cl2 = send(card, [0x95, 0x70, 0x52, 0xb1, 0x6e, 0x80, 0x52 ^ 0xb1 ^ 0x6e ^ 0x80], { crc: true });
      expect(cl2?.bytes[0]).toBe(sak);
      expect(card.status).toBe('active');
    }
  });

  it('(a) a partial anticollision frame: the card answers the bits after the reader’s known ones; another card’s bits: silence', () => {
    const card = new MifareClassic1k(UID4);
    card.field(true);
    REQA(card);
    // NVB 24h: SEL, NVB and 4 known bits (the low nibble of A3h).
    const rest = send(card, [0x93, 0x24, 0x03], { lastBits: 4 });
    expect(rest?.lastBits).toBe(4); // 36 bits: 4 bytes and 4 bits
    expect(rest?.bytes).toHaveLength(5);
    // Joined at bit 4 (the reader's RxAlign), they make the level's 40 bits.
    const joined = [0x03 | ((rest?.bytes[0] ?? 0) << 4)];
    for (let i = 1; i < 5; i++) joined.push((((rest?.bytes[i - 1] ?? 0) >> 4) | ((rest?.bytes[i] ?? 0) << 4)) & 0xff);
    expect(joined.map((b) => b & 0xff)).toEqual([0xa3, 0xf1, 0xc5, 0x2e, 0xa3 ^ 0xf1 ^ 0xc5 ^ 0x2e]);
    expect(send(card, [0x93, 0x24, 0x05], { lastBits: 4 })).toBeNull();
    expect(card.status).toBe('ready');
  });

  it('(a) the states: REQA leaves an ACTIVE card for IDLE (answering the next), HLTA halts it, only WUPA wakes it, errors return it to HALT; the field resets it', () => {
    const card = new MifareClassic1k(UID4);
    card.field(true);
    REQA(card);
    select(card);
    expect(REQA(card)).toBeNull();
    expect(card.status).toBe('idle');
    expect(REQA(card)).not.toBeNull();
    select(card);
    expect(send(card, [0x50, 0x00], { crc: true })).toBeNull();
    expect(card.status).toBe('halt');
    expect(REQA(card)).toBeNull();
    expect(WUPA(card)?.bytes).toEqual([0x04, 0x00]);
    expect(send(card, [0x30, 0x00], { crc: true })).toBeNull(); // not a SELECT: back to HALT
    expect(card.status).toBe('halt');
    card.field(false);
    expect(card.status).toBe('off');
    card.field(true);
    expect(REQA(card)).not.toBeNull();
  });

  it('parses and formats UIDs', () => {
    expect(parseUid('A3 F1 C5 2E')).toEqual(UID4);
    expect(parseUid('043c8a52b16e80')).toEqual(UID7);
    expect(parseUid('88000000')).toBeNull(); // the cascade tag
    expect(parseUid('A3F1C5')).toBeNull();
    expect(parseUid('zz112233')).toBeNull();
    expect(formatUid(UID4)).toBe('A3 F1 C5 2E');
  });
});

describe('MIFARE Classic 1K (BT197)', () => {
  const ready = (uid = UID4): MifareClassic1k => {
    const card = new MifareClassic1k(uid);
    card.field(true);
    REQA(card);
    select(card);
    return card;
  };
  const read = (card: MifareClassic1k, block: number): Heard | null => send(card, [0x30, block], { crc: true, encrypted: true });
  const write = (card: MifareClassic1k, block: number, data: number[]): [Heard | null, Heard | null] => {
    const first = send(card, [0xa0, block], { crc: true, encrypted: true });
    if (first?.bytes[0] !== PICC_ACK) return [first, null];
    return [first, send(card, data, { crc: true, encrypted: true })];
  };

  it('(b) ships with block 0 (UID, BCC, SAK, ATQA), keys FFFFFFFFFFFFh and the transport configuration FF 07 80 69', () => {
    const card = ready();
    expect(authenticate(card, 0x60, 0)).toBe('ok');
    expect(card.status).toBe('authenticated');
    expect(read(card, 0)?.bytes).toEqual(withCrc([0xa3, 0xf1, 0xc5, 0x2e, 0xa3 ^ 0xf1 ^ 0xc5 ^ 0x2e, 0x08, 0x04, 0x00, 0x42, 0x45, 0x4e, 0x43, 0x48, 0x54, 0x4f, 0x50]));
    // The trailer: key A never reads; access bits and (readable here) key B do.
    expect(read(card, 3)?.bytes).toEqual(withCrc([0, 0, 0, 0, 0, 0, 0xff, 0x07, 0x80, 0x69, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]));
    expect(accessBytes([0, 0, 0, 1])).toEqual([0xff, 0x07, 0x80]);
    expect(accessBytes([4, 4, 4, 3])).toEqual([0x78, 0x77, 0x88]);
    // A 7-byte UID card authenticates with its last four bytes.
    const seven = ready(UID7);
    expect(authenticate(seven, 0x60, 0, KEY, [0x52, 0xb1, 0x6e, 0x80])).toBe('ok');
    expect(read(seven, 0)?.bytes.slice(0, 10)).toEqual([...UID7, 0x08, 0x44, 0x00]);
  });

  it('(b) READ and WRITE (two steps, ACK each, the second after the EEPROM write) in the open sector only; block 0 read-only; plaintext ends the session', () => {
    const card = ready();
    expect(send(card, [0x30, 0x04], { crc: true })).toEqual(nak); // not authenticated
    expect(card.status).toBe('idle');
    REQA(card);
    select(card);
    expect(authenticate(card, 0x60, 4)).toBe('ok');
    const data = Array.from({ length: 16 }, (_, i) => 0x10 + i);
    const [first, second] = write(card, 5, data);
    expect(first).toEqual(ack);
    expect(second).toEqual({ ...ack, delayNs: CLASSIC_WRITE_NS });
    expect(read(card, 5)?.bytes).toEqual(withCrc(data));
    expect(write(card, 0, data)[0]).toEqual(nak); // another sector, and read-only anyway
    expect(card.status).toBe('idle');
    REQA(card);
    select(card);
    expect(authenticate(card, 0x60, 0)).toBe('ok');
    expect(write(card, 0, data)[0]).toEqual(nak); // the manufacturer block
    REQA(card);
    select(card);
    authenticate(card, 0x60, 5);
    expect(read(card, 8)).toEqual(nak); // sector 2 isn't open
    REQA(card);
    select(card);
    authenticate(card, 0x60, 5);
    expect(send(card, [0x30, 0x05], { crc: true })).toBeNull(); // the reader stopped encrypting: garbage
    expect(card.status).toBe('idle');
    // A CRC error: NAK 5h.
    REQA(card);
    select(card);
    authenticate(card, 0x60, 5);
    expect(send(card, [0x30, 0x05, 0x00, 0x00], { encrypted: true })).toEqual({ ...nak, bytes: [0x05] });
  });

  it('(b) a wrong key or UID is silence and back to IDLE; HLTA when authenticated halts', () => {
    const card = ready();
    expect(authenticate(card, 0x60, 4, [0, 1, 2, 3, 4, 5])).toBe('silent');
    expect(card.status).toBe('idle');
    REQA(card);
    select(card);
    expect(authenticate(card, 0x60, 4, KEY, [1, 2, 3, 4])).toBe('silent');
    REQA(card);
    select(card);
    expect(authenticate(card, 0x60, 64)).toBe('protocol');
    REQA(card);
    expect(authenticate(card, 0x60, 4)).toBe('silent'); // not selected
    select(card);
    authenticate(card, 0x60, 4);
    expect(send(card, [0x50, 0x00], { crc: true, encrypted: true })).toBeNull();
    expect(card.status).toBe('halt');
    expect(WUPA(card)).not.toBeNull();
  });

  it('(b) access conditions: key B can’t serve while readable; "78 77 88" reads with A and writes with B, hiding key B; bad bits block the sector', () => {
    const card = ready();
    authenticate(card, 0x61, 4); // key B, readable in the transport configuration
    expect(card.status).toBe('authenticated');
    expect(read(card, 4)).toEqual(nak);
    // Key A writes the trailer in the transport configuration: new keys, data blocks 100, trailer 011.
    REQA(card);
    select(card);
    authenticate(card, 0x60, 7);
    const keyA = [0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5];
    const keyB = [0xb0, 0xb1, 0xb2, 0xb3, 0xb4, 0xb5];
    expect(write(card, 7, [...keyA, 0x78, 0x77, 0x88, 0x69, ...keyB])[1]?.bytes).toEqual([PICC_ACK]);
    expect(card.memory.subarray(7 * 16, 8 * 16)).toEqual(Uint8Array.from([...keyA, 0x78, 0x77, 0x88, 0x69, ...keyB]));
    // The old key no longer opens it.
    expect(authenticate(card, 0x60, 4)).toBe('silent');
    REQA(card);
    select(card);
    expect(authenticate(card, 0x60, 4, keyA)).toBe('ok');
    expect(read(card, 4)?.bytes).toHaveLength(18);
    expect(read(card, 7)?.bytes).toEqual(withCrc([0, 0, 0, 0, 0, 0, 0x78, 0x77, 0x88, 0x69, 0, 0, 0, 0, 0, 0])); // key B hidden
    expect(write(card, 4, new Array(16).fill(1))[0]).toEqual(nak); // writing needs key B
    REQA(card);
    select(card);
    expect(authenticate(card, 0x61, 4, keyB)).toBe('ok');
    expect(write(card, 4, new Array(16).fill(1))[1]?.bytes).toEqual([PICC_ACK]);
    // Inconsistent access bits (written with key B: 011 lets it): the sector is blocked.
    expect(write(card, 7, [...keyA, 0x00, 0x00, 0x00, 0x69, ...keyB])[1]?.bytes).toEqual([PICC_ACK]);
    expect(REQA(card)).toBeNull(); // plaintext to an authenticated card: garbage, back to IDLE
    REQA(card);
    select(card);
    expect(authenticate(card, 0x60, 4, keyA)).toBe('ok');
    expect(read(card, 4)).toEqual(nak);
  });

  it('(b) value blocks: INCREMENT, DECREMENT and RESTORE into the transfer buffer, TRANSFER back', () => {
    const card = ready();
    authenticate(card, 0x60, 8);
    const value = (v: number, a: number): number[] => {
      const b = [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
      return [...b, ...b.map((x) => ~x & 0xff), ...b, a, ~a & 0xff, a, ~a & 0xff];
    };
    write(card, 9, value(100, 9));
    const op = (code: number, block: number, operand: number): Heard | null => {
      const first = send(card, [code, block], { crc: true, encrypted: true });
      expect(first, `${code.toString(16)} ${block}`).toEqual(ack);
      return send(card, [operand & 0xff, (operand >> 8) & 0xff, (operand >> 16) & 0xff, (operand >>> 24) & 0xff], { crc: true, encrypted: true });
    };
    expect(op(0xc1, 9, 20)).toBeNull(); // no answer to the operand
    expect(send(card, [0xb0, 9], { crc: true, encrypted: true })).toEqual({ ...ack, delayNs: CLASSIC_WRITE_NS });
    expect(read(card, 9)?.bytes.slice(0, 16)).toEqual(value(120, 9));
    op(0xc0, 9, 150);
    send(card, [0xb0, 10], { crc: true, encrypted: true });
    expect(read(card, 10)?.bytes.slice(0, 16)).toEqual(value(-30, 9));
    // Not a value block: NAK.
    expect(send(card, [0xc1, 8], { crc: true, encrypted: true })).toEqual(nak);
  });
});

describe('NTAG213 (BT197)', () => {
  const ready = (): Ntag213 => {
    const card = new Ntag213(UID7);
    card.field(true);
    REQA(card);
    select(card);
    return card;
  };
  const read = (card: Ntag213, page: number): number[] | undefined => send(card, [0x30, page], { crc: true })?.bytes.slice(0, 16);

  it('(c) READ: the UID pages, the capability container, an empty NDEF message; rolling over at the end, PWD and PACK as zeros', () => {
    const card = ready();
    expect(read(card, 0)).toEqual([0x04, 0x3c, 0x8a, 0x88 ^ 0x04 ^ 0x3c ^ 0x8a, 0x52, 0xb1, 0x6e, 0x80, 0x52 ^ 0xb1 ^ 0x6e ^ 0x80, 0x48, 0, 0, 0xe1, 0x10, 0x12, 0x00]);
    expect(read(card, 4)?.slice(0, 4)).toEqual([0x03, 0x00, 0xfe, 0x00]);
    expect(read(card, 0x2b)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0x04, 0x3c, 0x8a, 0x88 ^ 0x04 ^ 0x3c ^ 0x8a, 0x52, 0xb1, 0x6e, 0x80]);
    expect(read(card, 0x29)?.slice(0, 8)).toEqual([0x04, 0x00, 0x00, 0xff, 0x00, 0x05, 0x00, 0x00]);
    expect(send(card, [0x60], { crc: true })?.bytes).toEqual(withCrc([0x00, 0x04, 0x04, 0x02, 0x01, 0x00, 0x0f, 0x03]));
    expect(send(card, [0x3a, 0x04, 0x05], { crc: true })?.bytes).toHaveLength(10);
    expect(send(card, [0x30, 45], { crc: true })).toEqual({ bytes: [0x00], lastBits: 4, delayNs: 0 });
    expect(card.status).toBe('idle');
  });

  it('(c) WRITE a page (ACK after 4.1 ms), COMPATIBILITY_WRITE; pages 0–1 refuse, the CC and lock bits only set, locked pages refuse; MFAuthent is a protocol error', () => {
    const card = ready();
    expect(send(card, [0xa2, 0x04, 1, 2, 3, 4], { crc: true })).toEqual({ ...ack, delayNs: NTAG_WRITE_NS });
    expect(read(card, 4)?.slice(0, 4)).toEqual([1, 2, 3, 4]);
    expect(send(card, [0xa0, 0x05], { crc: true })).toEqual(ack);
    expect(send(card, [9, 8, 7, 6, ...new Array(12).fill(0xee)], { crc: true })).toEqual({ ...ack, delayNs: NTAG_WRITE_NS });
    expect(read(card, 4)?.slice(0, 12)).toEqual([1, 2, 3, 4, 9, 8, 7, 6, 0, 0, 0, 0]);
    expect(send(card, [0xa2, 0x00, 0, 0, 0, 0], { crc: true })?.bytes).toEqual([0x00]);
    REQA(card);
    select(card);
    send(card, [0xa2, 0x03, 0x00, 0x00, 0x00, 0x0f], { crc: true });
    expect(read(card, 3)?.slice(0, 4)).toEqual([0xe1, 0x10, 0x12, 0x0f]);
    // Lock pages 4–7 (lock byte 0, bits 4–7).
    send(card, [0xa2, 0x02, 0x00, 0x00, 0xf0, 0x00], { crc: true });
    expect(send(card, [0xa2, 0x04, 0, 0, 0, 0], { crc: true })?.bytes).toEqual([0x00]);
    REQA(card);
    select(card);
    expect(send(card, [0xa2, 0x08, 5, 5, 5, 5], { crc: true })?.bytes).toEqual([PICC_ACK]);
    expect(card.authenticate()).toBe('protocol');
    expect(card.status).toBe('idle');
  });
});
