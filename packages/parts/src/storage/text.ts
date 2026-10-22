/**
 * UTF-8 and base64 without TextEncoder or atob (BT89): neither is in the DOM-free ES2023 lib
 * this package compiles against. For card files, which are small and rarely converted.
 */

export function utf8Encode(text: string): Uint8Array {
  const out: number[] = [];
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0xfffd;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(out);
}

/** UTF-8 → string, or null when the bytes aren't UTF-8 text (bad sequences, NULs, control bytes). */
export function utf8Text(bytes: Uint8Array): string | null {
  let s = '';
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i];
    let c: number;
    let n: number;
    if (b < 0x80) {
      c = b;
      n = 0;
    } else if ((b & 0xe0) === 0xc0) {
      c = b & 31;
      n = 1;
    } else if ((b & 0xf0) === 0xe0) {
      c = b & 15;
      n = 2;
    } else if ((b & 0xf8) === 0xf0) {
      c = b & 7;
      n = 3;
    } else return null;
    for (let k = 1; k <= n; k++) {
      const next = bytes[i + k];
      if (next === undefined || (next & 0xc0) !== 0x80) return null;
      c = (c << 6) | (next & 63);
    }
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) return null;
    s += String.fromCodePoint(c);
    i += n + 1;
  }
  return s;
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const INDEX = new Int16Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) INDEX[ALPHABET.charCodeAt(i)] = i;

export function base64Encode(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    s += ALPHABET[a >> 2] + ALPHABET[((a & 3) << 4) | (b >> 4)];
    s += i + 1 < bytes.length ? ALPHABET[((b & 15) << 2) | (c >> 6)] : '=';
    s += i + 2 < bytes.length ? ALPHABET[c & 63] : '=';
  }
  return s;
}

/** Base64 → bytes (whitespace ignored), or null when it isn't base64. */
export function base64Decode(text: string): Uint8Array | null {
  const clean = text.replace(/\s+/g, '').replace(/=+$/, '');
  if (clean.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let at = 0;
  for (let i = 0; i < clean.length; i++) {
    const code = clean.charCodeAt(i);
    const v = code < 128 ? INDEX[code] : -1;
    if (v < 0) return null;
    value = (value << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (value >> bits) & 0xff;
    }
  }
  return out;
}
