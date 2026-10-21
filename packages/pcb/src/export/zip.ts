/**
 * A minimal ZIP writer (BT58): stored entries (no compression — Gerbers are small), CRC-32,
 * UTF-8 names, one fixed timestamp (1980-01-01 00:00), entries in the order given. The same files
 * give the same bytes. No dependency, DOM-free.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** DOS time/date of 1980-01-01 00:00:00. */
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

/** UTF-8 bytes of a string (packages are DOM-free: no TextEncoder in their typings). */
export function utf8(text: string): Uint8Array {
  const out: number[] = [];
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(out);
}

export interface ZipEntry {
  name: string;
  data: string | Uint8Array;
}

export function zip(entries: readonly ZipEntry[]): Uint8Array {
  const files = entries.map((e) => {
    const name = utf8(e.name);
    const data = typeof e.data === 'string' ? utf8(e.data) : e.data;
    return { name, data, crc: crc32(data) };
  });
  const localSize = files.reduce((sum, f) => sum + 30 + f.name.length + f.data.length, 0);
  const centralSize = files.reduce((sum, f) => sum + 46 + f.name.length, 0);
  const out = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(out.buffer);
  let at = 0;
  const offsets: number[] = [];
  for (const f of files) {
    offsets.push(at);
    view.setUint32(at, 0x04034b50, true);
    view.setUint16(at + 4, 10, true); // version needed
    view.setUint16(at + 6, 0x0800, true); // UTF-8 names
    view.setUint16(at + 8, 0, true); // stored
    view.setUint16(at + 10, DOS_TIME, true);
    view.setUint16(at + 12, DOS_DATE, true);
    view.setUint32(at + 14, f.crc, true);
    view.setUint32(at + 18, f.data.length, true);
    view.setUint32(at + 22, f.data.length, true);
    view.setUint16(at + 26, f.name.length, true);
    view.setUint16(at + 28, 0, true);
    out.set(f.name, at + 30);
    out.set(f.data, at + 30 + f.name.length);
    at += 30 + f.name.length + f.data.length;
  }
  const central = at;
  files.forEach((f, i) => {
    view.setUint32(at, 0x02014b50, true);
    view.setUint16(at + 4, 20, true); // made by
    view.setUint16(at + 6, 10, true);
    view.setUint16(at + 8, 0x0800, true);
    view.setUint16(at + 10, 0, true);
    view.setUint16(at + 12, DOS_TIME, true);
    view.setUint16(at + 14, DOS_DATE, true);
    view.setUint32(at + 16, f.crc, true);
    view.setUint32(at + 20, f.data.length, true);
    view.setUint32(at + 24, f.data.length, true);
    view.setUint16(at + 28, f.name.length, true);
    view.setUint16(at + 30, 0, true); // extra
    view.setUint16(at + 32, 0, true); // comment
    view.setUint16(at + 34, 0, true); // disk
    view.setUint16(at + 36, 0, true); // internal attributes
    view.setUint32(at + 38, 0, true); // external attributes
    view.setUint32(at + 42, offsets[i], true);
    out.set(f.name, at + 46);
    at += 46 + f.name.length;
  });
  view.setUint32(at, 0x06054b50, true);
  view.setUint16(at + 4, 0, true);
  view.setUint16(at + 6, 0, true);
  view.setUint16(at + 8, files.length, true);
  view.setUint16(at + 10, files.length, true);
  view.setUint32(at + 12, at - central, true);
  view.setUint32(at + 16, central, true);
  view.setUint16(at + 20, 0, true);
  return out;
}
