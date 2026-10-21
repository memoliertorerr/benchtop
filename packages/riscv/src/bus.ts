/**
 * What the RISC-V core needs from the rest of the chip (BT64): data reads and writes of 1, 2
 * and 4 bytes (little-endian, naturally aligned — the core raises the misaligned exceptions
 * itself) and 16-bit instruction fetch. A SoC puts its address map behind it; the bare test
 * machine uses one plain array. A bus refuses an access by throwing RiscvBusError (the core
 * raises the matching access fault), or postpones it by throwing RISCV_BUS_YIELD.
 *
 * A bus that also implements RiscvCodeBus lets the core predecode instructions (icache.ts).
 */

export interface RiscvBus {
  read8(addr: number): number;
  read16(addr: number): number;
  read32(addr: number): number;
  write8(addr: number, value: number): void;
  write16(addr: number, value: number): void;
  write32(addr: number, value: number): void;
  /** The instruction halfword at `addr` (even). */
  fetch16(addr: number): number;
}

/**
 * Thrown by a bus instead of performing an access the SoC wants to postpone (a peripheral access
 * while another core is behind in time). The instruction hasn't happened: the core ends its run
 * with the PC on it and executes it again on the next run. One shared object: no allocation.
 */
export const RISCV_BUS_YIELD: { readonly yield: true } = Object.freeze({ yield: true });

/** A refused access at `address`; the core raises the access fault of the access's kind. */
export class RiscvBusError extends Error {
  readonly address: number;
  constructor(kind: string, address: number) {
    super(`${kind} at 0x${(address >>> 0).toString(16).padStart(8, '0')}`);
    this.name = 'RiscvBusError';
    this.address = address >>> 0;
  }
}

/** What the predecode cache needs from a bus. */
export interface RiscvCodeBus {
  /**
   * May the core predecode the 4 KB page at `address` (page-aligned)? Only for plain bytes with
   * no fetch side effects. A bus that accepts a writable page must call the core's
   * `invalidateCode` when that page is written.
   */
  codePage(address: number): boolean;
  /** The halfword at `address` in a page codePage accepted, without side effects. */
  codeHalf(address: number): number;
}

export function isRiscvCodeBus(bus: object): bus is RiscvCodeBus {
  const b = bus as Partial<RiscvCodeBus>;
  return typeof b.codePage === 'function' && typeof b.codeHalf === 'function';
}
