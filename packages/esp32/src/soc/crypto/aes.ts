/**
 * The ESP32's AES accelerator (BT102; 0x3FF01000, `soc/hwcrypto_reg.h`): START (0x00), IDLE
 * (0x04, reads 1 — an operation completes at once), MODE (0x08: 0–2 encrypt with a 128/192/256-bit
 * key, 4–6 decrypt), KEY_0–7 (0x10–0x2C), TEXT_0–3 (0x30–0x3C, the block in and then out), ENDIAN
 * (0x40). Key and text words carry their bytes little-endian — IDF's `aes_ll` memcpys them, the
 * ROM's `ets_aes_crypt` packs byte 0 lowest — which is the byte order at ENDIAN's reset value
 * (IDF never writes it; other values are kept but not modeled). Unclocked or in reset (DPORT
 * PERI_CLK_EN / PERI_RST_EN bit 0) the block reads 0 and ignores writes.
 */

import type { Peripheral } from '../periph.ts';
import { aesDecrypt, aesEncrypt, aesExpandKey, aesRounds } from './aes-math.ts';

export const AES_BASE = 0x3ff01000;
const START = 0x00;
const IDLE = 0x04;
const MODE = 0x08;
const KEY = 0x10;
const TEXT = 0x30;
const ENDIAN = 0x40;

export class AesAccelerator implements Peripheral {
  private mode = 0;
  private endian = 0;
  private readonly key = new Uint32Array(8);
  private readonly text = new Uint32Array(4);
  private readonly keyBytes = new Uint8Array(32);
  private readonly roundKeys = new Uint8Array(240);
  private readonly block = new Uint8Array(16);
  /** The expanded key is current for this key and size (−1: none). */
  private expandedFor = -1;
  private readonly enabled: () => boolean;
  /** Blocks processed since reset. */
  blocks = 0;

  constructor(enabled: () => boolean) {
    this.enabled = enabled;
  }

  implements(offset: number): boolean {
    return offset <= ENDIAN;
  }

  read32(offset: number): number {
    if (!this.enabled()) return 0;
    if (offset === IDLE) return 1;
    if (offset === MODE) return this.mode;
    if (offset === ENDIAN) return this.endian;
    if (offset >= KEY && offset < KEY + 32) return this.key[(offset - KEY) >>> 2];
    if (offset >= TEXT && offset < TEXT + 16) return this.text[(offset - TEXT) >>> 2];
    return 0;
  }

  write32(offset: number, value: number): void {
    if (!this.enabled()) return;
    if (offset === MODE) this.mode = value & 7;
    else if (offset === ENDIAN) this.endian = value & 0x3f;
    else if (offset >= KEY && offset < KEY + 32) {
      this.key[(offset - KEY) >>> 2] = value >>> 0;
      this.expandedFor = -1;
    } else if (offset >= TEXT && offset < TEXT + 16) this.text[(offset - TEXT) >>> 2] = value >>> 0;
    else if (offset === START && (value & 1) !== 0) this.run();
  }

  private run(): void {
    const size = this.mode & 3;
    if (size === 3) return; // a reserved mode: nothing happens
    const keyBytes = 16 + 8 * size;
    if (this.expandedFor !== size) {
      for (let i = 0; i < keyBytes; i++) this.keyBytes[i] = (this.key[i >>> 2] >>> (8 * (i & 3))) & 0xff;
      aesExpandKey(this.keyBytes.subarray(0, keyBytes), this.roundKeys);
      this.expandedFor = size;
    }
    const b = this.block;
    for (let i = 0; i < 16; i++) b[i] = (this.text[i >>> 2] >>> (8 * (i & 3))) & 0xff;
    if ((this.mode & 4) === 0) aesEncrypt(b, this.roundKeys, aesRounds(keyBytes));
    else aesDecrypt(b, this.roundKeys, aesRounds(keyBytes));
    for (let w = 0; w < 4; w++) this.text[w] = (b[4 * w] | (b[4 * w + 1] << 8) | (b[4 * w + 2] << 16) | (b[4 * w + 3] << 24)) >>> 0;
    this.blocks++;
  }

  clear(): void {
    this.mode = 0;
    this.endian = 0;
    this.key.fill(0);
    this.text.fill(0);
    this.expandedFor = -1;
  }

  systemReset(): void {
    this.clear();
    this.blocks = 0;
  }
}
