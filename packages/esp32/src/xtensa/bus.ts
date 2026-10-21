/**
 * What the Xtensa core needs from the rest of the chip: data reads and writes of 1, 2 and 4
 * bytes (little-endian) and instruction fetch. BT31 puts the ESP32's address map behind it; the
 * bare test machine uses two plain arrays. A bus signals an unmapped or illegal access by
 * throwing XtensaBusError with the exception cause (`exccause`) the core then raises.
 *
 * Unaligned data: the ESP32's core-isa.h configures XCHAL_UNALIGNED_LOAD/STORE_EXCEPTION 0 and
 * XCHAL_UNALIGNED_LOAD/STORE_HW 1, so per the ISA RM's description of those load/store options an
 * unaligned L16/L32/S16/S32 raises no exception and the hardware performs it at the unaligned
 * address: a bus composes the access from the bytes at addr, addr+1, …
 */

export interface XtensaBus {
  read8(addr: number): number;
  read16(addr: number): number;
  read32(addr: number): number;
  write8(addr: number, value: number): void;
  write16(addr: number, value: number): void;
  write32(addr: number, value: number): void;
  /** The (up to) three instruction bytes at `addr`, packed as b0 | b1 << 8 | b2 << 16. */
  fetch(addr: number): number;
  /** WITLB/WDTLB changed a region-protection attribute (8 regions; BT31's bus enforces them). */
  protectionChanged?(itlb: Uint8Array, dtlb: Uint8Array): void;
}

/**
 * Thrown by a bus instead of performing an access the SoC wants to postpone (BT33: a peripheral
 * access while the other core is behind in time). The instruction hasn't happened: the core ends
 * its run with the PC on it and executes it again on the next run. One shared object, so a
 * yield allocates nothing.
 */
export const BUS_YIELD: { readonly yield: true } = Object.freeze({ yield: true });

/** A failed access; the core raises `exccause` (an EXCCAUSE value) with EXCVADDR = address. */
export class XtensaBusError extends Error {
  readonly address: number;
  readonly exccause: number;
  constructor(kind: string, address: number, cause: number) {
    super(`${kind} at 0x${(address >>> 0).toString(16).padStart(8, '0')}`);
    this.name = 'XtensaBusError';
    this.address = address >>> 0;
    this.exccause = cause;
  }
}
