/**
 * The ESP32's SHA accelerator (BT102; 0x3FF03000, `soc/hwcrypto_reg.h`): SHA-1, SHA-256,
 * SHA-384 and SHA-512 over 512- or 1024-bit blocks in TEXT (0x00–0x7C, 32 words). Per type t (0
 * SHA-1, 1 SHA-256, 2 SHA-384, 3 SHA-512) four registers at 0x80 + 0x10·t: START (begin a message
 * with this block), CONTINUE (one more block), LOAD (put the digest into TEXT) and BUSY. TEXT is
 * shared, but each engine — SHA-1, SHA-256, and SHA-384/512 together — keeps its own state, so
 * messages of different engines interleave (IDF locks the engines separately; TLS 1.2 hashes its
 * transcript with SHA-256 and SHA-384 at once — BT104 found a single state breaking that). TEXT words are the block's
 * big-endian words (IDF's `sha_ll_fill_text_block` byte-swaps; the ROM's `ets_sha_finish` pads
 * in the registers); after LOAD, TEXT holds the digest words, SHA-384/512's 64-bit words as
 * high, low. An operation completes at once: BUSY reads 0. Unclocked or in reset (DPORT
 * PERI_CLK_EN / PERI_RST_EN bit 1) the block reads 0 and ignores writes; leaving reset clears it.
 */

import type { Peripheral } from '../periph.ts';
import { SHA1_INIT, SHA256_INIT, SHA384_INIT, SHA512_INIT, sha1Block, sha256Block, sha512Block } from './sha-math.ts';

export const SHA_BASE = 0x3ff03000;
const TYPE_BASE = 0x80;
const TEXT_WORDS = 32;
/** Digest words per type, as LOAD writes them into TEXT. */
const DIGEST_WORDS = [5, 8, 12, 16];

export class ShaAccelerator implements Peripheral {
  readonly text = new Uint32Array(TEXT_WORDS);
  /** Per engine (SHA-1, SHA-256, SHA-384/512): its state and the type it was started as (−1: none). */
  private readonly states = [new Uint32Array(16), new Uint32Array(16), new Uint32Array(16)];
  private readonly types = [-1, -1, -1];
  private readonly enabled: () => boolean;
  /** Blocks hashed since reset (tests, docs). */
  blocks = 0;

  /** `enabled`: the block is clocked and out of reset (DPORT). */
  constructor(enabled: () => boolean) {
    this.enabled = enabled;
  }

  implements(offset: number): boolean {
    return offset < TYPE_BASE + 0x40;
  }

  read32(offset: number): number {
    if (!this.enabled()) return 0;
    if (offset < TYPE_BASE) return this.text[offset >>> 2];
    return 0; // START/CONTINUE/LOAD read 0; BUSY: never busy
  }

  write32(offset: number, value: number): void {
    if (!this.enabled()) return;
    if (offset < TYPE_BASE) {
      this.text[offset >>> 2] = value >>> 0;
      return;
    }
    if (offset >= TYPE_BASE + 0x40 || (value & 1) === 0) return;
    const type = (offset - TYPE_BASE) >>> 4;
    const engine = type < 2 ? type : 2;
    const state = this.states[engine];
    const op = (offset & 0xf) >>> 2; // 0 START, 1 CONTINUE, 2 LOAD, 3 BUSY
    if (op === 0) {
      this.types[engine] = type;
      state.set(type === 0 ? SHA1_INIT : type === 1 ? SHA256_INIT : type === 2 ? SHA384_INIT : SHA512_INIT);
      this.block(engine);
    } else if (op === 1) {
      if (this.types[engine] < 0) return; // nothing started on this engine
      this.block(engine);
    } else if (op === 2) {
      if (this.types[engine] < 0) return;
      const words = DIGEST_WORDS[type];
      for (let i = 0; i < words; i++) this.text[i] = state[i];
    }
  }

  private block(engine: number): void {
    this.blocks++;
    if (engine === 0) sha1Block(this.states[0], this.text);
    else if (engine === 1) sha256Block(this.states[1], this.text);
    else sha512Block(this.states[2], this.text);
  }

  /** Back to the reset state (a chip reset, or the block put in reset). */
  clear(): void {
    this.text.fill(0);
    for (const state of this.states) state.fill(0);
    this.types.fill(-1);
  }

  systemReset(): void {
    this.clear();
    this.blocks = 0;
  }
}
