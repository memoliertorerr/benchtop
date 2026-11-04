/**
 * SHA-1, SHA-256 and SHA-512 compression functions (FIPS 180-4), for the ESP32's SHA
 * accelerator (BT102). Each works on a state and one block of 32-bit big-endian message words
 * as the accelerator's TEXT registers hold them; nothing is allocated per block. SHA-384 is
 * SHA-512 with other initial values and a shorter digest; SHA-512's 64-bit words are high/low
 * pairs of 32-bit numbers (`hi[i]`, `lo[i]`), so no BigInt runs per round.
 */

export const SHA1_INIT = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
export const SHA256_INIT = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
/** SHA-512's initial values as [hi, lo] pairs; SHA-384's below. */
export const SHA512_INIT = [
  0x6a09e667, 0xf3bcc908, 0xbb67ae85, 0x84caa73b, 0x3c6ef372, 0xfe94f82b, 0xa54ff53a, 0x5f1d36f1,
  0x510e527f, 0xade682d1, 0x9b05688c, 0x2b3e6c1f, 0x1f83d9ab, 0xfb41bd6b, 0x5be0cd19, 0x137e2179,
];
export const SHA384_INIT = [
  0xcbbb9d5d, 0xc1059ed8, 0x629a292a, 0x367cd507, 0x9159015a, 0x3070dd17, 0x152fecd8, 0xf70e5939,
  0x67332667, 0xffc00b31, 0x8eb44a87, 0x68581511, 0xdb0c2e0d, 0x64f98fa7, 0x47b5481d, 0xbefa4fa4,
];

const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** SHA-512's round constants, [hi, lo] pairs. */
const K512 = new Uint32Array([
  0x428a2f98, 0xd728ae22, 0x71374491, 0x23ef65cd, 0xb5c0fbcf, 0xec4d3b2f, 0xe9b5dba5, 0x8189dbbc, 0x3956c25b, 0xf348b538, 0x59f111f1, 0xb605d019, 0x923f82a4, 0xaf194f9b, 0xab1c5ed5, 0xda6d8118,
  0xd807aa98, 0xa3030242, 0x12835b01, 0x45706fbe, 0x243185be, 0x4ee4b28c, 0x550c7dc3, 0xd5ffb4e2, 0x72be5d74, 0xf27b896f, 0x80deb1fe, 0x3b1696b1, 0x9bdc06a7, 0x25c71235, 0xc19bf174, 0xcf692694,
  0xe49b69c1, 0x9ef14ad2, 0xefbe4786, 0x384f25e3, 0x0fc19dc6, 0x8b8cd5b5, 0x240ca1cc, 0x77ac9c65, 0x2de92c6f, 0x592b0275, 0x4a7484aa, 0x6ea6e483, 0x5cb0a9dc, 0xbd41fbd4, 0x76f988da, 0x831153b5,
  0x983e5152, 0xee66dfab, 0xa831c66d, 0x2db43210, 0xb00327c8, 0x98fb213f, 0xbf597fc7, 0xbeef0ee4, 0xc6e00bf3, 0x3da88fc2, 0xd5a79147, 0x930aa725, 0x06ca6351, 0xe003826f, 0x14292967, 0x0a0e6e70,
  0x27b70a85, 0x46d22ffc, 0x2e1b2138, 0x5c26c926, 0x4d2c6dfc, 0x5ac42aed, 0x53380d13, 0x9d95b3df, 0x650a7354, 0x8baf63de, 0x766a0abb, 0x3c77b2a8, 0x81c2c92e, 0x47edaee6, 0x92722c85, 0x1482353b,
  0xa2bfe8a1, 0x4cf10364, 0xa81a664b, 0xbc423001, 0xc24b8b70, 0xd0f89791, 0xc76c51a3, 0x0654be30, 0xd192e819, 0xd6ef5218, 0xd6990624, 0x5565a910, 0xf40e3585, 0x5771202a, 0x106aa070, 0x32bbd1b8,
  0x19a4c116, 0xb8d2d0c8, 0x1e376c08, 0x5141ab53, 0x2748774c, 0xdf8eeb99, 0x34b0bcb5, 0xe19b48a8, 0x391c0cb3, 0xc5c95a63, 0x4ed8aa4a, 0xe3418acb, 0x5b9cca4f, 0x7763e373, 0x682e6ff3, 0xd6b2b8a3,
  0x748f82ee, 0x5defb2fc, 0x78a5636f, 0x43172f60, 0x84c87814, 0xa1f0ab72, 0x8cc70208, 0x1a6439ec, 0x90befffa, 0x23631e28, 0xa4506ceb, 0xde82bde9, 0xbef9a3f7, 0xb2c67915, 0xc67178f2, 0xe372532b,
  0xca273ece, 0xea26619c, 0xd186b8c7, 0x21c0c207, 0xeada7dd6, 0xcde0eb1e, 0xf57d4f7f, 0xee6ed178, 0x06f067aa, 0x72176fba, 0x0a637dc5, 0xa2c898a6, 0x113f9804, 0xbef90dae, 0x1b710b35, 0x131c471b,
  0x28db77f5, 0x23047d84, 0x32caab7b, 0x40c72493, 0x3c9ebe0a, 0x15c9bebc, 0x431d67c4, 0x9c100d4c, 0x4cc5d4be, 0xcb3e42b6, 0x597f299c, 0xfc657e2a, 0x5fcb6fab, 0x3ad6faec, 0x6c44198c, 0x4a475817,
]);

const W32 = new Uint32Array(80);

/** One SHA-1 block: `state` (5 words) updated from `block` (16 big-endian words). */
export function sha1Block(state: Uint32Array, block: Uint32Array): void {
  const w = W32;
  for (let t = 0; t < 16; t++) w[t] = block[t];
  for (let t = 16; t < 80; t++) {
    const x = w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16];
    w[t] = (x << 1) | (x >>> 31);
  }
  let a = state[0];
  let b = state[1];
  let c = state[2];
  let d = state[3];
  let e = state[4];
  for (let t = 0; t < 80; t++) {
    let f: number;
    let k: number;
    if (t < 20) {
      f = (b & c) | (~b & d);
      k = 0x5a827999;
    } else if (t < 40) {
      f = b ^ c ^ d;
      k = 0x6ed9eba1;
    } else if (t < 60) {
      f = (b & c) | (b & d) | (c & d);
      k = 0x8f1bbcdc;
    } else {
      f = b ^ c ^ d;
      k = 0xca62c1d6;
    }
    const temp = (((a << 5) | (a >>> 27)) + f + e + k + w[t]) | 0;
    e = d;
    d = c;
    c = (b << 30) | (b >>> 2);
    b = a;
    a = temp;
  }
  state[0] = (state[0] + a) >>> 0;
  state[1] = (state[1] + b) >>> 0;
  state[2] = (state[2] + c) >>> 0;
  state[3] = (state[3] + d) >>> 0;
  state[4] = (state[4] + e) >>> 0;
}

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

/** One SHA-256 block: `state` (8 words) updated from `block` (16 big-endian words). */
export function sha256Block(state: Uint32Array, block: Uint32Array): void {
  const w = W32;
  for (let t = 0; t < 16; t++) w[t] = block[t];
  for (let t = 16; t < 64; t++) {
    const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
    const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
    w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
  }
  let a = state[0];
  let b = state[1];
  let c = state[2];
  let d = state[3];
  let e = state[4];
  let f = state[5];
  let g = state[6];
  let h = state[7];
  for (let t = 0; t < 64; t++) {
    const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
    const ch = (e & f) ^ (~e & g);
    const t1 = (h + s1 + ch + K256[t] + w[t]) | 0;
    const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const t2 = (s0 + maj) | 0;
    h = g;
    g = f;
    f = e;
    e = (d + t1) | 0;
    d = c;
    c = b;
    b = a;
    a = (t1 + t2) | 0;
  }
  state[0] = (state[0] + a) >>> 0;
  state[1] = (state[1] + b) >>> 0;
  state[2] = (state[2] + c) >>> 0;
  state[3] = (state[3] + d) >>> 0;
  state[4] = (state[4] + e) >>> 0;
  state[5] = (state[5] + f) >>> 0;
  state[6] = (state[6] + g) >>> 0;
  state[7] = (state[7] + h) >>> 0;
}

const WH = new Uint32Array(80);
const WL = new Uint32Array(80);
/** Scratch for 64-bit helpers: [hi, lo]. */
const R = new Uint32Array(2);

/** (hi, lo) rotated right by n (0 < n < 64) into R. */
function rotr64(hi: number, lo: number, n: number): void {
  if (n < 32) {
    R[0] = (hi >>> n) | (lo << (32 - n));
    R[1] = (lo >>> n) | (hi << (32 - n));
  } else {
    const m = n - 32;
    R[0] = m === 0 ? lo : (lo >>> m) | (hi << (32 - m));
    R[1] = m === 0 ? hi : (hi >>> m) | (lo << (32 - m));
  }
}

/**
 * One SHA-512 (and SHA-384) block: `state` (16 words: 8 [hi, lo] pairs) updated from `block`
 * (32 big-endian words: 16 [hi, lo] pairs).
 */
export function sha512Block(state: Uint32Array, block: Uint32Array): void {
  const wh = WH;
  const wl = WL;
  for (let t = 0; t < 16; t++) {
    wh[t] = block[2 * t];
    wl[t] = block[2 * t + 1];
  }
  for (let t = 16; t < 80; t++) {
    // σ0 = rotr1 ^ rotr8 ^ shr7 of w[t-15]; σ1 = rotr19 ^ rotr61 ^ shr6 of w[t-2]
    const h15 = wh[t - 15];
    const l15 = wl[t - 15];
    rotr64(h15, l15, 1);
    let s0h = R[0];
    let s0l = R[1];
    rotr64(h15, l15, 8);
    s0h ^= R[0];
    s0l ^= R[1];
    s0h ^= h15 >>> 7;
    s0l ^= (l15 >>> 7) | (h15 << 25);
    const h2 = wh[t - 2];
    const l2 = wl[t - 2];
    rotr64(h2, l2, 19);
    let s1h = R[0];
    let s1l = R[1];
    rotr64(h2, l2, 61);
    s1h ^= R[0];
    s1l ^= R[1];
    s1h ^= h2 >>> 6;
    s1l ^= (l2 >>> 6) | (h2 << 26);
    // w[t] = w[t-16] + σ0 + w[t-7] + σ1, with carries
    const lo = (wl[t - 16] >>> 0) + (s0l >>> 0) + (wl[t - 7] >>> 0) + (s1l >>> 0);
    const hi = wh[t - 16] + s0h + wh[t - 7] + s1h + Math.floor(lo / 0x100000000);
    wl[t] = lo >>> 0;
    wh[t] = hi >>> 0;
  }
  let ah = state[0], al = state[1], bh = state[2], bl = state[3], ch = state[4], cl = state[5], dh = state[6], dl = state[7];
  let eh = state[8], el = state[9], fh = state[10], fl = state[11], gh = state[12], gl = state[13], hh = state[14], hl = state[15];
  for (let t = 0; t < 80; t++) {
    // Σ1(e) = rotr14 ^ rotr18 ^ rotr41
    rotr64(eh, el, 14);
    let S1h = R[0], S1l = R[1];
    rotr64(eh, el, 18);
    S1h ^= R[0];
    S1l ^= R[1];
    rotr64(eh, el, 41);
    S1h ^= R[0];
    S1l ^= R[1];
    const chh = (eh & fh) ^ (~eh & gh);
    const chl = (el & fl) ^ (~el & gl);
    // t1 = h + Σ1 + ch + K + w
    let lo = (hl >>> 0) + (S1l >>> 0) + (chl >>> 0) + K512[2 * t + 1] + wl[t];
    const t1h = (hh + S1h + chh + K512[2 * t] + wh[t] + Math.floor(lo / 0x100000000)) >>> 0;
    const t1l = lo >>> 0;
    // Σ0(a) = rotr28 ^ rotr34 ^ rotr39
    rotr64(ah, al, 28);
    let S0h = R[0], S0l = R[1];
    rotr64(ah, al, 34);
    S0h ^= R[0];
    S0l ^= R[1];
    rotr64(ah, al, 39);
    S0h ^= R[0];
    S0l ^= R[1];
    const majh = (ah & bh) ^ (ah & ch) ^ (bh & ch);
    const majl = (al & bl) ^ (al & cl) ^ (bl & cl);
    lo = (S0l >>> 0) + (majl >>> 0);
    const t2h = (S0h + majh + Math.floor(lo / 0x100000000)) >>> 0;
    const t2l = lo >>> 0;
    hh = gh; hl = gl;
    gh = fh; gl = fl;
    fh = eh; fl = el;
    lo = (dl >>> 0) + t1l;
    eh = (dh + t1h + Math.floor(lo / 0x100000000)) >>> 0;
    el = lo >>> 0;
    dh = ch; dl = cl;
    ch = bh; cl = bl;
    bh = ah; bl = al;
    lo = t1l + t2l;
    ah = (t1h + t2h + Math.floor(lo / 0x100000000)) >>> 0;
    al = lo >>> 0;
  }
  add64(state, 0, ah, al);
  add64(state, 2, bh, bl);
  add64(state, 4, ch, cl);
  add64(state, 6, dh, dl);
  add64(state, 8, eh, el);
  add64(state, 10, fh, fl);
  add64(state, 12, gh, gl);
  add64(state, 14, hh, hl);
}

/** state[i..i+1] (a [hi, lo] pair) += (h, l). */
function add64(state: Uint32Array, i: number, h: number, l: number): void {
  const lo = (state[i + 1] >>> 0) + (l >>> 0);
  state[i] = (state[i] + h + Math.floor(lo / 0x100000000)) >>> 0;
  state[i + 1] = lo >>> 0;
}
