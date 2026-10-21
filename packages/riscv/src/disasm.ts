/**
 * The RISC-V disassembler (BT64): what objdump prints, in its `-M no-aliases` form (`aliases:
 * false`) or its default form (pseudo-instructions: li, mv, ret, csrr, zext.b, the compressed
 * instructions under their base names …). Comments and `<symbol>` suffixes aren't part of it.
 * Checked against GNU objdump 2.43 — the arduino-pico core's RISC-V toolchain — for the
 * Hazard3 ISA (fixtures/riscv/corpus, disasm.test.ts); Xh3bextm and cm.mvsa01/cm.mva01s, which
 * that objdump doesn't know, follow the specs' tables and binutils' conventions. Not a hot
 * path: allocates freely.
 *
 * Deliberate differences, where objdump decodes what this RV32 core rejects: RV64's shift
 * amounts ≥ 32, Zcmp's reserved register lists (0–3), c.addi16sp with 0, sfence.vma (no
 * supervisor mode) — those print as undecodable words here (`.insn 2, 0x…`).
 */

import { D_AUX, D_IMM, D_LEN, D_NAME, D_RD, D_RS1, D_RS2, DESCRIPTOR_SIZE, decode } from './decode.ts';
import { FMT, NAME, NAMES, REG_NAMES, type RiscvProfile } from './isa.ts';

export interface Disassembly {
  mnemonic: string;
  operands: string;
  /** 2 or 4. */
  length: number;
}

/** The CSR names objdump 2.43 prints (every extension's, whatever the ELF's ISA; others print as 0x-hex). */
const CSR_NAMES = new Map<number, string>();
function csrNames(first: number, names: string): void {
  names.split(' ').forEach((name, i) => {
    if (name !== '-') CSR_NAMES.set(first + i, name);
  });
}
function csrRange(first: number, from: number, to: number, prefix: string, suffix = ''): void {
  for (let n = from; n <= to; n++) CSR_NAMES.set(first + n - from, `${prefix}${n}${suffix}`);
}
csrNames(0x001, 'fflags frm fcsr');
csrNames(0x008, 'vstart vxsat vxrm');
csrNames(0x00f, 'vcsr');
csrNames(0x015, 'seed');
csrNames(0x100, 'sstatus');
csrNames(0x104, 'sie stvec scounteren');
csrNames(0x10a, 'senvcfg - sstateen0 sstateen1 sstateen2 sstateen3');
csrNames(0x114, 'sieh');
csrNames(0x140, 'sscratch sepc scause stval sip');
csrNames(0x14d, 'stimecmp - - siselect sireg sireg2 sireg3 siph sireg4');
csrNames(0x156, 'sireg5 sireg6');
csrNames(0x15c, 'stopei stimecmph');
csrNames(0x180, 'satp');
csrNames(0x200, 'vsstatus');
csrNames(0x204, 'vsie vstvec');
csrNames(0x214, 'vsieh');
csrNames(0x240, 'vsscratch vsepc vscause vstval vsip');
csrNames(0x24d, 'vstimecmp - - vsiselect vsireg vsireg2 vsireg3 vsiph vsireg4');
csrNames(0x256, 'vsireg5 vsireg6');
csrNames(0x25c, 'vstopei vstimecmph');
csrNames(0x280, 'vsatp');
csrNames(0x300, 'mstatus misa medeleg mideleg mie mtvec mcounteren - mvien');
csrNames(0x309, 'mvip menvcfg - mstateen0 mstateen1 mstateen2 mstateen3 mstatush - - midelegh');
csrNames(0x314, 'mieh');
csrNames(0x318, 'mvienh mviph menvcfgh - mstateen0h mstateen1h mstateen2h mstateen3h mcountinhibit');
csrNames(0x321, 'mcyclecfg minstretcfg mhpmevent3 mhpmevent4 mhpmevent5 mhpmevent6 mhpmevent7 mhpmevent8 mhpmevent9');
csrRange(0x32a, 10, 31, 'mhpmevent');
csrNames(0x340, 'mscratch mepc mcause mtval mip');
csrNames(0x34a, 'mtinst mtval2');
csrNames(0x350, 'miselect mireg mireg2 mireg3 miph mireg4 mireg5 mireg6');
csrNames(0x35c, 'mtopei');
csrRange(0x3a0, 0, 15, 'pmpcfg');
csrRange(0x3b0, 0, 63, 'pmpaddr');
csrNames(0x5a8, 'scontext');
csrNames(0x600, 'hstatus - hedeleg hideleg hie htimedelta hcounteren hgeie hvien');
csrNames(0x609, 'hvictl henvcfg - hstateen0 hstateen1 hstateen2 hstateen3');
csrNames(0x613, 'hidelegh - htimedeltah - - hvienh - henvcfgh - hstateen0h');
csrNames(0x61d, 'hstateen1h hstateen2h hstateen3h');
csrNames(0x643, 'htval hip hvip hviprio1 hviprio2 - - htinst');
csrNames(0x655, 'hviph hviprio1h hviprio2h');
csrNames(0x680, 'hgatp');
csrNames(0x6a8, 'hcontext');
csrNames(0x721, 'mcyclecfgh minstretcfgh mhpmevent3h mhpmevent4h mhpmevent5h mhpmevent6h mhpmevent7h mhpmevent8h mhpmevent9h');
csrRange(0x72a, 10, 31, 'mhpmevent', 'h');
csrNames(0x747, 'mseccfg');
csrNames(0x757, 'mseccfgh');
csrNames(0x7a0, 'tselect tdata1 tdata2 tdata3 tinfo tcontrol - - mcontext');
csrNames(0x7aa, 'mscontext');
csrNames(0x7b0, 'dcsr dpc dscratch0 dscratch1');
csrNames(0xb00, 'mcycle - minstret mhpmcounter3 mhpmcounter4 mhpmcounter5 mhpmcounter6 mhpmcounter7 mhpmcounter8');
csrRange(0xb09, 9, 31, 'mhpmcounter');
csrNames(0xb80, 'mcycleh - minstreth mhpmcounter3h mhpmcounter4h mhpmcounter5h mhpmcounter6h mhpmcounter7h mhpmcounter8h');
csrRange(0xb89, 9, 31, 'mhpmcounter', 'h');
csrNames(0xc00, 'cycle time instret hpmcounter3 hpmcounter4 hpmcounter5 hpmcounter6 hpmcounter7 hpmcounter8');
csrRange(0xc09, 9, 31, 'hpmcounter');
csrNames(0xc20, 'vl vtype vlenb');
csrNames(0xc80, 'cycleh timeh instreth hpmcounter3h hpmcounter4h hpmcounter5h hpmcounter6h hpmcounter7h hpmcounter8h');
csrRange(0xc89, 9, 31, 'hpmcounter', 'h');
csrNames(0xda0, 'scountovf');
csrNames(0xdb0, 'stopi');
csrNames(0xe12, 'hgeip');
csrNames(0xeb0, 'vstopi');
csrNames(0xf11, 'mvendorid marchid mimpid mhartid mconfigptr');
csrNames(0xfb0, 'mtopi');

/** objdump's spelling of a CSR number. */
export function csrName(csr: number): string {
  return CSR_NAMES.get(csr) ?? `0x${csr.toString(16)}`;
}

/** rdcycle & co.: `csrrs rd,<csr>,zero` in the alias form. */
const RD_COUNTERS: Readonly<Record<number, string>> = { 0xc00: 'rdcycle', 0xc01: 'rdtime', 0xc02: 'rdinstret', 0xc80: 'rdcycleh', 0xc81: 'rdtimeh', 0xc82: 'rdinstreth' };

const hex = (n: number): string => `0x${(n >>> 0).toString(16)}`;
const R = (n: number): string => REG_NAMES[n];

function fenceSet(bits: number): string {
  if (bits === 0) return 'unknown';
  return `${bits & 8 ? 'i' : ''}${bits & 4 ? 'o' : ''}${bits & 2 ? 'r' : ''}${bits & 1 ? 'w' : ''}`;
}

/** A Zcmp register list as binutils prints it: {ra}, {ra,s0}, {ra,s0-s1} … {ra,s0-s11}. */
function rlistText(rlist: number): string {
  if (rlist === 4) return '{ra}';
  if (rlist === 5) return '{ra,s0}';
  const last = rlist === 15 ? 27 : rlist === 6 ? 9 : rlist + 11;
  return `{ra,s0-${R(last)}}`;
}

/** objdump's operands for a word it can't decode: `2, 0x0004`, `4, 0xf127be03`. */
function invalidOperands(raw: number, length: number): string {
  return `${length}, 0x${(raw >>> 0).toString(16).padStart(2 * length, '0')}`;
}

const scratch = new Int32Array(DESCRIPTOR_SIZE);

/**
 * Disassembles the instruction whose first halfword is `word`'s low half (pass the 32 bits at
 * `pc`; only the low 16 are read for a compressed instruction).
 */
export function disassemble(word: number, pc: number, profile: RiscvProfile, aliases = true): Disassembly {
  const d = scratch;
  decode(word, profile, d);
  const length = d[D_LEN];
  const name = d[D_NAME];
  const raw = length === 2 ? word & 0xffff : word >>> 0;
  if (name === NAME.INVALID) return { mnemonic: '.insn', operands: invalidOperands(raw, length), length };
  if (name === NAME.C_UNIMP) return { mnemonic: aliases ? 'unimp' : 'c.unimp', operands: '', length };
  // `csrrw zero,cycle,zero` is objdump's unimp in both forms.
  if (raw === 0xc0001073) return { mnemonic: 'unimp', operands: '', length };
  if (aliases) {
    const alias = aliasOf(d, pc);
    if (alias !== undefined) return { mnemonic: alias[0], operands: alias[1], length };
  }
  if (name === NAME.FENCE && d[D_AUX] >> 8 !== 0) return { mnemonic: 'fence.tso', operands: '', length };
  const info = NAMES[name];
  let mnemonic = info.name;
  if (info.fmt === FMT.AMO || info.fmt === FMT.LR) mnemonic += ['', '.rl', '.aq', '.aqrl'][d[D_AUX] & 3];
  return { mnemonic, operands: operands(info.fmt, d, pc), length };
}

function operands(fmt: number, d: Int32Array, pc: number): string {
  const rd = R(d[D_RD]);
  const rs1 = R(d[D_RS1]);
  const rs2 = R(d[D_RS2]);
  const imm = d[D_IMM];
  const target = ((pc + imm) >>> 0).toString(16);
  switch (fmt) {
    case FMT.NONE:
      return '';
    case FMT.U:
      return `${rd},${hex(imm >>> 12)}`;
    case FMT.J:
      return `${rd},${target}`;
    case FMT.RD_MEM:
      return `${rd},${imm}(${rs1})`;
    case FMT.B:
      return `${rs1},${rs2},${target}`;
    case FMT.RS2_MEM:
      return `${rs2},${imm}(${rs1})`;
    case FMT.I:
      return `${rd},${rs1},${imm}`;
    case FMT.SHIFT:
      return `${rd},${rs1},${hex(imm)}`;
    case FMT.R:
      return `${rd},${rs1},${rs2}`;
    case FMT.UNARY:
      return `${rd},${rs1}`;
    case FMT.CSR:
      return `${rd},${csrName(d[D_AUX])},${rs1}`;
    case FMT.CSRI:
      return `${rd},${csrName(d[D_AUX])},${imm}`;
    case FMT.FENCE:
      return `${fenceSet((d[D_AUX] >> 4) & 15)},${fenceSet(d[D_AUX] & 15)}`;
    case FMT.AMO:
      return `${rd},${rs2},(${rs1})`;
    case FMT.LR:
      return `${rd},(${rs1})`;
    case FMT.BEXTM:
      return `${rd},${rs1},${rs2},${d[D_AUX]}`;
    case FMT.BEXTMI:
      return `${rd},${rs1},${imm},${d[D_AUX]}`;
    case FMT.CMPP: {
      const neg = d[D_NAME] === NAME.CM_PUSH ? '-' : '';
      return `${rlistText(d[D_AUX] >> 4)},${neg}${imm}`;
    }
    case FMT.CMMV:
      return `${rs1},${rs2}`;
    case FMT.C_RR:
      return `${rd},${rs2}`;
    case FMT.C_RI:
      return `${rd},${imm}`;
    case FMT.C_RHEX:
      return d[D_NAME] === NAME.C_LUI ? `${rd},${hex((imm >>> 12) & 0xfffff)}` : `${rd},${hex(imm)}`;
    case FMT.C_R:
      return d[D_NAME] === NAME.C_JR || d[D_NAME] === NAME.C_JALR ? rs1 : rd;
    case FMT.C_J:
      return target;
    case FMT.C_B:
      return `${rs1},${target}`;
    case FMT.C_ADDI4SPN:
      return `${rd},sp,${imm}`;
    case FMT.C_ADDI16SP:
      return `sp,${imm}`;
    default:
      return '';
  }
}

/** objdump's pseudo-instruction for this descriptor, or undefined to print the real one. */
function aliasOf(d: Int32Array, pc: number): [string, string] | undefined {
  const name = d[D_NAME];
  const rdN = d[D_RD];
  const rs1N = d[D_RS1];
  const rs2N = d[D_RS2];
  const imm = d[D_IMM];
  const rd = R(rdN);
  const rs1 = R(rs1N);
  const rs2 = R(rs2N);
  const target = ((pc + imm) >>> 0).toString(16);
  const N = NAME;
  switch (name) {
    case N.ADDI:
      if (rdN === 0 && rs1N === 0 && imm === 0) return ['nop', ''];
      if (rs1N === 0) return ['li', `${rd},${imm}`];
      if (imm === 0) return ['mv', `${rd},${rs1}`];
      return undefined;
    case N.ANDI:
      return imm === 255 ? ['zext.b', `${rd},${rs1}`] : undefined;
    case N.XORI:
      return imm === -1 ? ['not', `${rd},${rs1}`] : undefined;
    case N.SLTIU:
      return imm === 1 ? ['seqz', `${rd},${rs1}`] : undefined;
    case N.SUB:
      return rs1N === 0 ? ['neg', `${rd},${rs2}`] : undefined;
    case N.SLTU:
      return rs1N === 0 ? ['snez', `${rd},${rs2}`] : undefined;
    case N.SLT:
      if (rs2N === 0) return ['sltz', `${rd},${rs1}`];
      if (rs1N === 0) return ['sgtz', `${rd},${rs2}`];
      return undefined;
    case N.BEQ:
      return rs2N === 0 ? ['beqz', `${rs1},${target}`] : undefined;
    case N.BNE:
      return rs2N === 0 ? ['bnez', `${rs1},${target}`] : undefined;
    case N.BLT:
      if (rs2N === 0) return ['bltz', `${rs1},${target}`];
      if (rs1N === 0) return ['bgtz', `${rs2},${target}`];
      return undefined;
    case N.BGE:
      if (rs1N === 0) return ['blez', `${rs2},${target}`];
      if (rs2N === 0) return ['bgez', `${rs1},${target}`];
      return undefined;
    case N.JAL:
      if (rdN === 0) return ['j', target];
      return rdN === 1 ? ['jal', target] : undefined;
    case N.JALR:
      if (rdN === 0 && rs1N === 1 && imm === 0) return ['ret', ''];
      if (rdN === 0) return ['jr', imm === 0 ? rs1 : `${imm}(${rs1})`];
      if (rdN === 1) return ['jalr', imm === 0 ? rs1 : `${imm}(${rs1})`];
      return imm === 0 ? ['jalr', `${rd},${rs1}`] : undefined;
    case N.FENCE: {
      const aux = d[D_AUX];
      if (aux >> 8 !== 0) return ['fence.tso', ''];
      return (aux & 0xff) === 0xff ? ['fence', ''] : undefined;
    }
    case N.CSRRS: {
      const csr = csrName(d[D_AUX]);
      if (rs1N === 0) {
        const counter = RD_COUNTERS[d[D_AUX]];
        return counter !== undefined ? [counter, rd] : ['csrr', `${rd},${csr}`];
      }
      return rdN === 0 ? ['csrs', `${csr},${rs1}`] : undefined;
    }
    case N.CSRRW:
      return rdN === 0 ? ['csrw', `${csrName(d[D_AUX])},${rs1}`] : undefined;
    case N.CSRRC:
      return rdN === 0 ? ['csrc', `${csrName(d[D_AUX])},${rs1}`] : undefined;
    case N.CSRRWI:
      return rdN === 0 ? ['csrwi', `${csrName(d[D_AUX])},${imm}`] : undefined;
    case N.CSRRSI:
      return rdN === 0 ? ['csrsi', `${csrName(d[D_AUX])},${imm}`] : undefined;
    case N.CSRRCI:
      return rdN === 0 ? ['csrci', `${csrName(d[D_AUX])},${imm}`] : undefined;
    // Compressed instructions print as their base instruction, except the HINTs on x0.
    case N.C_ADDI:
      if (rdN === 0) return imm === 0 ? ['nop', ''] : ['c.nop', `${imm}`];
      return ['addi', `${rd},${rd},${imm}`];
    case N.C_ADDI4SPN:
      return ['addi', `${rd},sp,${imm}`];
    case N.C_ADDI16SP:
      return ['addi', `sp,sp,${imm}`];
    case N.C_LI:
      return rdN === 0 ? undefined : ['li', `${rd},${imm}`];
    case N.C_LUI:
      return rdN === 0 ? undefined : ['lui', `${rd},${hex((imm >>> 12) & 0xfffff)}`];
    case N.C_MV:
      return rdN === 0 ? undefined : ['mv', `${rd},${rs2}`];
    case N.C_ADD:
      return rdN === 0 ? undefined : ['add', `${rd},${rd},${rs2}`];
    case N.C_SLLI:
      return rdN === 0 ? undefined : ['slli', `${rd},${rd},${hex(imm)}`];
    case N.C_SRLI:
      return ['srli', `${rd},${rd},${hex(imm)}`];
    case N.C_SRAI:
      return ['srai', `${rd},${rd},${hex(imm)}`];
    case N.C_ANDI:
      return ['andi', `${rd},${rd},${imm}`];
    case N.C_SUB:
    case N.C_XOR:
    case N.C_OR:
    case N.C_AND:
    case N.C_MUL:
      return [NAMES[name].name.slice(2), `${rd},${rd},${rs2}`];
    case N.C_J:
      return ['j', target];
    case N.C_JAL:
      return ['jal', target];
    case N.C_JR:
      return rs1N === 1 ? ['ret', ''] : ['jr', rs1];
    case N.C_JALR:
      return ['jalr', rs1];
    case N.C_BEQZ:
      return ['beqz', `${rs1},${target}`];
    case N.C_BNEZ:
      return ['bnez', `${rs1},${target}`];
    case N.C_EBREAK:
      return ['ebreak', ''];
    case N.C_LW:
    case N.C_LWSP:
    case N.C_LBU:
    case N.C_LHU:
    case N.C_LH:
      return [NAMES[name].name.slice(2).replace('sp', ''), `${rd},${imm}(${rs1})`];
    case N.C_SW:
    case N.C_SWSP:
    case N.C_SB:
    case N.C_SH:
      return [NAMES[name].name.slice(2).replace('sp', ''), `${rs2},${imm}(${rs1})`];
    case N.C_ZEXT_B:
    case N.C_SEXT_B:
    case N.C_ZEXT_H:
    case N.C_SEXT_H:
    case N.C_NOT:
      return [NAMES[name].name.slice(2), `${rd},${rd}`];
    default:
      return undefined;
  }
}
