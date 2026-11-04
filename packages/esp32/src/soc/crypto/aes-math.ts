/**
 * AES-128/192/256 (FIPS 197) on one 16-byte block, for the ESP32's AES accelerator (BT102): the
 * key expanded into `roundKeys` once per key, then `aesEncrypt` / `aesDecrypt` in place on a
 * 16-byte state. Byte-oriented (the S-box and xtime), nothing allocated per block.
 */

const SBOX = new Uint8Array(256);
const INV_SBOX = new Uint8Array(256);

// The S-box from the multiplicative inverse in GF(2^8) and the affine map (FIPS 197 §5.1.1).
{
  let p = 1;
  let q = 1;
  do {
    p = p ^ ((p << 1) & 0xff) ^ (p & 0x80 ? 0x1b : 0); // p · 3
    q ^= q << 1;
    q ^= q << 2;
    q ^= q << 4;
    q &= 0xff;
    if (q & 0x80) q ^= 0x09; // q / 3
    const x = q ^ ((q << 1) | (q >>> 7)) ^ ((q << 2) | (q >>> 6)) ^ ((q << 3) | (q >>> 5)) ^ ((q << 4) | (q >>> 4));
    SBOX[p] = (x ^ 0x63) & 0xff;
  } while (p !== 1);
  SBOX[0] = 0x63;
  for (let i = 0; i < 256; i++) INV_SBOX[SBOX[i]] = i;
}

const xtime = (b: number): number => ((b << 1) ^ (b & 0x80 ? 0x1b : 0)) & 0xff;
const mul = (a: number, b: number): number => {
  let r = 0;
  for (let i = 0; i < 8; i++) {
    if (b & 1) r ^= a;
    a = xtime(a);
    b >>= 1;
  }
  return r;
};

/** Rounds for a key of `keyBytes` (16, 24, 32). */
export const aesRounds = (keyBytes: number): number => keyBytes / 4 + 6;

/** Expands `key` (16, 24 or 32 bytes) into `out` (at least 16 · (rounds + 1) bytes). */
export function aesExpandKey(key: Uint8Array, out: Uint8Array): void {
  const nk = key.length / 4;
  const total = 4 * (aesRounds(key.length) + 1);
  out.set(key);
  let rcon = 1;
  for (let i = nk; i < total; i++) {
    let t0 = out[4 * i - 4];
    let t1 = out[4 * i - 3];
    let t2 = out[4 * i - 2];
    let t3 = out[4 * i - 1];
    if (i % nk === 0) {
      const r = t0;
      t0 = SBOX[t1] ^ rcon;
      t1 = SBOX[t2];
      t2 = SBOX[t3];
      t3 = SBOX[r];
      rcon = xtime(rcon);
    } else if (nk > 6 && i % nk === 4) {
      t0 = SBOX[t0];
      t1 = SBOX[t1];
      t2 = SBOX[t2];
      t3 = SBOX[t3];
    }
    out[4 * i] = out[4 * (i - nk)] ^ t0;
    out[4 * i + 1] = out[4 * (i - nk) + 1] ^ t1;
    out[4 * i + 2] = out[4 * (i - nk) + 2] ^ t2;
    out[4 * i + 3] = out[4 * (i - nk) + 3] ^ t3;
  }
}

const T = new Uint8Array(16);

function addRoundKey(s: Uint8Array, rk: Uint8Array, round: number): void {
  for (let i = 0; i < 16; i++) s[i] ^= rk[16 * round + i];
}

/** Encrypts the 16-byte block `s` in place with expanded key `rk` of `rounds` rounds. */
export function aesEncrypt(s: Uint8Array, rk: Uint8Array, rounds: number): void {
  addRoundKey(s, rk, 0);
  for (let round = 1; round <= rounds; round++) {
    // SubBytes + ShiftRows into T (column-major state: byte r + 4c)
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) T[r + 4 * c] = SBOX[s[r + 4 * ((c + r) & 3)]];
    if (round < rounds) {
      for (let c = 0; c < 4; c++) {
        const a0 = T[4 * c], a1 = T[4 * c + 1], a2 = T[4 * c + 2], a3 = T[4 * c + 3];
        s[4 * c] = xtime(a0) ^ xtime(a1) ^ a1 ^ a2 ^ a3;
        s[4 * c + 1] = a0 ^ xtime(a1) ^ xtime(a2) ^ a2 ^ a3;
        s[4 * c + 2] = a0 ^ a1 ^ xtime(a2) ^ xtime(a3) ^ a3;
        s[4 * c + 3] = xtime(a0) ^ a0 ^ a1 ^ a2 ^ xtime(a3);
      }
    } else s.set(T);
    addRoundKey(s, rk, round);
  }
}

/** Decrypts the 16-byte block `s` in place with expanded key `rk` of `rounds` rounds. */
export function aesDecrypt(s: Uint8Array, rk: Uint8Array, rounds: number): void {
  addRoundKey(s, rk, rounds);
  for (let round = rounds - 1; round >= 0; round--) {
    // InvShiftRows + InvSubBytes into T
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) T[r + 4 * ((c + r) & 3)] = INV_SBOX[s[r + 4 * c]];
    for (let i = 0; i < 16; i++) T[i] ^= rk[16 * round + i];
    if (round > 0) {
      for (let c = 0; c < 4; c++) {
        const a0 = T[4 * c], a1 = T[4 * c + 1], a2 = T[4 * c + 2], a3 = T[4 * c + 3];
        s[4 * c] = mul(a0, 14) ^ mul(a1, 11) ^ mul(a2, 13) ^ mul(a3, 9);
        s[4 * c + 1] = mul(a0, 9) ^ mul(a1, 14) ^ mul(a2, 11) ^ mul(a3, 13);
        s[4 * c + 2] = mul(a0, 13) ^ mul(a1, 9) ^ mul(a2, 14) ^ mul(a3, 11);
        s[4 * c + 3] = mul(a0, 11) ^ mul(a1, 13) ^ mul(a2, 9) ^ mul(a3, 14);
      }
    } else s.set(T);
  }
}
