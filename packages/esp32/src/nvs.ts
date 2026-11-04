/**
 * ESP-IDF's NVS — the non-volatile storage Preferences, `nvs_set_*` and the WiFi driver keep — read
 * from flash (BT119). Clean-room from the format ESP-IDF documents (the NVS library's "Internals")
 * and checked on what the firmware writes (fixtures/sketches/esp32/prefs-types). DOM-free; the
 * flash is untrusted (a host's saved copy): nothing here throws on it — what doesn't parse is
 * reported in `problems` and skipped.
 *
 * A partition is 4 KB pages. A page: a 32-byte header — state (u32: 0xFFFFFFFF empty, …FE active,
 * …FC full, …F8 freeing, …F0 corrupt), sequence number (u32), version (0xFE: 2, multi-page blobs;
 * 0xFF: 1), CRC32 of bytes 4–27 at 28 — then a 32-byte bitmap with 2 bits per entry (11 empty,
 * 10 written, 00 erased), then 126 entries of 32 bytes: namespace index, type, span (entries the
 * item takes), chunk index (0xFF but in blob data), CRC32 of the entry's other 28 bytes, a
 * 16-byte NUL-terminated key, 8 bytes of data. Namespaces are items of namespace 0 whose u8 value
 * is their index. Numbers are little-endian in the data. Strings (0x21) and blob chunks (0x42,
 * version 1's whole blobs 0x41) hold size (u16), 2 reserved bytes and a CRC32 of the payload,
 * which fills the next span − 1 entries; a version-2 blob is chunks numbered from the index item's
 * (0x48: size u32, chunk count, first chunk) start, in any page. The CRC is ESP-IDF's
 * `crc32_le(0xFFFFFFFF, …)`: the reflected CRC-32 (0xEDB88320) from 0, inverted at the end.
 */

import { parsePartitionTable } from './boot/partitions.ts';

export type NvsType = 'u8' | 'i8' | 'u16' | 'i16' | 'u32' | 'i32' | 'u64' | 'i64' | 'string' | 'blob';

export interface NvsEntry {
  readonly namespace: string;
  readonly key: string;
  readonly type: NvsType;
  /** Numbers to 32 bits as numbers, 64-bit ones as decimal strings, strings as text, blobs as bytes. */
  readonly value: number | string | Uint8Array;
}

export interface NvsDump {
  /** Sorted by namespace, then key. */
  readonly entries: NvsEntry[];
  /** Pages in use (active or full). */
  readonly pages: number;
  readonly problems: string[];
}

/** An NVS partition in a flash's partition table (type data, subtype nvs). */
export interface NvsPartition {
  readonly label: string;
  readonly offset: number;
  readonly size: number;
}

export const NVS_PAGE = 4096;
const ENTRY = 32;
const ENTRIES = 126;
const FIRST_ENTRY = 64;
const STATE_ACTIVE = 0xfffffffe;
const STATE_FULL = 0xfffffffc;
const STATE_FREEING = 0xfffffff8;
const STATE_EMPTY = 0xffffffff;
const WRITTEN = 0b10;
const PARTITION_TABLE = 0x8000;

const TYPES: Readonly<Record<number, NvsType>> = { 0x01: 'u8', 0x11: 'i8', 0x02: 'u16', 0x12: 'i16', 0x04: 'u32', 0x14: 'i32', 0x08: 'u64', 0x18: 'i64', 0x21: 'string', 0x41: 'blob', 0x42: 'blob' };
const TYPE_SZ = 0x21;
const TYPE_BLOB_V1 = 0x41;
const TYPE_BLOB_DATA = 0x42;
const TYPE_BLOB_INDEX = 0x48;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** ESP-IDF's `crc32_le(0xFFFFFFFF, bytes)` over `bytes[start, end)`. */
export function nvsCrc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let crc = 0;
  for (let i = start; i < end; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return ~crc >>> 0;
}

/** The NVS partitions the partition table at 0x8000 lists (none when it doesn't parse). */
export function nvsPartitions(flash: Uint8Array): NvsPartition[] {
  if (flash.length < PARTITION_TABLE + 0xc00) return [];
  const parsed = parsePartitionTable(flash.subarray(PARTITION_TABLE, PARTITION_TABLE + 0xc00));
  if (!parsed.ok) return [];
  return parsed.table.partitions
    .filter((p) => p.type === 1 && p.subtype === 2 && p.offset + p.size <= flash.length && p.size >= NVS_PAGE)
    .map((p) => ({ label: p.label, offset: p.offset, size: p.size }));
}

const u32 = (b: Uint8Array, at: number): number => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
const u16 = (b: Uint8Array, at: number): number => b[at] | (b[at + 1] << 8);

function keyOf(b: Uint8Array, at: number): string {
  let out = '';
  for (let i = 0; i < 16 && b[at + i] !== 0; i++) out += String.fromCharCode(b[at + i]);
  return out;
}

/** UTF-8 text (packages are DOM-free: no TextDecoder in their typings), a malformed sequence as U+FFFD. */
function utf8Text(b: Uint8Array): string {
  let out = '';
  for (let i = 0; i < b.length; ) {
    const c = b[i];
    const n = c < 0x80 ? 1 : c >= 0xf0 ? 4 : c >= 0xe0 ? 3 : c >= 0xc0 ? 2 : 0;
    if (n === 0 || i + n > b.length) {
      out += '�';
      i++;
      continue;
    }
    let cp = n === 1 ? c : c & (0xff >> (n + 1));
    for (let k = 1; k < n; k++) cp = (cp << 6) | (b[i + k] & 0x3f);
    out += String.fromCodePoint(cp);
    i += n;
  }
  return out;
}

interface Item {
  ns: number;
  type: number;
  chunk: number;
  key: string;
  data: Uint8Array;
  /** The payload of a string or blob chunk (empty for the rest). */
  payload: Uint8Array;
}

/** Every NVS item of `partition` (its bytes), with its namespace's name. */
export function decodeNvs(partition: Uint8Array): NvsDump {
  const problems: string[] = [];
  const pages: { seq: number; at: number }[] = [];
  for (let at = 0; at + NVS_PAGE <= partition.length; at += NVS_PAGE) {
    const state = u32(partition, at);
    if (state === STATE_EMPTY) continue;
    const page = at / NVS_PAGE;
    if (state !== STATE_ACTIVE && state !== STATE_FULL && state !== STATE_FREEING) {
      problems.push(`page ${page}: state 0x${state.toString(16)} (corrupt or unknown): skipped`);
      continue;
    }
    if (u32(partition, at + 28) !== nvsCrc32(partition, at + 4, at + 28)) {
      problems.push(`page ${page}: header CRC mismatch: skipped`);
      continue;
    }
    pages.push({ seq: u32(partition, at + 4), at });
  }
  pages.sort((a, b) => a.seq - b.seq);
  // Items in page order (later ones win for the same namespace and key).
  const items: Item[] = [];
  for (const { at } of pages) {
    const page = at / NVS_PAGE;
    for (let i = 0; i < ENTRIES; ) {
      const state = (partition[at + 32 + (i >> 2)] >> ((i & 3) * 2)) & 3;
      if (state !== WRITTEN) {
        i++;
        continue;
      }
      const e = at + FIRST_ENTRY + i * ENTRY;
      const span = partition[e + 2];
      if (span === 0 || i + span > ENTRIES) {
        problems.push(`page ${page} entry ${i}: span ${span} doesn't fit the page: skipped`);
        i++;
        continue;
      }
      const head = partition.subarray(e, e + ENTRY);
      const crc = nvsCrc32(Uint8Array.from([...head.subarray(0, 4), ...head.subarray(8, 32)]));
      if (u32(head, 4) !== crc) {
        problems.push(`page ${page} entry ${i}: CRC mismatch: skipped`);
        i += span;
        continue;
      }
      const type = head[1];
      let payload: Uint8Array = new Uint8Array(0);
      if (type === TYPE_SZ || type === TYPE_BLOB_DATA || type === TYPE_BLOB_V1) {
        const size = u16(head, 24);
        if (size > (span - 1) * ENTRY) {
          problems.push(`page ${page} entry ${i}: ${size} bytes don't fit ${span - 1} entries: skipped`);
          i += span;
          continue;
        }
        payload = partition.slice(e + ENTRY, e + ENTRY + size);
        if (nvsCrc32(payload) !== u32(head, 28)) {
          problems.push(`page ${page} entry ${i} ("${keyOf(head, 8)}"): data CRC mismatch: skipped`);
          i += span;
          continue;
        }
      }
      items.push({ ns: head[0], type, chunk: head[3], key: keyOf(head, 8), data: head.slice(24, 32), payload });
      i += span;
    }
  }
  const namespaces = new Map<number, string>();
  for (const item of items) if (item.ns === 0 && item.type === 0x01) namespaces.set(item.data[0], item.key);
  const byKey = new Map<string, NvsEntry>();
  const nameOf = (ns: number): string => namespaces.get(ns) ?? `#${ns}`;
  for (const item of items) {
    if (item.ns === 0 || item.type === TYPE_BLOB_DATA) continue;
    const id = `${item.ns}\u0000${item.key}`;
    if (item.type === TYPE_BLOB_INDEX) {
      const blob = assembleBlob(items, item);
      if (typeof blob === 'string') {
        problems.push(`"${nameOf(item.ns)}.${item.key}": ${blob}`);
        continue;
      }
      byKey.set(id, { namespace: nameOf(item.ns), key: item.key, type: 'blob', value: blob });
      continue;
    }
    const type = TYPES[item.type];
    if (type === undefined) {
      problems.push(`"${nameOf(item.ns)}.${item.key}": unknown type 0x${item.type.toString(16)}: skipped`);
      continue;
    }
    byKey.set(id, { namespace: nameOf(item.ns), key: item.key, type, value: valueOf(type, item) });
  }
  const entries = [...byKey.values()].sort((a, b) => (a.namespace < b.namespace ? -1 : a.namespace > b.namespace ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { entries, pages: pages.length, problems };
}

function valueOf(type: NvsType, item: Item): number | string | Uint8Array {
  const d = item.data;
  const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
  switch (type) {
    case 'u8':
      return d[0];
    case 'i8':
      return view.getInt8(0);
    case 'u16':
      return view.getUint16(0, true);
    case 'i16':
      return view.getInt16(0, true);
    case 'u32':
      return view.getUint32(0, true);
    case 'i32':
      return view.getInt32(0, true);
    case 'u64':
      return view.getBigUint64(0, true).toString();
    case 'i64':
      return view.getBigInt64(0, true).toString();
    case 'string': {
      const end = item.payload.indexOf(0);
      return utf8Text(end < 0 ? item.payload : item.payload.subarray(0, end));
    }
    case 'blob':
      return item.payload;
  }
}

/** A version-2 blob's bytes from its chunks, or why it can't be put together. */
function assembleBlob(items: readonly Item[], index: Item): Uint8Array | string {
  const size = u32(index.data, 0);
  const count = index.data[4];
  const start = index.data[5];
  const out = new Uint8Array(size);
  let at = 0;
  for (let c = 0; c < count; c++) {
    let chunk: Item | undefined;
    for (const item of items) if (item.type === TYPE_BLOB_DATA && item.ns === index.ns && item.key === index.key && item.chunk === start + c) chunk = item;
    if (chunk === undefined) return `blob chunk ${start + c} is missing: skipped`;
    if (at + chunk.payload.length > size) return `blob chunks hold more than its ${size} bytes: skipped`;
    out.set(chunk.payload, at);
    at += chunk.payload.length;
  }
  if (at !== size) return `blob chunks hold ${at} of its ${size} bytes: skipped`;
  return out;
}
