/**
 * Trap causes, interrupt bits and machine-mode status fields (BT64): The RISC-V Instruction Set
 * Manual, Volume II (privileged, 20211203) §3.1.6 mstatus, §3.1.7 mtvec, §3.1.9 mip/mie,
 * §3.1.15 mcause (table 3.6).
 */

/** mcause exception codes (interrupt bit clear). */
export const CAUSE = {
  INSTRUCTION_MISALIGNED: 0,
  INSTRUCTION_ACCESS: 1,
  ILLEGAL_INSTRUCTION: 2,
  BREAKPOINT: 3,
  LOAD_MISALIGNED: 4,
  LOAD_ACCESS: 5,
  STORE_MISALIGNED: 6,
  STORE_ACCESS: 7,
  ECALL_U: 8,
  ECALL_M: 11,
} as const;

/** mcause's interrupt bit; the low bits are the interrupt number (IRQ). */
export const INTERRUPT_BIT = 0x80000000;

/** Machine interrupt numbers (mip/mie bit positions). */
export const IRQ = { MSI: 3, MTI: 7, MEI: 11 } as const;

/** Taken in this order when several are pending and enabled (privileged spec §3.1.9). */
export const IRQ_PRIORITY: readonly number[] = [IRQ.MEI, IRQ.MSI, IRQ.MTI];

/** The mip/mie bits this core implements. */
export const IRQ_MASK = (1 << IRQ.MSI) | (1 << IRQ.MTI) | (1 << IRQ.MEI);

export const MSTATUS = {
  MIE: 1 << 3,
  MPIE: 1 << 7,
  MPP_SHIFT: 11,
  MPP_MASK: 3 << 11,
  MPRV: 1 << 17,
  TW: 1 << 21,
} as const;

/** Privilege modes. */
export const MODE = { U: 0, M: 3 } as const;
