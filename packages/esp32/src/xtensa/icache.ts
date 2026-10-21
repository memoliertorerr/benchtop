/**
 * The predecoded instruction cache (BT37): one per core, over the instruction bus
 * 0x40000000–0x40BFFFFF in 4 KB pages keyed by virtual address (IROM translation differs per
 * core). A page is an Int32Array of ENTRY (2) ints per byte offset, allocated on its first
 * fetch and filled lazily, one instruction at a time, by the core (cpu.ts `pack`): word 0
 * holds the op, length, r, s, t and window quarter (W0_* below) and is 0 until the offset is
 * decoded; word 1 the target address or the immediate. Two words, not the decoder's eight:
 * consecutive instructions' entries share cache lines (measured on tick-heavy code).
 *
 * Whether a page may be cached, and what its fetches cost, is the bus's call (`codePage`):
 * CODE_NONE — every fetch there goes through fetch() (slow pages, pages a region attribute
 * restricts, the cache pools, APP_CPU reads of RTC FAST); CODE_PLAIN — bytes with no fetch side
 * effects (ROM, SRAM0, SRAM1 through its instruction alias, RTC FAST for the PRO_CPU); or the
 * flash offset of the page (≥ 0), whose instructions look up the flash cache as they execute
 * (`codeFetched`). Refused pages are remembered until the next invalidation.
 *
 * Invalidation (the bus and the SoC call these): a store to a physical page the bus marked as
 * holding code drops that virtual page in both cores (`invalidatePage`); an MMU table write
 * drops this core's pages of the 64 KB page the entry maps (`invalidateRange`); a cache-control
 * change or a cache flush drops this core's flash pages, a flash erase or program both cores'
 * pages mapped to the touched range (`invalidateFlash`); a region-protection or boot-remap
 * change and a reboot drop everything (`invalidateAll`). ROM pages never invalidate otherwise.
 * Each invalidation that drops a page calls `onChange` (the core ends its run loop there, so no
 * reference to a dropped page survives). Freed pages are pooled and reused, zeroed.
 */

/** codePage(): fetches there must go through fetch(). */
export const CODE_NONE = -1;
/** codePage(): plain bytes, no fetch side effects. */
export const CODE_PLAIN = -2;

export const IC_BASE = 0x40000000;
export const IC_PAGE_SIZE = 0x1000;
/** 0x40000000–0x40BFFFFF: the instruction bus up to the end of IROM. */
export const IC_PAGES = 0xc00;
/** Ints per byte offset: packed word 0, then the target or the immediate. */
export const ENTRY = 2;

// Word 0 of an entry.
export const W0_OP_MASK = 0x3ff; // op + 1 (0: OP_INVALID)
export const W0_LEN_SHIFT = 10; // 2 bits: 2 or 3
export const W0_R_SHIFT = 12;
export const W0_S_SHIFT = 16;
export const W0_T_SHIFT = 20;
export const W0_Q_SHIFT = 24; // 2 bits: the highest window quarter the instruction touches
/** The instruction runs past the page's end: it always goes through fetch(). */
export const W0_FALLBACK = 1 << 26;

/** What the cache needs from the bus (SocBus and the bare test machine implement it). */
export interface CodeBus {
  codePage(address: number): number;
  /** The byte at instruction-bus `address` of a page codePage accepted, without side effects. */
  codeByte(address: number): number;
  /** The flash cache lookups of an instruction `length` bytes long at flash `offset`. */
  codeFetched(offset: number, length: number): void;
}

/** Does `bus` support the predecode cache? */
export function isCodeBus(bus: object): bus is CodeBus {
  const b = bus as Partial<CodeBus>;
  return typeof b.codePage === 'function' && typeof b.codeByte === 'function' && typeof b.codeFetched === 'function';
}

export class ICache {
  private readonly pages: (Int32Array | null)[] = new Array<Int32Array | null>(IC_PAGES).fill(null);
  private readonly source = new Int32Array(IC_PAGES);
  private readonly refused = new Uint8Array(IC_PAGES);
  private readonly pool: Int32Array[] = [];
  /** The source tag (flash offset, or CODE_PLAIN) of the page `lookup` last returned. */
  lastSource = CODE_PLAIN;
  /** Pages now allocated (reports, tests), and how many of them are flash pages. */
  live = 0;
  private liveFlash = 0;
  /** Pages refused since the last invalidation (a full-table reset is needed only then). */
  private refusals = 0;
  /** Page fills since construction (reports, tests). */
  fills = 0;
  /** Called after any invalidation. */
  onChange: (() => void) | null = null;

  /** The page holding `pc`, allocating it when the bus allows, or null (use fetch()). */
  lookup(pc: number, bus: CodeBus): Int32Array | null {
    const index = (pc - IC_BASE) >>> 12;
    if (index >= IC_PAGES) return null;
    const page = this.pages[index];
    if (page !== null) {
      this.lastSource = this.source[index];
      return page;
    }
    if (this.refused[index] !== 0) return null;
    const source = bus.codePage((pc & ~0xfff) >>> 0);
    if (source === CODE_NONE) {
      this.refused[index] = 1;
      this.refusals++;
      return null;
    }
    const fresh = this.pool.pop();
    let allocated: Int32Array;
    if (fresh === undefined) allocated = new Int32Array(IC_PAGE_SIZE * ENTRY);
    else {
      fresh.fill(0);
      allocated = fresh;
    }
    this.pages[index] = allocated;
    this.source[index] = source;
    this.live++;
    if (source >= 0) this.liveFlash++;
    this.fills++;
    this.lastSource = source;
    return allocated;
  }

  /** Drops the page at virtual address `address` (a store to its code). */
  invalidatePage(address: number): void {
    const index = (address - IC_BASE) >>> 12;
    if (index >= IC_PAGES) return;
    this.refused[index] = 0;
    if (this.drop(index)) this.onChange?.();
  }

  /** Drops the pages of virtual [address, address + size) (an MMU entry changed). */
  invalidateRange(address: number, size: number): void {
    let changed = false;
    for (let a = address; a < address + size; a += IC_PAGE_SIZE) {
      const index = (a - IC_BASE) >>> 12;
      if (index >= IC_PAGES) continue;
      this.refused[index] = 0;
      changed = this.drop(index) || changed;
    }
    if (changed) this.onChange?.();
  }

  /** Drops the flash pages mapped to flash [start, end) — all of them by default. */
  invalidateFlash(start = 0, end = Number.POSITIVE_INFINITY): void {
    if (this.refusals !== 0) this.refused.fill(0, (0x400c0000 - IC_BASE) >>> 12);
    if (this.liveFlash === 0) return;
    let changed = false;
    for (let i = 0; i < IC_PAGES; i++) {
      const s = this.source[i];
      if (this.pages[i] !== null && s >= 0 && s < end && s + IC_PAGE_SIZE > start) changed = this.drop(i) || changed;
    }
    if (changed) this.onChange?.();
  }

  /** Drops everything. */
  invalidateAll(): void {
    if (this.refusals !== 0) {
      this.refused.fill(0);
      this.refusals = 0;
    }
    if (this.live === 0) return;
    for (let i = 0; i < IC_PAGES; i++) this.drop(i);
    this.onChange?.();
  }

  private drop(index: number): boolean {
    const page = this.pages[index];
    if (page === null) return false;
    this.pages[index] = null;
    this.pool.push(page);
    this.live--;
    if (this.source[index] >= 0) this.liveFlash--;
    return true;
  }
}
