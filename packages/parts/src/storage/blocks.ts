/**
 * A card's 512-byte blocks, sparse (BT89): only blocks ever written hold memory, so an 8 GB card
 * costs what its files do. Unwritten blocks read as zeros — what a freshly formatted card's FATs
 * and data area hold.
 */

export const BLOCK = 512;
const ZERO = new Uint8Array(BLOCK);

export class SparseBlocks {
  readonly count: number;
  private readonly map = new Map<number, Uint8Array>();

  constructor(count: number) {
    this.count = count;
  }

  /** Blocks holding memory. */
  get used(): number {
    return this.map.size;
  }

  /** Whether block `lba` was ever written (else it reads as zeros). */
  has(lba: number): boolean {
    return this.map.has(lba);
  }

  /** Block `lba`'s bytes, shared: read them now, never write them (zeros when unwritten). */
  peek(lba: number): Uint8Array {
    return this.map.get(lba) ?? ZERO;
  }

  /** Block `lba` to write into (allocated on first use). */
  writable(lba: number): Uint8Array {
    let block = this.map.get(lba);
    if (block === undefined) this.map.set(lba, (block = new Uint8Array(BLOCK)));
    return block;
  }

  /** Copies 512 bytes from `data` at `offset` into block `lba`. */
  write(lba: number, data: Uint8Array, offset = 0): void {
    this.writable(lba).set(data.subarray(offset, offset + BLOCK));
  }

  /** Erases blocks `first`…`last` (inclusive) back to zeros. */
  erase(first: number, last: number): void {
    if (last - first > this.map.size) {
      for (const lba of [...this.map.keys()]) if (lba >= first && lba <= last) this.map.delete(lba);
    } else {
      for (let lba = first; lba <= last; lba++) this.map.delete(lba);
    }
  }

  /** Every block back to zeros. */
  clear(): void {
    this.map.clear();
  }
}
