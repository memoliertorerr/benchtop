/**
 * The RISC-V decoder (BT64): one instruction into a caller-owned Int32Array descriptor, no
 * allocation. `word` is the 32 bits at the PC (the first halfword in its low half); when its low
 * two bits aren't 11 the instruction is the 16-bit one in the low half. What decodes depends on
 * the profile's extensions; anything else is OP.INVALID (an illegal-instruction trap when it
 * executes). Encodings: The RISC-V Instruction Set Manual, Volume I (unprivileged, 20191213)
 * chapters 2, 7, 8, 9, 16; the bit-manipulation spec 1.0.0; Zc 1.0.4 (Zcb, Zcmp); Hazard3's
 * Xh3bextm (its documentation's custom-0 layout).
 *
 * Where the specs leave room this follows objdump: FENCE needs fm = 0 (or the exact FENCE.TSO
 * word) and rd = rs1 = 0, FENCE.I is the one word 0x0000100f, the system instructions are exact
 * words. RV32C's HINT encodings (c.addi rd,0, c.li zero, c.mv zero, c.slli rd,0 …) decode and
 * execute as the no-ops they are; its custom code points (c.slli with shamt[5] set …) don't.
 */

import { NAME, OP, type RiscvProfile } from './isa.ts';

export const D_OP = 0;
export const D_LEN = 1;
export const D_RD = 2;
export const D_RS1 = 3;
export const D_RS2 = 4;
export const D_IMM = 5;
/** Display spelling (NAME id). */
export const D_NAME = 6;
/**
 * AMO aq/rl (aq << 1 | rl); FENCE fm << 8 | pred << 4 | succ; the CSR number; Zcmp
 * rlist << 4 | spimm; h3.bextm/h3.bextmi's field width (1–8).
 */
export const D_AUX = 7;
export const DESCRIPTOR_SIZE = 8;

const N = NAME;
const O_INVALID = OP.INVALID;

function set(out: Int32Array, op: number, len: number, rd: number, rs1: number, rs2: number, imm: number, name: number, aux: number): void {
  out[D_OP] = op;
  out[D_LEN] = len;
  out[D_RD] = rd;
  out[D_RS1] = rs1;
  out[D_RS2] = rs2;
  out[D_IMM] = imm;
  out[D_NAME] = name;
  out[D_AUX] = aux;
}

function invalid(out: Int32Array, len: number, name: number = N.INVALID): void {
  set(out, O_INVALID, len, 0, 0, 0, 0, name, 0);
}

/**
 * Decodes the instruction whose first halfword is `word`'s low half into `out`. Words with the
 * ≥ 80-bit length prefix (low seven bits all set) are invalid halfwords, as objdump steps them.
 */
export function decode(word: number, profile: RiscvProfile, out: Int32Array): void {
  if ((word & 3) !== 3) decode16(word & 0xffff, profile, out);
  else if ((word & 0x7f) === 0x7f) invalid(out, 2);
  else decode32(word | 0, profile, out);
}

// Tables indexed by funct3 (0 = not an instruction there).
const BRANCH_OP = Int32Array.of(OP.BEQ, OP.BNE, 0, 0, OP.BLT, OP.BGE, OP.BLTU, OP.BGEU);
const BRANCH_NAME = Int32Array.of(N.BEQ, N.BNE, 0, 0, N.BLT, N.BGE, N.BLTU, N.BGEU);
const LOAD_OP = Int32Array.of(OP.LB, OP.LH, OP.LW, 0, OP.LBU, OP.LHU, 0, 0);
const LOAD_NAME = Int32Array.of(N.LB, N.LH, N.LW, 0, N.LBU, N.LHU, 0, 0);
const STORE_OP = Int32Array.of(OP.SB, OP.SH, OP.SW, 0, 0, 0, 0, 0);
const STORE_NAME = Int32Array.of(N.SB, N.SH, N.SW, 0, 0, 0, 0, 0);
const IMM_OP = Int32Array.of(OP.ADDI, 0, OP.SLTI, OP.SLTIU, OP.XORI, 0, OP.ORI, OP.ANDI);
const IMM_NAME = Int32Array.of(N.ADDI, 0, N.SLTI, N.SLTIU, N.XORI, 0, N.ORI, N.ANDI);
const BASE_OP = Int32Array.of(OP.ADD, OP.SLL, OP.SLT, OP.SLTU, OP.XOR, OP.SRL, OP.OR, OP.AND);
const BASE_NAME = Int32Array.of(N.ADD, N.SLL, N.SLT, N.SLTU, N.XOR, N.SRL, N.OR, N.AND);
const MUL_OP = Int32Array.of(OP.MUL, OP.MULH, OP.MULHSU, OP.MULHU, OP.DIV, OP.DIVU, OP.REM, OP.REMU);
const MUL_NAME = Int32Array.of(N.MUL, N.MULH, N.MULHSU, N.MULHU, N.DIV, N.DIVU, N.REM, N.REMU);
const CSR_OP = Int32Array.of(0, OP.CSRRW, OP.CSRRS, OP.CSRRC, 0, OP.CSRRWI, OP.CSRRSI, OP.CSRRCI);
const CSR_NAME = Int32Array.of(0, N.CSRRW, N.CSRRS, N.CSRRC, 0, N.CSRRWI, N.CSRRSI, N.CSRRCI);
/** AMO funct5 (0–31) → op / name; 0 = none. LR.W (funct5 2) is handled apart. */
const AMO_OP = new Int32Array(32);
const AMO_NAME = new Int32Array(32);
for (const [funct5, op, name] of [
  [0x03, OP.SC_W, N.SC_W], [0x01, OP.AMOSWAP_W, N.AMOSWAP_W], [0x00, OP.AMOADD_W, N.AMOADD_W],
  [0x04, OP.AMOXOR_W, N.AMOXOR_W], [0x0c, OP.AMOAND_W, N.AMOAND_W], [0x08, OP.AMOOR_W, N.AMOOR_W],
  [0x10, OP.AMOMIN_W, N.AMOMIN_W], [0x14, OP.AMOMAX_W, N.AMOMAX_W], [0x18, OP.AMOMINU_W, N.AMOMINU_W],
  [0x1c, OP.AMOMAXU_W, N.AMOMAXU_W],
] as const) {
  AMO_OP[funct5] = op;
  AMO_NAME[funct5] = name;
}
const C_ALU_OP = Int32Array.of(OP.SUB, OP.XOR, OP.OR, OP.AND);
const C_ALU_NAME = Int32Array.of(N.C_SUB, N.C_XOR, N.C_OR, N.C_AND);

function decode32(w: number, p: RiscvProfile, out: Int32Array): void {
  const opcode = w & 0x7f;
  const rd = (w >>> 7) & 31;
  const funct3 = (w >>> 12) & 7;
  const rs1 = (w >>> 15) & 31;
  const rs2 = (w >>> 20) & 31;
  const funct7 = w >>> 25;
  const immI = w >> 20;
  switch (opcode) {
    case 0x37:
      return set(out, OP.LUI, 4, rd, 0, 0, w & 0xfffff000, N.LUI, 0);
    case 0x17:
      return set(out, OP.AUIPC, 4, rd, 0, 0, w & 0xfffff000, N.AUIPC, 0);
    case 0x6f: {
      const imm = ((w >> 31) << 20) | (((w >>> 12) & 0xff) << 12) | (((w >>> 20) & 1) << 11) | (((w >>> 21) & 0x3ff) << 1);
      return set(out, OP.JAL, 4, rd, 0, 0, imm, N.JAL, 0);
    }
    case 0x67:
      if (funct3 !== 0) return invalid(out, 4);
      return set(out, OP.JALR, 4, rd, rs1, 0, immI, N.JALR, 0);
    case 0x63: {
      const op = BRANCH_OP[funct3];
      if (op === 0) return invalid(out, 4);
      const imm = ((w >> 31) << 12) | (((w >>> 7) & 1) << 11) | (((w >>> 25) & 0x3f) << 5) | (((w >>> 8) & 0xf) << 1);
      return set(out, op, 4, 0, rs1, rs2, imm, BRANCH_NAME[funct3], 0);
    }
    case 0x03: {
      const op = LOAD_OP[funct3];
      if (op === 0) return invalid(out, 4);
      return set(out, op, 4, rd, rs1, 0, immI, LOAD_NAME[funct3], 0);
    }
    case 0x23: {
      const op = STORE_OP[funct3];
      if (op === 0) return invalid(out, 4);
      return set(out, op, 4, 0, rs1, rs2, ((w >> 25) << 5) | rd, STORE_NAME[funct3], 0);
    }
    case 0x13:
      if (funct3 !== 1 && funct3 !== 5) return set(out, IMM_OP[funct3], 4, rd, rs1, 0, immI, IMM_NAME[funct3], 0);
      return decodeShiftImm(p, out, rd, funct3, rs1, rs2, funct7);
    case 0x33:
      return decodeOp(p, out, rd, funct3, rs1, rs2, funct7);
    case 0x0f:
      if (funct3 === 0 && rd === 0 && rs1 === 0) {
        const fm = w >>> 28;
        const pred = (w >>> 24) & 15;
        const succ = (w >>> 20) & 15;
        if (fm === 0 || (fm === 8 && pred === 3 && succ === 3)) return set(out, OP.FENCE, 4, 0, 0, 0, 0, N.FENCE, (fm << 8) | (pred << 4) | succ);
      }
      if (w === 0x0000100f) return set(out, OP.FENCE_I, 4, 0, 0, 0, 0, N.FENCE_I, 0);
      return invalid(out, 4);
    case 0x73:
      if (funct3 === 0) return decodeSystem(w, out);
      if (funct3 === 4) return invalid(out, 4);
      // The immediate forms carry their 5-bit uimm in the rs1 field (D_IMM; D_RS1 = 0).
      if (funct3 >= 5) return set(out, CSR_OP[funct3], 4, rd, 0, 0, rs1, CSR_NAME[funct3], w >>> 20);
      return set(out, CSR_OP[funct3], 4, rd, rs1, 0, 0, CSR_NAME[funct3], w >>> 20);
    case 0x2f: {
      if (funct3 !== 2) return invalid(out, 4);
      const funct5 = w >>> 27;
      const aqrl = (w >>> 25) & 3;
      if (funct5 === 2) return rs2 === 0 ? set(out, OP.LR_W, 4, rd, rs1, 0, 0, N.LR_W, aqrl) : invalid(out, 4);
      const op = AMO_OP[funct5];
      if (op === 0) return invalid(out, 4);
      return set(out, op, 4, rd, rs1, rs2, 0, AMO_NAME[funct5], aqrl);
    }
    case 0x0b:
      // Xh3bextm: bits 31:29 and 25 zero, bits 28:26 the field width − 1.
      if (!p.xh3bextm || (w & 0xe2000000) !== 0) return invalid(out, 4);
      if (funct3 === 0) return set(out, OP.H3_BEXTM, 4, rd, rs1, rs2, 0, N.H3_BEXTM, ((w >>> 26) & 7) + 1);
      if (funct3 === 4) return set(out, OP.H3_BEXTMI, 4, rd, rs1, 0, rs2, N.H3_BEXTMI, ((w >>> 26) & 7) + 1);
      return invalid(out, 4);
    default:
      return invalid(out, 4);
  }
}

/** OP-IMM funct3 1 and 5: shifts by immediate, Zbs single-bit immediates, Zbb/Zbkb unary ops. */
function decodeShiftImm(p: RiscvProfile, out: Int32Array, rd: number, funct3: number, rs1: number, shamt: number, funct7: number): void {
  if (funct3 === 1) {
    if (funct7 === 0x00) return set(out, OP.SLLI, 4, rd, rs1, 0, shamt, N.SLLI, 0);
    if (p.zbs && funct7 === 0x24) return set(out, OP.BCLRI, 4, rd, rs1, 0, shamt, N.BCLRI, 0);
    if (p.zbs && funct7 === 0x34) return set(out, OP.BINVI, 4, rd, rs1, 0, shamt, N.BINVI, 0);
    if (p.zbs && funct7 === 0x14) return set(out, OP.BSETI, 4, rd, rs1, 0, shamt, N.BSETI, 0);
    if (p.zbb && funct7 === 0x30) {
      if (shamt === 0) return set(out, OP.CLZ, 4, rd, rs1, 0, 0, N.CLZ, 0);
      if (shamt === 1) return set(out, OP.CTZ, 4, rd, rs1, 0, 0, N.CTZ, 0);
      if (shamt === 2) return set(out, OP.CPOP, 4, rd, rs1, 0, 0, N.CPOP, 0);
      if (shamt === 4) return set(out, OP.SEXT_B, 4, rd, rs1, 0, 0, N.SEXT_B, 0);
      if (shamt === 5) return set(out, OP.SEXT_H, 4, rd, rs1, 0, 0, N.SEXT_H, 0);
    }
    if (p.zbkb && funct7 === 0x04 && shamt === 15) return set(out, OP.ZIP, 4, rd, rs1, 0, 0, N.ZIP, 0);
    return invalid(out, 4);
  }
  if (funct7 === 0x00) return set(out, OP.SRLI, 4, rd, rs1, 0, shamt, N.SRLI, 0);
  if (funct7 === 0x20) return set(out, OP.SRAI, 4, rd, rs1, 0, shamt, N.SRAI, 0);
  if ((p.zbb || p.zbkb) && funct7 === 0x30) return set(out, OP.RORI, 4, rd, rs1, 0, shamt, N.RORI, 0);
  if (p.zbs && funct7 === 0x24) return set(out, OP.BEXTI, 4, rd, rs1, 0, shamt, N.BEXTI, 0);
  if (p.zbb && funct7 === 0x14 && shamt === 7) return set(out, OP.ORC_B, 4, rd, rs1, 0, 0, N.ORC_B, 0);
  if ((p.zbb || p.zbkb) && funct7 === 0x34 && shamt === 24) return set(out, OP.REV8, 4, rd, rs1, 0, 0, N.REV8, 0);
  if (p.zbkb && funct7 === 0x34 && shamt === 7) return set(out, OP.BREV8, 4, rd, rs1, 0, 0, N.BREV8, 0);
  if (p.zbkb && funct7 === 0x04 && shamt === 15) return set(out, OP.UNZIP, 4, rd, rs1, 0, 0, N.UNZIP, 0);
  return invalid(out, 4);
}

function decodeOp(p: RiscvProfile, out: Int32Array, rd: number, funct3: number, rs1: number, rs2: number, funct7: number): void {
  let op = 0;
  let name = 0;
  const zbbOrKb = p.zbb || p.zbkb;
  switch (funct7) {
    case 0x00:
      op = BASE_OP[funct3];
      name = BASE_NAME[funct3];
      break;
    case 0x01:
      op = MUL_OP[funct3];
      name = MUL_NAME[funct3];
      break;
    case 0x20:
      if (funct3 === 0) (op = OP.SUB), (name = N.SUB);
      else if (funct3 === 5) (op = OP.SRA), (name = N.SRA);
      else if (zbbOrKb && funct3 === 7) (op = OP.ANDN), (name = N.ANDN);
      else if (zbbOrKb && funct3 === 6) (op = OP.ORN), (name = N.ORN);
      else if (zbbOrKb && funct3 === 4) (op = OP.XNOR), (name = N.XNOR);
      break;
    case 0x10:
      if (p.zba && funct3 === 2) (op = OP.SH1ADD), (name = N.SH1ADD);
      else if (p.zba && funct3 === 4) (op = OP.SH2ADD), (name = N.SH2ADD);
      else if (p.zba && funct3 === 6) (op = OP.SH3ADD), (name = N.SH3ADD);
      break;
    case 0x05:
      if (!p.zbb) break;
      if (funct3 === 4) (op = OP.MIN), (name = N.MIN);
      else if (funct3 === 5) (op = OP.MINU), (name = N.MINU);
      else if (funct3 === 6) (op = OP.MAX), (name = N.MAX);
      else if (funct3 === 7) (op = OP.MAXU), (name = N.MAXU);
      break;
    case 0x04:
      // zext.h is RV32's pack with rs2 = x0 (Zbb); Zbkb adds pack and packh.
      if (p.zbb && funct3 === 4 && rs2 === 0) return set(out, OP.ZEXT_H, 4, rd, rs1, 0, 0, N.ZEXT_H, 0);
      if (p.zbkb && funct3 === 4) (op = OP.PACK), (name = N.PACK);
      else if (p.zbkb && funct3 === 7) (op = OP.PACKH), (name = N.PACKH);
      break;
    case 0x30:
      if (zbbOrKb && funct3 === 1) (op = OP.ROL), (name = N.ROL);
      else if (zbbOrKb && funct3 === 5) (op = OP.ROR), (name = N.ROR);
      break;
    case 0x24:
      if (p.zbs && funct3 === 1) (op = OP.BCLR), (name = N.BCLR);
      else if (p.zbs && funct3 === 5) (op = OP.BEXT), (name = N.BEXT);
      break;
    case 0x34:
      if (p.zbs && funct3 === 1) (op = OP.BINV), (name = N.BINV);
      break;
    case 0x14:
      if (p.zbs && funct3 === 1) (op = OP.BSET), (name = N.BSET);
      break;
  }
  if (op === 0) return invalid(out, 4);
  return set(out, op, 4, rd, rs1, rs2, 0, name, 0);
}

function decodeSystem(w: number, out: Int32Array): void {
  switch (w) {
    case 0x00000073:
      return set(out, OP.ECALL, 4, 0, 0, 0, 0, N.ECALL, 0);
    case 0x00100073:
      return set(out, OP.EBREAK, 4, 0, 0, 0, 0, N.EBREAK, 0);
    case 0x30200073:
      return set(out, OP.MRET, 4, 0, 0, 0, 0, N.MRET, 0);
    case 0x10200073:
      return set(out, OP.SRET, 4, 0, 0, 0, 0, N.SRET, 0);
    case 0x10500073:
      return set(out, OP.WFI, 4, 0, 0, 0, 0, N.WFI, 0);
    case 0x7b200073:
      return set(out, OP.DRET, 4, 0, 0, 0, 0, N.DRET, 0);
    default:
      return invalid(out, 4);
  }
}

/** The x8–x15 register a 3-bit compressed register field names. */
function cr(bits: number): number {
  return 8 + (bits & 7);
}

/** Zcmp's s-register numbers for its 3-bit r1s'/r2s' fields (s0–s7). */
const SREG = Int32Array.of(8, 9, 18, 19, 20, 21, 22, 23);

function decode16(h: number, p: RiscvProfile, out: Int32Array): void {
  const quadrant = h & 3;
  const funct3 = h >>> 13;
  const rdFull = (h >>> 7) & 31;
  const rs2Full = (h >>> 2) & 31;
  const b12 = (h >>> 12) & 1;
  if (quadrant === 0) {
    if (h === 0) return invalid(out, 2, N.C_UNIMP);
    const rdp = cr(h >>> 2);
    const rs1p = cr(h >>> 7);
    switch (funct3) {
      case 0: {
        const imm = (((h >>> 7) & 0xf) << 6) | (((h >>> 11) & 3) << 4) | (((h >>> 5) & 1) << 3) | (((h >>> 6) & 1) << 2);
        if (imm === 0) return invalid(out, 2);
        return set(out, OP.ADDI, 2, rdp, 2, 0, imm, N.C_ADDI4SPN, 0);
      }
      case 2:
        return set(out, OP.LW, 2, rdp, rs1p, 0, (((h >>> 10) & 7) << 3) | (((h >>> 6) & 1) << 2) | (((h >>> 5) & 1) << 6), N.C_LW, 0);
      case 6:
        return set(out, OP.SW, 2, 0, rs1p, rdp, (((h >>> 10) & 7) << 3) | (((h >>> 6) & 1) << 2) | (((h >>> 5) & 1) << 6), N.C_SW, 0);
      case 4: {
        // Zcb's byte and halfword loads and stores.
        if (!p.zcb) return invalid(out, 2);
        const sub = (h >>> 10) & 7;
        const b6 = (h >>> 6) & 1;
        const uimmB = b6 | (((h >>> 5) & 1) << 1);
        const uimmH = ((h >>> 5) & 1) << 1;
        if (sub === 0) return set(out, OP.LBU, 2, rdp, rs1p, 0, uimmB, N.C_LBU, 0);
        if (sub === 1) return b6 === 0 ? set(out, OP.LHU, 2, rdp, rs1p, 0, uimmH, N.C_LHU, 0) : set(out, OP.LH, 2, rdp, rs1p, 0, uimmH, N.C_LH, 0);
        if (sub === 2) return set(out, OP.SB, 2, 0, rs1p, rdp, uimmB, N.C_SB, 0);
        if (sub === 3 && b6 === 0) return set(out, OP.SH, 2, 0, rs1p, rdp, uimmH, N.C_SH, 0);
        return invalid(out, 2);
      }
      default:
        return invalid(out, 2); // c.fld/c.flw/c.fsd/c.fsw: no F or D here
    }
  }
  if (quadrant === 1) {
    const imm6 = (((b12 << 5) | rs2Full) << 26) >> 26;
    switch (funct3) {
      case 0:
        return set(out, OP.ADDI, 2, rdFull, rdFull, 0, imm6, N.C_ADDI, 0);
      case 1:
        return set(out, OP.JAL, 2, 1, 0, 0, cjImm(h), N.C_JAL, 0);
      case 2:
        return set(out, OP.ADDI, 2, rdFull, 0, 0, imm6, N.C_LI, 0);
      case 3: {
        if (rdFull === 2) {
          const imm = ((b12 << 9) | (((h >>> 3) & 3) << 7) | (((h >>> 5) & 1) << 6) | (((h >>> 2) & 1) << 5) | (((h >>> 6) & 1) << 4)) << 22 >> 22;
          if (imm === 0) return invalid(out, 2);
          return set(out, OP.ADDI, 2, 2, 2, 0, imm, N.C_ADDI16SP, 0);
        }
        if (imm6 === 0) return invalid(out, 2);
        return set(out, OP.LUI, 2, rdFull, 0, 0, imm6 << 12, N.C_LUI, 0);
      }
      case 4:
        return decodeCAlu(h, p, out, b12);
      case 5:
        return set(out, OP.JAL, 2, 0, 0, 0, cjImm(h), N.C_J, 0);
      default: {
        const imm = ((b12 << 8) | (((h >>> 5) & 3) << 6) | (((h >>> 2) & 1) << 5) | (((h >>> 10) & 3) << 3) | (((h >>> 3) & 3) << 1)) << 23 >> 23;
        if (funct3 === 6) return set(out, OP.BEQ, 2, 0, cr(h >>> 7), 0, imm, N.C_BEQZ, 0);
        return set(out, OP.BNE, 2, 0, cr(h >>> 7), 0, imm, N.C_BNEZ, 0);
      }
    }
  }
  if (quadrant === 2) {
    switch (funct3) {
      case 0:
        if (b12 !== 0) return invalid(out, 2); // shamt[5]: custom on RV32
        if (rs2Full === 0) return set(out, OP.SLLI, 2, rdFull, rdFull, 0, 0, N.C_SLLI64, 0);
        return set(out, OP.SLLI, 2, rdFull, rdFull, 0, rs2Full, N.C_SLLI, 0);
      case 2:
        if (rdFull === 0) return invalid(out, 2);
        return set(out, OP.LW, 2, rdFull, 2, 0, (b12 << 5) | (((h >>> 4) & 7) << 2) | (((h >>> 2) & 3) << 6), N.C_LWSP, 0);
      case 4:
        if (b12 === 0) {
          if (rs2Full !== 0) return set(out, OP.ADD, 2, rdFull, 0, rs2Full, 0, N.C_MV, 0);
          return rdFull === 0 ? invalid(out, 2) : set(out, OP.JALR, 2, 0, rdFull, 0, 0, N.C_JR, 0);
        }
        if (rs2Full !== 0) return set(out, OP.ADD, 2, rdFull, rdFull, rs2Full, 0, N.C_ADD, 0);
        return rdFull === 0 ? set(out, OP.EBREAK, 2, 0, 0, 0, 0, N.C_EBREAK, 0) : set(out, OP.JALR, 2, 1, rdFull, 0, 0, N.C_JALR, 0);
      case 5:
        return decodeZcmp(h, p, out);
      case 6:
        return set(out, OP.SW, 2, 0, 2, rs2Full, (((h >>> 9) & 15) << 2) | (((h >>> 7) & 3) << 6), N.C_SWSP, 0);
      default:
        return invalid(out, 2); // c.flwsp, c.fldsp, c.fswsp
    }
  }
  return invalid(out, 2);
}

/** Quadrant 1, funct3 100: c.srli, c.srai, c.andi, the register ALU ops and Zcb's c.mul and unary ops. */
function decodeCAlu(h: number, p: RiscvProfile, out: Int32Array, b12: number): void {
  const rdp = cr(h >>> 7);
  const sub = (h >>> 10) & 3;
  const low5 = (h >>> 2) & 31;
  if (sub === 0 || sub === 1) {
    if (b12 !== 0) return invalid(out, 2); // shamt[5]: custom on RV32
    const op = sub === 0 ? OP.SRLI : OP.SRAI;
    if (low5 === 0) return set(out, op, 2, rdp, rdp, 0, 0, sub === 0 ? N.C_SRLI64 : N.C_SRAI64, 0);
    return set(out, op, 2, rdp, rdp, 0, low5, sub === 0 ? N.C_SRLI : N.C_SRAI, 0);
  }
  if (sub === 2) return set(out, OP.ANDI, 2, rdp, rdp, 0, (((b12 << 5) | low5) << 26) >> 26, N.C_ANDI, 0);
  const rs2p = cr(h >>> 2);
  const f2 = (h >>> 5) & 3;
  if (b12 === 0) return set(out, C_ALU_OP[f2], 2, rdp, rdp, rs2p, 0, C_ALU_NAME[f2], 0);
  if (!p.zcb) return invalid(out, 2);
  if (f2 === 2) return set(out, OP.MUL, 2, rdp, rdp, rs2p, 0, N.C_MUL, 0);
  if (f2 !== 3) return invalid(out, 2);
  switch (h & 0x1c) {
    case 0x00:
      return set(out, OP.ANDI, 2, rdp, rdp, 0, 0xff, N.C_ZEXT_B, 0);
    case 0x04:
      return p.zbb ? set(out, OP.SEXT_B, 2, rdp, rdp, 0, 0, N.C_SEXT_B, 0) : invalid(out, 2);
    case 0x08:
      return p.zbb ? set(out, OP.ZEXT_H, 2, rdp, rdp, 0, 0, N.C_ZEXT_H, 0) : invalid(out, 2);
    case 0x0c:
      return p.zbb ? set(out, OP.SEXT_H, 2, rdp, rdp, 0, 0, N.C_SEXT_H, 0) : invalid(out, 2);
    case 0x14:
      return set(out, OP.NOT, 2, rdp, rdp, 0, 0, N.C_NOT, 0);
    default:
      return invalid(out, 2);
  }
}

/** CJ-format offset (c.j, c.jal). */
function cjImm(h: number): number {
  const imm =
    (((h >>> 12) & 1) << 11) | (((h >>> 8) & 1) << 10) | (((h >>> 9) & 3) << 8) | (((h >>> 6) & 1) << 7) |
    (((h >>> 7) & 1) << 6) | (((h >>> 2) & 1) << 5) | (((h >>> 11) & 1) << 4) | (((h >>> 3) & 7) << 1);
  return (imm << 20) >> 20;
}

/** Quadrant 2, funct3 101 (RV32DC's c.fsdsp): Zcmp's push/pop and register moves. */
function decodeZcmp(h: number, p: RiscvProfile, out: Int32Array): void {
  if (!p.zcmp) return invalid(out, 2);
  const sel = (h >>> 8) & 31;
  const rlist = (h >>> 4) & 15;
  const spimm = (h >>> 2) & 3;
  let op = 0;
  let name = 0;
  if (sel === 0x18) (op = OP.CM_PUSH), (name = N.CM_PUSH);
  else if (sel === 0x1a) (op = OP.CM_POP), (name = N.CM_POP);
  else if (sel === 0x1c) (op = OP.CM_POPRETZ), (name = N.CM_POPRETZ);
  else if (sel === 0x1e) (op = OP.CM_POPRET), (name = N.CM_POPRET);
  if (op !== 0) {
    if (rlist < 4) return invalid(out, 2);
    return set(out, op, 2, 0, 0, 0, stackAdj(rlist, spimm), name, (rlist << 4) | spimm);
  }
  if (((h >>> 10) & 7) === 3) {
    const r1 = SREG[(h >>> 7) & 7];
    const r2 = SREG[(h >>> 2) & 7];
    const f2 = (h >>> 5) & 3;
    if (f2 === 1 && r1 !== r2) return set(out, OP.CM_MVSA01, 2, 0, r1, r2, 0, N.CM_MVSA01, 0);
    if (f2 === 3) return set(out, OP.CM_MVA01S, 2, 0, r1, r2, 0, N.CM_MVA01S, 0);
  }
  return invalid(out, 2);
}

/** Zcmp's stack adjustment on RV32: the register list's 16-byte-aligned size plus spimm × 16. */
export function stackAdj(rlist: number, spimm: number): number {
  const base = rlist === 15 ? 64 : rlist >= 12 ? 48 : rlist >= 8 ? 32 : 16;
  return base + spimm * 16;
}

/** How many registers a Zcmp rlist (4–15) saves: ra plus s0…, s10 never without s11 (15 = ra, s0–s11). */
export function rlistCount(rlist: number): number {
  return rlist === 15 ? 13 : rlist - 3;
}

/** The i-th register (0 = ra, then s0, s1, s2 …) of a Zcmp list. */
export const RLIST_REGS = Int32Array.of(1, 8, 9, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27);
