import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DPORT, PERI } from '../dport.ts';
import { Esp32Soc } from '../soc.ts';
import { AesAccelerator } from './aes.ts';
import { RsaAccelerator } from './rsa.ts';
import { ShaAccelerator } from './sha.ts';

// BT102: the SHA and AES accelerators through their registers, the way IDF's hal drives them
// (big-endian TEXT words for SHA, little-endian key/text words for AES), against FIPS vectors
// and Node's crypto.

const SHA_TYPES = [
  { name: 'sha1', type: 0, block: 64, digest: 20 },
  { name: 'sha256', type: 1, block: 64, digest: 32 },
  { name: 'sha384', type: 2, block: 128, digest: 48 },
  { name: 'sha512', type: 3, block: 128, digest: 64 },
] as const;

/** Hashes `message` the way IDF does: pad in memory, then each block's big-endian words into TEXT, START then CONTINUE, LOAD. */
function hashOnAccelerator(sha: ShaAccelerator, kind: (typeof SHA_TYPES)[number], message: Uint8Array): string {
  const lengthBytes = kind.block === 64 ? 8 : 16;
  const total = Math.ceil((message.length + 1 + lengthBytes) / kind.block) * kind.block;
  const padded = new Uint8Array(total);
  padded.set(message);
  padded[message.length] = 0x80;
  const bits = BigInt(message.length) * 8n;
  for (let i = 0; i < 8; i++) padded[total - 1 - i] = Number((bits >> BigInt(8 * i)) & 0xffn);
  const reg = 0x80 + 0x10 * kind.type;
  for (let b = 0; b < total; b += kind.block) {
    for (let i = 0; i < kind.block / 4; i++) {
      const at = b + 4 * i;
      sha.write32(4 * i, ((padded[at] << 24) | (padded[at + 1] << 16) | (padded[at + 2] << 8) | padded[at + 3]) >>> 0);
    }
    sha.write32(b === 0 ? reg : reg + 4, 1);
    expect(sha.read32(reg + 0xc)).toBe(0); // BUSY
  }
  sha.write32(reg + 8, 1); // LOAD
  let out = '';
  for (let i = 0; i < kind.digest / 4; i++) out += sha.read32(4 * i).toString(16).padStart(8, '0');
  return out;
}

describe('the SHA accelerator (BT102)', () => {
  it('hashes FIPS 180-4\'s "abc", an empty message and multi-block messages like Node', () => {
    const sha = new ShaAccelerator(() => true);
    const messages = [new TextEncoder().encode('abc'), new Uint8Array(0), randomBytes(55), randomBytes(56), randomBytes(111), randomBytes(112), randomBytes(1000)];
    for (const kind of SHA_TYPES) {
      for (const message of messages) expect(hashOnAccelerator(sha, kind, message), `${kind.name} of ${message.length}`).toBe(createHash(kind.name).update(message).digest('hex'));
    }
    expect(hashOnAccelerator(sha, SHA_TYPES[1], new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('keeps a state per engine: SHA-256 and SHA-384 messages interleave block by block (TLS 1.2\'s transcript)', () => {
    const sha = new ShaAccelerator(() => true);
    const a = randomBytes(300);
    const b = randomBytes(300);
    const blocksOf = (message: Uint8Array, block: number): Uint32Array[] => {
      const lengthBytes = block === 64 ? 8 : 16;
      const total = Math.ceil((message.length + 1 + lengthBytes) / block) * block;
      const p = new Uint8Array(total);
      p.set(message);
      p[message.length] = 0x80;
      const bitCount = BigInt(message.length) * 8n;
      for (let i = 0; i < 8; i++) p[total - 1 - i] = Number((bitCount >> BigInt(8 * i)) & 0xffn);
      const out: Uint32Array[] = [];
      for (let o = 0; o < total; o += block) out.push(Uint32Array.from({ length: block / 4 }, (_, i) => ((p[o + 4 * i] << 24) | (p[o + 4 * i + 1] << 16) | (p[o + 4 * i + 2] << 8) | p[o + 4 * i + 3]) >>> 0));
      return out;
    };
    const x = blocksOf(a, 64);
    const y = blocksOf(b, 128);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      if (i < x.length) {
        x[i].forEach((w, k) => sha.write32(4 * k, w));
        sha.write32(i === 0 ? 0x90 : 0x94, 1);
      }
      if (i < y.length) {
        y[i].forEach((w, k) => sha.write32(4 * k, w));
        sha.write32(i === 0 ? 0xa0 : 0xa4, 1);
      }
    }
    const digest = (load: number, words: number): string => {
      sha.write32(load, 1);
      let out = '';
      for (let i = 0; i < words; i++) out += sha.read32(4 * i).toString(16).padStart(8, '0');
      return out;
    };
    expect(digest(0x98, 8)).toBe(createHash('sha256').update(a).digest('hex'));
    expect(digest(0xa8, 12)).toBe(createHash('sha384').update(b).digest('hex'));
  });

  it('reads 0 and ignores writes while unclocked or in reset', () => {
    let on = false;
    const sha = new ShaAccelerator(() => on);
    sha.write32(0, 0x12345678);
    expect(sha.read32(0)).toBe(0);
    on = true;
    expect(sha.read32(0)).toBe(0);
    sha.write32(0, 0x12345678);
    expect(sha.read32(0)).toBe(0x12345678);
  });
});

/** Runs one block through the AES registers as IDF's aes_ll does. */
function aesOnAccelerator(aes: AesAccelerator, key: Uint8Array, block: Uint8Array, decrypt: boolean): Buffer {
  const word = (b: Uint8Array, i: number): number => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
  for (let i = 0; i < key.length / 4; i++) aes.write32(0x10 + 4 * i, word(key, 4 * i));
  aes.write32(0x08, (decrypt ? 4 : 0) + key.length / 8 - 2);
  for (let i = 0; i < 4; i++) aes.write32(0x30 + 4 * i, word(block, 4 * i));
  aes.write32(0x00, 1);
  expect(aes.read32(0x04)).toBe(1); // IDLE
  const out = Buffer.alloc(16);
  for (let i = 0; i < 4; i++) out.writeUInt32LE(aes.read32(0x30 + 4 * i), 4 * i);
  return out;
}

describe('the AES accelerator (BT102)', () => {
  it('encrypts FIPS 197\'s appendix C block with 128-, 192- and 256-bit keys and decrypts it back', () => {
    const aes = new AesAccelerator(() => true);
    const plain = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
    const expected = ['69c4e0d86a7b0430d8cdb78070b4c55a', 'dda97ca4864cdfe06eaf70a0ec0d7191', '8ea2b7ca516745bfeafc49904b496089'];
    [16, 24, 32].forEach((n, i) => {
      const key = Uint8Array.from({ length: n }, (_, k) => k);
      const cipher = aesOnAccelerator(aes, key, plain, false);
      expect(cipher.toString('hex')).toBe(expected[i]);
      expect(aesOnAccelerator(aes, key, cipher, true).equals(plain)).toBe(true);
    });
  });

  it('agrees with Node on random keys and blocks', () => {
    const aes = new AesAccelerator(() => true);
    for (const n of [16, 24, 32]) {
      for (let i = 0; i < 50; i++) {
        const key = randomBytes(n);
        const block = randomBytes(16);
        const c = createCipheriv(`aes-${n * 8}-ecb`, key, null).setAutoPadding(false);
        expect(aesOnAccelerator(aes, key, block, false).equals(Buffer.concat([c.update(block), c.final()]))).toBe(true);
      }
    }
  });
});

describe('DPORT gates the accelerators (BT102)', () => {
  it('clock on and out of reset: the blocks answer; back into reset they clear', () => {
    const soc = new Esp32Soc();
    soc.sha.write32(0, 0xabcd);
    expect(soc.sha.read32(0)).toBe(0); // unclocked at reset: the ROM's ets_sha_enable turns it on
    soc.dport.write32(DPORT.PERI_CLK_EN, (1 << PERI.SHA) | (1 << PERI.AES));
    soc.dport.write32(DPORT.PERI_RST_EN, 0);
    soc.sha.write32(0, 0xabcd);
    soc.aes.write32(0x30, 0x1234);
    expect([soc.sha.read32(0), soc.aes.read32(0x30), soc.aes.read32(0x04)]).toEqual([0xabcd, 0x1234, 1]);
    soc.dport.write32(DPORT.PERI_RST_EN, 1 << PERI.SHA);
    expect(soc.sha.read32(0)).toBe(0);
    soc.dport.write32(DPORT.PERI_RST_EN, 0);
    expect([soc.sha.read32(0), soc.aes.read32(0x30)]).toEqual([0, 0x1234]); // SHA cleared, AES kept
  });
});

/** A random BigInt of exactly `bits` bits (top bit set). */
function randomBig(bits: number, odd = false): bigint {
  let v = BigInt(`0x${randomBytes(bits / 8).toString('hex')}`) | (1n << BigInt(bits - 1));
  if (odd) v |= 1n;
  return v;
}

function writeBig(rsa: RsaAccelerator, base: number, words: number, value: bigint): void {
  let v = value;
  for (let i = 0; i < words; i++) {
    rsa.write32(base + 4 * i, Number(v & 0xffffffffn));
    v >>= 32n;
  }
}

function readBig(rsa: RsaAccelerator, base: number, words: number): bigint {
  let v = 0n;
  for (let i = words - 1; i >= 0; i--) v = (v << 32n) | BigInt(rsa.read32(base + 4 * i));
  return v;
}

const modPow = (b: bigint, e: bigint, m: bigint): bigint => {
  let r = 1n;
  let x = b % m;
  for (let k = e; k > 0n; k >>= 1n) {
    if (k & 1n) r = (r * x) % m;
    x = (x * x) % m;
  }
  return r;
};

describe('the RSA accelerator (BT103)', () => {
  it('Montgomery multiplication Z = X·Z·R⁻¹ mod M at 512–4096 bits, as the ROM drives it', () => {
    const rsa = new RsaAccelerator(() => true);
    expect(rsa.read32(0x818)).toBe(1); // CLEAN
    for (const bits of [512, 1024, 2048, 3072, 4096]) {
      const words = bits / 32;
      for (let n = 0; n < 20; n++) {
        const m = randomBig(bits, true);
        const x = randomBig(bits - 1) % m;
        const y = randomBig(bits - 1) % m;
        writeBig(rsa, 0x000, words, m);
        writeBig(rsa, 0x600, words, x);
        writeBig(rsa, 0x200, words, y);
        rsa.write32(0x80c, words / 16 - 1);
        rsa.write32(0x814, 1);
        expect(rsa.read32(0x814)).toBe(0);
        rsa.write32(0x810, 1);
        expect(rsa.read32(0x814)).toBe(1);
        const r = 1n << BigInt(bits);
        expect(((readBig(rsa, 0x200, words) * r) % m)).toBe((x * y) % m); // Z·R ≡ X·Y
      }
    }
  });

  it('plain multiplication: A in X\'s low half, B in Z\'s high half, the product in Z', () => {
    const rsa = new RsaAccelerator(() => true);
    for (const bits of [512, 1024, 2048]) {
      const words = bits / 32;
      for (let n = 0; n < 20; n++) {
        const a = randomBig(bits);
        const b = randomBig(bits);
        writeBig(rsa, 0x600, 2 * words, a);
        writeBig(rsa, 0x200, words, 0n);
        writeBig(rsa, 0x200 + 4 * words, words, b);
        rsa.write32(0x800, 0);
        rsa.write32(0x80c, ((2 * words) / 16 - 1) | 8);
        rsa.write32(0x810, 1);
        expect(readBig(rsa, 0x200, 2 * words)).toBe(a * b);
      }
    }
  });

  it('modular exponentiation Z = X^Y mod M', () => {
    const rsa = new RsaAccelerator(() => true);
    for (const bits of [512, 2048]) {
      const words = bits / 32;
      for (let n = 0; n < 5; n++) {
        const m = randomBig(bits, true);
        const x = randomBig(bits - 1) % m;
        const y = randomBig(bits);
        writeBig(rsa, 0x000, words, m);
        writeBig(rsa, 0x600, words, x);
        writeBig(rsa, 0x400, words, y);
        rsa.write32(0x804, words / 16 - 1);
        rsa.write32(0x808, 1);
        expect(readBig(rsa, 0x200, words)).toBe(modPow(x, y, m));
      }
    }
    expect(rsa.operations).toBe(10);
  });

  it('powered down or unclocked it reads 0 (CLEAN too)', () => {
    const soc = new Esp32Soc();
    expect(soc.rsa.read32(0x818)).toBe(0);
    soc.dport.write32(DPORT.PERI_CLK_EN, 1 << PERI.RSA);
    soc.dport.write32(DPORT.PERI_RST_EN, 0);
    soc.dport.write32(DPORT.RSA_PD_CTRL, 1);
    expect(soc.rsa.read32(0x818)).toBe(0);
    soc.dport.write32(DPORT.RSA_PD_CTRL, 0); // what ets_bigint_enable does, then waits for CLEAN
    expect(soc.rsa.read32(0x818)).toBe(1);
  });
});
