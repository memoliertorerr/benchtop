/**
 * XEA2 exception constants for the ESP32's LX6 (ISA RM exception-cause table; vector offsets
 * from the ESP32 core-isa.h). No PTP MMU here (XCHAL_HAVE_PTP_MMU 0), so there is no ring
 * protection: PS.RING doesn't exist and Privileged (8) is never raised.
 */

export const EXCCAUSE = {
  ILLEGAL_INSTRUCTION: 0,
  SYSCALL: 1,
  INSTRUCTION_FETCH_ERROR: 2,
  LOAD_STORE_ERROR: 3,
  LEVEL1_INTERRUPT: 4,
  ALLOCA: 5,
  INTEGER_DIVIDE_BY_ZERO: 6,
  PRIVILEGED: 8,
  LOAD_STORE_ALIGNMENT: 9,
  INST_FETCH_PROHIBITED: 20,
  LOAD_PROHIBITED: 28,
  STORE_PROHIBITED: 29,
  /** + N for coprocessor N. */
  COPROCESSOR_DISABLED: 32,
} as const;

/** Offsets from VECBASE. */
export const VECTOR = {
  WINDOW_OVERFLOW4: 0x00,
  WINDOW_UNDERFLOW4: 0x40,
  WINDOW_OVERFLOW8: 0x80,
  WINDOW_UNDERFLOW8: 0xc0,
  WINDOW_OVERFLOW12: 0x100,
  WINDOW_UNDERFLOW12: 0x140,
  LEVEL2: 0x180,
  LEVEL3: 0x1c0,
  LEVEL4: 0x200,
  LEVEL5: 0x240,
  DEBUG: 0x280,
  NMI: 0x2c0,
  KERNEL: 0x300,
  USER: 0x340,
  DOUBLE: 0x3c0,
} as const;

/** High-priority interrupt vector offset by level (2–7; 6 is the debug level, 7 the NMI). */
export const LEVEL_VECTOR: readonly number[] = [0, 0, VECTOR.LEVEL2, VECTOR.LEVEL3, VECTOR.LEVEL4, VECTOR.LEVEL5, VECTOR.DEBUG, VECTOR.NMI];

export const RESET_VECTOR = 0x40000400;
export const VECBASE_RESET = 0x40000000;
export const EXCM_LEVEL = 3;
export const DEBUG_LEVEL = 6;
export const NMI_LEVEL = 7;

/** DEBUGCAUSE bits. */
export const DEBUGCAUSE = { ICOUNT: 1, IBREAK: 2, DBREAK: 4, BREAK: 8, BREAKN: 16, DEBUGINT: 32 } as const;

/** PS fields. */
export const PS = {
  INTLEVEL: 0xf,
  EXCM: 0x10,
  UM: 0x20,
  OWB_SHIFT: 8,
  OWB: 0xf00,
  CALLINC_SHIFT: 16,
  CALLINC: 0x30000,
  WOE: 0x40000,
  /** Every writable PS bit (no RING without an MMU). */
  MASK: 0x70f3f,
  /** At reset: INTLEVEL 15, EXCM 1. */
  RESET: 0x1f,
} as const;
