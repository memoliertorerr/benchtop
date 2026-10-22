/**
 * A faster Cortex-M0+ core for the RP2040 (BT75): rp2040js's `CortexM0Core` with its
 * `executeInstruction` replaced. Everything else is inherited unchanged — the exception model
 * (`checkForInterrupts`, `exceptionEntry`/`exceptionReturn`, `BXWritePC`), the NVIC and SysTick
 * fields rp2040js's PPB reads and writes, the special registers — so the chip around it can't
 * tell the difference.
 *
 * What changes is how an instruction is found and run. rp2040js tests the opcode against an
 * if-chain of ~90 patterns in a fixed order; here `OP_OF` (built once, by the same tests in the
 * same order, for every 16-bit first halfword) gives the instruction at once and a switch runs
 * it. The 32-bit encodings (first halfword 0xE800 and up) depend on their second halfword too,
 * so they stay one case that tests BL, DMB, DSB, ISB, MRS, MSR and UDF.W in rp2040js's order.
 * Instruction fetches and the common loads and stores read SRAM and flash from the arrays
 * rp2040js's bus reads (same ranges, same results); everything else goes through the bus as
 * before.
 *
 * Exactness is the point — results, flags, PC and cycles (with `cyclesIO`'s bus costs) equal the
 * stock core's, quirks included (a carry flag on a shift by 0 or by 32 and more, an unknown
 * 32-bit instruction advancing PC by 2): m0.test.ts runs both cores in lockstep on every Pico
 * fixture and compares their state after every instruction.
 */

import type { RP2040 } from 'rp2040js';

/** rp2040js's core (its class isn't exported: the fast core extends the class an RP2040's core has). */
export type StockCore = RP2040['core'];
type StockCoreClass = new (rp: RP2040) => StockCore;

const FLASH_START = 0x10000000;
const RAM_START = 0x20000000;
const SIO_START = 0xd0000000;
const APB_START = 0x40000000;
const PC = 15;
const SP = 13;
const LR = 14;
/** rp2040js's log component for the core (its warnings become the adapter's Problems). */
const LOG_NAME = 'CortexM0Core';

/** Instruction ids, in rp2040js's if-chain order (the first pattern that matches wins). */
export const OP = {
  UNKNOWN: 0,
  ADCS: 1,
  ADD_SP_IMM_RD: 2,
  ADD_SP_IMM: 3,
  ADDS_T1: 4,
  ADDS_T2: 5,
  ADDS_REG: 6,
  ADD_REG: 7,
  ADR: 8,
  ANDS: 9,
  ASRS_IMM: 10,
  ASRS_REG: 11,
  B_COND: 12,
  B: 13,
  BICS: 14,
  BKPT: 15,
  BLX: 16,
  BX: 17,
  CMN: 18,
  CMP_IMM: 19,
  CMP_REG: 20,
  CMP_REG_T2: 21,
  CPSID: 22,
  CPSIE: 23,
  EORS: 24,
  LDMIA: 25,
  LDR_IMM: 26,
  LDR_SP: 27,
  LDR_LIT: 28,
  LDR_REG: 29,
  LDRB_IMM: 30,
  LDRB_REG: 31,
  LDRH_IMM: 32,
  LDRH_REG: 33,
  LDRSB: 34,
  LDRSH: 35,
  LSLS_IMM: 36,
  LSLS_REG: 37,
  LSRS_IMM: 38,
  LSRS_REG: 39,
  MOV: 40,
  MOVS: 41,
  MULS: 42,
  MVNS: 43,
  ORRS: 44,
  POP: 45,
  PUSH: 46,
  REV: 47,
  REV16: 48,
  REVSH: 49,
  ROR: 50,
  NEGS: 51,
  NOP: 52,
  SBCS: 53,
  SEV: 54,
  STMIA: 55,
  STR_IMM: 56,
  STR_SP: 57,
  STR_REG: 58,
  STRB_IMM: 59,
  STRB_REG: 60,
  STRH_IMM: 61,
  STRH_REG: 62,
  SUB_SP_IMM: 63,
  SUBS_T1: 64,
  SUBS_T2: 65,
  SUBS_REG: 66,
  SVC: 67,
  SXTB: 68,
  SXTH: 69,
  TST: 70,
  UDF: 71,
  UXTB: 72,
  UXTH: 73,
  WFE: 74,
  WFI: 75,
  YIELD: 76,
  /** A 32-bit encoding: BL, DMB, DSB, ISB, MRS, MSR, UDF.W or unknown, by its second halfword. */
  WIDE: 77,
} as const;

/**
 * The instruction a 16-bit first halfword selects: rp2040js's tests (cortex-m0-core.js,
 * executeInstruction) in their order, with the second halfword taken as 0 — which only the
 * 32-bit encodings look at, and those are WIDE here.
 */
export function classify(opcode: number): number {
  if (opcode >> 12 === 0b1111 || opcode >> 11 === 0b11101) return OP.WIDE;
  if (opcode >> 6 === 0b0100000101) return OP.ADCS;
  if (opcode >> 11 === 0b10101) return OP.ADD_SP_IMM_RD;
  if (opcode >> 7 === 0b101100000) return OP.ADD_SP_IMM;
  if (opcode >> 9 === 0b0001110) return OP.ADDS_T1;
  if (opcode >> 11 === 0b00110) return OP.ADDS_T2;
  if (opcode >> 9 === 0b0001100) return OP.ADDS_REG;
  if (opcode >> 8 === 0b01000100) return OP.ADD_REG;
  if (opcode >> 11 === 0b10100) return OP.ADR;
  if (opcode >> 6 === 0b0100000000) return OP.ANDS;
  if (opcode >> 11 === 0b00010) return OP.ASRS_IMM;
  if (opcode >> 6 === 0b0100000100) return OP.ASRS_REG;
  if (opcode >> 12 === 0b1101 && ((opcode >> 9) & 0x7) !== 0b111) return OP.B_COND;
  if (opcode >> 11 === 0b11100) return OP.B;
  if (opcode >> 6 === 0b0100001110) return OP.BICS;
  if (opcode >> 8 === 0b10111110) return OP.BKPT;
  if (opcode >> 7 === 0b010001111 && (opcode & 0x7) === 0) return OP.BLX;
  if (opcode >> 7 === 0b010001110 && (opcode & 0x7) === 0) return OP.BX;
  if (opcode >> 6 === 0b0100001011) return OP.CMN;
  if (opcode >> 11 === 0b00101) return OP.CMP_IMM;
  if (opcode >> 6 === 0b0100001010) return OP.CMP_REG;
  if (opcode >> 8 === 0b01000101) return OP.CMP_REG_T2;
  if (opcode === 0xb672) return OP.CPSID;
  if (opcode === 0xb662) return OP.CPSIE;
  if (opcode >> 6 === 0b0100000001) return OP.EORS;
  if (opcode >> 11 === 0b11001) return OP.LDMIA;
  if (opcode >> 11 === 0b01101) return OP.LDR_IMM;
  if (opcode >> 11 === 0b10011) return OP.LDR_SP;
  if (opcode >> 11 === 0b01001) return OP.LDR_LIT;
  if (opcode >> 9 === 0b0101100) return OP.LDR_REG;
  if (opcode >> 11 === 0b01111) return OP.LDRB_IMM;
  if (opcode >> 9 === 0b0101110) return OP.LDRB_REG;
  if (opcode >> 11 === 0b10001) return OP.LDRH_IMM;
  if (opcode >> 9 === 0b0101101) return OP.LDRH_REG;
  if (opcode >> 9 === 0b0101011) return OP.LDRSB;
  if (opcode >> 9 === 0b0101111) return OP.LDRSH;
  if (opcode >> 11 === 0b00000) return OP.LSLS_IMM;
  if (opcode >> 6 === 0b0100000010) return OP.LSLS_REG;
  if (opcode >> 11 === 0b00001) return OP.LSRS_IMM;
  if (opcode >> 6 === 0b0100000011) return OP.LSRS_REG;
  if (opcode >> 8 === 0b01000110) return OP.MOV;
  if (opcode >> 11 === 0b00100) return OP.MOVS;
  if (opcode >> 6 === 0b0100001101) return OP.MULS;
  if (opcode >> 6 === 0b0100001111) return OP.MVNS;
  if (opcode >> 6 === 0b0100001100) return OP.ORRS;
  if (opcode >> 9 === 0b1011110) return OP.POP;
  if (opcode >> 9 === 0b1011010) return OP.PUSH;
  if (opcode >> 6 === 0b1011101000) return OP.REV;
  if (opcode >> 6 === 0b1011101001) return OP.REV16;
  if (opcode >> 6 === 0b1011101011) return OP.REVSH;
  if (opcode >> 6 === 0b0100000111) return OP.ROR;
  if (opcode >> 6 === 0b0100001001) return OP.NEGS;
  if (opcode === 0b1011111100000000) return OP.NOP;
  if (opcode >> 6 === 0b0100000110) return OP.SBCS;
  if (opcode === 0b1011111101000000) return OP.SEV;
  if (opcode >> 11 === 0b11000) return OP.STMIA;
  if (opcode >> 11 === 0b01100) return OP.STR_IMM;
  if (opcode >> 11 === 0b10010) return OP.STR_SP;
  if (opcode >> 9 === 0b0101000) return OP.STR_REG;
  if (opcode >> 11 === 0b01110) return OP.STRB_IMM;
  if (opcode >> 9 === 0b0101010) return OP.STRB_REG;
  if (opcode >> 11 === 0b10000) return OP.STRH_IMM;
  if (opcode >> 9 === 0b0101001) return OP.STRH_REG;
  if (opcode >> 7 === 0b101100001) return OP.SUB_SP_IMM;
  if (opcode >> 9 === 0b0001111) return OP.SUBS_T1;
  if (opcode >> 11 === 0b00111) return OP.SUBS_T2;
  if (opcode >> 9 === 0b0001101) return OP.SUBS_REG;
  if (opcode >> 8 === 0b11011111) return OP.SVC;
  if (opcode >> 6 === 0b1011001001) return OP.SXTB;
  if (opcode >> 6 === 0b1011001000) return OP.SXTH;
  if (opcode >> 6 === 0b0100001000) return OP.TST;
  if (opcode >> 8 === 0b11011110) return OP.UDF;
  if (opcode >> 6 === 0b1011001011) return OP.UXTB;
  if (opcode >> 6 === 0b1011001010) return OP.UXTH;
  if (opcode === 0b1011111100100000) return OP.WFE;
  if (opcode === 0b1011111100110000) return OP.WFI;
  if (opcode === 0b1011111100010000) return OP.YIELD;
  return OP.UNKNOWN;
}

/** Every first halfword's instruction (built once). */
export const OP_OF: Uint8Array = (() => {
  const table = new Uint8Array(65536);
  for (let opcode = 0; opcode < 65536; opcode++) table[opcode] = classify(opcode);
  return table;
})();

/** Set bits in a PUSH's 9-bit register list (r0–r7, lr). */
const BITS9: Uint8Array = (() => {
  const table = new Uint8Array(512);
  for (let i = 0; i < 512; i++) for (let b = i; b !== 0; b &= b - 1) table[i]++;
  return table;
})();

const signExtend8 = (value: number): number => (value << 24) >> 24;
const signExtend16 = (value: number): number => (value << 16) >> 16;

/** The fast core (its class is made from rp2040js's at run time). */
export type FastCore = InstanceType<ReturnType<typeof makeFastCore>>;

/** The fast core's class for rp2040js's core class (made once). */
let made: { base: StockCoreClass; fast: ReturnType<typeof makeFastCore> } | null = null;

/** A fast core for `rp`, to install as `rp.core` before the chip first runs (loadBootrom resets it). */
export function createFastCore(rp: RP2040): StockCore {
  const cls = rp.core.constructor as StockCoreClass;
  // BT80: core 1 is made after core 0 is installed: `rp.core` is already a fast core then.
  if (made !== null && (made.base === cls || (made.fast as unknown) === cls)) return new made.fast(rp);
  made = { base: cls, fast: makeFastCore(cls) };
  return new made.fast(rp);
}

function makeFastCore(Base: StockCoreClass) {
  return class FastM0Core extends Base {
    private readonly rp: RP2040;
    private readonly flash16: Uint16Array;
    private readonly flash32: Uint32Array;
    private readonly flashLength: number;
    private readonly sram8: Uint8Array;
    private readonly sram16: Uint16Array;
    private readonly sram32: Uint32Array;
    private readonly sramView: DataView;
    private readonly sramLength: number;

    constructor(rp: RP2040) {
      super(rp);
      this.rp = rp;
      this.flash16 = rp.flash16;
      this.flash32 = new Uint32Array(rp.flash.buffer, rp.flash.byteOffset, rp.flash.length >>> 2);
      this.flashLength = rp.flash.length;
      this.sram8 = rp.sram;
      this.sram16 = new Uint16Array(rp.sram.buffer, rp.sram.byteOffset, rp.sram.length >>> 1);
      this.sram32 = new Uint32Array(rp.sram.buffer, rp.sram.byteOffset, rp.sram.length >>> 2);
      this.sramView = rp.sramView;
      this.sramLength = rp.sram.length;
    }

    /** rp2040js's addUpdateFlags (private there). */
    private add(addend1: number, addend2: number): number {
      const unsignedSum = (addend1 + addend2) >>> 0;
      const signedSum = (addend1 | 0) + (addend2 | 0);
      const result = addend1 + addend2;
      this.N = !!(result & 0x80000000);
      this.Z = (result & 0xffffffff) === 0;
      this.C = result !== unsignedSum;
      this.V = (result | 0) !== signedSum;
      return result & 0xffffffff;
    }

    /** rp2040js's substractUpdateFlags (private there). */
    private sub(minuend: number, subtrahend: number): number {
      const result = minuend - subtrahend;
      this.N = !!(result & 0x80000000);
      this.Z = (result & 0xffffffff) === 0;
      this.C = minuend >= subtrahend;
      this.V = (!!(result & 0x80000000) && !(minuend & 0x80000000) && !!(subtrahend & 0x80000000)) || (!(result & 0x80000000) && !!(minuend & 0x80000000) && !(subtrahend & 0x80000000));
      return result;
    }

    /** The bus cost of an access (rp2040js's cyclesIO, without the call). */
    private static io(addr: number, write: boolean): number {
      const a = addr >>> 0;
      if (a >= SIO_START && a < SIO_START + 0x10000000) return 0;
      if (a >= APB_START && a < APB_START + 0x10000000) return write ? 4 : 3;
      return 1;
    }

    /** A halfword fetch: flash and SRAM from their arrays (rp2040js's readUint16 ranges), else the bus. */
    private fetch16(address: number): number {
      if (address >= FLASH_START && address < FLASH_START + this.flashLength) return this.flash16[(address - FLASH_START) >>> 1];
      if (address >= RAM_START && address < RAM_START + this.sramLength) return this.sram16[(address - RAM_START) >>> 1];
      return this.readUint16(address);
    }

    /**
     * A word load: aligned SRAM and flash (its first alias, where literal pools live) from their
     * arrays — the ranges and results of rp2040js's readUint32, without its three calls.
     */
    private load32(address: number): number {
      const a = address >>> 0;
      if ((a & 3) === 0) {
        if (a >= RAM_START && a < RAM_START + this.sramLength) return this.sramView.getUint32(a - RAM_START, true);
        if (a >= FLASH_START && a < FLASH_START + this.flashLength) return this.flash32[(a - FLASH_START) >>> 2];
      }
      return this.readUint32(address);
    }

    /** A word store: SRAM straight into its array (rp2040js's writeUint32 finds no peripheral there). */
    private store32(address: number, value: number): void {
      const a = address >>> 0;
      if (a >= RAM_START && a < RAM_START + this.sramLength) {
        this.sramView.setUint32(a - RAM_START, value, true);
        return;
      }
      this.writeUint32(address, value);
    }

    /** BT80: the core sleeps in a WFE (an event from the other core wakes it), not a WFI. */
    wfe = false;
    /** BT80: called on SEV while core 1 runs (rp2040js's SEV only logs; one core keeps that). */
    onSev: (() => void) | null = null;

    /** BT76: the loop runs while `retired` is below this; `cut` ends it after the instruction executing. */
    stopAt = 0;

    /** Ends `runCycles` after the instruction executing: an alarm due sooner, PIO starting, a clock change. */
    cut(): void {
      this.stopAt = 0;
    }

    /**
     * Cycles the instructions themselves took — what `executeInstruction` returns, summed. Not
     * `cycles`: rp2040js adds to that outside an instruction's count too (its SIO divider's 8),
     * and the adapter's time follows the instructions' counts, as it did with the stock core.
     */
    retired = 0;

    /**
     * BT76: instructions until `retired` reaches `stopRetired` or the run is cut — by the
     * adapter (`cut`: an earlier alarm, PIO starting, a clock change), by WFI/WFE putting the core
     * to sleep, or by a BKPT/UDF (our bootrom's ROM calls charge cycles the adapter accounts for).
     * The same instructions, one call for the lot.
     */
    runCycles(stopRetired: number): void {
      if (this.waiting) return;
      const before = this.retired;
      this.stopAt = stopRetired;
      try {
        this.loop();
      } finally {
        this.cycles += this.retired - before; // the loop leaves `cycles` to its callers
      }
    }

    /** One instruction (rp2040js's API: the adapter's single steps and the lockstep test use it). */
    override executeInstruction(): number {
      const before = this.retired;
      this.stopAt = 0; // the loop runs its body once
      try {
        this.loop();
      } finally {
        this.cycles += this.retired - before;
      }
      return this.retired - before;
    }

    /**
     * The interpreter: one instruction, then more while `retired` is below `stopAt` — one call
     * for a whole batch, so the switch, the locals and the fields it reads stay hot. The case
     * labels are literals (OP's values, named in comments): V8 builds a jump table only for
     * constant labels — `case OP.ADCS:` would be a property load and a compare per case. The
     * hottest cases (B<cond>, CMP #imm, LDR literal, PUSH/POP on an SRAM stack, BL, BX) do their
     * helpers' work inline, for the same results.
     */
    private loop(): void {
      const r = this.registers;
      let retired = this.retired;
      const flash16 = this.flash16;
      const flash32 = this.flash32;
      const flashLength = this.flashLength;
      const sram32 = this.sram32;
      const sramLength = this.sramLength;
      do {
        if (this.interruptsUpdated) {
          if (this.checkForInterrupts()) this.waiting = false;
        }
        const pc = r[PC];
        const opcodePC = pc & ~1;
        const inFlash = opcodePC - FLASH_START;
        const opcode = inFlash >= 0 && inFlash < flashLength ? flash16[inFlash >>> 1] : this.fetch16(opcodePC);
        r[PC] = pc + 2;
        let deltaCycles = 1;
        switch (OP_OF[opcode]) {
          case 1 /* ADCS */: {
            const Rdn = opcode & 0x7;
            r[Rdn] = this.add(r[(opcode >> 3) & 0x7], r[Rdn] + (this.C ? 1 : 0));
            break;
          }
          case 2 /* ADD_SP_IMM_RD */:
            r[(opcode >> 8) & 0x7] = r[SP] + ((opcode & 0xff) << 2);
            break;
          case 3 /* ADD_SP_IMM */:
            r[SP] = (r[SP] + ((opcode & 0x7f) << 2)) & ~0x3;
            break;
          case 4 /* ADDS_T1 */:
            r[opcode & 0x7] = this.add(r[(opcode >> 3) & 0x7], (opcode >> 6) & 0x7);
            break;
          case 5 /* ADDS_T2 */: {
            const Rdn = (opcode >> 8) & 0x7;
            r[Rdn] = this.add(r[Rdn], opcode & 0xff);
            break;
          }
          case 6 /* ADDS_REG */:
            r[opcode & 0x7] = this.add(r[(opcode >> 3) & 0x7], r[(opcode >> 6) & 0x7]);
            break;
          case 7 /* ADD_REG */: {
            const Rm = (opcode >> 3) & 0xf;
            const Rdn = ((opcode & 0x80) >> 4) | (opcode & 0x7);
            const left = Rdn === PC ? r[PC] + 2 : r[Rdn];
            const right = Rm === PC ? r[PC] + 2 : r[Rm];
            const result = left + right;
            if (Rdn !== SP && Rdn !== PC) r[Rdn] = result;
            else if (Rdn === PC) {
              r[Rdn] = result & ~0x1;
              deltaCycles++;
            } else r[Rdn] = result & ~0x3;
            break;
          }
          case 8 /* ADR */:
            r[(opcode >> 8) & 0x7] = (opcodePC & 0xfffffffc) + 4 + ((opcode & 0xff) << 2);
            break;
          case 9 /* ANDS */: {
            const Rdn = opcode & 0x7;
            const result = r[Rdn] & r[(opcode >> 3) & 0x7];
            r[Rdn] = result;
            this.N = !!(result & 0x80000000);
            this.Z = (result & 0xffffffff) === 0;
            break;
          }
          case 10 /* ASRS_IMM */: {
            const imm5 = (opcode >> 6) & 0x1f;
            const input = r[(opcode >> 3) & 0x7];
            const shiftN = imm5 ? imm5 : 32;
            const result = shiftN < 32 ? input >> shiftN : (input & 0x80000000) >> 31;
            r[opcode & 0x7] = result;
            this.N = !!(result & 0x80000000);
            this.Z = (result & 0xffffffff) === 0;
            this.C = !!(input & (1 << (shiftN - 1)));
            break;
          }
          case 11 /* ASRS_REG */: {
            const Rdn = opcode & 0x7;
            const input = r[Rdn];
            const amount = r[(opcode >> 3) & 0x7] & 0xff;
            const shiftN = amount < 32 ? amount : 32;
            const result = shiftN < 32 ? input >> shiftN : (input & 0x80000000) >> 31;
            r[Rdn] = result;
            this.N = !!(result & 0x80000000);
            this.Z = (result & 0xffffffff) === 0;
            this.C = !!(input & (1 << (shiftN - 1)));
            break;
          }
          case 12 /* B_COND */: {
            // checkCondition inline (conditions 14 and 15 are UDF and SVC, never here)
            let pass: boolean;
            switch ((opcode >> 9) & 0x7) {
              case 0:
                pass = this.Z;
                break;
              case 1:
                pass = this.C;
                break;
              case 2:
                pass = this.N;
                break;
              case 3:
                pass = this.V;
                break;
              case 4:
                pass = this.C && !this.Z;
                break;
              case 5:
                pass = this.N === this.V;
                break;
              default:
                pass = this.N === this.V && !this.Z;
            }
            if (pass !== ((opcode & 0x100) !== 0)) {
              let imm8 = (opcode & 0xff) << 1;
              if (imm8 & (1 << 8)) imm8 = (imm8 & 0x1ff) - 0x200;
              r[PC] = pc + 4 + imm8; // r[PC] was pc + 2
              deltaCycles++;
            }
            break;
          }
          case 13 /* B */: {
            let imm11 = (opcode & 0x7ff) << 1;
            if (imm11 & (1 << 11)) imm11 = (imm11 & 0x7ff) - 0x800;
            r[PC] = pc + 4 + imm11; // r[PC] was pc + 2
            deltaCycles++;
            break;
          }
          case 14 /* BICS */: {
            const Rdn = opcode & 0x7;
            const result = (r[Rdn] &= ~r[(opcode >> 3) & 0x7]);
            this.N = !!(result & 0x80000000);
            this.Z = result === 0;
            break;
          }
          case 15 /* BKPT */:
            this.breakRewind = 2;
            this.rp.onBreak(opcode & 0xff);
            this.stopAt = 0;
            break;
          case 16 /* BLX */: {
            const Rm = (opcode >> 3) & 0xf;
            r[LR] = r[PC] | 0x1;
            r[PC] = r[Rm] & ~1;
            deltaCycles++;
            this.blTaken(this, true);
            break;
          }
          case 17 /* BX */: {
            const target = r[(opcode >> 3) & 0xf];
            if (target >>> 28 === 0xf) this.BXWritePC(target); // maybe an exception return
            else r[PC] = target & ~1;
            deltaCycles++;
            break;
          }
          case 18 /* CMN */:
            this.add(r[opcode & 0x7], r[(opcode >> 3) & 0x7]);
            break;
          case 19 /* CMP_IMM */: {
            // sub() inline; an 8-bit subtrahend never has bit 31 set
            const minuend = r[(opcode >> 8) & 0x7];
            const imm = opcode & 0xff;
            const result = minuend - imm;
            this.N = !!(result & 0x80000000);
            this.Z = (result & 0xffffffff) === 0;
            this.C = minuend >= imm;
            this.V = !(result & 0x80000000) && !!(minuend & 0x80000000);
            break;
          }
          case 20 /* CMP_REG */:
            this.sub(r[opcode & 0x7], r[(opcode >> 3) & 0x7]);
            break;
          case 21 /* CMP_REG_T2 */:
            this.sub(r[((opcode >> 4) & 0x8) | (opcode & 0x7)], r[(opcode >> 3) & 0xf]);
            break;
          case 22 /* CPSID */:
            this.PM = true;
            break;
          case 23 /* CPSIE */:
            this.PM = false;
            this.interruptsUpdated = true;
            break;
          case 24 /* EORS */: {
            const Rdn = opcode & 0x7;
            const result = r[(opcode >> 3) & 0x7] ^ r[Rdn];
            r[Rdn] = result;
            this.N = !!(result & 0x80000000);
            this.Z = result === 0;
            break;
          }
          case 25 /* LDMIA */: {
            const Rn = (opcode >> 8) & 0x7;
            const list = opcode & 0xff;
            let address = r[Rn];
            for (let i = 0; i < 8; i++) {
              if (list & (1 << i)) {
                r[i] = this.load32(address);
                address += 4;
                deltaCycles++;
              }
            }
            if (!(list & (1 << Rn))) r[Rn] = address;
            break;
          }
          case 26 /* LDR_IMM */: {
            const addr = r[(opcode >> 3) & 0x7] + (((opcode >> 6) & 0x1f) << 2);
            deltaCycles += FastM0Core.io(addr, false);
            r[opcode & 0x7] = this.load32(addr);
            break;
          }
          case 27 /* LDR_SP */: {
            const addr = r[SP] + ((opcode & 0xff) << 2);
            deltaCycles += FastM0Core.io(addr, false);
            r[(opcode >> 8) & 0x7] = this.load32(addr);
            break;
          }
          case 28 /* LDR_LIT */: {
            const addr = ((r[PC] + 2) & 0xfffffffc) + ((opcode & 0xff) << 2);
            const at = addr - FLASH_START;
            if (at >= 0 && at < flashLength) {
              deltaCycles++; // io(): flash costs 1
              r[(opcode >> 8) & 7] = flash32[at >>> 2];
            } else {
              deltaCycles += FastM0Core.io(addr, false);
              r[(opcode >> 8) & 7] = this.load32(addr);
            }
            break;
          }
          case 29 /* LDR_REG */: {
            const addr = r[(opcode >> 6) & 0x7] + r[(opcode >> 3) & 0x7];
            deltaCycles += FastM0Core.io(addr, false);
            r[opcode & 0x7] = this.load32(addr);
            break;
          }
          case 30 /* LDRB_IMM */: {
            const addr = r[(opcode >> 3) & 0x7] + ((opcode >> 6) & 0x1f);
            deltaCycles += FastM0Core.io(addr, false);
            r[opcode & 0x7] = addr >= RAM_START && addr < RAM_START + this.sramLength ? this.sram8[addr - RAM_START] : this.readUint8(addr);
            break;
          }
          case 31 /* LDRB_REG */: {
            const addr = r[(opcode >> 6) & 0x7] + r[(opcode >> 3) & 0x7];
            deltaCycles += FastM0Core.io(addr, false);
            r[opcode & 0x7] = addr >= RAM_START && addr < RAM_START + this.sramLength ? this.sram8[addr - RAM_START] : this.readUint8(addr);
            break;
          }
          case 32 /* LDRH_IMM */: {
            const addr = r[(opcode >> 3) & 0x7] + (((opcode >> 6) & 0x1f) << 1);
            deltaCycles += FastM0Core.io(addr, false);
            r[opcode & 0x7] = this.readUint16(addr);
            break;
          }
          case 33 /* LDRH_REG */: {
            const addr = r[(opcode >> 6) & 0x7] + r[(opcode >> 3) & 0x7];
            deltaCycles += FastM0Core.io(addr, false);
            r[opcode & 0x7] = this.readUint16(addr);
            break;
          }
          case 34 /* LDRSB */: {
            const addr = r[(opcode >> 6) & 0x7] + r[(opcode >> 3) & 0x7];
            deltaCycles += FastM0Core.io(addr, false);
            r[opcode & 0x7] = signExtend8(this.readUint8(addr));
            break;
          }
          case 35 /* LDRSH */: {
            const addr = r[(opcode >> 6) & 0x7] + r[(opcode >> 3) & 0x7];
            deltaCycles += FastM0Core.io(addr, false);
            r[opcode & 0x7] = signExtend16(this.readUint16(addr));
            break;
          }
          case 36 /* LSLS_IMM */: {
            const imm5 = (opcode >> 6) & 0x1f;
            const input = r[(opcode >> 3) & 0x7];
            const result = input << imm5;
            r[opcode & 0x7] = result;
            this.N = !!(result & 0x80000000);
            this.Z = result === 0;
            this.C = imm5 ? !!(input & (1 << (32 - imm5))) : this.C;
            break;
          }
          case 37 /* LSLS_REG */: {
            const Rdn = opcode & 0x7;
            const input = r[Rdn];
            const shiftCount = r[(opcode >> 3) & 0x7] & 0xff;
            const result = shiftCount >= 32 ? 0 : input << shiftCount;
            r[Rdn] = result;
            this.N = !!(result & 0x80000000);
            this.Z = result === 0;
            this.C = shiftCount ? !!(input & (1 << (32 - shiftCount))) : this.C;
            break;
          }
          case 38 /* LSRS_IMM */: {
            const imm5 = (opcode >> 6) & 0x1f;
            const input = r[(opcode >> 3) & 0x7];
            const result = imm5 ? input >>> imm5 : 0;
            r[opcode & 0x7] = result;
            this.N = !!(result & 0x80000000);
            this.Z = result === 0;
            this.C = !!((input >>> (imm5 ? imm5 - 1 : 31)) & 0x1);
            break;
          }
          case 39 /* LSRS_REG */: {
            const Rdn = opcode & 0x7;
            const shiftAmount = r[(opcode >> 3) & 0x7] & 0xff;
            const input = r[Rdn];
            const result = shiftAmount < 32 ? input >>> shiftAmount : 0;
            r[Rdn] = result;
            this.N = !!(result & 0x80000000);
            this.Z = result === 0;
            this.C = shiftAmount <= 32 ? !!((input >>> (shiftAmount - 1)) & 0x1) : false;
            break;
          }
          case 40 /* MOV */: {
            const Rm = (opcode >> 3) & 0xf;
            const Rd = ((opcode >> 4) & 0x8) | (opcode & 0x7);
            let value = Rm === PC ? r[PC] + 2 : r[Rm];
            if (Rd === PC) {
              deltaCycles++;
              value &= ~1;
            } else if (Rd === SP) value &= ~3;
            r[Rd] = value;
            break;
          }
          case 41 /* MOVS */: {
            const value = opcode & 0xff;
            r[(opcode >> 8) & 7] = value;
            this.N = false;
            this.Z = value === 0;
            break;
          }
          case 42 /* MULS */: {
            const Rdm = opcode & 0x7;
            const result = Math.imul(r[(opcode >> 3) & 0x7], r[Rdm]);
            r[Rdm] = result;
            this.N = !!(result & 0x80000000);
            this.Z = (result & 0xffffffff) === 0;
            break;
          }
          case 43 /* MVNS */: {
            const result = ~r[(opcode >> 3) & 7];
            r[opcode & 7] = result;
            this.N = !!(result & 0x80000000);
            this.Z = result === 0;
            break;
          }
          case 44 /* ORRS */: {
            const Rdn = opcode & 0x7;
            const result = r[Rdn] | r[(opcode >> 3) & 0x7];
            r[Rdn] = result;
            this.N = !!(result & 0x80000000);
            this.Z = (result & 0xffffffff) === 0;
            break;
          }
          case 45 /* POP */: {
            let address = r[SP];
            const at = address - RAM_START;
            if (at >= 0 && at + 36 <= sramLength && (at & 3) === 0) {
              // the stack in SRAM (load32's fast path, one range check for the lot)
              let word = at >>> 2;
              for (let bits = opcode & 0xff; bits !== 0; bits &= bits - 1) {
                r[31 - Math.clz32(bits & -bits)] = sram32[word++]; // the lowest register first
                deltaCycles++;
              }
              if (opcode & 0x100) {
                const target = sram32[word++];
                r[SP] = (RAM_START + (word << 2)) & ~0x3;
                if (target >>> 28 === 0xf) this.BXWritePC(target); // maybe an exception return
                else r[PC] = target & ~1;
                deltaCycles += 2;
              } else r[SP] = (RAM_START + (word << 2)) & ~0x3;
              break;
            }
            for (let i = 0; i <= 7; i++) {
              if (opcode & (1 << i)) {
                r[i] = this.load32(address);
                address += 4;
                deltaCycles++;
              }
            }
            if ((opcode >> 8) & 1) {
              r[SP] = (address + 4) & ~0x3;
              this.BXWritePC(this.load32(address));
              deltaCycles += 2;
            } else r[SP] = address & ~0x3;
            break;
          }
          case 46 /* PUSH */: {
            const bitCount = BITS9[opcode & 0x1ff];
            let address = r[SP] - 4 * bitCount;
            const at = address - RAM_START;
            if (at >= 0 && at + 4 * bitCount <= sramLength && (at & 3) === 0) {
              // the stack in SRAM (store32's fast path, one range check for the lot)
              let word = at >>> 2;
              for (let bits = opcode & 0xff; bits !== 0; bits &= bits - 1) {
                sram32[word++] = r[31 - Math.clz32(bits & -bits)]; // the lowest register first
                deltaCycles++;
              }
              if (opcode & 0x100) sram32[word] = r[LR];
              r[SP] = address & ~0x3;
              break;
            }
            for (let i = 0; i <= 7; i++) {
              if (opcode & (1 << i)) {
                this.store32(address, r[i]);
                deltaCycles++;
                address += 4;
              }
            }
            if (opcode & (1 << 8)) this.store32(address, r[LR]);
            r[SP] = (r[SP] - 4 * bitCount) & ~0x3;
            break;
          }
          case 47 /* REV */: {
            const input = r[(opcode >> 3) & 0x7];
            r[opcode & 0x7] = ((input & 0xff) << 24) | (((input >> 8) & 0xff) << 16) | (((input >> 16) & 0xff) << 8) | ((input >> 24) & 0xff);
            break;
          }
          case 48 /* REV16 */: {
            const input = r[(opcode >> 3) & 0x7];
            r[opcode & 0x7] = (((input >> 16) & 0xff) << 24) | (((input >> 24) & 0xff) << 16) | ((input & 0xff) << 8) | ((input >> 8) & 0xff);
            break;
          }
          case 49 /* REVSH */: {
            const input = r[(opcode >> 3) & 0x7];
            r[opcode & 0x7] = signExtend16(((input & 0xff) << 8) | ((input >> 8) & 0xff));
            break;
          }
          case 50 /* ROR */: {
            const Rdn = opcode & 0x7;
            const input = r[Rdn];
            const shift = (r[(opcode >> 3) & 0x7] & 0xff) % 32;
            const result = (input >>> shift) | (input << (32 - shift));
            r[Rdn] = result;
            this.N = !!(result & 0x80000000);
            this.Z = result === 0;
            this.C = !!(result & 0x80000000);
            break;
          }
          case 51 /* NEGS */:
            r[opcode & 0x7] = this.sub(0, r[(opcode >> 3) & 0x7]);
            break;
          case 52 /* NOP */:
            break;
          case 53 /* SBCS */: {
            const Rdn = opcode & 0x7;
            r[Rdn] = this.sub(r[Rdn], r[(opcode >> 3) & 0x7] + (1 - (this.C ? 1 : 0)));
            break;
          }
          case 54 /* SEV */:
            this.logger.info(LOG_NAME, 'SEV');
            this.onSev?.();
            break;
          case 55 /* STMIA */: {
            const Rn = (opcode >> 8) & 0x7;
            const list = opcode & 0xff;
            let address = r[Rn];
            for (let i = 0; i < 8; i++) {
              if (list & (1 << i)) {
                this.store32(address, r[i]);
                address += 4;
                deltaCycles++;
              }
            }
            if (!(list & (1 << Rn))) r[Rn] = address;
            break;
          }
          case 56 /* STR_IMM */: {
            const address = r[(opcode >> 3) & 0x7] + (((opcode >> 6) & 0x1f) << 2);
            deltaCycles += FastM0Core.io(address, true);
            this.store32(address, r[opcode & 0x7]);
            break;
          }
          case 57 /* STR_SP */: {
            const address = r[SP] + ((opcode & 0xff) << 2);
            deltaCycles += FastM0Core.io(address, true);
            this.store32(address, r[(opcode >> 8) & 0x7]);
            break;
          }
          case 58 /* STR_REG */: {
            const address = r[(opcode >> 6) & 0x7] + r[(opcode >> 3) & 0x7];
            deltaCycles += FastM0Core.io(address, true);
            this.store32(address, r[opcode & 0x7]);
            break;
          }
          case 59 /* STRB_IMM */: {
            const address = r[(opcode >> 3) & 0x7] + ((opcode >> 6) & 0x1f);
            deltaCycles += FastM0Core.io(address, true);
            if (address >= RAM_START && address < RAM_START + this.sramLength) this.sram8[address - RAM_START] = r[opcode & 0x7];
            else this.writeUint8(address, r[opcode & 0x7]);
            break;
          }
          case 60 /* STRB_REG */: {
            const address = r[(opcode >> 6) & 0x7] + r[(opcode >> 3) & 0x7];
            deltaCycles += FastM0Core.io(address, true);
            if (address >= RAM_START && address < RAM_START + this.sramLength) this.sram8[address - RAM_START] = r[opcode & 0x7];
            else this.writeUint8(address, r[opcode & 0x7]);
            break;
          }
          case 61 /* STRH_IMM */: {
            const address = r[(opcode >> 3) & 0x7] + (((opcode >> 6) & 0x1f) << 1);
            deltaCycles += FastM0Core.io(address, true);
            this.writeUint16(address, r[opcode & 0x7]);
            break;
          }
          case 62 /* STRH_REG */: {
            const address = r[(opcode >> 6) & 0x7] + r[(opcode >> 3) & 0x7];
            deltaCycles += FastM0Core.io(address, true);
            this.writeUint16(address, r[opcode & 0x7]);
            break;
          }
          case 63 /* SUB_SP_IMM */:
            r[SP] = (r[SP] - ((opcode & 0x7f) << 2)) & ~0x3;
            break;
          case 64 /* SUBS_T1 */:
            r[opcode & 0x7] = this.sub(r[(opcode >> 3) & 0x7], (opcode >> 6) & 0x7);
            break;
          case 65 /* SUBS_T2 */: {
            const Rdn = (opcode >> 8) & 0x7;
            r[Rdn] = this.sub(r[Rdn], opcode & 0xff);
            break;
          }
          case 66 /* SUBS_REG */:
            r[opcode & 0x7] = this.sub(r[(opcode >> 3) & 0x7], r[(opcode >> 6) & 0x7]);
            break;
          case 67 /* SVC */:
            this.pendingSVCall = true;
            this.interruptsUpdated = true;
            break;
          case 68 /* SXTB */:
            r[opcode & 0x7] = signExtend8(r[(opcode >> 3) & 0x7]);
            break;
          case 69 /* SXTH */:
            r[opcode & 0x7] = signExtend16(r[(opcode >> 3) & 0x7]);
            break;
          case 70 /* TST */: {
            const result = r[opcode & 0x7] & r[(opcode >> 3) & 0x7];
            this.N = !!(result & 0x80000000);
            this.Z = result === 0;
            break;
          }
          case 71 /* UDF */:
            this.breakRewind = 2;
            this.rp.onBreak(opcode & 0xff);
            this.stopAt = 0;
            break;
          case 72 /* UXTB */:
            r[opcode & 0x7] = r[(opcode >> 3) & 0x7] & 0xff;
            break;
          case 73 /* UXTH */:
            r[opcode & 0x7] = r[(opcode >> 3) & 0x7] & 0xffff;
            break;
          case 74 /* WFE */:
            deltaCycles++;
            if (this.eventRegistered) this.eventRegistered = false;
            else {
              this.waiting = true;
              this.wfe = true;
              this.stopAt = 0;
            }
            break;
          case 75 /* WFI */:
            deltaCycles++;
            this.waiting = true;
            this.wfe = false;
            this.stopAt = 0;
            break;
          case 76 /* YIELD */:
            this.logger.info(LOG_NAME, 'Yield');
            break;
          case 77 /* WIDE */: {
            // BL, the common one, inline; the rest in wide() (rp2040js's order: BL is tested first).
            const opcode2 = inFlash >= 0 && inFlash + 2 < flashLength ? flash16[(inFlash + 2) >>> 1] : this.fetch16(opcodePC + 2);
            if (opcode >> 11 === 0b11110 && opcode2 >> 14 === 0b11 && ((opcode2 >> 12) & 0x1) === 1) {
              const S = (opcode >> 10) & 0x1;
              const I1 = 1 - (S ^ ((opcode2 >> 13) & 0x1));
              const I2 = 1 - (S ^ ((opcode2 >> 11) & 0x1));
              const imm32 = ((S ? 0b11111111 : 0) << 24) | ((I1 << 23) | (I2 << 22) | ((opcode & 0x3ff) << 12) | ((opcode2 & 0x7ff) << 1));
              r[LR] = (pc + 4) | 0x1; // r[PC] was pc + 2
              r[PC] = pc + 4 + imm32;
              deltaCycles += 2;
              this.blTaken(this, false);
            } else deltaCycles = this.wide(opcode, opcode2, opcodePC, deltaCycles);
            break;
          }
          default:
            this.unknown(opcode, 0, opcodePC);
        }
        retired += deltaCycles;
        this.retired = retired; // `cycles` catches up when the loop returns (runCycles)
      } while (retired < this.stopAt);
    }

    /** The 32-bit encodings other than BL, tested in rp2040js's order. */
    private wide(opcode: number, opcode2: number, opcodePC: number, cycles: number): number {
      const r = this.registers;
      if (opcode === 0xf3bf && ((opcode2 & 0xfff0) === 0x8f50 || (opcode2 & 0xfff0) === 0x8f40 || (opcode2 & 0xfff0) === 0x8f60)) {
        // DMB, DSB, ISB
        r[PC] += 2;
        return cycles + 2;
      }
      if (opcode === 0b1111001111101111 && opcode2 >> 12 === 0b1000) {
        r[(opcode2 >> 8) & 0xf] = this.readSpecialRegister(opcode2 & 0xff);
        r[PC] += 2;
        return cycles + 2;
      }
      if (opcode >> 4 === 0b111100111000 && opcode2 >> 8 === 0b10001000) {
        this.writeSpecialRegister(opcode2 & 0xff, r[opcode & 0xf]);
        r[PC] += 2;
        return cycles + 2;
      }
      if (opcode >> 4 === 0b111101111111 && opcode2 >> 12 === 0b1010) {
        this.breakRewind = 4;
        this.rp.onBreak(((opcode & 0xf) << 12) | (opcode2 & 0xfff));
        r[PC] += 2;
        this.stopAt = 0;
        return cycles;
      }
      this.unknown(opcode, opcode2, opcodePC);
      return cycles;
    }

    private unknown(opcode: number, opcode2: number, opcodePC: number): void {
      this.logger.warn(LOG_NAME, `Warning: Instruction at ${opcodePC.toString(16)} is not implemented yet!`);
      this.logger.warn(LOG_NAME, `Opcode: 0x${opcode.toString(16)} (0x${opcode2.toString(16)})`);
    }
  };
}
