/**
 * BT196: what the MFRC522 talks to over the air — a proximity card (PICC, ISO/IEC 14443 type A).
 * The chip hands it frames as bytes (the last byte's valid bits counted) and takes back its answer,
 * or silence. MIFARE Classic authentication happens inside the MFRC522 (MFAuthent): the card checks
 * the key, and frames after it pass in plaintext at this interface — the chip's Crypto1 is not
 * modelled because neither side's host ever sees ciphertext (`encrypted` says whether the reader
 * would have encrypted the frame, so a card can tell a reader that stopped encrypting, or never
 * authenticated, from one that did). BT197 implements the cards.
 */

/** A card's answer: `length` bytes of `bytes`, the last of them `lastBits` valid (8 = all). */
export interface PiccAnswer {
  readonly bytes: Uint8Array;
  length: number;
  lastBits: number;
  /** Time the card takes beyond the standard frame delay (an EEPROM write), ns. */
  delayNs: number;
}

/** MFAuthent's outcome: authenticated; no answer (the reader times out); an answer that isn't one (ProtocolErr). */
export type PiccAuth = 'ok' | 'silent' | 'protocol';

export interface Picc {
  /** The reader's RF field turned on or off; off powers the card down (back to IDLE). */
  field(on: boolean): void;
  /**
   * A frame from the reader: `length` bytes of `data`, the last `lastBits` valid (8 = all), sent
   * encrypted or not. Returns the answer (which may reuse one buffer), or null for silence.
   */
  frame(data: Uint8Array, length: number, lastBits: number, encrypted: boolean): PiccAnswer | null;
  /**
   * MFAuthent: `keyType` 0x60 (key A) or 0x61 (key B) for `block`, with the six key bytes from
   * `key[keyAt]` and the four UID bytes from `uid[uidAt]`.
   */
  authenticate(keyType: number, block: number, key: Uint8Array, keyAt: number, uid: Uint8Array, uidAt: number): PiccAuth;
}

/** One byte into ISO/IEC 14443-3 CRC_A (x¹⁶ + x¹² + x⁵ + 1, LSB first, no final XOR). */
export function crcAUpdate(crc: number, byte: number): number {
  let b = (byte ^ crc) & 0xff;
  b = (b ^ (b << 4)) & 0xff;
  return ((crc >> 8) ^ (b << 8) ^ (b << 3) ^ (b >> 4)) & 0xffff;
}

/** CRC_A of `length` bytes from `start`, preset `preset` (ISO's 0x6363); sent LSB first. */
export function crcA(data: ArrayLike<number>, start: number, length: number, preset = 0x6363): number {
  let crc = preset & 0xffff;
  for (let i = start; i < start + length; i++) crc = crcAUpdate(crc, data[i]);
  return crc;
}
