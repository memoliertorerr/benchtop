/**
 * BT197: the cards an RC522 reads — ISO/IEC 14443-3 type A proximity cards behind `Picc` (picc.ts).
 *
 * Every card (`Iso14443Card`): POWER-OFF without the field; IDLE; READY after REQA (26h, 7 bits)
 * or WUPA (52h; the only wake from HALT), answering ATQA; anticollision and SELECT per cascade level
 * (93h, 95h; NVB 20h asks for the whole level — 4 UID bytes, or the cascade tag 88h and 3, then
 * BCC, their XOR —, a partial NVB answers the bits after the known ones, NVB 70h with the level and
 * CRC_A selects: SAK, its cascade bit 04h while the UID goes on); ACTIVE once the UID is complete;
 * HLTA (50h 00h) to HALT. Anything unexpected sends a card back to IDLE — to HALT if HALT is where
 * WUPA found it — without an answer (so a card left ACTIVE ignores the next REQA and answers the one
 * after, as on hardware). A 4-byte UID can't start with 88h; 7-byte UIDs take two levels.
 *
 * `MifareClassic1k` (NXP's MF1S50 data sheet): 16 sectors of 4 blocks; block 0 the manufacturer
 * block (UID, BCC, SAK 08h, ATQA, and "BENCHTOP" for NXP's data; read-only); each sector's trailer
 * key A, access bits, a general-purpose byte (69h) and key B — FFFFFFFFFFFFh and FF 07 80, the
 * transport configuration, as shipped. MFAuthent with key A (60h) or B (61h) and the UID's last
 * four bytes opens a sector; a wrong key is silence (the reader times out) and the card returns to
 * IDLE. Then, encrypted (picc.ts: `encrypted`): READ (30h) 16 bytes, keys shown as the access bits
 * allow (key A never: zeros); WRITE (A0h) two steps, each acknowledged by the 4-bit ACK (Ah), the
 * second after an EEPROM write of 2.5 ms (taken), trailer parts written only where allowed; value
 * blocks — INCREMENT (C1h), DECREMENT (C0h), RESTORE (C2h) into the transfer buffer, TRANSFER (B0h)
 * back. Each checked against the sector's access conditions (MF1S50 Tables 7–9) for the key used;
 * key B can't serve where the trailer lets it be read; access bits whose complements disagree block
 * the sector. Refusals are the 4-bit NAK 4h (5h for a CRC error), and back to IDLE.
 *
 * `Ntag213` (NXP's NTAG213/215/216 data sheet): 45 pages of 4 bytes — the 7-byte UID with BCC0/BCC1
 * on pages 0–2, the static lock bytes, the capability container E1 10 12 00 on page 3 (one-time
 * programmable: bits only set), 144 bytes of user memory from page 4 (an empty NDEF message as
 * shipped), the dynamic lock bytes and the configuration pages 40–44 (AUTH0 FFh: no password).
 * READ (30h) four pages rolling over at the end, FAST_READ (3Ah), WRITE (A2h) a page after 4.1 ms,
 * COMPATIBILITY_WRITE (A0h), GET_VERSION (60h: 00 04 04 02 01 00 0F 03); locked pages, pages 0–1 and
 * addresses past 2Ch NAK (0h); PWD and PACK read as zeros. MFAuthent at an NTAG is a protocol
 * error at the reader. Not modelled: PWD_AUTH, READ_SIG, READ_CNT, the UID mirror.
 *
 * Answers reuse one buffer per card; nothing allocates per frame.
 */

import { crcA, type Picc, type PiccAnswer, type PiccAuth } from './picc.ts';

const OFF = 0;
const IDLE = 1;
const READY = 2;
const ACTIVE = 3;
const HALT = 4;
/** MIFARE Classic: a sector authenticated, frames encrypted. */
const AUTHENTICATED = 5;

/** The 4-bit acknowledgement and refusals. */
export const PICC_ACK = 0x0a;
export const PICC_NAK = 0x04;
export const PICC_NAK_CRC = 0x05;

/** Hex digits (spaces allowed) → UID bytes, or null unless 4 or 7 bytes (a 4-byte one not starting with 88h). */
export function parseUid(text: string): Uint8Array | null {
  const hex = text.replace(/[\s:-]/g, '');
  if (!/^[0-9a-fA-F]*$/.test(hex) || (hex.length !== 8 && hex.length !== 14)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  if (bytes.length === 4 && bytes[0] === 0x88) return null;
  return bytes;
}

/** UID bytes as the libraries print them: "A3 F1 C5 2E". */
export function formatUid(uid: ArrayLike<number>): string {
  let out = '';
  for (let i = 0; i < uid.length; i++) out += (i > 0 ? ' ' : '') + uid[i].toString(16).toUpperCase().padStart(2, '0');
  return out;
}

const crcOk = (data: Uint8Array, length: number): boolean => length >= 3 && crcA(data, 0, length) === 0;

export abstract class Iso14443Card implements Picc {
  readonly uid: Uint8Array;
  protected state = OFF;
  /** WUPA found it in HALT: errors send it back there. */
  protected halted = false;
  private level = 1;
  /** Each cascade level's 5 bytes (CLn + BCC). */
  private readonly levels: Uint8Array[];
  private readonly atqa: number;
  private readonly sak: number;
  protected readonly out = new Uint8Array(192);
  protected readonly answer: PiccAnswer = { bytes: this.out, length: 0, lastBits: 8, delayNs: 0 };

  protected constructor(uid: Uint8Array, atqa: number, sak: number) {
    this.uid = uid;
    this.atqa = atqa;
    this.sak = sak;
    const level = (a: number, b: number, c: number, d: number): Uint8Array => Uint8Array.of(a, b, c, d, a ^ b ^ c ^ d);
    this.levels = uid.length === 4 ? [level(uid[0], uid[1], uid[2], uid[3])] : [level(0x88, uid[0], uid[1], uid[2]), level(uid[3], uid[4], uid[5], uid[6])];
  }

  /** The ISO state's name, for tests and tools. */
  get status(): 'off' | 'idle' | 'ready' | 'active' | 'halt' | 'authenticated' {
    return (['off', 'idle', 'ready', 'active', 'halt', 'authenticated'] as const)[this.state];
  }

  field(on: boolean): void {
    this.state = on ? IDLE : OFF;
    this.halted = false;
    this.level = 1;
    this.endSession();
  }

  frame(data: Uint8Array, length: number, lastBits: number, encrypted: boolean): PiccAnswer | null {
    const state = this.state;
    if (state === OFF || length === 0) return null;
    if (state === AUTHENTICATED) {
      if (!encrypted) return this.reject();
      return this.secure(data, length, lastBits);
    }
    if (encrypted) return this.reject();
    if (length === 1 && lastBits === 7) {
      const wake = data[0] === 0x52;
      if ((state === IDLE && (wake || data[0] === 0x26)) || (state === HALT && wake)) {
        this.halted = state === HALT;
        this.state = READY;
        this.level = 1;
        this.out[0] = this.atqa & 0xff;
        this.out[1] = this.atqa >> 8;
        return this.bytes(2);
      }
      return state === READY || state === ACTIVE ? this.reject() : null;
    }
    if (state === READY) return this.select(data, length, lastBits);
    if (state === ACTIVE) {
      if (length === 4 && lastBits === 8 && data[0] === 0x50 && data[1] === 0x00 && crcOk(data, 4)) {
        this.state = HALT;
        this.halted = true;
        return null;
      }
      return this.command(data, length, lastBits);
    }
    return null; // IDLE and HALT ignore everything else
  }

  abstract authenticate(keyType: number, block: number, key: Uint8Array, keyAt: number, uid: Uint8Array, uidAt: number): PiccAuth;

  /** A frame in ACTIVE (not HLTA). */
  protected abstract command(data: Uint8Array, length: number, lastBits: number): PiccAnswer | null;

  /** An encrypted frame once authenticated (MIFARE Classic). */
  protected secure(_data: Uint8Array, _length: number, _lastBits: number): PiccAnswer | null {
    return this.reject();
  }

  /** The authenticated session ends (the field went, or an error). */
  protected endSession(): void {}

  /** Back to IDLE (or HALT), silent. */
  protected reject(): null {
    this.state = this.halted ? HALT : IDLE;
    this.level = 1;
    this.endSession();
    return null;
  }

  /** A 4-bit NAK, then back to IDLE (or HALT). */
  protected nak(code: number): PiccAnswer {
    this.reject();
    return this.nibble(code);
  }

  protected nibble(value: number, delayNs = 0): PiccAnswer {
    this.out[0] = value & 0x0f;
    this.answer.length = 1;
    this.answer.lastBits = 4;
    this.answer.delayNs = delayNs;
    return this.answer;
  }

  /** The first `n` bytes of `out`, full bytes. */
  protected bytes(n: number): PiccAnswer {
    this.answer.length = n;
    this.answer.lastBits = 8;
    this.answer.delayNs = 0;
    return this.answer;
  }

  /** `n` bytes in `out`, then their CRC_A. */
  protected withCrc(n: number): PiccAnswer {
    const crc = crcA(this.out, 0, n);
    this.out[n] = crc & 0xff;
    this.out[n + 1] = crc >> 8;
    return this.bytes(n + 2);
  }

  private select(data: Uint8Array, length: number, lastBits: number): PiccAnswer | null {
    const cl = this.levels[this.level - 1];
    if (length < 2 || data[0] !== 0x93 + 2 * (this.level - 1)) return this.reject();
    const nvb = data[1];
    if (nvb === 0x70) {
      if (length !== 9 || lastBits !== 8 || !crcOk(data, 9)) return this.reject();
      for (let i = 0; i < 5; i++) if (data[2 + i] !== cl[i]) return this.reject();
      if (this.level < this.levels.length) {
        this.level++;
        this.out[0] = 0x04; // the cascade bit: the UID goes on
        return this.withCrc(1);
      }
      this.state = ACTIVE;
      this.out[0] = this.sak;
      return this.withCrc(1);
    }
    const whole = nvb >> 4;
    const bits = nvb & 0x0f;
    if (whole < 2 || whole > 6 || bits > 7 || (whole === 6 && bits > 0)) return this.reject();
    const known = (whole - 2) * 8 + bits;
    // The reader's known bits must be the card's.
    for (let i = 0; i < known; i++) {
      const byte = 2 + (i >> 3);
      if (byte >= length) return this.reject();
      if (((data[byte] >> (i & 7)) & 1) !== ((cl[i >> 3] >> (i & 7)) & 1)) return null; // another card's: stays READY, silent
    }
    const rest = 40 - known;
    const n = (rest + 7) >> 3;
    this.out.fill(0, 0, n);
    for (let j = 0; j < rest; j++) {
      const i = known + j;
      if ((cl[i >> 3] >> (i & 7)) & 1) this.out[j >> 3] |= 1 << (j & 7);
    }
    this.answer.length = n;
    this.answer.lastBits = rest & 7 || 8;
    this.answer.delayNs = 0;
    return this.answer;
  }
}

// MIFARE Classic 1K.

/** Allowed keys per access condition (index C1·4 + C2·2 + C3): 1 key A, 2 key B (MF1S50 Tables 8 and 9). */
const DATA_READ = [3, 3, 3, 2, 3, 2, 3, 0];
const DATA_WRITE = [3, 0, 0, 2, 2, 0, 2, 0];
const DATA_INCREMENT = [3, 0, 0, 0, 0, 0, 2, 0];
const DATA_DECREMENT = [3, 3, 0, 0, 0, 0, 3, 0];
const KEY_A_WRITE = [1, 1, 0, 2, 2, 0, 0, 0];
const ACCESS_READ = [1, 1, 1, 3, 3, 3, 3, 3];
const ACCESS_WRITE = [0, 1, 0, 2, 0, 2, 0, 0];
const KEY_B_READ = [1, 1, 1, 0, 0, 0, 0, 0];
const KEY_B_WRITE = [1, 1, 0, 2, 2, 0, 0, 0];

/** MIFARE Classic's EEPROM write, taken as 2.5 ms. */
export const CLASSIC_WRITE_NS = 2_500_000;
/** NTAG213's page write: its data sheet's 4.1 ms. */
export const NTAG_WRITE_NS = 4_100_000;

const STEP_NONE = 0;
const STEP_WRITE = 1;
const STEP_INCREMENT = 2;
const STEP_DECREMENT = 3;
const STEP_RESTORE = 4;

/** The four blocks' access conditions (C1·4 + C2·2 + C3) of the sector whose trailer starts at `t`; −1 each when the bits are inconsistent (the sector blocked). */
export function accessConditions(memory: Uint8Array, t: number, out: Int8Array): void {
  const b6 = memory[t + 6];
  const b7 = memory[t + 7];
  const b8 = memory[t + 8];
  const c1 = b7 >> 4;
  const c2 = b8 & 0x0f;
  const c3 = b8 >> 4;
  const valid = (~b6 & 0x0f) === c1 && ((~b6 >> 4) & 0x0f) === c2 && (~b7 & 0x0f) === c3;
  for (let i = 0; i < 4; i++) out[i] = valid ? (((c1 >> i) & 1) << 2) | (((c2 >> i) & 1) << 1) | ((c3 >> i) & 1) : -1;
}

/** Access bits bytes 6–8 for conditions [block 0, 1, 2, trailer] (each C1·4 + C2·2 + C3). */
export function accessBytes(conditions: readonly number[]): [number, number, number] {
  let c1 = 0;
  let c2 = 0;
  let c3 = 0;
  for (let i = 0; i < 4; i++) {
    c1 |= ((conditions[i] >> 2) & 1) << i;
    c2 |= ((conditions[i] >> 1) & 1) << i;
    c3 |= (conditions[i] & 1) << i;
  }
  return [((~c2 & 0x0f) << 4) | (~c1 & 0x0f), (c1 << 4) | (~c3 & 0x0f), (c3 << 4) | c2];
}

export class MifareClassic1k extends Iso14443Card {
  /** 64 blocks of 16 bytes. */
  readonly memory = new Uint8Array(1024);
  private sector = -1;
  /** The key that opened it: 1 key A, 2 key B (0 none usable). */
  private key = 0;
  private step = STEP_NONE;
  private stepBlock = 0;
  private transfer = 0;
  private transferAddress = 0;
  private transferValid = false;
  private readonly access = new Int8Array(4);

  constructor(uid: Uint8Array) {
    super(uid, uid.length === 4 ? 0x0004 : 0x0044, 0x08);
    const m = this.memory;
    m.set(uid, 0);
    let at = uid.length;
    if (uid.length === 4) m[at++] = uid[0] ^ uid[1] ^ uid[2] ^ uid[3];
    m[at++] = 0x08;
    m[at++] = uid.length === 4 ? 0x04 : 0x44;
    m[at++] = 0x00;
    const maker = [0x42, 0x45, 0x4e, 0x43, 0x48, 0x54, 0x4f, 0x50]; // "BENCHTOP"
    for (let i = 0; at < 16; i++) m[at++] = maker[i];
    for (let s = 0; s < 16; s++) {
      const t = (s * 4 + 3) * 16;
      m.fill(0xff, t, t + 6);
      m.set([0xff, 0x07, 0x80, 0x69], t + 6);
      m.fill(0xff, t + 10, t + 16);
    }
  }

  authenticate(keyType: number, block: number, key: Uint8Array, keyAt: number, uid: Uint8Array, uidAt: number): PiccAuth {
    if (this.state !== ACTIVE && this.state !== AUTHENTICATED) return 'silent';
    if ((keyType !== 0x60 && keyType !== 0x61) || block > 63) {
      this.reject();
      return 'protocol';
    }
    const own = this.uid.length - 4;
    for (let i = 0; i < 4; i++) if (uid[uidAt + i] !== this.uid[own + i]) return this.silent();
    const sector = block >> 2;
    const t = (sector * 4 + 3) * 16 + (keyType === 0x60 ? 0 : 10);
    for (let i = 0; i < 6; i++) if (key[keyAt + i] !== this.memory[t + i]) return this.silent();
    this.state = AUTHENTICATED;
    this.sector = sector;
    accessConditions(this.memory, sector * 64 + 48, this.access);
    const trailer = this.access[3];
    // Key B can't serve where the trailer lets it be read.
    this.key = keyType === 0x60 ? 1 : trailer >= 0 && KEY_B_READ[trailer] !== 0 ? 0 : 2;
    this.step = STEP_NONE;
    return 'ok';
  }

  private silent(): PiccAuth {
    this.reject();
    return 'silent';
  }

  protected override endSession(): void {
    this.sector = -1;
    this.key = 0;
    this.step = STEP_NONE;
    this.transferValid = false;
  }

  /** ACTIVE but not authenticated: the memory is closed. */
  protected command(data: Uint8Array, length: number, _lastBits: number): PiccAnswer | null {
    if (length >= 3 && !crcOk(data, length)) return this.nak(PICC_NAK_CRC);
    return this.nak(PICC_NAK);
  }

  /** Whether `table` allows the session's key for `block` (in the open sector, its sector not blocked). */
  private allows(table: readonly number[], block: number): boolean {
    if (block >> 2 !== this.sector) return false;
    const condition = this.access[block & 3];
    return condition >= 0 && (table[condition] & this.key) !== 0;
  }

  protected override secure(data: Uint8Array, length: number, lastBits: number): PiccAnswer | null {
    if (lastBits !== 8 || length < 3) return this.reject();
    if (!crcOk(data, length)) return this.nak(PICC_NAK_CRC);
    const step = this.step;
    if (step !== STEP_NONE) {
      this.step = STEP_NONE;
      return this.secondStep(step, data, length);
    }
    if (length === 4 && data[0] === 0x50 && data[1] === 0x00) {
      this.state = HALT;
      this.halted = true;
      this.endSession();
      return null;
    }
    if (length !== 4) return this.nak(PICC_NAK);
    const block = data[1];
    const trailer = (block & 3) === 3;
    switch (data[0]) {
      case 0x30:
        return this.read(block);
      case 0xa0: {
        const writable = trailer
          ? this.allows(KEY_A_WRITE, block) || this.allows(ACCESS_WRITE, block) || this.allows(KEY_B_WRITE, block)
          : block !== 0 && this.allows(DATA_WRITE, block);
        if (!writable) return this.nak(PICC_NAK);
        this.step = STEP_WRITE;
        this.stepBlock = block;
        return this.nibble(PICC_ACK);
      }
      case 0xc1:
      case 0xc0:
      case 0xc2: {
        const table = data[0] === 0xc1 ? DATA_INCREMENT : DATA_DECREMENT;
        if (trailer || !this.allows(table, block) || !this.valueBlock(block)) return this.nak(PICC_NAK);
        this.step = data[0] === 0xc1 ? STEP_INCREMENT : data[0] === 0xc0 ? STEP_DECREMENT : STEP_RESTORE;
        this.stepBlock = block;
        return this.nibble(PICC_ACK);
      }
      case 0xb0: {
        if (trailer || block === 0 || !this.transferValid || !this.allows(DATA_DECREMENT, block)) return this.nak(PICC_NAK);
        const m = this.memory;
        const at = block * 16;
        const v = this.transfer;
        for (let i = 0; i < 4; i++) {
          const byte = (v >>> (8 * i)) & 0xff;
          m[at + i] = byte;
          m[at + 4 + i] = ~byte & 0xff;
          m[at + 8 + i] = byte;
        }
        const a = this.transferAddress;
        m[at + 12] = a;
        m[at + 13] = ~a & 0xff;
        m[at + 14] = a;
        m[at + 15] = ~a & 0xff;
        return this.nibble(PICC_ACK, CLASSIC_WRITE_NS);
      }
      default:
        return this.nak(PICC_NAK);
    }
  }

  private read(block: number): PiccAnswer {
    if (block > 63 || block >> 2 !== this.sector) return this.nak(PICC_NAK);
    const m = this.memory;
    const at = block * 16;
    if ((block & 3) !== 3) {
      if (!this.allows(DATA_READ, block)) return this.nak(PICC_NAK);
      for (let i = 0; i < 16; i++) this.out[i] = m[at + i];
      return this.withCrc(16);
    }
    if (this.access[3] < 0) return this.nak(PICC_NAK);
    this.out.fill(0, 0, 16); // key A never reads
    if (this.allows(ACCESS_READ, block)) for (let i = 6; i < 10; i++) this.out[i] = m[at + i];
    if (this.allows(KEY_B_READ, block)) for (let i = 10; i < 16; i++) this.out[i] = m[at + i];
    return this.withCrc(16);
  }

  private valueBlock(block: number): boolean {
    const m = this.memory;
    const at = block * 16;
    for (let i = 0; i < 4; i++) {
      if (m[at + i] !== m[at + 8 + i] || m[at + i] !== (~m[at + 4 + i] & 0xff)) return false;
    }
    return m[at + 12] === m[at + 14] && m[at + 13] === m[at + 15] && m[at + 12] === (~m[at + 13] & 0xff);
  }

  private secondStep(step: number, data: Uint8Array, length: number): PiccAnswer | null {
    const block = this.stepBlock;
    const m = this.memory;
    const at = block * 16;
    if (step === STEP_WRITE) {
      if (length !== 18) return this.nak(PICC_NAK);
      if ((block & 3) !== 3) {
        for (let i = 0; i < 16; i++) m[at + i] = data[i];
      } else {
        if (this.allows(KEY_A_WRITE, block)) for (let i = 0; i < 6; i++) m[at + i] = data[i];
        if (this.allows(ACCESS_WRITE, block)) for (let i = 6; i < 10; i++) m[at + i] = data[i];
        if (this.allows(KEY_B_WRITE, block)) for (let i = 10; i < 16; i++) m[at + i] = data[i];
        accessConditions(m, at, this.access);
      }
      return this.nibble(PICC_ACK, CLASSIC_WRITE_NS);
    }
    // INCREMENT, DECREMENT, RESTORE: 4 bytes of operand; no answer.
    if (length !== 6) return this.reject();
    const value = m[at] | (m[at + 1] << 8) | (m[at + 2] << 16) | (m[at + 3] << 24);
    const operand = data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24);
    this.transfer = step === STEP_INCREMENT ? (value + operand) | 0 : step === STEP_DECREMENT ? (value - operand) | 0 : value;
    this.transferAddress = m[at + 12];
    this.transferValid = true;
    return null;
  }
}

// NTAG213.

const NTAG_PAGES = 45;
const NTAG_VERSION = [0x00, 0x04, 0x04, 0x02, 0x01, 0x00, 0x0f, 0x03];

export class Ntag213 extends Iso14443Card {
  /** 45 pages of 4 bytes. */
  readonly memory = new Uint8Array(NTAG_PAGES * 4);
  private compatPage = -1;

  constructor(uid: Uint8Array) {
    super(uid, 0x0044, 0x00);
    const m = this.memory;
    m.set([uid[0], uid[1], uid[2], 0x88 ^ uid[0] ^ uid[1] ^ uid[2]], 0);
    m.set([uid[3], uid[4], uid[5], uid[6]], 4);
    m.set([uid[3] ^ uid[4] ^ uid[5] ^ uid[6], 0x48, 0x00, 0x00], 8);
    m.set([0xe1, 0x10, 0x12, 0x00], 12); // capability container: NDEF 1.0, 144 bytes, read/write
    m.set([0x03, 0x00, 0xfe, 0x00], 16); // an empty NDEF message
    m.set([0x00, 0x00, 0x00, 0xbd], 40 * 4); // dynamic lock bytes
    m.set([0x04, 0x00, 0x00, 0xff], 41 * 4); // CFG0: AUTH0 FFh
    m.set([0x00, 0x05, 0x00, 0x00], 42 * 4); // CFG1
    m.fill(0xff, 43 * 4, 44 * 4); // PWD
  }

  authenticate(): PiccAuth {
    if (this.state !== ACTIVE) return 'silent';
    this.reject(); // 60h is GET_VERSION's code, its CRC wrong here: a NAK
    return 'protocol';
  }

  /** Whether the lock bits protect `page` from writes. */
  private locked(page: number): boolean {
    const m = this.memory;
    if (page === 3) return (m[10] & 0x08) !== 0;
    if (page >= 4 && page <= 7) return (m[10] & (1 << page)) !== 0;
    if (page >= 8 && page <= 15) return (m[11] & (1 << (page - 8))) !== 0;
    if (page >= 16 && page <= 31) return (m[160] & (1 << ((page - 16) >> 1))) !== 0;
    if (page >= 32 && page <= 39) return (m[161] & (1 << ((page - 32) >> 1))) !== 0;
    return false;
  }

  private writePage(page: number, data: Uint8Array, from: number): boolean {
    if (page < 2 || page >= NTAG_PAGES || this.locked(page)) return false;
    const m = this.memory;
    const at = page * 4;
    if (page === 2) {
      m[10] |= data[from + 2];
      m[11] |= data[from + 3];
    } else if (page === 3 || page === 40) {
      for (let i = 0; i < 4; i++) m[at + i] |= data[from + i]; // one-time programmable / lock bits
    } else for (let i = 0; i < 4; i++) m[at + i] = data[from + i];
    return true;
  }

  private readPages(start: number, count: number): PiccAnswer {
    const m = this.memory;
    for (let p = 0; p < count; p++) {
      const page = (start + p) % NTAG_PAGES;
      for (let i = 0; i < 4; i++) this.out[p * 4 + i] = page >= 43 ? 0 : m[page * 4 + i];
    }
    return this.withCrc(count * 4);
  }

  protected command(data: Uint8Array, length: number, lastBits: number): PiccAnswer | null {
    if (lastBits !== 8 || length < 3) return this.reject();
    if (!crcOk(data, length)) return this.nak(0x01);
    if (this.compatPage >= 0) {
      const page = this.compatPage;
      this.compatPage = -1;
      if (length !== 18) return this.nak(0x00);
      return this.writePage(page, data, 0) ? this.nibble(PICC_ACK, NTAG_WRITE_NS) : this.nak(0x00);
    }
    switch (data[0]) {
      case 0x30:
        if (length !== 4 || data[1] >= NTAG_PAGES) return this.nak(0x00);
        return this.readPages(data[1], 4);
      case 0x3a:
        if (length !== 5 || data[1] > data[2] || data[2] >= NTAG_PAGES) return this.nak(0x00);
        return this.readPages(data[1], data[2] - data[1] + 1);
      case 0xa2:
        if (length !== 8) return this.nak(0x00);
        return this.writePage(data[1], data, 2) ? this.nibble(PICC_ACK, NTAG_WRITE_NS) : this.nak(0x00);
      case 0xa0:
        if (length !== 4 || data[1] < 2 || data[1] >= NTAG_PAGES || this.locked(data[1])) return this.nak(0x00);
        this.compatPage = data[1];
        return this.nibble(PICC_ACK);
      case 0x60:
        if (length !== 3) return this.nak(0x00);
        for (let i = 0; i < 8; i++) this.out[i] = NTAG_VERSION[i];
        return this.withCrc(8);
      default:
        return this.nak(0x00);
    }
  }

  protected override endSession(): void {
    this.compatPage = -1;
  }
}
