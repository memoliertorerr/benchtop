/**
 * Special (SR) and user (UR) register numbers for the ESP32's Xtensa LX6, as objdump names them
 * (`rsr.<name>`); numbers per the ISA Reference Manual and the ESP32 core-isa.h. INTERRUPT (226)
 * reads as `interrupt` and writes as `intset`. User registers are Espressif's TIE state:
 * EXPSTATE, THREADPTR, the FPU's FCR/FSR and the f64 accelerator's F64R_LO/F64R_HI/F64S.
 */

export const SR = {
  LBEG: 0, LEND: 1, LCOUNT: 2, SAR: 3, BR: 4, LITBASE: 5, SCOMPARE1: 12, ACCLO: 16, ACCHI: 17,
  M0: 32, M1: 33, M2: 34, M3: 35, WINDOWBASE: 72, WINDOWSTART: 73, MMID: 89, IBREAKENABLE: 96,
  MEMCTL: 97, ATOMCTL: 99, DDR: 104, IBREAKA0: 128, IBREAKA1: 129, DBREAKA0: 144, DBREAKA1: 145,
  DBREAKC0: 160, DBREAKC1: 161, CONFIGID0: 176, EPC1: 177, EPC2: 178, EPC3: 179, EPC4: 180,
  EPC5: 181, EPC6: 182, EPC7: 183, DEPC: 192, EPS2: 194, EPS3: 195, EPS4: 196, EPS5: 197, EPS6: 198,
  EPS7: 199, CONFIGID1: 208, EXCSAVE1: 209, EXCSAVE2: 210, EXCSAVE3: 211, EXCSAVE4: 212,
  EXCSAVE5: 213, EXCSAVE6: 214, EXCSAVE7: 215, CPENABLE: 224, INTERRUPT: 226, INTCLEAR: 227,
  INTENABLE: 228, PS: 230, VECBASE: 231, EXCCAUSE: 232, DEBUGCAUSE: 233, CCOUNT: 234, PRID: 235,
  ICOUNT: 236, ICOUNTLEVEL: 237, EXCVADDR: 238, CCOMPARE0: 240, CCOMPARE1: 241, CCOMPARE2: 242,
  MISC0: 244, MISC1: 245, MISC2: 246, MISC3: 247,
} as const;

export const UR = {
  EXPSTATE: 230, THREADPTR: 231, FCR: 232, FSR: 233, F64R_LO: 234, F64R_HI: 235, F64S: 236,
  // BT124: the ESP32-S3's PIE coprocessor (coprocessor 3, "cop_ai"; its tie.h CP3 save list).
  ACCX_0: 0, ACCX_1: 1, QACC_H_0: 2, QACC_H_1: 3, QACC_H_2: 4, QACC_H_3: 5, QACC_H_4: 6,
  QACC_L_0: 7, QACC_L_1: 8, QACC_L_2: 9, QACC_L_3: 10, QACC_L_4: 11, SAR_BYTE: 13, FFT_BIT_WIDTH: 14,
  UA_STATE_0: 15, UA_STATE_1: 16, UA_STATE_2: 17, UA_STATE_3: 18,
} as const;
/** BT124: the user registers that are the S3's PIE (coprocessor 3) state: CPENABLE bit 3 gates them. */
export const PIE_URS: readonly number[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14, 15, 16, 17, 18];

const names = (table: Readonly<Record<string, number>>): ReadonlyMap<number, string> => {
  const map = new Map<number, string>();
  for (const [name, n] of Object.entries(table)) if (!map.has(n)) map.set(n, name.toLowerCase());
  return map;
};

/** Register number → objdump's name ("ps", "threadptr"). */
export const SR_NAMES = names(SR);
export const UR_NAMES = names(UR);
