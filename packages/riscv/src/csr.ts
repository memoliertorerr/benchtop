/**
 * Control and status registers (BT64): the standard machine-mode set the core implements
 * itself, and the hook through which a SoC adds its own (Hazard3's Xh3irq meiea/meipa/…,
 * msleep, the ESP32-C3's interrupt matrix CSRs …) and drives interrupt lines. Numbers: the
 * privileged spec's tables 2.2–2.5.
 */

export const CSR = {
  // Unprivileged counters (read-only shadows of mcycle/minstret, gated by mcounteren).
  CYCLE: 0xc00,
  TIME: 0xc01,
  INSTRET: 0xc02,
  CYCLEH: 0xc80,
  TIMEH: 0xc81,
  INSTRETH: 0xc82,
  // Machine information (read-only).
  MVENDORID: 0xf11,
  MARCHID: 0xf12,
  MIMPID: 0xf13,
  MHARTID: 0xf14,
  MCONFIGPTR: 0xf15,
  // Machine trap setup and handling.
  MSTATUS: 0x300,
  MISA: 0x301,
  MEDELEG: 0x302,
  MIDELEG: 0x303,
  MIE: 0x304,
  MTVEC: 0x305,
  MCOUNTEREN: 0x306,
  MSTATUSH: 0x310,
  MSCRATCH: 0x340,
  MEPC: 0x341,
  MCAUSE: 0x342,
  MTVAL: 0x343,
  MIP: 0x344,
  // Memory protection.
  PMPCFG0: 0x3a0,
  PMPADDR0: 0x3b0,
  // Counters.
  MCYCLE: 0xb00,
  MINSTRET: 0xb02,
  MCYCLEH: 0xb80,
  MINSTRETH: 0xb82,
  MCOUNTINHIBIT: 0x320,
  MHPMCOUNTER3: 0xb03,
  MHPMCOUNTER3H: 0xb83,
  MHPMEVENT3: 0x323,
} as const;

/** Read-only: bits 11:10 of the number are 11. */
export function csrReadOnly(csr: number): boolean {
  return csr >>> 10 === 3;
}

/** The lowest privilege that may access the CSR: bits 9:8 of the number. */
export function csrPrivilege(csr: number): number {
  return (csr >>> 8) & 3;
}

/**
 * A SoC's CSRs and interrupt sources. The core consults the hook for every CSR it doesn't
 * implement itself, after its own privilege and read-only checks.
 */
export interface RiscvCsrHook {
  /** The CSR's value, or undefined when there's no such CSR (illegal instruction). */
  readCsr(csr: number): number | undefined;
  /**
   * Writes the CSR; false when there's no such CSR (illegal instruction). Called after
   * readCsr for a read-modify-write instruction, with the merged value.
   */
  writeCsr(csr: number, value: number): boolean;
  /**
   * BT65: a CSR whose value read depends on the same instruction's write operand (Hazard3's
   * indexed arrays — Xh3irq's meiea/meipa/meifa/meipra, meinext.update, meicontext.clearts):
   * the whole instruction in one call, after the core's privilege and read-only checks.
   * `kind` 0 write (csrrw), 1 set (csrrs), 2 clear (csrrc); `writes` is false for a set or clear
   * with x0 / a zero immediate. Returns the value read into rd, or undefined to fall back to
   * readCsr/writeCsr.
   */
  accessCsr?(csr: number, kind: number, operand: number, writes: boolean): number | undefined;
}
