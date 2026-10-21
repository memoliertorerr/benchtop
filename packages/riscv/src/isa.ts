/**
 * The RISC-V instructions this core knows (BT64): RV32I, M, A, C, Zicsr, Zifencei, the
 * privileged ones (mret, wfi; sret and dret decode but trap), the bit-manipulation extensions
 * Zba, Zbb, Zbs and Zbkb, the code-size extensions Zcb and Zcmp, and Hazard3's Xh3bextm. Which
 * of them a core accepts is its `RiscvProfile`.
 *
 * Two numberings: OP is what executes (a compressed instruction executes as its base op —
 * c.addi as ADDI), NAME is what the disassembler prints in objdump's `-M no-aliases` form (the
 * compressed spelling, the AMO's .aq/.rl suffixes come from the descriptor's aux bits).
 * Plain objects of numbers (erasable syntax, no enums); hot code copies them into module
 * constants (vitest turns imported-name access into getters).
 */

export const OP = {
  INVALID: 0,
  LUI: 1, AUIPC: 2, JAL: 3, JALR: 4,
  BEQ: 5, BNE: 6, BLT: 7, BGE: 8, BLTU: 9, BGEU: 10,
  LB: 11, LH: 12, LW: 13, LBU: 14, LHU: 15, SB: 16, SH: 17, SW: 18,
  ADDI: 19, SLTI: 20, SLTIU: 21, XORI: 22, ORI: 23, ANDI: 24, SLLI: 25, SRLI: 26, SRAI: 27,
  ADD: 28, SUB: 29, SLL: 30, SLT: 31, SLTU: 32, XOR: 33, SRL: 34, SRA: 35, OR: 36, AND: 37,
  FENCE: 38, FENCE_I: 39, ECALL: 40, EBREAK: 41, MRET: 42, SRET: 43, WFI: 44, DRET: 45,
  CSRRW: 46, CSRRS: 47, CSRRC: 48, CSRRWI: 49, CSRRSI: 50, CSRRCI: 51,
  MUL: 52, MULH: 53, MULHSU: 54, MULHU: 55, DIV: 56, DIVU: 57, REM: 58, REMU: 59,
  LR_W: 60, SC_W: 61, AMOSWAP_W: 62, AMOADD_W: 63, AMOXOR_W: 64, AMOAND_W: 65, AMOOR_W: 66,
  AMOMIN_W: 67, AMOMAX_W: 68, AMOMINU_W: 69, AMOMAXU_W: 70,
  SH1ADD: 71, SH2ADD: 72, SH3ADD: 73,
  ANDN: 74, ORN: 75, XNOR: 76, CLZ: 77, CTZ: 78, CPOP: 79, MAX: 80, MAXU: 81, MIN: 82, MINU: 83,
  SEXT_B: 84, SEXT_H: 85, ZEXT_H: 86, ROL: 87, ROR: 88, RORI: 89, ORC_B: 90, REV8: 91,
  BCLR: 92, BCLRI: 93, BEXT: 94, BEXTI: 95, BINV: 96, BINVI: 97, BSET: 98, BSETI: 99,
  PACK: 100, PACKH: 101, BREV8: 102, ZIP: 103, UNZIP: 104,
  H3_BEXTM: 105, H3_BEXTMI: 106,
  CM_PUSH: 107, CM_POP: 108, CM_POPRET: 109, CM_POPRETZ: 110, CM_MVSA01: 111, CM_MVA01S: 112,
  /** Zcb's c.not: rd = ~rd (no base op spells it). */
  NOT: 113,
} as const;

export type Op = (typeof OP)[keyof typeof OP];
export const OP_COUNT = 114;

/** Operand layouts the disassembler prints. */
export const FMT = {
  NONE: 0,
  /** rd,imm20 (lui/auipc: 0x-hex of the 20-bit field) */
  U: 1,
  /** rd,target */
  J: 2,
  /** rd,imm(rs1) — loads, jalr */
  RD_MEM: 3,
  /** rs1,rs2,target */
  B: 4,
  /** rs2,imm(rs1) */
  RS2_MEM: 5,
  /** rd,rs1,imm (decimal) */
  I: 6,
  /** rd,rs1,shamt (0x-hex) */
  SHIFT: 7,
  /** rd,rs1,rs2 */
  R: 8,
  /** rd,rs1 */
  UNARY: 9,
  /** rd,csr,rs1 */
  CSR: 10,
  /** rd,csr,uimm */
  CSRI: 11,
  /** pred,succ */
  FENCE: 12,
  /** rd,rs2,(rs1) */
  AMO: 13,
  /** rd,(rs1) */
  LR: 14,
  /** rd,rs1,rs2,size (h3.bextm) */
  BEXTM: 15,
  /** rd,rs1,shamt,size (h3.bextmi) */
  BEXTMI: 16,
  /** {rlist},spimm (cm.push/pop) */
  CMPP: 17,
  /** r1s,r2s (cm.mvsa01/mva01s) */
  CMMV: 18,
  // Compressed spellings (no-aliases form).
  /** rd,rs2 (c.mv, c.add, c.sub …) */
  C_RR: 19,
  /** rd,imm decimal (c.addi, c.li, c.andi) */
  C_RI: 20,
  /** rd,0x-hex (c.lui, c.slli, c.srli, c.srai) */
  C_RHEX: 21,
  /** rs1 (c.jr, c.jalr) and rd (c.zext.b …) */
  C_R: 22,
  /** target (c.j, c.jal) */
  C_J: 23,
  /** rs1,target (c.beqz, c.bnez) */
  C_B: 24,
  /** rd,sp,imm (c.addi4spn) */
  C_ADDI4SPN: 25,
  /** sp,imm (c.addi16sp) */
  C_ADDI16SP: 26,
} as const;

interface NameInfo {
  name: string;
  fmt: number;
}

/** Display spellings, indexed by NAME id. */
export const NAMES: readonly NameInfo[] = [];
export const NAME: Record<string, number> = {};

function name(id: string, text: string, fmt: number): void {
  NAME[id] = NAMES.length;
  (NAMES as NameInfo[]).push({ name: text, fmt });
}

name('INVALID', '', FMT.NONE);
// 32-bit, one spelling per OP.
for (const [id, text, fmt] of [
  ['LUI', 'lui', FMT.U], ['AUIPC', 'auipc', FMT.U], ['JAL', 'jal', FMT.J], ['JALR', 'jalr', FMT.RD_MEM],
  ['BEQ', 'beq', FMT.B], ['BNE', 'bne', FMT.B], ['BLT', 'blt', FMT.B], ['BGE', 'bge', FMT.B], ['BLTU', 'bltu', FMT.B], ['BGEU', 'bgeu', FMT.B],
  ['LB', 'lb', FMT.RD_MEM], ['LH', 'lh', FMT.RD_MEM], ['LW', 'lw', FMT.RD_MEM], ['LBU', 'lbu', FMT.RD_MEM], ['LHU', 'lhu', FMT.RD_MEM],
  ['SB', 'sb', FMT.RS2_MEM], ['SH', 'sh', FMT.RS2_MEM], ['SW', 'sw', FMT.RS2_MEM],
  ['ADDI', 'addi', FMT.I], ['SLTI', 'slti', FMT.I], ['SLTIU', 'sltiu', FMT.I], ['XORI', 'xori', FMT.I], ['ORI', 'ori', FMT.I], ['ANDI', 'andi', FMT.I],
  ['SLLI', 'slli', FMT.SHIFT], ['SRLI', 'srli', FMT.SHIFT], ['SRAI', 'srai', FMT.SHIFT],
  ['ADD', 'add', FMT.R], ['SUB', 'sub', FMT.R], ['SLL', 'sll', FMT.R], ['SLT', 'slt', FMT.R], ['SLTU', 'sltu', FMT.R], ['XOR', 'xor', FMT.R],
  ['SRL', 'srl', FMT.R], ['SRA', 'sra', FMT.R], ['OR', 'or', FMT.R], ['AND', 'and', FMT.R],
  ['FENCE', 'fence', FMT.FENCE], ['FENCE_I', 'fence.i', FMT.NONE], ['ECALL', 'ecall', FMT.NONE], ['EBREAK', 'ebreak', FMT.NONE],
  ['MRET', 'mret', FMT.NONE], ['SRET', 'sret', FMT.NONE], ['WFI', 'wfi', FMT.NONE], ['DRET', 'dret', FMT.NONE],
  ['CSRRW', 'csrrw', FMT.CSR], ['CSRRS', 'csrrs', FMT.CSR], ['CSRRC', 'csrrc', FMT.CSR],
  ['CSRRWI', 'csrrwi', FMT.CSRI], ['CSRRSI', 'csrrsi', FMT.CSRI], ['CSRRCI', 'csrrci', FMT.CSRI],
  ['MUL', 'mul', FMT.R], ['MULH', 'mulh', FMT.R], ['MULHSU', 'mulhsu', FMT.R], ['MULHU', 'mulhu', FMT.R],
  ['DIV', 'div', FMT.R], ['DIVU', 'divu', FMT.R], ['REM', 'rem', FMT.R], ['REMU', 'remu', FMT.R],
  ['LR_W', 'lr.w', FMT.LR], ['SC_W', 'sc.w', FMT.AMO], ['AMOSWAP_W', 'amoswap.w', FMT.AMO], ['AMOADD_W', 'amoadd.w', FMT.AMO],
  ['AMOXOR_W', 'amoxor.w', FMT.AMO], ['AMOAND_W', 'amoand.w', FMT.AMO], ['AMOOR_W', 'amoor.w', FMT.AMO], ['AMOMIN_W', 'amomin.w', FMT.AMO],
  ['AMOMAX_W', 'amomax.w', FMT.AMO], ['AMOMINU_W', 'amominu.w', FMT.AMO], ['AMOMAXU_W', 'amomaxu.w', FMT.AMO],
  ['SH1ADD', 'sh1add', FMT.R], ['SH2ADD', 'sh2add', FMT.R], ['SH3ADD', 'sh3add', FMT.R],
  ['ANDN', 'andn', FMT.R], ['ORN', 'orn', FMT.R], ['XNOR', 'xnor', FMT.R], ['CLZ', 'clz', FMT.UNARY], ['CTZ', 'ctz', FMT.UNARY], ['CPOP', 'cpop', FMT.UNARY],
  ['MAX', 'max', FMT.R], ['MAXU', 'maxu', FMT.R], ['MIN', 'min', FMT.R], ['MINU', 'minu', FMT.R],
  ['SEXT_B', 'sext.b', FMT.UNARY], ['SEXT_H', 'sext.h', FMT.UNARY], ['ZEXT_H', 'zext.h', FMT.UNARY],
  ['ROL', 'rol', FMT.R], ['ROR', 'ror', FMT.R], ['RORI', 'rori', FMT.SHIFT], ['ORC_B', 'orc.b', FMT.UNARY], ['REV8', 'rev8', FMT.UNARY],
  ['BCLR', 'bclr', FMT.R], ['BCLRI', 'bclri', FMT.SHIFT], ['BEXT', 'bext', FMT.R], ['BEXTI', 'bexti', FMT.SHIFT],
  ['BINV', 'binv', FMT.R], ['BINVI', 'binvi', FMT.SHIFT], ['BSET', 'bset', FMT.R], ['BSETI', 'bseti', FMT.SHIFT],
  ['PACK', 'pack', FMT.R], ['PACKH', 'packh', FMT.R], ['BREV8', 'brev8', FMT.UNARY], ['ZIP', 'zip', FMT.UNARY], ['UNZIP', 'unzip', FMT.UNARY],
  ['H3_BEXTM', 'h3.bextm', FMT.BEXTM], ['H3_BEXTMI', 'h3.bextmi', FMT.BEXTMI],
  ['CM_PUSH', 'cm.push', FMT.CMPP], ['CM_POP', 'cm.pop', FMT.CMPP], ['CM_POPRET', 'cm.popret', FMT.CMPP], ['CM_POPRETZ', 'cm.popretz', FMT.CMPP],
  ['CM_MVSA01', 'cm.mvsa01', FMT.CMMV], ['CM_MVA01S', 'cm.mva01s', FMT.CMMV],
] as const) name(id, text, fmt);

// Compressed spellings.
for (const [id, text, fmt] of [
  ['C_ADDI4SPN', 'c.addi4spn', FMT.C_ADDI4SPN], ['C_LW', 'c.lw', FMT.RD_MEM], ['C_SW', 'c.sw', FMT.RS2_MEM],
  ['C_UNIMP', 'c.unimp', FMT.NONE], ['C_ADDI', 'c.addi', FMT.C_RI], ['C_JAL', 'c.jal', FMT.C_J], ['C_LI', 'c.li', FMT.C_RI],
  ['C_ADDI16SP', 'c.addi16sp', FMT.C_ADDI16SP], ['C_LUI', 'c.lui', FMT.C_RHEX],
  ['C_SRLI', 'c.srli', FMT.C_RHEX], ['C_SRAI', 'c.srai', FMT.C_RHEX], ['C_ANDI', 'c.andi', FMT.C_RI],
  ['C_SUB', 'c.sub', FMT.C_RR], ['C_XOR', 'c.xor', FMT.C_RR], ['C_OR', 'c.or', FMT.C_RR], ['C_AND', 'c.and', FMT.C_RR],
  ['C_J', 'c.j', FMT.C_J], ['C_BEQZ', 'c.beqz', FMT.C_B], ['C_BNEZ', 'c.bnez', FMT.C_B],
  ['C_SLLI', 'c.slli', FMT.C_RHEX], ['C_SLLI64', 'c.slli64', FMT.C_R], ['C_SRLI64', 'c.srli64', FMT.C_R], ['C_SRAI64', 'c.srai64', FMT.C_R], ['C_LWSP', 'c.lwsp', FMT.RD_MEM], ['C_JR', 'c.jr', FMT.C_R], ['C_MV', 'c.mv', FMT.C_RR],
  ['C_EBREAK', 'c.ebreak', FMT.NONE], ['C_JALR', 'c.jalr', FMT.C_R], ['C_ADD', 'c.add', FMT.C_RR], ['C_SWSP', 'c.swsp', FMT.RS2_MEM],
  // Zcb
  ['C_LBU', 'c.lbu', FMT.RD_MEM], ['C_LHU', 'c.lhu', FMT.RD_MEM], ['C_LH', 'c.lh', FMT.RD_MEM], ['C_SB', 'c.sb', FMT.RS2_MEM], ['C_SH', 'c.sh', FMT.RS2_MEM],
  ['C_ZEXT_B', 'c.zext.b', FMT.C_R], ['C_SEXT_B', 'c.sext.b', FMT.C_R], ['C_ZEXT_H', 'c.zext.h', FMT.C_R], ['C_SEXT_H', 'c.sext.h', FMT.C_R],
  ['C_NOT', 'c.not', FMT.C_R], ['C_MUL', 'c.mul', FMT.C_RR],
] as const) name(id, text, fmt);

/** The extensions a core accepts. */
export interface RiscvProfile {
  /** M, A and C are always on; these are the optional ones. */
  zba: boolean;
  zbb: boolean;
  zbs: boolean;
  zbkb: boolean;
  zcb: boolean;
  zcmp: boolean;
  /** Hazard3's multi-bit extract (custom-0). */
  xh3bextm: boolean;
  /** Hazard3's power hints (BT65): h3.block (slt x0, x0, x0) and h3.unblock (slt x0, x0, x1). */
  xh3power?: boolean;
  /** User mode (else M only). */
  umode: boolean;
}

export const RV32IMAC: Readonly<RiscvProfile> = { zba: false, zbb: false, zbs: false, zbkb: false, zcb: false, zcmp: false, xh3bextm: false, umode: false };

/** Hazard3 as configured in the RP2350 (datasheet: RV32IMAC + Zicsr, Zifencei, Zba, Zbb, Zbs, Zbkb, Zcb, Zcmp, Xh3bextm, Xh3power; M and U modes). */
export const HAZARD3: Readonly<RiscvProfile> = { zba: true, zbb: true, zbs: true, zbkb: true, zcb: true, zcmp: true, xh3bextm: true, xh3power: true, umode: true };

/** ABI register names (objdump's). */
export const REG_NAMES: readonly string[] = [
  'zero', 'ra', 'sp', 'gp', 'tp', 't0', 't1', 't2', 's0', 's1', 'a0', 'a1', 'a2', 'a3', 'a4', 'a5',
  'a6', 'a7', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10', 's11', 't3', 't4', 't5', 't6',
];
