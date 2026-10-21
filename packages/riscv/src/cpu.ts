/**
 * The RISC-V core (BT64): RV32IMAC with Zicsr and Zifencei, the extensions its RiscvProfile
 * enables (Hazard3's: Zba, Zbb, Zbs, Zbkb, Zcb, Zcmp, Xh3bextm), and machine and user modes
 * (The RISC-V Instruction Set Manual, Volume II, 20211203: chapter 3 and §3.7's PMP registers).
 *
 * Registers: `x` holds x0–x31 as int32; x0 is rewritten to 0 after every instruction.
 *
 * Timing (flat model): every instruction takes one cycle, a trap or interrupt entry one more
 * (not an instruction). WFI sleeps by skipping cycles to the end of the run unless an enabled
 * interrupt is pending. mcycle counts cycles, minstret instructions, each as a 64-bit value
 * (JS numbers: exact to 2^53).
 *
 * The run loop (interpret) keeps the PC, the cycle count and the current code page in locals
 * and tests one field per instruction, `attention` — set when an interrupt may be deliverable,
 * by WFI, by requestStop and when the predecode cache dropped pages — before fetching. An
 * instruction is a packed entry (icache.ts layout) run by one switch with literal case labels
 * (the OP ids; case-labels.test.ts checks them): from the predecode cache when the bus is a
 * RiscvCodeBus, else decoded through fetch16. No allocation, closures or BigInt per
 * instruction (AGENTS rule 3). bench-loop.S: ≈ 36 simulated MIPS predecoded, ≈ 15 without the
 * cache, in plain Node.
 *
 * Traps: mepc, mcause, mtval (the fault address, the illegal instruction's bits, 0 otherwise —
 * or always 0 with `writeMtval: false`), mstatus.MPIE/MIE/MPP, then mtvec (vectored: base +
 * 4 × cause for interrupts). Interrupts MEI > MSI > MTI come from `setInterruptLine` (the SoC's
 * timer, software and external interrupt sources); a SoC's own CSRs come through `csrHook`.
 * Misaligned loads and stores trap; a RiscvBusError becomes the access fault of the access.
 * PMP: the pmpcfg/pmpaddr registers hold their values (lock bits included) but aren't enforced.
 */

import type { RiscvBus, RiscvCodeBus } from './bus.ts';
import { isRiscvCodeBus, RISCV_BUS_YIELD, RiscvBusError } from './bus.ts';
import { CSR, csrPrivilege, csrReadOnly, type RiscvCsrHook } from './csr.ts';
import * as dec from './decode.ts';
import * as ic from './icache.ts';
import { RiscvICache } from './icache.ts';
import * as isa from './isa.ts';
import type { RiscvProfile } from './isa.ts';
import * as traps from './traps.ts';

// Imported bindings copied to module constants once: under vitest's module transform every
// access to an imported name is a getter call.
const decode = dec.decode;
const DESCRIPTOR_SIZE = dec.DESCRIPTOR_SIZE;
const D_OP = dec.D_OP;
const D_LEN = dec.D_LEN;
const D_RD = dec.D_RD;
const D_RS1 = dec.D_RS1;
const D_RS2 = dec.D_RS2;
const D_IMM = dec.D_IMM;
const D_AUX = dec.D_AUX;
const RLIST_REGS = dec.RLIST_REGS;
const rlistCount = dec.rlistCount;
const OP = isa.OP;
const W0_FILLED = ic.W0_FILLED;
const W0_LEN4 = ic.W0_LEN4;
const W0_AUX_SHIFT = ic.W0_AUX_SHIFT;
const PAGE_SHIFT = ic.RC_PAGE_SHIFT;
const CAUSE_ILLEGAL = traps.CAUSE.ILLEGAL_INSTRUCTION;
const CAUSE_BREAKPOINT = traps.CAUSE.BREAKPOINT;
const CAUSE_LOAD_MISALIGNED = traps.CAUSE.LOAD_MISALIGNED;
const CAUSE_STORE_MISALIGNED = traps.CAUSE.STORE_MISALIGNED;
const CAUSE_LOAD_ACCESS = traps.CAUSE.LOAD_ACCESS;
const CAUSE_STORE_ACCESS = traps.CAUSE.STORE_ACCESS;
const CAUSE_INSTRUCTION_ACCESS = traps.CAUSE.INSTRUCTION_ACCESS;
const INTERRUPT_BIT = traps.INTERRUPT_BIT;
const IRQ_MASK = traps.IRQ_MASK;
const IRQ_PRIORITY = Int32Array.from(traps.IRQ_PRIORITY);
const MIE = traps.MSTATUS.MIE;
const MPIE = traps.MSTATUS.MPIE;
const MPP_SHIFT = traps.MSTATUS.MPP_SHIFT;
const MPP_MASK = traps.MSTATUS.MPP_MASK;
const MPRV = traps.MSTATUS.MPRV;
const TW = traps.MSTATUS.TW;
const MODE_M = traps.MODE.M;
const MODE_U = traps.MODE.U;

/** Why the core stopped. */
export const HALT = { RUNNING: 0, BREAK: 1, FAULT: 2 } as const;

const TWO32 = 4294967296;

// ── M and B extension helpers ─────────────────────────────────────────────────────────────

/** The high 32 bits of the unsigned 64-bit product (16-bit limbs: every partial product is exact). */
function mulhu(a: number, b: number): number {
  const aL = a & 0xffff;
  const aH = a >>> 16;
  const bL = b & 0xffff;
  const bH = b >>> 16;
  const lh = aL * bH;
  const hl = aH * bL;
  const mid = ((aL * bL) >>> 16) + (lh & 0xffff) + (hl & 0xffff);
  return (aH * bH + (lh >>> 16) + (hl >>> 16) + (mid >>> 16)) | 0;
}

function mulh(a: number, b: number): number {
  return (mulhu(a, b) - (a < 0 ? b : 0) - (b < 0 ? a : 0)) | 0;
}

function mulhsu(a: number, b: number): number {
  return (mulhu(a, b) - (a < 0 ? b : 0)) | 0;
}

function cpop(v: number): number {
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return Math.imul((v + (v >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
}

function orcb(v: number): number {
  return (v & 0xff ? 0xff : 0) | (v & 0xff00 ? 0xff00 : 0) | (v & 0xff0000 ? 0xff0000 : 0) | (v & 0xff000000 ? 0xff000000 : 0);
}

function rev8(v: number): number {
  return ((v & 0xff) << 24) | ((v & 0xff00) << 8) | ((v >>> 8) & 0xff00) | (v >>> 24);
}

function brev8(v: number): number {
  v = ((v >>> 1) & 0x55555555) | ((v & 0x55555555) << 1);
  v = ((v >>> 2) & 0x33333333) | ((v & 0x33333333) << 2);
  return ((v >>> 4) & 0x0f0f0f0f) | ((v & 0x0f0f0f0f) << 4);
}

/** Zbkb zip (RV32): bit i of the low half to bit 2i, bit i of the high half to bit 2i + 1. */
function zip(v: number): number {
  let t = (v ^ (v >>> 8)) & 0x0000ff00;
  v = v ^ t ^ (t << 8);
  t = (v ^ (v >>> 4)) & 0x00f000f0;
  v = v ^ t ^ (t << 4);
  t = (v ^ (v >>> 2)) & 0x0c0c0c0c;
  v = v ^ t ^ (t << 2);
  t = (v ^ (v >>> 1)) & 0x22222222;
  return v ^ t ^ (t << 1);
}

/** Zbkb unzip (RV32): zip's inverse. */
function unzip(v: number): number {
  let t = (v ^ (v >>> 1)) & 0x22222222;
  v = v ^ t ^ (t << 1);
  t = (v ^ (v >>> 2)) & 0x0c0c0c0c;
  v = v ^ t ^ (t << 2);
  t = (v ^ (v >>> 4)) & 0x00f000f0;
  v = v ^ t ^ (t << 4);
  t = (v ^ (v >>> 8)) & 0x0000ff00;
  return v ^ t ^ (t << 8);
}

// ── The core ──────────────────────────────────────────────────────────────────────────────

export interface RiscvCoreOptions {
  /** The ISA the core accepts (default Hazard3's). */
  profile?: RiscvProfile;
  /** PC after reset. */
  resetPc?: number;
  /** mtvec after reset. */
  resetMtvec?: number;
  mhartid?: number;
  mvendorid?: number;
  marchid?: number;
  mimpid?: number;
  /** misa (default: RV32, A, C, I, M, U when the profile has user mode, X when it has a custom extension). */
  misa?: number;
  /** PMP entries with storage, 0–16 (default 16). */
  pmpEntries?: number;
  /** Traps write mtval (default true); false: mtval reads 0 and ignores writes. */
  writeMtval?: boolean;
}

export class RiscvCore {
  /** x0–x31. */
  readonly x = new Int32Array(32);
  pc = 0;
  /** Privilege mode: 3 machine, 0 user (traps.MODE). */
  mode: number = MODE_M;
  mstatus = 0;
  mie = 0;
  mtvec = 0;
  mscratch = 0;
  mepc = 0;
  mcause = 0;
  mtval = 0;
  mcounteren = 0;
  mcountinhibit = 0;
  readonly pmpcfg = new Uint8Array(16);
  readonly pmpaddr = new Uint32Array(16);
  readonly profile: Readonly<RiscvProfile>;
  readonly mhartid: number;
  readonly mvendorid: number;
  readonly marchid: number;
  readonly mimpid: number;
  readonly misa: number;
  readonly resetPc: number;
  readonly resetMtvec: number;
  readonly pmpEntries: number;
  readonly writeMtval: boolean;
  /** Interrupt lines (mip bits) the SoC drives. */
  lines = 0;
  /** The LR.W reservation's address, or −1. */
  reservation = -1;
  /** Cycles since construction (instructions + trap entries + cycles asleep in WFI). */
  cycles = 0;
  /** Cycles spent asleep in WFI. */
  slept = 0;
  /** Cycles spent entering traps and interrupts. */
  trapCycles = 0;
  /** In WFI, waiting for an interrupt. */
  waiting = false;
  /** HALT.* */
  halt: number = HALT.RUNNING;
  haltReason = '';
  /** Tested before every instruction: an interrupt may be deliverable, WFI, or a stop request. */
  attention = false;
  /** A SoC's CSRs (consulted for every CSR the core doesn't implement). */
  csrHook: RiscvCsrHook | null = null;
  /** Claims an EBREAK as a halt instead of a breakpoint exception (the bare machine's exit). */
  ebreakHook: (() => boolean) | null = null;
  /** Called on every trap entry with mcause, mepc and mtval (interrupts included). */
  trapHook: ((cause: number, epc: number, tval: number) => void) | null = null;
  /** BT65: called after an MRET (Hazard3 restores its interrupt priority stack there). */
  mretHook: (() => void) | null = null;
  /** BT65 (Xh3power): an h3.unblock executed — the SoC calls `unblock()` on every hart, this one included. */
  unblockHook: (() => void) | null = null;
  /** An h3.unblock arrived since this hart's last h3.block. */
  unblocked = false;
  /**
   * BT71 (a debugger's single steps): leave `run` right after entering an interrupt, before the
   * handler's first instruction, so a breakpoint there is seen. Read only when an interrupt is
   * taken, never in the instruction loop.
   */
  stopOnTrap = false;
  /** Asleep in h3.block (not WFI): an unblock wakes it. */
  private blocked = false;
  readonly bus: RiscvBus;
  readonly icache = new RiscvICache();
  /** Run through the predecode cache when the bus supports it (false: decode every instruction). */
  predecode = true;
  private readonly codeBus: RiscvCodeBus | null;
  private readonly d = new Int32Array(DESCRIPTOR_SIZE);
  /** The entry decode() produced last (packed), and the instruction's bits. */
  private w0s = 0;
  private w1s = 0;
  private lastBits = 0;
  /** A fetch through the bus is in progress (a bus error then is an instruction access fault). */
  private fetching = false;
  private stopRequested = false;
  /** The predecode cache dropped pages: the loop looks its page up again. */
  private codeChanged = false;
  private cycleOffset = 0;
  private instretOffset = 0;
  /** mcountinhibit's frozen counter values. */
  private cycleFrozen = 0;
  private instretFrozen = 0;

  constructor(bus: RiscvBus, options: RiscvCoreOptions = {}) {
    this.bus = bus;
    this.codeBus = isRiscvCodeBus(bus) ? bus : null;
    this.profile = options.profile ?? isa.HAZARD3;
    this.resetPc = options.resetPc ?? 0;
    this.resetMtvec = options.resetMtvec ?? 0;
    this.mhartid = options.mhartid ?? 0;
    this.mvendorid = options.mvendorid ?? 0;
    this.marchid = options.marchid ?? 0;
    this.mimpid = options.mimpid ?? 0;
    this.pmpEntries = Math.max(0, Math.min(16, options.pmpEntries ?? 16));
    this.writeMtval = options.writeMtval ?? true;
    this.icache.onChange = () => {
      this.codeChanged = true;
      this.attention = true;
    };
    const p = this.profile;
    const letter = (c: string): number => 1 << (c.charCodeAt(0) - 65);
    this.misa = options.misa ?? ((1 << 30) | letter('A') | letter('C') | letter('I') | letter('M') | (p.umode ? letter('U') : 0) | (p.xh3bextm ? letter('X') : 0)) >>> 0;
    this.reset();
  }

  /** Reset: registers, CSRs and mode as at power-on; `cycles` keeps counting; interrupt lines stay (the SoC's). */
  reset(): void {
    this.x.fill(0);
    this.pc = this.resetPc >>> 0;
    this.mode = MODE_M;
    this.mstatus = MODE_M << MPP_SHIFT;
    this.mie = 0;
    this.mtvec = this.resetMtvec >>> 0;
    this.mscratch = this.mepc = this.mcause = this.mtval = 0;
    this.mcounteren = this.mcountinhibit = 0;
    this.pmpcfg.fill(0);
    this.pmpaddr.fill(0);
    this.reservation = -1;
    this.waiting = false;
    this.unblocked = false;
    this.halt = HALT.RUNNING;
    this.haltReason = '';
    this.cycleOffset = -this.cycles;
    this.instretOffset = -this.instructions;
    this.icache.invalidateAll();
    this.updateIrq();
  }

  /** Instructions retired since construction. */
  get instructions(): number {
    return this.cycles - this.slept - this.trapCycles;
  }

  /** mip: the lines the SoC drives. */
  get mip(): number {
    return this.lines & IRQ_MASK;
  }

  /** An interrupt line (traps.IRQ: MSI, MTI, MEI) goes high or low. */
  setInterruptLine(irq: number, high: boolean): void {
    this.lines = high ? this.lines | (1 << irq) : this.lines & ~(1 << irq);
    this.updateIrq();
  }

  /** An h3.unblock reached this hart: wakes it from h3.block (or WFI), else latches for the next h3.block. */
  unblock(): void {
    if (this.waiting && this.blocked) {
      this.waiting = false;
      this.blocked = false;
      this.updateIrq();
    } else this.unblocked = true;
  }

  /** Ends the current run after the instruction in progress (a SoC event). */
  requestStop(): void {
    this.stopRequested = true;
    this.attention = true;
  }

  /** Drops predecoded instructions overlapping [address, address + size): a bus calls it on writes to code pages it accepted. */
  invalidateCode(address: number, size = 1): void {
    this.icache.invalidate(address >>> 0, size);
  }

  /** Stops the core with a message (a model error, not a guest trap). */
  fault(message: string): void {
    this.halt = HALT.FAULT;
    this.haltReason = message;
  }

  // ── Running ─────────────────────────────────────────────────────────────────────────────

  /** Runs up to `max` cycles; returns the instructions retired. Stops early on a halt or a stop request. */
  run(max: number): number {
    const before = this.instructions;
    const end = this.cycles + max;
    this.stopRequested = false;
    this.updateIrq();
    while (this.halt === HALT.RUNNING && this.cycles < end && !this.stopRequested) {
      try {
        this.interpret(end);
      } catch (error) {
        const fetching = this.fetching;
        this.fetching = false;
        if (error === RISCV_BUS_YIELD) this.stopRequested = true;
        else if (error instanceof RiscvBusError) this.accessFault(error.address, fetching);
        else this.fault(error instanceof Error ? error.message : String(error));
      }
    }
    this.stopRequested = false;
    this.updateIrq();
    return this.instructions - before;
  }

  /** Executes one instruction (or takes one pending interrupt). */
  step(): void {
    this.run(1);
  }

  /** Decodes into this.w0s/w1s, fetching through the bus. */
  private decodeFromBus(pc: number): void {
    this.fetching = true;
    let word = this.bus.fetch16(pc);
    if ((word & 3) === 3) word = (word | (this.bus.fetch16((pc + 2) >>> 0) << 16)) >>> 0;
    this.fetching = false;
    this.lastBits = word;
    decode(word, this.profile, this.d);
    this.pack();
  }

  /** Decodes the instruction at `pc` into its cache slot (when it may be cached) and this.w0s/w1s. */
  private fill(page: Int32Array, slot: number, pc: number): void {
    const cb = this.codeBus as RiscvCodeBus;
    let word = cb.codeHalf(pc);
    if ((word & 3) === 3) {
      if ((pc & 0xfff) === 0xffe) return this.decodeFromBus(pc); // runs into the next page
      word = (word | (cb.codeHalf((pc + 2) >>> 0) << 16)) >>> 0;
    }
    this.lastBits = word;
    decode(word, this.profile, this.d);
    this.pack();
    if (this.d[D_OP] !== 0) {
      page[slot] = this.w0s;
      page[slot + 1] = this.w1s;
    }
  }

  /** The descriptor → an entry (icache.ts layout). */
  private pack(): void {
    const d = this.d;
    const op = d[D_OP];
    let w0 = W0_FILLED | op | (d[D_LEN] === 4 ? W0_LEN4 : 0) | (d[D_RD] << 8) | (d[D_RS1] << 13) | (d[D_RS2] << 18);
    let w1 = d[D_IMM];
    if (op >= OP.CSRRW && op <= OP.CSRRCI) w1 = d[D_AUX] | (d[D_IMM] << 12);
    else if (op >= OP.CM_PUSH && op <= OP.CM_POPRETZ) w0 |= (d[D_AUX] >> 4) << W0_AUX_SHIFT;
    else if (op === OP.H3_BEXTM || op === OP.H3_BEXTMI) w0 |= (d[D_AUX] - 1) << W0_AUX_SHIFT;
    this.w0s = w0;
    this.w1s = w1;
  }

  /**
   * The run loop: executes until `end` (cycles), a halt, a stop request or WFI with nothing to
   * wake it. Locals mirror pc and cycles; `finally` writes them back (also when an access
   * throws: this.pc is the faulting instruction's).
   */
  private interpret(end: number): void {
    const x = this.x;
    const bus = this.bus;
    const codeBus = this.predecode ? this.codeBus : null;
    const icache = this.icache;
    let pc = this.pc;
    let cycles = this.cycles;
    let pageIndex = -1;
    let page: Int32Array | null = null;
    this.codeChanged = false;
    try {
      while (cycles < end) {
        if (this.attention) {
          if (this.codeChanged) {
            this.codeChanged = false;
            pageIndex = -1;
            page = null;
          }
          this.pc = pc;
          this.cycles = cycles;
          const go = this.service(end);
          pc = this.pc;
          cycles = this.cycles;
          if (!go) return;
          continue;
        }
        let w0: number;
        let w1: number;
        if (codeBus !== null && pc >>> PAGE_SHIFT !== pageIndex) {
          pageIndex = pc >>> PAGE_SHIFT;
          page = icache.lookup(pc, codeBus);
        }
        if (page !== null) {
          const slot = pc & 0xffe;
          w0 = page[slot];
          if (w0 !== 0) w1 = page[slot + 1];
          else {
            this.fill(page, slot, pc);
            w0 = this.w0s;
            w1 = this.w1s;
          }
        } else {
          // A bus error here leaves through `finally` with this.pc = pc: an instruction access fault.
          this.decodeFromBus(pc);
          w0 = this.w0s;
          w1 = this.w1s;
        }
        const rd = (w0 >>> 8) & 31;
        const rs1 = (w0 >>> 13) & 31;
        const rs2 = (w0 >>> 18) & 31;
        const next = (pc + ((w0 & W0_LEN4) !== 0 ? 4 : 2)) >>> 0;
        switch (w0 & 0x7f) {
          case 1 /* OP.LUI */:
            x[rd] = w1;
            pc = next;
            break;
          case 2 /* OP.AUIPC */:
            x[rd] = pc + w1;
            pc = next;
            break;
          case 3 /* OP.JAL */:
            x[rd] = next;
            pc = (pc + w1) >>> 0;
            break;
          case 4 /* OP.JALR */: {
            const target = ((x[rs1] + w1) & ~1) >>> 0;
            x[rd] = next;
            pc = target;
            break;
          }
          case 5 /* OP.BEQ */:
            pc = x[rs1] === x[rs2] ? (pc + w1) >>> 0 : next;
            break;
          case 6 /* OP.BNE */:
            pc = x[rs1] !== x[rs2] ? (pc + w1) >>> 0 : next;
            break;
          case 7 /* OP.BLT */:
            pc = x[rs1] < x[rs2] ? (pc + w1) >>> 0 : next;
            break;
          case 8 /* OP.BGE */:
            pc = x[rs1] >= x[rs2] ? (pc + w1) >>> 0 : next;
            break;
          case 9 /* OP.BLTU */:
            pc = x[rs1] >>> 0 < x[rs2] >>> 0 ? (pc + w1) >>> 0 : next;
            break;
          case 10 /* OP.BGEU */:
            pc = x[rs1] >>> 0 >= x[rs2] >>> 0 ? (pc + w1) >>> 0 : next;
            break;
          case 11 /* OP.LB */:
            x[rd] = (bus.read8((x[rs1] + w1) >>> 0) << 24) >> 24;
            pc = next;
            break;
          case 12 /* OP.LH */: {
            const a = (x[rs1] + w1) >>> 0;
            if ((a & 1) !== 0) {
              cycles = this.misaligned(CAUSE_LOAD_MISALIGNED, a, pc, cycles);
              pc = this.pc;
              continue;
            }
            x[rd] = (bus.read16(a) << 16) >> 16;
            pc = next;
            break;
          }
          case 13 /* OP.LW */: {
            const a = (x[rs1] + w1) >>> 0;
            if ((a & 3) !== 0) {
              cycles = this.misaligned(CAUSE_LOAD_MISALIGNED, a, pc, cycles);
              pc = this.pc;
              continue;
            }
            x[rd] = bus.read32(a);
            pc = next;
            break;
          }
          case 14 /* OP.LBU */:
            x[rd] = bus.read8((x[rs1] + w1) >>> 0) & 0xff;
            pc = next;
            break;
          case 15 /* OP.LHU */: {
            const a = (x[rs1] + w1) >>> 0;
            if ((a & 1) !== 0) {
              cycles = this.misaligned(CAUSE_LOAD_MISALIGNED, a, pc, cycles);
              pc = this.pc;
              continue;
            }
            x[rd] = bus.read16(a) & 0xffff;
            pc = next;
            break;
          }
          case 16 /* OP.SB */:
            bus.write8((x[rs1] + w1) >>> 0, x[rs2] & 0xff);
            pc = next;
            break;
          case 17 /* OP.SH */: {
            const a = (x[rs1] + w1) >>> 0;
            if ((a & 1) !== 0) {
              cycles = this.misaligned(CAUSE_STORE_MISALIGNED, a, pc, cycles);
              pc = this.pc;
              continue;
            }
            bus.write16(a, x[rs2] & 0xffff);
            pc = next;
            break;
          }
          case 18 /* OP.SW */: {
            const a = (x[rs1] + w1) >>> 0;
            if ((a & 3) !== 0) {
              cycles = this.misaligned(CAUSE_STORE_MISALIGNED, a, pc, cycles);
              pc = this.pc;
              continue;
            }
            bus.write32(a, x[rs2]);
            pc = next;
            break;
          }
          case 19 /* OP.ADDI */:
            x[rd] = x[rs1] + w1;
            pc = next;
            break;
          case 20 /* OP.SLTI */:
            x[rd] = x[rs1] < w1 ? 1 : 0;
            pc = next;
            break;
          case 21 /* OP.SLTIU */:
            x[rd] = x[rs1] >>> 0 < w1 >>> 0 ? 1 : 0;
            pc = next;
            break;
          case 22 /* OP.XORI */:
            x[rd] = x[rs1] ^ w1;
            pc = next;
            break;
          case 23 /* OP.ORI */:
            x[rd] = x[rs1] | w1;
            pc = next;
            break;
          case 24 /* OP.ANDI */:
            x[rd] = x[rs1] & w1;
            pc = next;
            break;
          case 25 /* OP.SLLI */:
            x[rd] = x[rs1] << w1;
            pc = next;
            break;
          case 26 /* OP.SRLI */:
            x[rd] = x[rs1] >>> w1;
            pc = next;
            break;
          case 27 /* OP.SRAI */:
            x[rd] = x[rs1] >> w1;
            pc = next;
            break;
          case 28 /* OP.ADD */:
            x[rd] = x[rs1] + x[rs2];
            pc = next;
            break;
          case 29 /* OP.SUB */:
            x[rd] = x[rs1] - x[rs2];
            pc = next;
            break;
          case 30 /* OP.SLL */:
            x[rd] = x[rs1] << x[rs2];
            pc = next;
            break;
          case 31 /* OP.SLT */:
            if (rd === 0 && rs1 === 0 && rs2 <= 1 && this.profile.xh3power === true) {
              // Xh3power: h3.block sleeps like WFI unless an unblock is latched; h3.unblock latches one on every hart.
              if (rs2 === 1) this.unblockHook?.();
              else if (this.unblocked) this.unblocked = false;
              else {
                this.waiting = true;
                this.blocked = true;
                this.attention = true;
              }
              pc = next;
              break;
            }
            x[rd] = x[rs1] < x[rs2] ? 1 : 0;
            pc = next;
            break;
          case 32 /* OP.SLTU */:
            x[rd] = x[rs1] >>> 0 < x[rs2] >>> 0 ? 1 : 0;
            pc = next;
            break;
          case 33 /* OP.XOR */:
            x[rd] = x[rs1] ^ x[rs2];
            pc = next;
            break;
          case 34 /* OP.SRL */:
            x[rd] = x[rs1] >>> x[rs2];
            pc = next;
            break;
          case 35 /* OP.SRA */:
            x[rd] = x[rs1] >> x[rs2];
            pc = next;
            break;
          case 36 /* OP.OR */:
            x[rd] = x[rs1] | x[rs2];
            pc = next;
            break;
          case 37 /* OP.AND */:
            x[rd] = x[rs1] & x[rs2];
            pc = next;
            break;
          case 38 /* OP.FENCE */: // one hart, in-order memory: nothing to order
            pc = next;
            break;
          case 39 /* OP.FENCE_I */:
            icache.invalidateAll();
            pc = next;
            break;
          case 40 /* OP.ECALL */:
            this.pc = pc;
            this.cycles = cycles;
            this.trap(this.mode === MODE_U ? traps.CAUSE.ECALL_U : traps.CAUSE.ECALL_M, 0);
            pc = this.pc;
            cycles = this.cycles;
            continue;
          case 41 /* OP.EBREAK */:
            this.pc = pc;
            this.cycles = cycles;
            if (this.ebreakHook !== null && this.ebreakHook()) {
              this.halt = HALT.BREAK;
              this.haltReason = 'ebreak';
              return;
            }
            this.trap(CAUSE_BREAKPOINT, this.writeMtval ? pc : 0);
            pc = this.pc;
            cycles = this.cycles;
            continue;
          case 42 /* OP.MRET */:
            if (this.mode !== MODE_M) {
              cycles = this.illegal(pc, cycles);
              pc = this.pc;
              continue;
            }
            this.mret();
            pc = this.pc;
            break;
          case 44 /* OP.WFI */:
            if (this.mode === MODE_U && (this.mstatus & TW) !== 0) {
              cycles = this.illegal(pc, cycles);
              pc = this.pc;
              continue;
            }
            pc = next;
            if ((this.mie & this.lines & IRQ_MASK) === 0) {
              this.waiting = true;
              this.blocked = false;
              this.attention = true;
            }
            break;
          case 46 /* OP.CSRRW */:
          case 47 /* OP.CSRRS */:
          case 48 /* OP.CSRRC */:
          case 49 /* OP.CSRRWI */:
          case 50 /* OP.CSRRSI */:
          case 51 /* OP.CSRRCI */:
            this.cycles = cycles;
            if (!this.csrInstruction(w0 & 0x7f, rd, rs1, w1)) {
              cycles = this.illegal(pc, cycles);
              pc = this.pc;
              continue;
            }
            pc = next;
            break;
          case 52 /* OP.MUL */:
            x[rd] = Math.imul(x[rs1], x[rs2]);
            pc = next;
            break;
          case 53 /* OP.MULH */:
            x[rd] = mulh(x[rs1], x[rs2]);
            pc = next;
            break;
          case 54 /* OP.MULHSU */:
            x[rd] = mulhsu(x[rs1], x[rs2]);
            pc = next;
            break;
          case 55 /* OP.MULHU */:
            x[rd] = mulhu(x[rs1], x[rs2]);
            pc = next;
            break;
          case 56 /* OP.DIV */: {
            // ÷0 → −1; −2^31 ÷ −1 → −2^31
            const a = x[rs1];
            const b = x[rs2];
            x[rd] = b === 0 ? -1 : b === -1 ? -a : (a / b) | 0;
            pc = next;
            break;
          }
          case 57 /* OP.DIVU */: {
            // ÷0 → 2^32 − 1
            const b = x[rs2] >>> 0;
            x[rd] = b === 0 ? -1 : (x[rs1] >>> 0) / b;
            pc = next;
            break;
          }
          case 58 /* OP.REM */: {
            // ÷0 → dividend; −2^31 rem −1 → 0
            const b = x[rs2];
            x[rd] = b === 0 ? x[rs1] : b === -1 ? 0 : x[rs1] % b;
            pc = next;
            break;
          }
          case 59 /* OP.REMU */: {
            // ÷0 → dividend
            const b = x[rs2] >>> 0;
            x[rd] = b === 0 ? x[rs1] : (x[rs1] >>> 0) % b;
            pc = next;
            break;
          }
          case 60 /* OP.LR_W */: {
            const a = x[rs1] >>> 0;
            if ((a & 3) !== 0) {
              cycles = this.misaligned(CAUSE_LOAD_MISALIGNED, a, pc, cycles);
              pc = this.pc;
              continue;
            }
            x[rd] = bus.read32(a);
            this.reservation = a;
            pc = next;
            break;
          }
          case 61 /* OP.SC_W */: {
            const a = x[rs1] >>> 0;
            if ((a & 3) !== 0) {
              cycles = this.misaligned(CAUSE_STORE_MISALIGNED, a, pc, cycles);
              pc = this.pc;
              continue;
            }
            if (this.reservation === a) {
              bus.write32(a, x[rs2]);
              x[rd] = 0;
            } else x[rd] = 1;
            this.reservation = -1;
            pc = next;
            break;
          }
          case 62 /* OP.AMOSWAP_W */:
          case 63 /* OP.AMOADD_W */:
          case 64 /* OP.AMOXOR_W */:
          case 65 /* OP.AMOAND_W */:
          case 66 /* OP.AMOOR_W */:
          case 67 /* OP.AMOMIN_W */:
          case 68 /* OP.AMOMAX_W */:
          case 69 /* OP.AMOMINU_W */:
          case 70 /* OP.AMOMAXU_W */: {
            const a = x[rs1] >>> 0;
            if ((a & 3) !== 0) {
              cycles = this.misaligned(CAUSE_STORE_MISALIGNED, a, pc, cycles);
              pc = this.pc;
              continue;
            }
            const old = bus.read32(a);
            const v = x[rs2];
            let r: number;
            switch (w0 & 0x7f) {
              case 62 /* OP.AMOSWAP_W */:
                r = v;
                break;
              case 63 /* OP.AMOADD_W */:
                r = old + v;
                break;
              case 64 /* OP.AMOXOR_W */:
                r = old ^ v;
                break;
              case 65 /* OP.AMOAND_W */:
                r = old & v;
                break;
              case 66 /* OP.AMOOR_W */:
                r = old | v;
                break;
              case 67 /* OP.AMOMIN_W */:
                r = (old | 0) < v ? old : v;
                break;
              case 68 /* OP.AMOMAX_W */:
                r = (old | 0) > v ? old : v;
                break;
              case 69 /* OP.AMOMINU_W */:
                r = old >>> 0 < v >>> 0 ? old : v;
                break;
              default: // AMOMAXU_W
                r = old >>> 0 > v >>> 0 ? old : v;
            }
            bus.write32(a, r);
            x[rd] = old;
            pc = next;
            break;
          }
          case 71 /* OP.SH1ADD */:
            x[rd] = (x[rs1] << 1) + x[rs2];
            pc = next;
            break;
          case 72 /* OP.SH2ADD */:
            x[rd] = (x[rs1] << 2) + x[rs2];
            pc = next;
            break;
          case 73 /* OP.SH3ADD */:
            x[rd] = (x[rs1] << 3) + x[rs2];
            pc = next;
            break;
          case 74 /* OP.ANDN */:
            x[rd] = x[rs1] & ~x[rs2];
            pc = next;
            break;
          case 75 /* OP.ORN */:
            x[rd] = x[rs1] | ~x[rs2];
            pc = next;
            break;
          case 76 /* OP.XNOR */:
            x[rd] = ~(x[rs1] ^ x[rs2]);
            pc = next;
            break;
          case 77 /* OP.CLZ */:
            x[rd] = Math.clz32(x[rs1]);
            pc = next;
            break;
          case 78 /* OP.CTZ */: {
            const v = x[rs1];
            x[rd] = v === 0 ? 32 : 31 - Math.clz32(v & -v);
            pc = next;
            break;
          }
          case 79 /* OP.CPOP */:
            x[rd] = cpop(x[rs1]);
            pc = next;
            break;
          case 80 /* OP.MAX */:
            x[rd] = x[rs1] > x[rs2] ? x[rs1] : x[rs2];
            pc = next;
            break;
          case 81 /* OP.MAXU */:
            x[rd] = x[rs1] >>> 0 > x[rs2] >>> 0 ? x[rs1] : x[rs2];
            pc = next;
            break;
          case 82 /* OP.MIN */:
            x[rd] = x[rs1] < x[rs2] ? x[rs1] : x[rs2];
            pc = next;
            break;
          case 83 /* OP.MINU */:
            x[rd] = x[rs1] >>> 0 < x[rs2] >>> 0 ? x[rs1] : x[rs2];
            pc = next;
            break;
          case 84 /* OP.SEXT_B */:
            x[rd] = (x[rs1] << 24) >> 24;
            pc = next;
            break;
          case 85 /* OP.SEXT_H */:
            x[rd] = (x[rs1] << 16) >> 16;
            pc = next;
            break;
          case 86 /* OP.ZEXT_H */:
            x[rd] = x[rs1] & 0xffff;
            pc = next;
            break;
          case 87 /* OP.ROL */: {
            const v = x[rs1];
            const s = x[rs2] & 31;
            x[rd] = (v << s) | (v >>> (32 - s));
            pc = next;
            break;
          }
          case 88 /* OP.ROR */: {
            const v = x[rs1];
            const s = x[rs2] & 31;
            x[rd] = (v >>> s) | (v << (32 - s));
            pc = next;
            break;
          }
          case 89 /* OP.RORI */: {
            const v = x[rs1];
            x[rd] = (v >>> w1) | (v << (32 - w1));
            pc = next;
            break;
          }
          case 90 /* OP.ORC_B */:
            x[rd] = orcb(x[rs1]);
            pc = next;
            break;
          case 91 /* OP.REV8 */:
            x[rd] = rev8(x[rs1]);
            pc = next;
            break;
          case 92 /* OP.BCLR */:
            x[rd] = x[rs1] & ~(1 << x[rs2]);
            pc = next;
            break;
          case 93 /* OP.BCLRI */:
            x[rd] = x[rs1] & ~(1 << w1);
            pc = next;
            break;
          case 94 /* OP.BEXT */:
            x[rd] = (x[rs1] >>> x[rs2]) & 1;
            pc = next;
            break;
          case 95 /* OP.BEXTI */:
            x[rd] = (x[rs1] >>> w1) & 1;
            pc = next;
            break;
          case 96 /* OP.BINV */:
            x[rd] = x[rs1] ^ (1 << x[rs2]);
            pc = next;
            break;
          case 97 /* OP.BINVI */:
            x[rd] = x[rs1] ^ (1 << w1);
            pc = next;
            break;
          case 98 /* OP.BSET */:
            x[rd] = x[rs1] | (1 << x[rs2]);
            pc = next;
            break;
          case 99 /* OP.BSETI */:
            x[rd] = x[rs1] | (1 << w1);
            pc = next;
            break;
          case 100 /* OP.PACK */:
            x[rd] = (x[rs1] & 0xffff) | (x[rs2] << 16);
            pc = next;
            break;
          case 101 /* OP.PACKH */:
            x[rd] = (x[rs1] & 0xff) | ((x[rs2] & 0xff) << 8);
            pc = next;
            break;
          case 102 /* OP.BREV8 */:
            x[rd] = brev8(x[rs1]);
            pc = next;
            break;
          case 103 /* OP.ZIP */:
            x[rd] = zip(x[rs1]);
            pc = next;
            break;
          case 104 /* OP.UNZIP */:
            x[rd] = unzip(x[rs1]);
            pc = next;
            break;
          case 105 /* OP.H3_BEXTM */: // rd = (rs1 >> rs2[4:0]) & (2^size − 1)
            x[rd] = (x[rs1] >>> x[rs2]) & ~(-2 << ((w0 >>> W0_AUX_SHIFT) & 7));
            pc = next;
            break;
          case 106 /* OP.H3_BEXTMI */:
            x[rd] = (x[rs1] >>> w1) & ~(-2 << ((w0 >>> W0_AUX_SHIFT) & 7));
            pc = next;
            break;
          case 107 /* OP.CM_PUSH */: {
            // s11 … s0, ra from sp − 4 down; then sp −= stack_adj
            const sp = x[2] >>> 0;
            if ((sp & 3) !== 0) {
              cycles = this.misaligned(CAUSE_STORE_MISALIGNED, (sp - 4) >>> 0, pc, cycles);
              pc = this.pc;
              continue;
            }
            let a = sp;
            for (let i = rlistCount((w0 >>> W0_AUX_SHIFT) & 15) - 1; i >= 0; i--) {
              a = (a - 4) >>> 0;
              bus.write32(a, x[RLIST_REGS[i]]);
            }
            x[2] = sp - w1;
            pc = next;
            break;
          }
          case 108 /* OP.CM_POP */:
          case 109 /* OP.CM_POPRET */:
          case 110 /* OP.CM_POPRETZ */: {
            // s11 … s0, ra from sp + stack_adj − 4 down; sp += stack_adj; [a0 = 0;] [ret]
            const sp = x[2] >>> 0;
            if ((sp & 3) !== 0) {
              cycles = this.misaligned(CAUSE_LOAD_MISALIGNED, (sp + w1 - 4) >>> 0, pc, cycles);
              pc = this.pc;
              continue;
            }
            let a = (sp + w1) >>> 0;
            for (let i = rlistCount((w0 >>> W0_AUX_SHIFT) & 15) - 1; i >= 0; i--) {
              a = (a - 4) >>> 0;
              x[RLIST_REGS[i]] = bus.read32(a);
            }
            x[2] = sp + w1;
            const op = w0 & 0x7f;
            if (op === 110 /* OP.CM_POPRETZ */) x[10] = 0;
            pc = op === 108 /* OP.CM_POP */ ? next : (x[1] & ~1) >>> 0;
            break;
          }
          case 111 /* OP.CM_MVSA01 */: // r1s' = a0, r2s' = a1
            x[rs1] = x[10];
            x[rs2] = x[11];
            pc = next;
            break;
          case 112 /* OP.CM_MVA01S */: {
            // a0 = r1s', a1 = r2s'
            const v1 = x[rs1];
            const v2 = x[rs2];
            x[10] = v1;
            x[11] = v2;
            pc = next;
            break;
          }
          case 113 /* OP.NOT */: // c.not
            x[rd] = ~x[rs1];
            pc = next;
            break;
          default:
            // INVALID, SRET and DRET (no supervisor mode, not in debug mode)
            cycles = this.illegal(pc, cycles);
            pc = this.pc;
            continue;
        }
        x[0] = 0;
        cycles++;
      }
    } finally {
      this.pc = pc;
      this.cycles = cycles;
    }
  }

  /**
   * Handles `attention` at an instruction boundary: a stop request (false: leave the loop), a
   * deliverable interrupt (taken), WFI (woken by any enabled pending interrupt, else asleep to
   * `end`: false).
   */
  private service(end: number): boolean {
    if (this.stopRequested) return false;
    const pending = this.mie & this.lines & IRQ_MASK;
    if (pending !== 0 && (this.mode === MODE_U || (this.mstatus & MIE) !== 0)) {
      this.waiting = false;
      for (let i = 0; i < IRQ_PRIORITY.length; i++) {
        const irq = IRQ_PRIORITY[i];
        if ((pending & (1 << irq)) !== 0) {
          this.trap((INTERRUPT_BIT | irq) >>> 0, 0);
          break;
        }
      }
      if (this.stopOnTrap) {
        this.stopRequested = true;
        return false;
      }
      return true;
    }
    if (this.waiting) {
      if (pending !== 0) {
        this.waiting = false;
        this.updateIrq();
        return true;
      }
      this.slept += end - this.cycles;
      this.cycles = end;
      return false;
    }
    this.attention = false;
    return true;
  }

  /** Recomputes `attention` after mie, mip, mstatus, the mode, WFI or the code changed. */
  private updateIrq(): void {
    const pending = this.mie & this.lines & IRQ_MASK;
    const deliverable = pending !== 0 && (this.mode === MODE_U || (this.mstatus & MIE) !== 0);
    this.attention = deliverable || this.waiting || this.stopRequested || this.codeChanged;
  }

  // ── Traps ───────────────────────────────────────────────────────────────────────────────

  /** Takes a trap at this.pc: `cause` is mcause (interrupt bit included), `tval` mtval. */
  trap(cause: number, tval: number): void {
    const interrupt = (cause & INTERRUPT_BIT) !== 0;
    this.mepc = (this.pc & ~1) >>> 0;
    this.mcause = cause >>> 0;
    this.mtval = this.writeMtval ? tval >>> 0 : 0;
    const mie = (this.mstatus & MIE) !== 0;
    this.mstatus = (this.mstatus & ~(MIE | MPIE | MPP_MASK)) | (mie ? MPIE : 0) | (this.mode << MPP_SHIFT);
    this.mode = MODE_M;
    this.reservation = -1;
    const base = (this.mtvec & ~3) >>> 0;
    this.pc = interrupt && (this.mtvec & 3) === 1 ? (base + 4 * (cause & 0x7fffffff)) >>> 0 : base;
    this.cycles++;
    this.trapCycles++;
    this.trapHook?.(this.mcause, this.mepc, this.mtval);
    this.updateIrq();
  }

  private mret(): void {
    const mpp = (this.mstatus & MPP_MASK) >>> MPP_SHIFT;
    const mpie = (this.mstatus & MPIE) !== 0;
    const lowest = this.profile.umode ? MODE_U : MODE_M;
    let status = (this.mstatus & ~(MIE | MPP_MASK)) | (mpie ? MIE : 0) | MPIE | (lowest << MPP_SHIFT);
    if (mpp !== MODE_M) status &= ~MPRV;
    this.mstatus = status;
    this.mode = mpp;
    this.reservation = -1;
    this.pc = this.mepc >>> 0;
    this.mretHook?.();
    this.updateIrq();
  }

  /** An illegal-instruction trap at `pc`; returns the new cycle count. */
  private illegal(pc: number, cycles: number): number {
    this.pc = pc;
    this.cycles = cycles;
    this.trap(CAUSE_ILLEGAL, this.instructionBits(pc));
    return this.cycles;
  }

  /** A misaligned load or store at `pc`; returns the new cycle count. */
  private misaligned(cause: number, address: number, pc: number, cycles: number): number {
    this.pc = pc;
    this.cycles = cycles;
    this.trap(cause, address);
    return this.cycles;
  }

  /** The bits of the instruction at `pc` (mtval of an illegal instruction), 0 if they can't be read. */
  private instructionBits(pc: number): number {
    try {
      let word = this.bus.fetch16(pc);
      if ((word & 3) === 3) word = (word | (this.bus.fetch16((pc + 2) >>> 0) << 16)) >>> 0;
      return word;
    } catch {
      return this.lastBits;
    }
  }

  /** A RiscvBusError at `address` during the instruction at this.pc (or its fetch). */
  private accessFault(address: number, fetching: boolean): void {
    if (fetching) {
      this.trap(CAUSE_INSTRUCTION_ACCESS, address);
      return;
    }
    // The instruction itself fetched fine: is it a load (or a pop) or a store/AMO?
    decode(this.instructionBits(this.pc), this.profile, this.d);
    const op = this.d[D_OP];
    const load = (op >= OP.LB && op <= OP.LHU) || op === OP.LR_W || (op >= OP.CM_POP && op <= OP.CM_POPRETZ);
    this.trap(load ? CAUSE_LOAD_ACCESS : CAUSE_STORE_ACCESS, address);
  }

  // ── CSRs ────────────────────────────────────────────────────────────────────────────────

  /** A CSR instruction; false: illegal. `w1` is csr | uimm << 12. */
  private csrInstruction(op: number, rd: number, rs1: number, w1: number): boolean {
    const csr = w1 & 0xfff;
    const immediate = op >= 49;
    const operand = immediate ? w1 >>> 12 : this.x[rs1];
    const kind = immediate ? op - 3 : op; // 46 RW, 47 RS, 48 RC
    const writes = kind === 46 || (immediate ? operand !== 0 : rs1 !== 0);
    if (csrPrivilege(csr) > this.mode) return false;
    if (writes && csrReadOnly(csr)) return false;
    const whole = this.csrHook?.accessCsr?.(csr, kind - 46, operand >>> 0, writes);
    if (whole !== undefined) {
      this.x[rd] = whole;
      this.x[0] = 0;
      return true;
    }
    let old = 0;
    if (kind !== 46 || rd !== 0) {
      const value = this.readCsr(csr);
      if (value === undefined) return false;
      old = value;
    }
    if (writes) {
      const value = kind === 46 ? operand : kind === 47 ? old | operand : old & ~operand;
      if (!this.writeCsr(csr, value >>> 0)) return false;
    }
    this.x[rd] = old;
    this.x[0] = 0;
    return true;
  }

  /** mcycle now (64-bit). */
  get mcycle(): number {
    return (this.mcountinhibit & 1) !== 0 ? this.cycleFrozen : this.cycles + this.cycleOffset;
  }

  /** minstret now (64-bit). */
  get minstret(): number {
    return (this.mcountinhibit & 4) !== 0 ? this.instretFrozen : this.instructions + this.instretOffset;
  }

  /** Sets mcycle as the next instruction will read it. */
  private setMcycle(value: number): void {
    if ((this.mcountinhibit & 1) !== 0) this.cycleFrozen = value;
    else this.cycleOffset = value - (this.cycles + 1);
  }

  /** Sets minstret as the next instruction will read it (the writing instruction doesn't count). */
  private setMinstret(value: number): void {
    if ((this.mcountinhibit & 4) !== 0) this.instretFrozen = value;
    else this.instretOffset = value - (this.instructions + 1);
  }

  /** A CSR's value as an instruction reads it, or undefined (no such CSR here or in the hook). */
  readCsr(csr: number): number | undefined {
    switch (csr) {
      case CSR.MSTATUS:
        return this.mstatus >>> 0;
      case CSR.MSTATUSH:
        return 0;
      case CSR.MISA:
        return this.misa;
      case CSR.MIE:
        return this.mie;
      case CSR.MIP:
        return this.mip;
      case CSR.MTVEC:
        return this.mtvec;
      case CSR.MSCRATCH:
        return this.mscratch >>> 0;
      case CSR.MEPC:
        return this.mepc >>> 0;
      case CSR.MCAUSE:
        return this.mcause >>> 0;
      case CSR.MTVAL:
        return this.mtval >>> 0;
      case CSR.MCOUNTEREN:
        return this.profile.umode ? this.mcounteren : undefined;
      case CSR.MCOUNTINHIBIT:
        return this.mcountinhibit;
      case CSR.MCYCLE:
        return this.mcycle % TWO32 >>> 0;
      case CSR.MCYCLEH:
        return Math.floor(this.mcycle / TWO32) >>> 0;
      case CSR.MINSTRET:
        return this.minstret % TWO32 >>> 0;
      case CSR.MINSTRETH:
        return Math.floor(this.minstret / TWO32) >>> 0;
      case CSR.CYCLE:
      case CSR.CYCLEH:
      case CSR.INSTRET:
      case CSR.INSTRETH: {
        const bit = (csr & 0x7f) === 0 ? 1 : 4;
        if (this.mode === MODE_U && (this.mcounteren & bit) === 0) return undefined;
        return this.readCsr(csr - 0xc00 + 0xb00);
      }
      case CSR.MVENDORID:
        return this.mvendorid;
      case CSR.MARCHID:
        return this.marchid;
      case CSR.MIMPID:
        return this.mimpid;
      case CSR.MHARTID:
        return this.mhartid;
      case CSR.MCONFIGPTR:
        return 0;
    }
    if (csr >= CSR.PMPCFG0 && csr < CSR.PMPCFG0 + 4) {
      const i = (csr - CSR.PMPCFG0) * 4;
      const c = this.pmpcfg;
      return (c[i] | (c[i + 1] << 8) | (c[i + 2] << 16) | (c[i + 3] << 24)) >>> 0;
    }
    if (csr >= CSR.PMPADDR0 && csr < CSR.PMPADDR0 + 16) return this.pmpaddr[csr - CSR.PMPADDR0];
    // The unimplemented hardware performance monitor: hardwired zero.
    if ((csr >= CSR.MHPMCOUNTER3 && csr <= 0xb1f) || (csr >= CSR.MHPMCOUNTER3H && csr <= 0xb9f) || (csr >= CSR.MHPMEVENT3 && csr <= 0x33f)) return 0;
    return this.csrHook?.readCsr(csr);
  }

  /** Writes a CSR as an instruction does; false: no such CSR. */
  writeCsr(csr: number, value: number): boolean {
    switch (csr) {
      case CSR.MSTATUS: {
        let status = value & MIE;
        status |= value & MPIE;
        if (this.profile.umode) {
          const mpp = (value & MPP_MASK) >>> MPP_SHIFT;
          status |= (mpp === MODE_U ? MODE_U : MODE_M) << MPP_SHIFT;
          status |= value & (MPRV | TW);
        } else status |= MODE_M << MPP_SHIFT;
        this.mstatus = status;
        this.updateIrq();
        return true;
      }
      case CSR.MSTATUSH:
      case CSR.MISA:
      case CSR.MIP: // MSIP/MTIP/MEIP are the SoC's lines: read-only here
      case CSR.MCONFIGPTR:
        return true;
      case CSR.MIE:
        this.mie = value & IRQ_MASK;
        this.updateIrq();
        return true;
      case CSR.MTVEC:
        this.mtvec = (value & ~2) >>> 0; // modes 0 (direct) and 1 (vectored)
        return true;
      case CSR.MSCRATCH:
        this.mscratch = value >>> 0;
        return true;
      case CSR.MEPC:
        this.mepc = (value & ~1) >>> 0;
        return true;
      case CSR.MCAUSE:
        this.mcause = value >>> 0;
        return true;
      case CSR.MTVAL:
        if (this.writeMtval) this.mtval = value >>> 0;
        return true;
      case CSR.MCOUNTEREN:
        if (!this.profile.umode) return false;
        this.mcounteren = value & 5;
        return true;
      case CSR.MCOUNTINHIBIT: {
        const cycle = this.mcycle;
        const instret = this.minstret;
        this.mcountinhibit = value & 5;
        this.cycleFrozen = cycle;
        this.instretFrozen = instret;
        // Counting again: continue from the frozen values (the writing instruction counts).
        this.cycleOffset = cycle - this.cycles;
        this.instretOffset = instret - this.instructions;
        return true;
      }
      case CSR.MCYCLE:
        this.setMcycle(Math.floor(this.mcycle / TWO32) * TWO32 + (value >>> 0));
        return true;
      case CSR.MCYCLEH:
        this.setMcycle((value >>> 0) * TWO32 + (this.mcycle % TWO32));
        return true;
      case CSR.MINSTRET:
        this.setMinstret(Math.floor(this.minstret / TWO32) * TWO32 + (value >>> 0));
        return true;
      case CSR.MINSTRETH:
        this.setMinstret((value >>> 0) * TWO32 + (this.minstret % TWO32));
        return true;
    }
    if (csr >= CSR.PMPCFG0 && csr < CSR.PMPCFG0 + 4) {
      for (let j = 0; j < 4; j++) {
        const e = (csr - CSR.PMPCFG0) * 4 + j;
        if (e >= this.pmpEntries || (this.pmpcfg[e] & 0x80) !== 0) continue;
        let b = (value >>> (8 * j)) & 0x9f;
        if ((b & 3) === 2) b &= ~2; // R = 0, W = 1 is reserved
        this.pmpcfg[e] = b;
      }
      return true;
    }
    if (csr >= CSR.PMPADDR0 && csr < CSR.PMPADDR0 + 16) {
      const e = csr - CSR.PMPADDR0;
      if (e >= this.pmpEntries || (this.pmpcfg[e] & 0x80) !== 0) return true;
      // A locked TOR entry above locks this address too.
      if (e + 1 < this.pmpEntries && (this.pmpcfg[e + 1] & 0x98) === 0x88) return true;
      this.pmpaddr[e] = value & 0x3fffffff;
      return true;
    }
    if ((csr >= CSR.MHPMCOUNTER3 && csr <= 0xb1f) || (csr >= CSR.MHPMCOUNTER3H && csr <= 0xb9f) || (csr >= CSR.MHPMEVENT3 && csr <= 0x33f)) return true;
    return this.csrHook?.writeCsr(csr, value) ?? false;
  }
}
