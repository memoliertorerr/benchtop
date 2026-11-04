/**
 * Builds the SPI flash a direct boot runs from (BT32): erased (0xFF), sized by the image header's
 * flash-size nibble (0: 1 MB, 1: 2 MB, 2: 4 MB, 3: 8 MB, 4: 16 MB), the partition table at 0x8000
 * (the firmware's own `.partitions.bin`, or DEFAULT_PARTITIONS serialized with its MD5 entry —
 * the app reads it through esp_partition), and the app image at the first app partition. There is
 * no second-stage bootloader at 0x1000: Benchtop does its work (direct-boot.ts).
 *
 * BT118: given a board's flash (`FlashTarget`), it writes there what an upload writes — the table
 * and the app, their sectors erased first (and on a new image the OTA data partition, as
 * esptool's boot_app0.bin) — and leaves the rest: NVS, SPIFFS/LittleFS, the EEPROM library's
 * partition keep what the firmware stored.
 */

import { md5 } from '../util/md5.ts';
import { ESP32_CHIP, type EspChip, type EspImage, parseEspImage } from './image.ts';
import { appPartition, DEFAULT_PARTITIONS, type Partition, PARTITION_MAGIC, PARTITION_MD5_MAGIC, type PartitionTable, parsePartitionTable } from './partitions.ts';

export const PARTITION_TABLE_OFFSET = 0x8000;
const FLASH_SIZES = [1, 2, 4, 8, 16];

export interface FlashLayout {
  flash: Uint8Array;
  image: EspImage;
  partitions: PartitionTable;
  app: Partition;
  /** BT118: the ranges written: the program's (the partition table, the app image). */
  written: { offset: number; length: number }[];
}

/** BT118: a board's flash to write into (kept when it holds the image's flash size; a bigger chip is fine) — it outlives resets. */
export interface FlashTarget {
  flash: Uint8Array;
  /** A new image (an upload): the OTA data partition is erased too. */
  upload: boolean;
}

const SECTOR = 0x1000;

/** Erases [offset, offset + length) rounded out to 4 KB sectors. */
function eraseSectors(flash: Uint8Array, offset: number, length: number): void {
  flash.fill(0xff, Math.floor(offset / SECTOR) * SECTOR, Math.min(flash.length, Math.ceil((offset + length) / SECTOR) * SECTOR));
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

export function buildFlash(app: Uint8Array, partitionsBin?: Uint8Array, chip: EspChip = ESP32_CHIP, target?: FlashTarget): BuiltFlash {
  const parsed = parseEspImage(app, chip);
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
  const size = megabytes * 1024 * 1024;
  if (app0.offset + app0.size > size) return { ok: false, error: `partition ${app0.label} ends past the ${megabytes} MB flash` };
  const flash = target !== undefined && target.flash.length >= size ? target.flash : new Uint8Array(size).fill(0xff);
  eraseSectors(flash, PARTITION_TABLE_OFFSET, tableBytes.length);
  flash.set(tableBytes, PARTITION_TABLE_OFFSET);
  eraseSectors(flash, app0.offset, image.length);
  flash.set(app.subarray(0, image.length), app0.offset);
  if (target?.upload === true) for (const p of partitions.partitions) if (p.type === 1 && p.subtype === 0 && p.offset + p.size <= size) eraseSectors(flash, p.offset, p.size);
  const written = [
    { offset: PARTITION_TABLE_OFFSET, length: tableBytes.length },
    { offset: app0.offset, length: image.length },
  ];
  return { ok: true, layout: { flash, image, partitions, app: app0, written } };
}
