/**
 * UF2 (USB Flashing Format) files, the RP2040's and RP2350's native firmware image (BT60; in
 * @benchtop/core since BT65, which both chips' adapters use):
 * 512-byte blocks, each carrying up to 476 payload bytes for one target address (RP2040
 * datasheet §2.8.4.2 "UF2 Format Details"; the format's own specification). Untrusted input:
 * every field is checked, and anything that doesn't fit throws Uf2Error with a reason.
 */

export const UF2_BLOCK_SIZE = 512;
const MAGIC_START0 = 0x0a324655; // "UF2\n"
const MAGIC_START1 = 0x9e5d5157;
const MAGIC_END = 0x0ab16f30;
/** Flags: the block isn't for the main flash (skip it); the file-size field is a family ID. */
const FLAG_NOT_MAIN_FLASH = 0x00000001;
const FLAG_FAMILY_ID = 0x00002000;

/** Family IDs (the UF2 family list, as picotool writes them). */
export const UF2_FAMILY = {
  RP2040: 0xe48bff56,
  /** RP2350 images whose blocks hold absolute addresses (any CPU). */
  ABSOLUTE: 0xe48bff57,
  DATA: 0xe48bff58,
  RP2350_ARM_S: 0xe48bff59,
  RP2350_RISCV: 0xe48bff5a,
  RP2350_ARM_NS: 0xe48bff5b,
} as const;

export class Uf2Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Uf2Error';
  }
}

export interface Uf2Block {
  address: number;
  data: Uint8Array;
  /** The block's family ID (undefined: the block carries none). */
  family?: number;
}

export interface Uf2Image {
  /**
   * The family ID most main-flash blocks carry (undefined: none carries one). A file may join
   * several block sequences: picotool puts a one-block ABSOLUTE-family sequence before an RP2350
   * image (the RP2350-E10 workaround), so a loader keeps the blocks of the family it runs.
   */
  familyId: number | undefined;
  /** Main-flash blocks in file order (blocks flagged "not main flash" are dropped). */
  blocks: Uf2Block[];
}

/** A target region a UF2 may write: [start, end). */
export interface Uf2Region {
  start: number;
  end: number;
}

/**
 * Parses a UF2 file. Throws Uf2Error on anything malformed. Block sequences may follow one
 * another (block 0 with a different total or family starts the next); within one, block numbers
 * are unique and agree on the total and family. A sequence need not be complete.
 */
export function parseUf2(bytes: Uint8Array): Uf2Image {
  if (bytes.length === 0 || bytes.length % UF2_BLOCK_SIZE !== 0) throw new Uf2Error(`a UF2 file is a whole number of 512-byte blocks; this one is ${bytes.length} bytes`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const blocks: Uf2Block[] = [];
  const counts = new Map<number, number>();
  let total = -1;
  let sequenceFamily: number | undefined;
  const seen = new Set<number>();
  for (let offset = 0; offset < bytes.length; offset += UF2_BLOCK_SIZE) {
    const at = (n: number): number => view.getUint32(offset + n, true);
    const index = offset / UF2_BLOCK_SIZE;
    if (at(0) !== MAGIC_START0 || at(4) !== MAGIC_START1 || at(508) !== MAGIC_END) throw new Uf2Error(`block ${index}: bad magic numbers (not a UF2 file?)`);
    const flags = at(8);
    const address = at(12);
    const size = at(16);
    const blockNo = at(20);
    const numBlocks = at(24);
    if (size === 0 || size > 476) throw new Uf2Error(`block ${index}: payload size ${size} (1–476 bytes)`);
    if (numBlocks === 0 || blockNo >= numBlocks) throw new Uf2Error(`block ${index}: block number ${blockNo} of ${numBlocks}`);
    if ((flags & FLAG_NOT_MAIN_FLASH) !== 0) continue;
    const family = (flags & FLAG_FAMILY_ID) !== 0 ? at(28) : undefined;
    if (total < 0 || (blockNo === 0 && (numBlocks !== total || family !== sequenceFamily))) {
      total = numBlocks;
      sequenceFamily = family;
      seen.clear();
    } else if (numBlocks !== total) throw new Uf2Error(`block ${index}: says ${numBlocks} blocks in all, earlier blocks said ${total}`);
    else if (family !== sequenceFamily) throw new Uf2Error(`block ${index}: family 0x${(family ?? 0).toString(16)} after 0x${(sequenceFamily ?? 0).toString(16)}`);
    if (seen.has(blockNo)) throw new Uf2Error(`block ${index}: block number ${blockNo} appears twice`);
    seen.add(blockNo);
    if (family !== undefined) counts.set(family, (counts.get(family) ?? 0) + 1);
    const block: Uf2Block = { address, data: bytes.subarray(offset + 32, offset + 32 + size) };
    if (family !== undefined) block.family = family;
    blocks.push(block);
  }
  if (blocks.length === 0) throw new Uf2Error('the UF2 file has no main-flash blocks');
  let familyId: number | undefined;
  for (const [family, count] of counts) if (familyId === undefined || count > (counts.get(familyId) ?? 0)) familyId = family;
  return { familyId, blocks };
}

/**
 * Writes a UF2's blocks into memory regions: each block must lie entirely inside one of
 * `regions` (`write(address, data)` places it). Throws Uf2Error naming the first block that
 * doesn't fit.
 */
export function placeUf2(image: Uf2Image, regions: readonly Uf2Region[], write: (address: number, data: Uint8Array) => void): void {
  for (const block of image.blocks) {
    const end = block.address + block.data.length;
    if (!regions.some((r) => block.address >= r.start && end <= r.end)) throw new Uf2Error(`a block for 0x${block.address.toString(16)}–0x${(end - 1).toString(16)} is outside the chip's flash and RAM`);
  }
  for (const block of image.blocks) write(block.address, block.data);
}

/** Builds a UF2 file from memory images (tests, tools): 256-byte payloads, family ID set. */
export function buildUf2(segments: readonly Uf2Block[], familyId: number): Uint8Array {
  const chunks: { address: number; data: Uint8Array }[] = [];
  for (const segment of segments) {
    for (let i = 0; i < segment.data.length; i += 256) chunks.push({ address: segment.address + i, data: segment.data.subarray(i, Math.min(i + 256, segment.data.length)) });
  }
  const out = new Uint8Array(chunks.length * UF2_BLOCK_SIZE);
  const view = new DataView(out.buffer);
  chunks.forEach((chunk, i) => {
    const o = i * UF2_BLOCK_SIZE;
    view.setUint32(o, MAGIC_START0, true);
    view.setUint32(o + 4, MAGIC_START1, true);
    view.setUint32(o + 8, FLAG_FAMILY_ID, true);
    view.setUint32(o + 12, chunk.address, true);
    view.setUint32(o + 16, chunk.data.length, true);
    view.setUint32(o + 20, i, true);
    view.setUint32(o + 24, chunks.length, true);
    view.setUint32(o + 28, familyId, true);
    out.set(chunk.data, o + 32);
    view.setUint32(o + 508, MAGIC_END, true);
  });
  return out;
}
