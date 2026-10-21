/**
 * ESP32 app image (the `.bin` Arduino IDE builds) → header, segments and integrity checks
 * (ESP-IDF's esp_image_format.h layout):
 *   24-byte header: magic 0xE9, segment count, SPI mode, SPI speed (low nibble) / size (high
 *   nibble), entry point, then the extended header — WP pin, drive settings, chip id (0 = ESP32),
 *   minimum revision, 8 reserved bytes, hash_appended.
 *   Segments: load address and length (8 bytes), then the data.
 *   Padding to 16 bytes whose last byte is the checksum: 0xEF XOR every segment data byte.
 *   With hash_appended, a SHA-256 of everything up to and including the checksum follows.
 * Untrusted input (AGENTS rule 6): every length stays inside the file and every segment inside
 * one ESP32 memory region; failures come back as `{ ok: false, error }`, never as exceptions.
 */

import { sha256 } from '../util/sha256.ts';

export const ESP_IMAGE_MAGIC = 0xe9;
export const ESP_CHECKSUM_MAGIC = 0xef;
const HEADER_BYTES = 24;
const SEGMENT_HEADER_BYTES = 8;
const MAX_SEGMENTS = 16;

export type MemoryRegion = 'DROM' | 'DRAM' | 'IROM' | 'IRAM' | 'RTC_FAST' | 'RTC_SLOW';

/** Where an image segment may load: [start, end] inclusive. */
export const IMAGE_REGIONS: readonly { region: MemoryRegion; start: number; end: number }[] = [
  { region: 'DROM', start: 0x3f400000, end: 0x3f7fffff },
  { region: 'DRAM', start: 0x3ffae000, end: 0x3fffffff },
  { region: 'IRAM', start: 0x40070000, end: 0x400bffff },
  { region: 'IROM', start: 0x400c2000, end: 0x40bfffff },
  { region: 'RTC_FAST', start: 0x3ff80000, end: 0x3ff81fff },
  { region: 'RTC_FAST', start: 0x400c0000, end: 0x400c1fff },
  { region: 'RTC_SLOW', start: 0x50000000, end: 0x50001fff },
];

export interface ImageSegment {
  loadAddress: number;
  /** A view into the input. */
  data: Uint8Array;
  region: MemoryRegion;
  /** Offset of the segment's data in the file. */
  fileOffset: number;
}

export interface EspImage {
  segmentCount: number;
  spiMode: number;
  /** Raw nibbles: speed 0xF = 80 MHz, size 2 = 4 MB (blink's byte is 0x2f). */
  spiSpeed: number;
  spiSize: number;
  entry: number;
  chipId: number;
  minChipRevision: number;
  hashAppended: boolean;
  segments: ImageSegment[];
  checksum: number;
  /** Bytes the image occupies, including the appended hash. */
  length: number;
}

export type ImageErrorCode = 'truncated' | 'magic' | 'segments' | 'chip' | 'address' | 'entry' | 'checksum' | 'hash';

export type ParsedImage = { ok: true; image: EspImage } | { ok: false; error: { code: ImageErrorCode; message: string } };

/** The region holding [address, address + length), or undefined. */
export function regionOf(address: number, length: number): MemoryRegion | undefined {
  const last = address + Math.max(length, 1) - 1;
  return IMAGE_REGIONS.find((r) => address >= r.start && last <= r.end)?.region;
}

const fail = (code: ImageErrorCode, message: string): ParsedImage => ({ ok: false, error: { code, message } });
const hex = (n: number): string => `0x${n.toString(16).padStart(8, '0')}`;

export function parseEspImage(bytes: Uint8Array): ParsedImage {
  if (bytes.length < HEADER_BYTES) return fail('truncated', `${bytes.length} bytes is shorter than the ${HEADER_BYTES}-byte image header`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[0] !== ESP_IMAGE_MAGIC) return fail('magic', `magic byte is 0x${bytes[0].toString(16)}, not 0xe9`);
  const segmentCount = bytes[1];
  if (segmentCount < 1 || segmentCount > MAX_SEGMENTS) return fail('segments', `${segmentCount} segments (expected 1–${MAX_SEGMENTS})`);
  const chipId = view.getUint16(12, true);
  if (chipId !== 0) return fail('chip', `chip id ${chipId} is not an ESP32 (0)`);
  const entry = view.getUint32(4, true);
  const segments: ImageSegment[] = [];
  let offset = HEADER_BYTES;
  let checksum = ESP_CHECKSUM_MAGIC;
  for (let i = 0; i < segmentCount; i++) {
    if (offset + SEGMENT_HEADER_BYTES > bytes.length) return fail('truncated', `segment ${i} header at ${offset} is past the end of the file`);
    const loadAddress = view.getUint32(offset, true);
    const length = view.getUint32(offset + 4, true);
    const dataStart = offset + SEGMENT_HEADER_BYTES;
    if (length > bytes.length - dataStart) return fail('truncated', `segment ${i} (${length} bytes at ${dataStart}) runs past the end of the file`);
    const region = regionOf(loadAddress, length);
    if (region === undefined) return fail('address', `segment ${i} at ${hex(loadAddress)} (+${length}) is outside every ESP32 memory region`);
    const data = bytes.subarray(dataStart, dataStart + length);
    for (let k = 0; k < data.length; k++) checksum ^= data[k];
    segments.push({ loadAddress, data, region, fileOffset: dataStart });
    offset = dataStart + length;
  }
  if (regionOf(entry, 1) !== 'IRAM') return fail('entry', `entry point ${hex(entry)} is not in IRAM`);
  // Zero padding so the checksum is the last byte of a 16-byte block.
  const checksumAt = offset + (15 - (offset % 16));
  if (checksumAt >= bytes.length) return fail('truncated', 'the file ends before the checksum byte');
  if (bytes[checksumAt] !== checksum) return fail('checksum', `checksum byte is 0x${bytes[checksumAt].toString(16)}, computed 0x${checksum.toString(16)}`);
  const hashAppended = bytes[23] === 1;
  let length = checksumAt + 1;
  if (hashAppended) {
    if (length + 32 > bytes.length) return fail('truncated', 'the file ends inside the appended SHA-256');
    const digest = sha256(bytes.subarray(0, length));
    for (let k = 0; k < 32; k++) if (digest[k] !== bytes[length + k]) return fail('hash', 'the appended SHA-256 does not match the image');
    length += 32;
  }
  return {
    ok: true,
    image: {
      segmentCount,
      spiMode: bytes[2],
      spiSpeed: bytes[3] & 0x0f,
      spiSize: bytes[3] >> 4,
      entry,
      chipId,
      minChipRevision: bytes[14],
      hashAppended,
      segments,
      checksum,
      length,
    },
  };
}
