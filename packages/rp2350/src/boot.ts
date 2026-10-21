/**
 * Direct boot (BT65): where the RP2350 bootrom would enter a flash image, found the way its flash
 * boot does (RP2350 datasheet §5.9 "Metadata block details", the pico-sdk's boot/picobin.h) —
 * without running the bootrom's boot path.
 *
 * A block starts with PICOBIN_BLOCK_MARKER_START (0xffffded3) on a word boundary in the first
 * 4 KB of flash; items follow (a header word: type in bits 6:0, bit 7 set for a two-byte size;
 * the size in words, the item's own data in the rest) up to the LAST item (0xff), whose size is
 * the items' total, then a link word (the next block's offset, relative) and
 * PICOBIN_BLOCK_MARKER_END (0xab123579). The blocks form a loop; the first block holding an
 * IMAGE_TYPE item (0x42) that says EXE is the image definition. Its CPU must be RISC-V and its
 * chip the RP2350 (this SoC has no Arm cores). ENTRY_POINT (0x44: pc, sp) gives the entry; without
 * one a RISC-V image is entered at its start (flash) with sp at the top of SRAM (0x20082000).
 * A LOAD_MAP (0x06: images the bootrom copies to RAM) isn't supported yet.
 *
 * What the bootrom leaves that this skips: QMI is in its default 03h read mode (XIP reads just
 * work here); clk_sys and clk_ref run from the ROSC; core 1 waits in the bootrom for a launch
 * (the SIO models that side); mtvec, gp and the stack are the image's own to set (crt0 does).
 */

export const MARKER_START = 0xffffded3;
export const MARKER_END = 0xab123579;
const ITEM_IMAGE_TYPE = 0x42;
const ITEM_ENTRY_POINT = 0x44;
const ITEM_LOAD_MAP = 0x06;
const ITEM_LAST = 0xff;
/** Where the bootrom looks for the first block. */
const SEARCH_WINDOW = 4096;
const SRAM_TOP = 0x20082000;

export interface ImageDef {
  /** The block's flash offset. */
  offset: number;
  /** IMAGE_TYPE's 16-bit flags. */
  imageType: number;
  entry: number;
  sp: number;
}

export class BootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BootError';
  }
}

interface Block {
  offset: number;
  items: Map<number, number>;
  link: number;
}

/** The block at `offset`, or undefined when there is none there. Untrusted: every size is checked. */
function readBlock(view: DataView, offset: number): Block | undefined {
  const word = (at: number): number => (at + 4 <= view.byteLength ? view.getUint32(at, true) : 0);
  if (word(offset) !== MARKER_START) return undefined;
  const items = new Map<number, number>();
  let at = offset + 4;
  let total = 0;
  for (let n = 0; n < 64; n++) {
    const header = word(at);
    const type = header & 0xff;
    const size = (type & 0x80) !== 0 ? (header >>> 8) & 0xffff : (header >>> 8) & 0xff;
    if (type === ITEM_LAST) {
      if (size !== total) return undefined;
      const link = word(at + 4) | 0;
      if (word(at + 8) !== MARKER_END) return undefined;
      return { offset, items, link };
    }
    if (size === 0 || at + 4 * size > view.byteLength) return undefined;
    items.set(type & 0x7f, at);
    total += size;
    at += 4 * size;
  }
  return undefined;
}

/** The image definition of a flash image (flash bytes from 0x10000000), or a BootError. */
export function findImageDef(flash: Uint8Array): ImageDef {
  const view = new DataView(flash.buffer, flash.byteOffset, flash.byteLength);
  let first: Block | undefined;
  for (let offset = 0; offset < Math.min(SEARCH_WINDOW, flash.length - 4) && first === undefined; offset += 4) first = readBlock(view, offset);
  if (first === undefined) throw new BootError('no RP2350 image in flash (no metadata block in its first 4 KB): the bootrom would wait for a UF2 in BOOTSEL mode');
  const seen = new Set<number>();
  for (let block: Block | undefined = first; block !== undefined && !seen.has(block.offset); ) {
    seen.add(block.offset);
    const typeAt = block.items.get(ITEM_IMAGE_TYPE & 0x7f);
    if (typeAt !== undefined) {
      const imageType = view.getUint32(typeAt, true) >>> 16;
      if ((imageType & 0xf) === 1) return imageDef(view, block, imageType);
    }
    const next: number = block.offset + block.link;
    block = next >= 0 && next !== block.offset ? readBlock(view, next) : undefined;
  }
  throw new BootError('the flash has metadata blocks but no executable image definition');
}

function imageDef(view: DataView, block: Block, imageType: number): ImageDef {
  const cpu = (imageType >>> 8) & 7;
  const chip = (imageType >>> 12) & 7;
  if (chip !== 1) throw new BootError('this image is for the RP2040, not the RP2350');
  if (cpu !== 1) throw new BootError(`this image is for the RP2350's ${cpu === 0 ? 'Arm' : 'varmulet'} cores; Benchtop runs its RISC-V cores only (build with arch=riscv)`);
  if (block.items.has(ITEM_LOAD_MAP)) throw new BootError('images the bootrom copies to RAM (a LOAD_MAP) are not supported yet');
  const entryAt = block.items.get(ITEM_ENTRY_POINT & 0x7f);
  if (entryAt === undefined) return { offset: block.offset, imageType, entry: 0x10000000, sp: SRAM_TOP };
  return { offset: block.offset, imageType, entry: view.getUint32(entryAt + 4, true), sp: view.getUint32(entryAt + 8, true) };
}
