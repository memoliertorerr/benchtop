/**
 * The predecoded instruction cache (BT64): 4 KB pages, keyed by page number, of ENTRY (2) ints
 * per halfword slot, allocated on a page's first fetch and filled lazily one instruction at a
 * time by the core (cpu.ts `pack`). Word 0 holds the op and its register fields (W0_* below) and
 * is 0 until the slot is decoded; word 1 the immediate (a CSR instruction: csr | uimm << 12).
 * Invalid instructions and 32-bit instructions in a page's last halfword aren't cached: they go
 * through the bus's fetch16 every time.
 *
 * Whether a page may be cached is the bus's call (RiscvCodeBus.codePage); refused pages are
 * remembered until the next invalidation. A bus that accepts a writable page calls the core's
 * invalidateCode on writes to it; FENCE.I drops everything. Each invalidation that drops a page
 * calls `onChange` (the core then looks its page up again before the next instruction).
 */

import type { RiscvCodeBus } from './bus.ts';

export const RC_PAGE_SHIFT = 12;
export const RC_PAGE_SIZE = 1 << RC_PAGE_SHIFT;
/** Ints per halfword slot. */
export const ENTRY = 2;

// Word 0 of an entry.
export const W0_OP_MASK = 0x7f;
/** The instruction is 4 bytes long. */
export const W0_LEN4 = 1 << 7;
export const W0_RD_SHIFT = 8;
export const W0_RS1_SHIFT = 13;
export const W0_RS2_SHIFT = 18;
/** 4 bits: Zcmp's rlist, h3.bextm's field width − 1. */
export const W0_AUX_SHIFT = 23;
/** The slot is decoded. */
export const W0_FILLED = 1 << 30;

export class RiscvICache {
  private readonly pages = new Map<number, Int32Array>();
  private readonly refused = new Set<number>();
  private readonly pool: Int32Array[] = [];
  /** Called after every invalidation that drops a page. */
  onChange: (() => void) | null = null;
  /** Page fills since construction (reports, tests). */
  fills = 0;

  get live(): number {
    return this.pages.size;
  }

  /** The page holding `pc`, allocating it when the bus allows, or null (fetch through the bus). */
  lookup(pc: number, bus: RiscvCodeBus): Int32Array | null {
    const index = pc >>> RC_PAGE_SHIFT;
    const page = this.pages.get(index);
    if (page !== undefined) return page;
    if (this.refused.has(index)) return null;
    if (!bus.codePage((index << RC_PAGE_SHIFT) >>> 0)) {
      this.refused.add(index);
      return null;
    }
    const fresh = this.pool.pop();
    let allocated: Int32Array;
    if (fresh === undefined) allocated = new Int32Array((RC_PAGE_SIZE >> 1) * ENTRY);
    else {
      fresh.fill(0);
      allocated = fresh;
    }
    this.pages.set(index, allocated);
    this.fills++;
    return allocated;
  }

  /** Drops the pages overlapping [address, address + size). */
  invalidate(address: number, size = 1): void {
    const first = address >>> RC_PAGE_SHIFT;
    const last = (address + Math.max(size, 1) - 1) >>> RC_PAGE_SHIFT;
    let changed = false;
    for (let index = first; index <= last; index++) {
      this.refused.delete(index);
      const page = this.pages.get(index);
      if (page === undefined) continue;
      this.pages.delete(index);
      this.pool.push(page);
      changed = true;
    }
    if (changed) this.onChange?.();
  }

  /** Drops everything. */
  invalidateAll(): void {
    this.refused.clear();
    if (this.pages.size === 0) return;
    for (const page of this.pages.values()) this.pool.push(page);
    this.pages.clear();
    this.onChange?.();
  }
}
