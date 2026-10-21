/**
 * Builds the SPI flash a direct boot runs from (BT32): erased (0xFF), sized by the image header's
 * flash-size nibble (0: 1 MB, 1: 2 MB, 2: 4 MB, 3: 8 MB, 4: 16 MB), the partition table at 0x8000
 * (the firmware's own `.partitions.bin`, or DEFAULT_PARTITIONS serialized with its MD5 entry —
 * the app reads it through esp_partition), and the app image at the first app partition. There is
 * no second-stage bootloader at 0x1000: Benchtop does its work (direct-boot.ts).
 */

import { md5 } from '../util/md5.ts';
import { type EspImage, parseEspImage } from './image.ts';
import { appPartition, DEFAULT_PARTITIONS, type Partition, PARTITION_MAGIC, PARTITION_MD5_MAGIC, type PartitionTable, parsePartitionTable } from './partitions.ts';

export const PARTITION_TABLE_OFFSET = 0x8000;
const FLASH_SIZES = [1, 2, 4, 8, 16];

export interface FlashLayout {
  flash: Uint8Array;
  image: EspImage;
  partitions: PartitionTable;
  app: Partition;
}

export type BuiltFlash = { ok: true; layout: FlashLayout } | { ok: false; error: string };

/** The partition table's bytes: 32-byte entries, then the MD5 entry. */
export function serializePartitions(table: PartitionTable): Uint8Array {
  const bytes = new Uint8Array(0xc00).fill(0xff);
  const view = new DataView(bytes.buffer);
  table.partitions.forEach((p, i) => {
    const at = i * 32;
    view.setUint16(at, PARTITION_MAGIC, true);
    bytes[at + 2] = p.type;
    bytes[at + 3] = p.subtype;
    view.setUint32(at + 4, p.offset, true);
    view.setUint32(at + 8, p.size, true);
    for (let k = 0; k < 16; k++) bytes[at + 12 + k] = k < p.label.length ? p.label.charCodeAt(k) : 0;
    view.setUint32(at + 28, p.flags, true);
  });
  const at = table.partitions.length * 32;
  view.setUint16(at, PARTITION_MD5_MAGIC, true);
  bytes.set(md5(bytes.subarray(0, at)), at + 16);
  return bytes;
}

export function buildFlash(app: Uint8Array, partitionsBin?: Uint8Array): BuiltFlash {
  const parsed = parseEspImage(app);
  if (!parsed.ok) return { ok: false, error: `app image: ${parsed.error.message}` };
  const image = parsed.image;
  const megabytes = FLASH_SIZES[image.spiSize];
  if (megabytes === undefined) return { ok: false, error: `flash size nibble ${image.spiSize} is not 0–4` };
  let partitions = DEFAULT_PARTITIONS;
  let tableBytes: Uint8Array;
  if (partitionsBin !== undefined) {
    const table = parsePartitionTable(partitionsBin);
    if (!table.ok) return { ok: false, error: `partition table: ${table.error}` };
    partitions = table.table;
    tableBytes = partitionsBin.subarray(0, Math.min(partitionsBin.length, 0xc00));
  } else tableBytes = serializePartitions(DEFAULT_PARTITIONS);
  const app0 = appPartition(partitions);
  if (app0 === undefined) return { ok: false, error: 'the partition table has no app partition' };
  if (image.length > app0.size) return { ok: false, error: `the app (${image.length} bytes) is larger than partition ${app0.label} (${app0.size})` };
  const flash = new Uint8Array(megabytes * 1024 * 1024).fill(0xff);
  if (app0.offset + app0.size > flash.length) return { ok: false, error: `partition ${app0.label} ends past the ${megabytes} MB flash` };
  flash.set(tableBytes, PARTITION_TABLE_OFFSET);
  flash.set(app.subarray(0, image.length), app0.offset);
  return { ok: true, layout: { flash, image, partitions, app: app0 } };
}
