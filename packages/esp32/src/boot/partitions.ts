/**
 * ESP-IDF partition table (at flash 0x8000; `<sketch>.partitions.bin`): 32-byte entries —
 * magic 0x50AA, type, subtype, offset, size, a 16-byte NUL-padded label, flags — then an MD5
 * entry (magic 0xEBEB, 14 bytes 0xFF, the MD5 of every entry before it) and 0xFF fill. At most
 * 0xC00 bytes. Untrusted input: entries stay inside the table, the MD5 is checked.
 */

import { md5 } from '../util/md5.ts';

export const PARTITION_MAGIC = 0x50aa;
export const PARTITION_MD5_MAGIC = 0xebeb;
export const PARTITION_TABLE_MAX = 0xc00;

export interface Partition {
  label: string;
  /** 0 app, 1 data. */
  type: number;
  subtype: number;
  offset: number;
  size: number;
  flags: number;
}

export interface PartitionTable {
  partitions: Partition[];
  /** The MD5 entry's digest (hex), or null when the table has none. */
  md5: string | null;
}

export type ParsedPartitions = { ok: true; table: PartitionTable } | { ok: false; error: string };

export function parsePartitionTable(bytes: Uint8Array): ParsedPartitions {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const partitions: Partition[] = [];
  let digest: string | null = null;
  const end = Math.min(bytes.length, PARTITION_TABLE_MAX);
  for (let at = 0; at + 32 <= end; at += 32) {
    const magic = view.getUint16(at, true);
    if (magic === 0xffff) break;
    if (magic === PARTITION_MD5_MAGIC) {
      const expected = md5(bytes.subarray(0, at));
      const stored = bytes.subarray(at + 16, at + 32);
      if (!expected.every((b, i) => b === stored[i])) return { ok: false, error: `partition table MD5 at ${at} does not match its entries` };
      digest = Array.from(stored, (b) => b.toString(16).padStart(2, '0')).join('');
      break;
    }
    if (magic !== PARTITION_MAGIC) return { ok: false, error: `entry at ${at} has magic 0x${magic.toString(16)}, not 0x50aa` };
    let label = '';
    for (let k = 0; k < 16 && bytes[at + 12 + k] !== 0; k++) label += String.fromCharCode(bytes[at + 12 + k]);
    partitions.push({
      label,
      type: bytes[at + 2],
      subtype: bytes[at + 3],
      offset: view.getUint32(at + 4, true),
      size: view.getUint32(at + 8, true),
      flags: view.getUint32(at + 28, true),
    });
  }
  if (partitions.length === 0) return { ok: false, error: 'no partition entries' };
  return { ok: true, table: { partitions, md5: digest } };
}

/** The partition the boot path runs: the first app partition (factory or ota_0). */
export function appPartition(table: PartitionTable): Partition | undefined {
  return table.partitions.find((p) => p.type === 0);
}

/**
 * The table Arduino's default ESP32 build uses (serial-hello.partitions.bin, also the other
 * fixtures'): used when a FirmwareImage brings no partition table.
 */
export const DEFAULT_PARTITIONS: PartitionTable = {
  partitions: [
    { label: 'nvs', type: 1, subtype: 0x02, offset: 0x9000, size: 0x5000, flags: 0 },
    { label: 'otadata', type: 1, subtype: 0x00, offset: 0xe000, size: 0x2000, flags: 0 },
    { label: 'app0', type: 0, subtype: 0x10, offset: 0x10000, size: 0x140000, flags: 0 },
    { label: 'app1', type: 0, subtype: 0x11, offset: 0x150000, size: 0x140000, flags: 0 },
    { label: 'spiffs', type: 1, subtype: 0x82, offset: 0x290000, size: 0x160000, flags: 0 },
    { label: 'coredump', type: 1, subtype: 0x03, offset: 0x3f0000, size: 0x10000, flags: 0 },
  ],
  md5: '972dae2ff872a0142d60bad124c0666b',
};
