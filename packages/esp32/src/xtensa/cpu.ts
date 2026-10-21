/**
 * The Xtensa LX6 core of the ESP32: the core ISA and Code Density (BT28); the windowed
 * register option, XEA2 exceptions, interrupts at levels 1–7, the special/user register file,
 * CCOUNT/CCOMPARE, zero-overhead loops and the ERI port (BT29); MUL16/MUL32/MUL32_HIGH/DIV32,
 * booleans, S32C1I/L32AI/S32RI, the region-protection TLB ops (BT30) here, and MAC16 and the
 * FPU in ops/. What's left faults "unimplemented: <mnemonic>": the DFP accelerator's f64*
 * ops and RF64R/WF64R (no libgcc routine uses them), Espressif's EXPSTATE/IMPWIRE TIE ops, the
 * OCD-only LDDR32.P/SDDR32.P, and PITLB/PDTLB (result format unknown).
 *
 * Registers: `ar` holds the 64 physical address registers; logical aN is
 * ar[(WINDOWBASE·4 + n) & 63].
 *
 * Timing (flat model): every instruction takes one cycle; CCOUNT = cycles + an offset set by
 * WSR.CCOUNT. Taking an exception or interrupt costs nothing; WAITI sleeps by skipping cycles
 * to the next CCOMPARE match (or the end of the run). The bus may add stall cycles (`stall`,
 * BT33's flash cache misses).
 *
 * The run loops stop at `stopAt` (the run's end or the next CCOMPARE match, whichever is first —
 * no per-instruction timer compare). inner() (no predecode cache) tests, before every
 * instruction, `irqCheck` — a boolean recomputed only when INTERRUPT, INTENABLE, PS or an
 * external line changes — and WAITI's `waiting`, then fetches and decodes. With the cache
 * (BT37, `predecode`, icache.ts) innerCached() makes those tests and interpret() runs from the
 * cache until stopAt, which drops to now whenever one of them would change (interpret()'s
 * comment has the rules), so both loops act on the same instruction boundaries. Either way an
 * instruction is a packed entry run by interpret()'s switch; the window check compares the
 * entry's precomputed quarter with `armedLimit` (window overflow is possible only while
 * PS.WOE = 1, PS.EXCM = 0 and a live frame owns a quarter of the 16 ahead). No allocation,
 * closures or BigInt per instruction (AGENTS rule 3).
 *
 * Exceptions follow XEA2: EPC1 and the user (PS.UM = 1) or kernel vector, or — with PS.EXCM
 * already set — DEPC and the double-exception vector. A bus error (XtensaBusError) becomes the
 * exception its `exccause` names. BREAK raises the debug exception (level 6) unless `breakHook`
 * claims it (the bare test machine halts on `break 1, 15`).
 */

import type { XtensaBus } from './bus.ts';
import { BUS_YIELD, XtensaBusError } from './bus.ts';
import * as dec from './decode.ts';
import * as exc from './exceptions.ts';
import * as icache from './icache.ts';
import { type CodeBus, ICache, isCodeBus } from './icache.ts';
import * as irq from './interrupts.ts';
import * as isa from './isa.ts';
import { executeFpu } from './ops/fpu.ts';
import { executeMac16, MAC_KIND } from './ops/mac16.ts';
import * as muldiv from './ops/muldiv.ts';
import { SR, UR } from './regs.ts';

// Imported bindings copied to module constants once: under vitest's module transform every
// access to an imported name is a getter call, and the loop below reads dozens per instruction.
const OP = isa.OP;
const OPS = isa.OPS;
const OP_INVALID = isa.OP_INVALID;
const OPND = isa.OPND;
const decode = dec.decode;
const target = dec.target;
const lengthOf = dec.lengthOf;
const ENTRY = icache.ENTRY;
const IC_PAGE_SIZE = icache.IC_PAGE_SIZE;
const W0_FALLBACK = icache.W0_FALLBACK;
const DESCRIPTOR_SIZE = dec.DESCRIPTOR_SIZE;
const D_OP = dec.D_OP;
const D_LEN = dec.D_LEN;
const D_R = dec.D_R;
const D_S = dec.D_S;
const D_T = dec.D_T;
const D_IMM = dec.D_IMM;
const D_IMM2 = dec.D_IMM2;
const EXCCAUSE = exc.EXCCAUSE;
const VECTOR = exc.VECTOR;
const LEVEL_VECTOR = exc.LEVEL_VECTOR;
const PS_INTLEVEL = exc.PS.INTLEVEL;
const PS_EXCM = exc.PS.EXCM;
const PS_UM = exc.PS.UM;
const PS_OWB = exc.PS.OWB;
const PS_CALLINC = exc.PS.CALLINC;
const PS_WOE = exc.PS.WOE;
const PS_MASK = exc.PS.MASK;
const ABOVE = irq.ABOVE;
const LEVEL_MASK = irq.LEVEL_MASK;
const NMI_MASK = irq.INT_MASK.NMI;
const INT_SETTABLE = irq.INT_SETTABLE;
const TIMER_INTERRUPT = irq.TIMER_INTERRUPT;
/** B4CONST and B4CONSTU by r: BEQI…BGEUI take their constant from the r field (the cache entry holds the target). */
const B4C = Int32Array.from(isa.B4CONST);
const B4CU = Int32Array.from(isa.B4CONSTU);
const muluh = muldiv.muluh;
const mulsh = muldiv.mulsh;

/** Why the core stopped. */
export const HALT = { RUNNING: 0, BREAK: 1, FAULT: 2 } as const;

/** Shift helpers for shift counts 0–63 (SAR is 6 bits): JS shifts use only the low 5 bits. */
const shl = (v: number, n: number): number => (n >= 32 ? 0 : (v << n) >>> 0);
const shr = (v: number, n: number): number => (n >= 32 ? 0 : v >>> n);
const sra = (v: number, n: number): number => (v | 0) >> (n >= 32 ? 31 : n);

/** Per op: which of r (1), s (2), t (4) name an address register, and an implicit window quarter. */
const USES = Uint8Array.from(OPS, (op) => {
  let mask = 0;
  for (const kind of op.operands) {
    if (kind === OPND.AR) mask |= 1;
    else if (kind === OPND.AS) mask |= 2;
    else if (kind === OPND.AT) mask |= 4;
  }
  return mask;
});
const IMPLICIT_QUARTER = new Uint8Array(OPS.length);
IMPLICIT_QUARTER[OP.CALL4] = IMPLICIT_QUARTER[OP.CALLX4] = 1;
IMPLICIT_QUARTER[OP.CALL8] = IMPLICIT_QUARTER[OP.CALLX8] = 2;
IMPLICIT_QUARTER[OP.CALL12] = IMPLICIT_QUARTER[OP.CALLX12] = 3;

/** Ops whose decoder offset names an address (branch, jump, call, loop, l32r): execute gets it as `tgt`. */
const TARGETED = Uint8Array.from(OPS, (op) => {
  const k = op.imm;
  const I = isa.IMM;
  return k === I.B4CONST || k === I.B4CONSTU || k === I.BBI || k === I.BR8 || k === I.BR12 || k === I.LOOP || k === I.BRN || k === I.J || k === I.CALL || k === I.L32R ? 1 : 0;
});

/** Ops executed outside the main switch: 1 FPU (ops/fpu.ts), 2 MAC16 (ops/mac16.ts). */
const EXT_KIND = Uint8Array.from(OPS, (op, i) => {
  if (/\.s$/.test(op.name) || /^(lsi|lsip|lsx|lsxp|ssi|ssip|ssx|ssxp|rfr|wfr)$/.test(op.name)) return 1;
  return MAC_KIND[i] !== 0 ? 2 : 0;
});

/** rsr/wsr/xsr/rur/wur ops: kind (1 rsr, 2 wsr, 3 xsr, 4 rur, 5 wur) and register number. */
const SPECIAL_KIND = new Uint8Array(OPS.length);
const SPECIAL_NUMBER = new Uint8Array(OPS.length);
OPS.forEach((op, i) => {
  const kind = op.name.slice(0, 4);
  const m = op.match;
  if (kind === 'rsr.' || kind === 'wsr.' || kind === 'xsr.') {
    SPECIAL_KIND[i] = kind === 'rsr.' ? 1 : kind === 'wsr.' ? 2 : 3;
    SPECIAL_NUMBER[i] = (m >>> 8) & 0xff;
  } else if (kind === 'rur.') {
    SPECIAL_KIND[i] = 4;
    SPECIAL_NUMBER[i] = (((m >>> 8) & 0xf) << 4) | ((m >>> 4) & 0xf);
  } else if (kind === 'wur.') {
    SPECIAL_KIND[i] = 5;
    SPECIAL_NUMBER[i] = (((m >>> 12) & 0xf) << 4) | ((m >>> 8) & 0xf);
  }
});

/**
 * Writable bits of the special registers kept in plain storage (registers with side effects —
 * SAR, the loop and window registers, PS, the interrupt and timer registers, VECBASE, PRID —
 * are handled in readSpecial/writeSpecial). Sources: the ISA RM's register descriptions and
 * the ESP32 core-isa.h (2 IBREAK, 2 DBREAK, 4 MISC, 8 coprocessors).
 */
export const SR_WRITABLE: Uint32Array = (() => {
  const m = new Uint32Array(256);
  const full = 0xffffffff;
  for (const n of [SR.SCOMPARE1, SR.ACCLO, SR.M0, SR.M1, SR.M2, SR.M3, SR.MMID, SR.DDR, SR.IBREAKA0, SR.IBREAKA1, SR.DBREAKA0, SR.DBREAKA1, SR.DEPC, SR.EXCVADDR, SR.ICOUNT, SR.MEMCTL])
    m[n] = full;
  for (let i = 1; i <= 7; i++) m[SR.EPC1 + i - 1] = full;
  for (let i = 1; i <= 7; i++) m[SR.EXCSAVE1 + i - 1] = full;
  for (let i = 2; i <= 7; i++) m[SR.EPS2 + i - 2] = PS_MASK;
  for (let i = 0; i < 4; i++) m[SR.MISC0 + i] = full;
  m[SR.BR] = 0xffff;
  m[SR.ACCHI] = 0xff;
  m[SR.IBREAKENABLE] = 0x3;
  m[SR.DBREAKC0] = m[SR.DBREAKC1] = 0xc000003f;
  m[SR.ATOMCTL] = 0x3f;
  m[SR.CPENABLE] = 0xff;
  m[SR.EXCCAUSE] = 0x3f;
  m[SR.DEBUGCAUSE] = 0x3f;
  m[SR.ICOUNTLEVEL] = 0xf;
  // LITBASE: this core has no absolute-literals option (core-isa.h); CONFIGID0/1 are read-only
  // configuration words (left 0): writes to them are ignored.
  return m;
})();

/** Writable bits of the user registers. FCR: rounding mode and enables; FSR: the flags. */
export const UR_WRITABLE: Uint32Array = (() => {
  const m = new Uint32Array(256);
  m[UR.EXPSTATE] = m[UR.THREADPTR] = m[UR.F64R_LO] = m[UR.F64R_HI] = m[UR.F64S] = 0xffffffff;
  m[UR.FCR] = 0x7f;
  m[UR.FSR] = 0xf80;
  return m;
})();

export interface XtensaCoreOptions {
  /** PRID: 0xCDCD on the PRO CPU, 0xABAB on the APP CPU. */
  prid?: number;
}

/** No breakpoints (shared, never written). */
const NO_BREAKPOINTS: ReadonlySet<number> = new Set<number>();

export class XtensaCore {
  /** The physical address registers. */
  readonly ar = new Uint32Array(64);
  pc = exc.RESET_VECTOR;
  /** Shift amount register (6 bits). */
  sar = 0;
  windowBase = 0;
  windowStart = 1;
  ps: number = exc.PS.RESET;
  vecbase: number = exc.VECBASE_RESET;
  lbeg = 0;
  lend = 0;
  lcount = 0;
  intenable = 0;
  /** INTERRUPT bits latched by edges, software (INTSET) and timers. */
  latched = 0;
  /** Level-type external interrupt lines (setInterruptLine). */
  lines = 0;
  readonly ccompare = new Uint32Array(3);
  /** Plain special-register storage (EPCn, EPSn, EXCSAVEn, EXCCAUSE, MISCn, …), by number. */
  readonly sr = new Uint32Array(256);
  /** User registers, by number (THREADPTR 231, FCR 232, …). */
  readonly ur = new Uint32Array(256);
  /** External registers (RER/WER): unknown addresses read 0 ("no debugger attached"). */
  readonly eri = new Map<number, number>();
  readonly prid: number;
  /** FPU registers f0–f15 as bits, a float view of them, and each one's extra exponent (ops/fpu.ts). */
  readonly f = new Uint32Array(16);
  readonly fv = new Float32Array(this.f.buffer);
  readonly fx = new Int16Array(16);
  /**
   * Region protection (core-matmap.h: one way of eight 512 MB entries, identity-mapped, 4-bit
   * attributes, reset 2): WITLB/WDTLB write them; BT31's bus enforces them.
   */
  readonly itlb = new Uint8Array(8).fill(2);
  readonly dtlb = new Uint8Array(8).fill(2);
  /** Cycles since construction (= instructions executed + cycles slept in WAITI). */
  cycles = 0;
  /** Cycles spent asleep in WAITI. */
  slept = 0;
  /** Cycles stalled on the bus (BT33: flash cache misses). */
  stalled = 0;
  /** In WAITI, waiting for an interrupt. */
  waiting = false;
  /** HALT.* */
  halt: number = HALT.RUNNING;
  /** The fault message, or the BREAK operands ("1, 15"). */
  haltReason = '';
  /** Claims a BREAK s, t as a halt instead of a debug exception (the bare machine's `break 1, 15`). */
  breakHook: ((s: number, t: number) => boolean) | null = null;
  /**
   * Debug tooling (BT32): called before every instruction with its PC and word. While set, the
   * core runs an instrumented copy of its loop; the normal loop never tests it per instruction.
   */
  instructionHook: ((pc: number, word: number) => void) | null = null;
  /**
   * Called on every general exception (cause, EPC, EXCVADDR — double exceptions included), every
   * interrupt above level 1 (cause −level) and every debug exception (cause −6, DEBUGCAUSE as
   * the third argument). Window overflow/underflow and level-1 interrupts are not reported.
   */
  exceptionHook: ((cause: number, pc: number, vaddr: number) => void) | null = null;
  /** A deliverable interrupt may be pending: checked before each instruction. */
  irqCheck = false;
  /**
   * BT73 (the debugger): addresses to stop before. While non-empty, `run` uses a checked copy of
   * its loop (chosen per run, never tested per instruction in the others); the adapter owns the
   * set and hands it to every core it builds.
   */
  breakpoints: ReadonlySet<number> = NO_BREAKPOINTS;
  /** The last run stopped before an instruction at a breakpoint (cleared by the next run). */
  atBreakpoint = false;
  /** The breakpoint the core stopped at, which the next run executes unchecked (−1: none). */
  resumePc = -1;
  readonly bus: XtensaBus;
  /** The predecoded instruction cache (BT37; icache.ts). */
  readonly icache = new ICache();
  /** Run through the predecode cache when the bus supports it (false: fetch and decode every instruction — A/B tests, the bench script). */
  predecode = true;
  private readonly codeBus: CodeBus | null;
  private readonly d = new Int32Array(DESCRIPTOR_SIZE);
  /** One packed entry (icache.ts layout) for instructions run without the cache. */
  private readonly scratch = new Int32Array(ENTRY);
  private ccountBase = 0;
  private nextTimerAt = 0;
  /** Per CCOMPARE: the cycle (in `cycles`) of its next match. */
  private readonly timerAt = new Float64Array(3);
  private stopAt = 0;
  private stopRequested = false;
  /** The first window quarter ahead owned by a live frame (1–3), or 4. */
  private windowLimit = 4;
  private overflowArmed = false;
  /** windowLimit while overflowArmed, else 4: the cached loop's one-compare window check. */
  private armedLimit = 4;

  constructor(bus: XtensaBus, options: XtensaCoreOptions = {}) {
    this.bus = bus;
    this.codeBus = isCodeBus(bus) ? bus : null;
    this.prid = options.prid ?? 0xcdcd;
    // Code changed under a running loop: end it there, so it re-reads the cache (no stale page).
    this.icache.onChange = () => {
      this.stopAt = this.cycles;
    };
    this.updateTimers();
    this.updatePs();
  }

  /**
   * Reset (BT32: APP_CPU leaving reset): registers, special registers, FPU, region protection
   * and interrupts as at power-on, PC at the reset vector, CCOUNT 0. `cycles` keeps counting
   * (the SoC's time accounting uses it); external interrupt lines are the matrix's and stay.
   */
  reset(): void {
    this.ar.fill(0);
    this.pc = exc.RESET_VECTOR;
    this.sar = 0;
    this.windowBase = 0;
    this.windowStart = 1;
    this.ps = exc.PS.RESET;
    this.vecbase = exc.VECBASE_RESET;
    this.lbeg = this.lend = this.lcount = 0;
    this.intenable = 0;
    this.latched = 0;
    this.ccompare.fill(0);
    this.sr.fill(0);
    this.ur.fill(0);
    this.eri.clear();
    this.f.fill(0);
    this.fx.fill(0);
    this.itlb.fill(2);
    this.dtlb.fill(2);
    this.waiting = false;
    this.halt = HALT.RUNNING;
    this.haltReason = '';
    this.ccountBase = -this.cycles >>> 0;
    this.updateTimers();
    this.updatePs();
    if (this.bus.protectionChanged !== undefined) this.bus.protectionChanged(this.itlb, this.dtlb);
  }

  /** Instructions executed since construction. */
  get instructions(): number {
    return this.cycles - this.slept - this.stalled;
  }

  /**
   * The bus holds the core for `n` cycles (a flash cache miss): they count in CCOUNT and time.
   * A CCOMPARE match the stall steps over still fires (timerMatch compares match cycles, not
   * values).
   */
  stall(n: number): void {
    this.cycles += n;
    this.stalled += n;
  }

  /** CCOUNT now. */
  get ccount(): number {
    return (this.cycles + this.ccountBase) >>> 0;
  }

  /** The cycle (in `cycles`) of the next CCOMPARE match. */
  get nextTimer(): number {
    return this.nextTimerAt;
  }

  /** In WAITI with nothing deliverable: only a timer match or an external line can wake it. */
  get asleep(): boolean {
    return this.waiting && !this.irqCheck && this.halt === HALT.RUNNING;
  }

  /** Logical register aN. */
  reg(n: number): number {
    return this.ar[((this.windowBase << 2) + n) & 63];
  }

  setReg(n: number, value: number): void {
    this.ar[((this.windowBase << 2) + n) & 63] = value;
  }

  // ── External interrupt lines (BT32's interrupt matrix drives these) ─────────────────────

  /** A level-type interrupt line goes high or low. */
  setInterruptLine(n: number, high: boolean): void {
    this.lines = (high ? this.lines | (1 << n) : this.lines & ~(1 << n)) >>> 0;
    this.updateIrq();
  }

  /** An edge-type (or NMI) interrupt fires: latched until INTCLEAR (NMI: until taken). */
  pulseInterrupt(n: number): void {
    this.latched = (this.latched | (1 << n)) >>> 0;
    this.updateIrq();
  }

  /** INTERRUPT: everything pending. */
  get interrupt(): number {
    return (this.latched | this.lines) >>> 0;
  }

  // ── Running ─────────────────────────────────────────────────────────────────────────────

  /**
   * Runs up to `max` cycles (instructions, or cycles asleep in WAITI); returns the instructions
   * executed. Stops early on a halt.
   */
  run(max: number): number {
    const before = this.instructions;
    const end = this.cycles + max;
    this.stopRequested = false;
    this.atBreakpoint = false;
    while (this.halt === HALT.RUNNING && this.cycles < end && !this.stopRequested) {
      this.stopAt = Math.min(end, this.nextTimerAt);
      try {
        if (this.breakpoints.size !== 0) this.innerChecked();
        else if (this.instructionHook !== null) this.innerHooked();
        else if (this.predecode && this.codeBus !== null) this.innerCached(this.codeBus);
        else this.inner();
      } catch (error) {
        if (error === BUS_YIELD) this.stopRequested = true;
        else if (error instanceof XtensaBusError) this.raise(error.exccause, this.pc, error.address);
        else this.fault(error instanceof Error ? error.message : String(error));
      }
      if (this.cycles >= this.nextTimerAt) this.timerMatch();
    }
    return this.instructions - before;
  }

  /** Executes one instruction (or takes one pending interrupt). */
  step(): void {
    this.run(1);
  }

  /** The run loop without the predecode cache: fetch and decode every instruction. */
  private inner(): void {
    const bus = this.bus;
    while (this.cycles < this.stopAt) {
      if (this.irqCheck && this.takeInterrupt()) continue;
      if (this.waiting) {
        this.slept += this.stopAt - this.cycles;
        this.cycles = this.stopAt;
        return;
      }
      const pc = this.pc;
      this.stepWord(pc, bus.fetch(pc));
    }
  }

  /**
   * The run loop through the predecode cache (BT37): it tests what inner() tests before every
   * instruction, then interpret() runs from the cache until stopAt.
   */
  private innerCached(code: CodeBus): void {
    while (this.cycles < this.stopAt) {
      if (this.irqCheck && this.takeInterrupt()) continue;
      if (this.waiting) {
        this.slept += this.stopAt - this.cycles;
        this.cycles = this.stopAt;
        return;
      }
      this.interpret(code);
    }
  }

  /** Decodes the instruction at `pc` into its cache entry (index `e`); returns the entry's word 0. */
  private fillEntry(page: Int32Array, e: number, pc: number, bus: CodeBus): number {
    const b0 = bus.codeByte(pc);
    const len = lengthOf(b0);
    if ((pc & 0xfff) + len > IC_PAGE_SIZE) {
      page[e] = W0_FALLBACK;
      return W0_FALLBACK;
    }
    decode(b0, bus.codeByte(pc + 1), len === 3 ? bus.codeByte(pc + 2) : 0, this.d);
    return this.pack(page, e, pc);
  }

  /**
   * Packs the decoder's descriptor (this.d) for the instruction at `pc` into entry `e` of
   * `entries` (icache.ts's layout): word 0 = op + 1, length, r, s, t and the highest window
   * quarter it touches (the ISA RM's WindowCheck: touching a quarter a live frame owns raises a
   * window overflow before the instruction executes); word 1 = the target address of a
   * branch, jump, call, loop or l32r, EXTUI's shift | width << 8, or the immediate. (The few
   * ops with both a target and an immediate — BEQI…BGEUI, BBCI/BBSI — rebuild the immediate
   * from r and t; BREAK's second operand is t.) Returns word 0.
   */
  private pack(entries: Int32Array, e: number, pc: number): number {
    const d = this.d;
    const op = d[D_OP];
    let w0 = d[D_LEN] << 10;
    if (op !== OP_INVALID) {
      const r = d[D_R];
      const s = d[D_S];
      const t = d[D_T];
      const uses = USES[op];
      let q = IMPLICIT_QUARTER[op];
      if ((uses & 1) !== 0 && r >> 2 > q) q = r >> 2;
      if ((uses & 2) !== 0 && s >> 2 > q) q = s >> 2;
      if ((uses & 4) !== 0 && t >> 2 > q) q = t >> 2;
      w0 |= (op + 1) | (r << 12) | (s << 16) | (t << 20) | (q << 24);
    }
    entries[e + 1] = op === OP_INVALID ? 0 : TARGETED[op] !== 0 ? target(d, pc) : op === OP.EXTUI ? d[D_IMM] | (d[D_IMM2] << 8) : d[D_IMM];
    entries[e] = w0;
    return w0;
  }

  /** One instruction from its fetched word: decoded, packed into the scratch entry, run (no cache). */
  private stepWord(pc: number, word: number): void {
    decode(word & 0xff, (word >>> 8) & 0xff, (word >>> 16) & 0xff, this.d);
    this.pack(this.scratch, 0, pc);
    this.interpret(null);
  }

  /** inner() with instructionHook called per instruction (debug runs only). */
  /**
   * BT73: the loop with a breakpoint check before each instruction — after any interrupt entry,
   * so a handler's first instruction can stop too.
   */
  private innerChecked(): void {
    const bus = this.bus;
    const breakpoints = this.breakpoints;
    while (this.cycles < this.stopAt) {
      if (this.irqCheck && this.takeInterrupt()) continue;
      if (this.waiting) {
        this.slept += this.stopAt - this.cycles;
        this.cycles = this.stopAt;
        return;
      }
      const pc = this.pc;
      if (pc !== this.resumePc && breakpoints.has(pc)) {
        this.resumePc = pc;
        this.atBreakpoint = true;
        this.requestStop();
        return;
      }
      this.resumePc = -1;
      this.stepWord(pc, bus.fetch(pc));
    }
  }

  private innerHooked(): void {
    const bus = this.bus;
    while (this.cycles < this.stopAt) {
      if (this.irqCheck && this.takeInterrupt()) continue;
      if (this.waiting) {
        this.slept += this.stopAt - this.cycles;
        this.cycles = this.stopAt;
        return;
      }
      const hook = this.instructionHook;
      if (hook === null) return;
      const pc = this.pc;
      const word = bus.fetch(pc);
      hook(pc, word);
      this.stepWord(pc, word);
    }
  }

  /**
   * Ends the current run() after the instruction now executing (BT33: a store that resets or
   * holds this core, which the SoC acts on once run() has returned). The next run() clears it.
   */
  requestStop(): void {
    this.stopRequested = true;
    this.stopAt = this.cycles;
  }

  /** Stops the core with a fault (an emulator limit, not an Xtensa exception). */
  fault(message: string): void {
    this.halt = HALT.FAULT;
    this.haltReason = message;
    this.stopAt = this.cycles;
  }

  // ── Exceptions and interrupts ───────────────────────────────────────────────────────────

  /** Raises a general exception (XEA2): EPC1 + user/kernel vector, or DEPC + double vector. */
  raise(cause: number, pc: number, vaddr?: number): void {
    if (this.exceptionHook !== null) this.exceptionHook(cause, pc, vaddr ?? 0);
    this.sr[SR.EXCCAUSE] = cause;
    if (vaddr !== undefined) this.sr[SR.EXCVADDR] = vaddr;
    const ps = this.ps;
    if ((ps & PS_EXCM) !== 0) {
      const vector = (this.vecbase + VECTOR.DOUBLE) >>> 0;
      if (pc === vector) {
        this.fault(`double exception at the double-exception vector 0x${vector.toString(16)} (cause ${cause})`);
        return;
      }
      this.sr[SR.DEPC] = pc;
      this.pc = vector;
    } else {
      this.sr[SR.EPC1] = pc;
      this.pc = (this.vecbase + ((ps & PS_UM) !== 0 ? VECTOR.USER : VECTOR.KERNEL)) >>> 0;
      this.ps = ps | PS_EXCM;
    }
    this.updatePs();
  }

  /** Takes the highest-level deliverable interrupt, if any. */
  private takeInterrupt(): boolean {
    const ps = this.ps;
    const masked = Math.max(ps & PS_INTLEVEL, (ps & PS_EXCM) !== 0 ? exc.EXCM_LEVEL : 0);
    const pending = this.latched | this.lines;
    const deliverable = ((pending & this.intenable & ABOVE[masked]) | (pending & NMI_MASK)) >>> 0;
    if (deliverable === 0) {
      this.irqCheck = false;
      return false;
    }
    let level = 7;
    while (level > 1 && (deliverable & LEVEL_MASK[level]) === 0) level--;
    this.waiting = false;
    const pc = this.pc;
    if (level === 1) {
      this.sr[SR.EXCCAUSE] = EXCCAUSE.LEVEL1_INTERRUPT;
      this.sr[SR.EPC1] = pc;
      this.pc = (this.vecbase + ((ps & PS_UM) !== 0 ? VECTOR.USER : VECTOR.KERNEL)) >>> 0;
      this.ps = ps | PS_EXCM;
    } else {
      if (level === exc.NMI_LEVEL) this.latched = (this.latched & ~NMI_MASK) >>> 0; // taken: cleared
      if (this.exceptionHook !== null) this.exceptionHook(-level, pc, 0);
      this.sr[SR.EPC1 + level - 1] = pc;
      this.sr[SR.EPS2 + level - 2] = ps;
      this.ps = (ps & ~(PS_INTLEVEL | PS_EXCM)) | level | PS_EXCM;
      this.pc = (this.vecbase + LEVEL_VECTOR[level]) >>> 0;
    }
    this.updatePs();
    return true;
  }

  private debugException(cause: number, pc: number): void {
    if (this.exceptionHook !== null) this.exceptionHook(-exc.DEBUG_LEVEL, pc, cause);
    const ps = this.ps;
    this.sr[SR.DEBUGCAUSE] = cause;
    this.sr[SR.EPC1 + exc.DEBUG_LEVEL - 1] = pc;
    this.sr[SR.EPS2 + exc.DEBUG_LEVEL - 2] = ps;
    this.ps = (ps & ~(PS_INTLEVEL | PS_EXCM)) | exc.DEBUG_LEVEL | PS_EXCM;
    this.pc = (this.vecbase + VECTOR.DEBUG) >>> 0;
    this.updatePs();
  }

  /**
   * Recomputes `irqCheck`: anything pending, enabled and above the current mask (or the NMI).
   * When it holds, the run loop must look at it before the next instruction: stopAt drops to
   * now, which ends a cached block there (innerCached).
   */
  private updateIrq(): void {
    const ps = this.ps;
    const masked = Math.max(ps & PS_INTLEVEL, (ps & PS_EXCM) !== 0 ? exc.EXCM_LEVEL : 0);
    const pending = this.latched | this.lines;
    this.irqCheck = ((pending & this.intenable & ABOVE[masked]) | (pending & NMI_MASK)) !== 0;
    if (this.irqCheck) this.stopAt = this.cycles;
  }

  // ── Windows ─────────────────────────────────────────────────────────────────────────────

  /** Recomputes the window-overflow state after WINDOWBASE, WINDOWSTART or PS change. */
  private updateWindow(): void {
    const ws = this.windowStart;
    const wb = this.windowBase;
    this.windowLimit = (ws >> ((wb + 1) & 15)) & 1 ? 1 : (ws >> ((wb + 2) & 15)) & 1 ? 2 : (ws >> ((wb + 3) & 15)) & 1 ? 3 : 4;
    this.overflowArmed = this.windowLimit < 4 && (this.ps & (PS_WOE | PS_EXCM)) === PS_WOE;
    this.armedLimit = this.overflowArmed ? this.windowLimit : 4;
  }

  private updatePs(): void {
    this.updateWindow();
    this.updateIrq();
  }

  /** Window overflow: rotate to the frame owning quarter n and jump to its spill handler. */
  private windowOverflow(n: number, pc: number): void {
    const wb = this.windowBase;
    const ws = this.windowStart;
    const m = (wb + n) & 15;
    this.ps = (this.ps & ~PS_OWB) | (wb << exc.PS.OWB_SHIFT) | PS_EXCM;
    this.sr[SR.EPC1] = pc;
    const vector = (ws >> ((m + 1) & 15)) & 1 ? VECTOR.WINDOW_OVERFLOW4 : (ws >> ((m + 2) & 15)) & 1 ? VECTOR.WINDOW_OVERFLOW8 : VECTOR.WINDOW_OVERFLOW12;
    this.windowBase = m;
    this.pc = (this.vecbase + vector) >>> 0;
    this.updatePs();
  }

  // ── Special registers ───────────────────────────────────────────────────────────────────

  readSpecial(n: number): number {
    switch (n) {
      case 3 /* SR.SAR */:
        return this.sar;
      case 0 /* SR.LBEG */:
        return this.lbeg;
      case 1 /* SR.LEND */:
        return this.lend;
      case 2 /* SR.LCOUNT */:
        return this.lcount;
      case 72 /* SR.WINDOWBASE */:
        return this.windowBase;
      case 73 /* SR.WINDOWSTART */:
        return this.windowStart;
      case 230 /* SR.PS */:
        return this.ps;
      case 226 /* SR.INTERRUPT */:
        return this.interrupt;
      case 228 /* SR.INTENABLE */:
        return this.intenable;
      case 234 /* SR.CCOUNT */:
        return this.ccount;
      case 240 /* SR.CCOMPARE0 */:
      case 241 /* SR.CCOMPARE1 */:
      case 242 /* SR.CCOMPARE2 */:
        return this.ccompare[n - SR.CCOMPARE0];
      case 231 /* SR.VECBASE */:
        return this.vecbase;
      case 235 /* SR.PRID */:
        return this.prid;
      case 17 /* SR.ACCHI */:
        return ((this.sr[n] << 24) >> 24) >>> 0; // bits 39–32, sign-extended
      default:
        return this.sr[n];
    }
  }

  writeSpecial(n: number, value: number): void {
    const v = value >>> 0;
    switch (n) {
      case 3 /* SR.SAR */:
        this.sar = v & 0x3f;
        return;
      case 0 /* SR.LBEG */:
        this.lbeg = v;
        return;
      case 1 /* SR.LEND */:
        this.lend = v;
        return;
      case 2 /* SR.LCOUNT */:
        this.lcount = v;
        return;
      case 72 /* SR.WINDOWBASE */:
        this.windowBase = v & 15;
        this.updateWindow();
        return;
      case 73 /* SR.WINDOWSTART */:
        this.windowStart = v & 0xffff;
        this.updateWindow();
        return;
      case 230 /* SR.PS */:
        this.ps = v & PS_MASK;
        this.updatePs();
        return;
      case 226 /* SR.INTERRUPT */: // INTSET
        this.latched = (this.latched | (v & INT_SETTABLE)) >>> 0;
        this.updateIrq();
        return;
      case 227 /* SR.INTCLEAR */:
        this.latched = (this.latched & ~(v & INT_SETTABLE)) >>> 0;
        this.updateIrq();
        return;
      case 228 /* SR.INTENABLE */:
        this.intenable = v;
        this.updateIrq();
        return;
      case 234 /* SR.CCOUNT */:
        this.ccountBase = (v - this.cycles) >>> 0;
        this.updateTimers();
        return;
      case 240 /* SR.CCOMPARE0 */:
      case 241 /* SR.CCOMPARE1 */:
      case 242 /* SR.CCOMPARE2 */: {
        const i = n - SR.CCOMPARE0;
        this.ccompare[i] = v;
        this.latched = (this.latched & ~(1 << TIMER_INTERRUPT[i])) >>> 0; // writing clears it
        this.updateTimers();
        this.updateIrq();
        return;
      }
      case 231 /* SR.VECBASE */:
        this.vecbase = (v & 0xfffffc00) >>> 0;
        return;
      case 235 /* SR.PRID */:
        return; // read-only
      default:
        this.sr[n] = v & SR_WRITABLE[n];
    }
  }

  // ── Timers ──────────────────────────────────────────────────────────────────────────────

  /** The cycle at which CCOUNT next equals a CCOMPARE (a full wrap when equal now). */
  private updateTimers(): void {
    const now = this.cycles;
    const count = this.ccount;
    let next = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 3; i++) {
      const distance = (this.ccompare[i] - count) >>> 0 || 0x100000000;
      this.timerAt[i] = now + distance;
      if (now + distance < next) next = now + distance;
    }
    this.nextTimerAt = next;
    if (next < this.stopAt) this.stopAt = next;
  }

  private timerMatch(): void {
    const now = this.cycles;
    for (let i = 0; i < 3; i++) if (this.timerAt[i] <= now) this.latched = (this.latched | (1 << TIMER_INTERRUPT[i])) >>> 0;
    this.updateTimers();
    this.updateIrq();
  }

  // ── Execution ───────────────────────────────────────────────────────────────────────────

  private illegal(pc: number): void {
    this.raise(EXCCAUSE.ILLEGAL_INSTRUCTION, pc);
  }

  /**
   * The interpreter (BT37 shape). With `code` (the predecode cache's bus) it runs from the
   * cache until stopAt — the PC's 4 KB page of packed entries (icache.ts layout), entries
   * filled on first use, the next page looked up when the PC leaves it, instructions from
   * pages the cache refuses (or that run past a page's end) one at a time through stepWord.
   * Without `code` it runs the one instruction stepWord packed into `scratch` for this.pc. The
   * switch and the loop share a function on purpose: V8 won't inline a function this size,
   * and a call per instruction (or per page) measured up to 2× slower (M1, Node 24).
   *
   * Exactness: between instructions this loop tests only `cycles < stopAt`. Whatever would
   * change inner()'s other per-instruction tests lowers stopAt to now instead — a deliverable
   * interrupt (updateIrq), WAITI, invalidated code (icache.onChange) — so a run leaves the
   * loop on the instruction boundary where inner() would have acted, and instruction counts,
   * CCOUNT and the flash cache lookups match a run without the cache exactly. The window check
   * is the entry's precomputed quarter against armedLimit. `continue` ends an instruction that
   * redirected the PC itself (an exception, a halt).
   */
  private interpret(code: CodeBus | null): void {
    const ar = this.ar;
    const bus = this.bus;
    const ic = this.icache;
    let page: Int32Array = this.scratch;
    // Without the cache the scratch entry is the instruction at this.pc; with it, a base no PC
    // is within a page of forces a lookup first.
    let base = code === null ? this.pc : this.pc + 2 * IC_PAGE_SIZE;
    let flash = -1;
    do {
      const pc = this.pc;
      let off = pc - base;
      if (code !== null && off >>> 0 >= IC_PAGE_SIZE) {
        const next = ic.lookup(pc, code);
        if (next === null) {
          this.stepWord(pc, bus.fetch(pc));
          continue;
        }
        page = next;
        base = (pc & ~0xfff) >>> 0;
        flash = ic.lastSource;
        off = pc - base;
      }
      const e = off << 1; // ENTRY ints per byte offset
      let w0 = page[e];
      if (w0 === 0 && code !== null) w0 = this.fillEntry(page, e, pc, code);
      if (w0 === W0_FALLBACK) {
        this.stepWord(pc, bus.fetch(pc));
        continue;
      }
      if (flash >= 0 && code !== null) code.codeFetched(flash + off, (w0 >>> 10) & 3);
      if (((w0 >>> 24) & 3) >= this.armedLimit) {
        this.windowOverflow(this.windowLimit, pc);
        continue;
      }
      const op = (w0 & 0x3ff) - 1;
      const r = (w0 >>> 12) & 15;
      const s = (w0 >>> 16) & 15;
      const t = (w0 >>> 20) & 15;
      // Word 1: the immediate — or, for a branch, jump, call, loop or l32r, the target.
      const imm = page[e + 1];
      const tgt = imm;
      const next = (pc + ((w0 >>> 10) & 3)) >>> 0;
      if (op === OP_INVALID) {
        this.illegal(pc);
        continue;
      }
      const wb = this.windowBase << 2;
      const ir = (wb + r) & 63;
      const is = (wb + s) & 63;
      const it = (wb + t) & 63;
      let npc = next;
      /** A taken branch, jump, call or return: no loop-back, even when its target is LEND. */
      let jumped = false;
      switch (op) {
        // ── Arithmetic and logic ──────────────────────────────────────────────────────────
        case 2 /* OP.ADD */:
        case 3 /* OP.ADD_N */:
          ar[ir] = ar[is] + ar[it];
          break;
        case 10 /* OP.ADDX2 */:
          ar[ir] = (ar[is] << 1) + ar[it];
          break;
        case 11 /* OP.ADDX4 */:
          ar[ir] = (ar[is] << 2) + ar[it];
          break;
        case 12 /* OP.ADDX8 */:
          ar[ir] = (ar[is] << 3) + ar[it];
          break;
        case 350 /* OP.SUB */:
          ar[ir] = ar[is] - ar[it];
          break;
        case 352 /* OP.SUBX2 */:
          ar[ir] = (ar[is] << 1) - ar[it];
          break;
        case 353 /* OP.SUBX4 */:
          ar[ir] = (ar[is] << 2) - ar[it];
          break;
        case 354 /* OP.SUBX8 */:
          ar[ir] = (ar[is] << 3) - ar[it];
          break;
        case 7 /* OP.ADDI */:
          ar[it] = ar[is] + imm;
          break;
        case 8 /* OP.ADDI_N */:
          ar[ir] = ar[is] + imm;
          break;
        case 9 /* OP.ADDMI */:
          ar[it] = ar[is] + imm;
          break;
        case 15 /* OP.AND */:
          ar[ir] = ar[is] & ar[it];
          break;
        case 213 /* OP.OR */:
          ar[ir] = ar[is] | ar[it];
          break;
        case 448 /* OP.XOR */:
          ar[ir] = ar[is] ^ ar[it];
          break;
        case 203 /* OP.NEG */:
          ar[ir] = -ar[it];
          break;
        case 0 /* OP.ABS */: {
          const v = ar[it] | 0;
          ar[ir] = v < 0 ? -v : v;
          break;
        }
        case 123 /* OP.MOVI */:
          ar[it] = imm;
          break;
        case 124 /* OP.MOVI_N */:
          ar[is] = imm;
          break;
        case 115 /* OP.MOV_N */:
          ar[it] = ar[is];
          break;
        case 117 /* OP.MOVEQZ */:
          if (ar[it] === 0) ar[ir] = ar[is];
          break;
        case 127 /* OP.MOVNEZ */:
          if (ar[it] !== 0) ar[ir] = ar[is];
          break;
        case 125 /* OP.MOVLTZ */:
          if ((ar[it] | 0) < 0) ar[ir] = ar[is];
          break;
        case 121 /* OP.MOVGEZ */:
          if ((ar[it] | 0) >= 0) ar[ir] = ar[is];
          break;
        case 111 /* OP.MIN */:
          ar[ir] = Math.min(ar[is] | 0, ar[it] | 0);
          break;
        case 108 /* OP.MAX */:
          ar[ir] = Math.max(ar[is] | 0, ar[it] | 0);
          break;
        case 112 /* OP.MINU */:
          ar[ir] = Math.min(ar[is], ar[it]);
          break;
        case 109 /* OP.MAXU */:
          ar[ir] = Math.max(ar[is], ar[it]);
          break;
        case 331 /* OP.SEXT */: {
          const shift = 31 - imm; // imm = sign bit position 7–22
          ar[ir] = (ar[is] << shift) >> shift;
          break;
        }
        case 59 /* OP.CLAMPS */: {
          const hi = 2 ** imm - 1; // imm 7–22
          const v = ar[is] | 0;
          ar[ir] = v > hi ? hi : v < -hi - 1 ? -hi - 1 : v;
          break;
        }
        case 208 /* OP.NSA */: {
          const v = ar[is] | 0;
          ar[it] = v === 0 || v === -1 ? 31 : Math.clz32(v < 0 ? ~v : v) - 1;
          break;
        }
        case 209 /* OP.NSAU */:
          ar[it] = Math.clz32(ar[is]);
          break;

        // ── Multiply and divide ───────────────────────────────────────────────────────────
        case 150 /* OP.MUL16S */:
          ar[ir] = ((ar[is] << 16) >> 16) * ((ar[it] << 16) >> 16);
          break;
        case 151 /* OP.MUL16U */:
          ar[ir] = (ar[is] & 0xffff) * (ar[it] & 0xffff);
          break;
        case 184 /* OP.MULL */:
          ar[ir] = Math.imul(ar[is], ar[it]);
          break;
        case 202 /* OP.MULUH */:
          ar[ir] = muluh(ar[is], ar[it]);
          break;
        case 201 /* OP.MULSH */:
          ar[ir] = mulsh(ar[is], ar[it]);
          break;
        case 218 /* OP.QUOS */:
        case 219 /* OP.QUOU */:
        case 224 /* OP.REMS */:
        case 225 /* OP.REMU */: {
          const divisor = ar[it];
          if (divisor === 0) {
            this.raise(EXCCAUSE.INTEGER_DIVIDE_BY_ZERO, pc);
            continue;
          }
          // QUOS(INT_MIN, −1) wraps to INT_MIN and REMS(INT_MIN, −1) is 0 (ISA RM), which |0 gives.
          if (op === OP.QUOS) ar[ir] = Math.trunc((ar[is] | 0) / (divisor | 0)) | 0;
          else if (op === OP.QUOU) ar[ir] = Math.trunc(ar[is] / divisor);
          else if (op === OP.REMS) ar[ir] = (ar[is] | 0) % (divisor | 0) | 0;
          else ar[ir] = ar[is] % divisor;
          break;
        }

        // ── Shifts ────────────────────────────────────────────────────────────────────────
        case 68 /* OP.EXTUI */:
          ar[ir] = (ar[it] >>> (imm & 31)) & (0xffffffff >>> (32 - (imm >>> 8)));
          break;
        case 334 /* OP.SLLI */:
          ar[ir] = shl(ar[is], imm);
          break;
        case 337 /* OP.SRAI */:
          ar[ir] = sra(ar[it], imm);
          break;
        case 340 /* OP.SRLI */:
          ar[ir] = ar[it] >>> imm;
          break;
        case 346 /* OP.SSL */:
          this.sar = 32 - (ar[is] & 31);
          break;
        case 347 /* OP.SSR */:
          this.sar = ar[is] & 31;
          break;
        case 343 /* OP.SSAI */:
          this.sar = imm;
          break;
        case 342 /* OP.SSA8L */:
          this.sar = (ar[is] & 3) << 3;
          break;
        case 341 /* OP.SSA8B */:
          this.sar = 32 - ((ar[is] & 3) << 3);
          break;
        case 333 /* OP.SLL */:
          // {AR[s], 32 zero bits} >> SAR, low word: a left shift by 32 − SAR.
          ar[ir] = shl(ar[is], 32 - this.sar);
          break;
        case 339 /* OP.SRL */:
          ar[ir] = shr(ar[it], this.sar);
          break;
        case 336 /* OP.SRA */:
          ar[ir] = sra(ar[it], this.sar);
          break;
        case 338 /* OP.SRC */: {
          // {AR[s], AR[t]} >> SAR, low word.
          const sa = this.sar;
          ar[ir] = sa === 0 ? ar[it] : sa >= 32 ? shr(ar[is], sa - 32) : ((ar[it] >>> sa) | (ar[is] << (32 - sa))) >>> 0;
          break;
        }

        // ── Loads and stores (unaligned: see bus.ts) ──────────────────────────────────────
        case 95 /* OP.L8UI */:
          ar[it] = bus.read8((ar[is] + imm) >>> 0);
          break;
        case 89 /* OP.L16UI */:
          ar[it] = bus.read16((ar[is] + imm) >>> 0);
          break;
        case 88 /* OP.L16SI */:
          ar[it] = (bus.read16((ar[is] + imm) >>> 0) << 16) >> 16;
          break;
        case 92 /* OP.L32I */:
        case 93 /* OP.L32I_N */:
        case 91 /* OP.L32E */:
          ar[it] = bus.read32((ar[is] + imm) >>> 0);
          break;
        case 328 /* OP.S8I */:
          bus.write8((ar[is] + imm) >>> 0, ar[it] & 0xff);
          break;
        case 321 /* OP.S16I */:
          bus.write16((ar[is] + imm) >>> 0, ar[it] & 0xffff);
          break;
        case 324 /* OP.S32I */:
        case 325 /* OP.S32I_N */:
        case 323 /* OP.S32E */:
          bus.write32((ar[is] + imm) >>> 0, ar[it]);
          break;
        case 94 /* OP.L32R */:
          ar[it] = bus.read32(tgt);
          break;

        // ── Jumps and calls ───────────────────────────────────────────────────────────────
        case 86 /* OP.J */:
          { npc = tgt; jumped = true; }
          break;
        case 87 /* OP.JX */:
          npc = ar[is];
          jumped = true;
          break;
        case 50 /* OP.CALL0 */:
          ar[wb & 63] = next;
          { npc = tgt; jumped = true; }
          break;
        case 54 /* OP.CALLX0 */: {
          const to = ar[is];
          ar[wb & 63] = next;
          npc = to;
          jumped = true;
          break;
        }
        case 227 /* OP.RET */:
        case 228 /* OP.RET_N */:
          npc = ar[wb & 63];
          jumped = true;
          break;
        case 52 /* OP.CALL4 */:
        case 53 /* OP.CALL8 */:
        case 51 /* OP.CALL12 */:
        case 56 /* OP.CALLX4 */:
        case 57 /* OP.CALLX8 */:
        case 55 /* OP.CALLX12 */: {
          // a(4n) ← n || (PC + 3)[29:0]; PS.CALLINC ← n (ENTRY rotates by it).
          const n = op === OP.CALL4 || op === OP.CALLX4 ? 1 : op === OP.CALL8 || op === OP.CALLX8 ? 2 : 3;
          const to = op === OP.CALL4 || op === OP.CALL8 || op === OP.CALL12 ? tgt : ar[is];
          ar[(wb + (n << 2)) & 63] = ((n << 30) | (next & 0x3fffffff)) >>> 0;
          this.ps = (this.ps & ~PS_CALLINC) | (n << exc.PS.CALLINC_SHIFT);
          npc = to;
          jumped = true;
          break;
        }
        case 65 /* OP.ENTRY */: {
          // The RM leaves WOE = 0, s > 3 and EXCM = 1 undefined ("may raise IllegalInstruction"):
          // the first two raise it; with EXCM = 1 ENTRY rotates without an overflow check (CWOE = 0).
          const ps = this.ps;
          if ((ps & PS_WOE) === 0 || s > 3) {
            this.illegal(pc);
            continue;
          }
          const callinc = (ps & PS_CALLINC) >>> exc.PS.CALLINC_SHIFT;
          if ((ps & PS_EXCM) === 0 && callinc !== 0 && this.windowLimit <= callinc) {
            this.windowOverflow(this.windowLimit, pc); // WindowCheck(00, CALLINC, 00)
            continue;
          }
          const sp = ar[is];
          const nwb = (this.windowBase + callinc) & 15;
          ar[((nwb << 2) + (s & 3)) & 63] = sp - imm;
          this.windowBase = nwb;
          this.windowStart |= 1 << nwb;
          this.updateWindow();
          break;
        }
        case 229 /* OP.RETW */:
        case 230 /* OP.RETW_N */: {
          const a0 = ar[wb & 63];
          const n = a0 >>> 30;
          const ps = this.ps;
          const w = this.windowBase;
          const ws = this.windowStart;
          const m = (ws >> ((w - 1) & 15)) & 1 ? 1 : (ws >> ((w - 2) & 15)) & 1 ? 2 : (ws >> ((w - 3) & 15)) & 1 ? 3 : 0;
          if (n === 0 || (ps & PS_WOE) === 0 || (ps & PS_EXCM) !== 0 || (m !== 0 && m !== n)) {
            this.illegal(pc);
            continue;
          }
          if ((ws >> ((w - n) & 15)) & 1) {
            this.windowStart = ws & ~(1 << w);
            this.windowBase = (w - n) & 15;
            npc = ((pc & 0xc0000000) | (a0 & 0x3fffffff)) >>> 0;
            jumped = true;
            this.updateWindow();
            break;
          }
          // The caller's frame was spilled: window underflow, then RETW runs again.
          this.ps = (ps & ~PS_OWB) | (w << exc.PS.OWB_SHIFT) | PS_EXCM;
          this.sr[SR.EPC1] = pc;
          this.windowBase = (w - n) & 15;
          this.pc = (this.vecbase + (n === 1 ? VECTOR.WINDOW_UNDERFLOW4 : n === 2 ? VECTOR.WINDOW_UNDERFLOW8 : VECTOR.WINDOW_UNDERFLOW12)) >>> 0;
          this.updatePs();
          continue;
        }
        case 129 /* OP.MOVSP */: {
          const w = this.windowBase;
          const ws = this.windowStart;
          if ((((ws >> ((w - 1) & 15)) | (ws >> ((w - 2) & 15)) | (ws >> ((w - 3) & 15))) & 1) === 0) {
            this.raise(EXCCAUSE.ALLOCA, pc); // the caller's frame is spilled
            continue;
          }
          ar[it] = ar[is];
          break;
        }
        case 242 /* OP.ROTW */:
          this.windowBase = (this.windowBase + imm) & 15;
          this.updateWindow();
          break;
        case 238 /* OP.RFWO */:
        case 239 /* OP.RFWU */: {
          // The RM's pseudocode has no PS.EXCM check (only the ring check this core lacks).
          const ps = this.ps;
          const w = this.windowBase;
          this.windowStart = op === OP.RFWO ? this.windowStart & ~(1 << w) : this.windowStart | (1 << w);
          this.windowBase = (ps & PS_OWB) >>> exc.PS.OWB_SHIFT;
          this.ps = ps & ~PS_EXCM;
          npc = this.sr[SR.EPC1];
          jumped = true;
          this.updatePs();
          break;
        }

        // ── Branches ──────────────────────────────────────────────────────────────────────
        case 26 /* OP.BEQ */:
          if (ar[is] === ar[it]) { npc = tgt; jumped = true; }
          break;
        case 42 /* OP.BNE */:
          if (ar[is] !== ar[it]) { npc = tgt; jumped = true; }
          break;
        case 36 /* OP.BLT */:
          if ((ar[is] | 0) < (ar[it] | 0)) { npc = tgt; jumped = true; }
          break;
        case 31 /* OP.BGE */:
          if ((ar[is] | 0) >= (ar[it] | 0)) { npc = tgt; jumped = true; }
          break;
        case 38 /* OP.BLTU */:
          if (ar[is] < ar[it]) { npc = tgt; jumped = true; }
          break;
        case 33 /* OP.BGEU */:
          if (ar[is] >= ar[it]) { npc = tgt; jumped = true; }
          break;
        case 21 /* OP.BANY */:
          if ((ar[is] & ar[it]) !== 0) { npc = tgt; jumped = true; }
          break;
        case 46 /* OP.BNONE */:
          if ((ar[is] & ar[it]) === 0) { npc = tgt; jumped = true; }
          break;
        case 20 /* OP.BALL */:
          if ((~ar[is] & ar[it]) === 0) { npc = tgt; jumped = true; }
          break;
        case 41 /* OP.BNALL */:
          if ((~ar[is] & ar[it]) !== 0) { npc = tgt; jumped = true; }
          break;
        case 22 /* OP.BBC */:
          if (((ar[is] >>> (ar[it] & 31)) & 1) === 0) { npc = tgt; jumped = true; }
          break;
        case 24 /* OP.BBS */:
          if (((ar[is] >>> (ar[it] & 31)) & 1) !== 0) { npc = tgt; jumped = true; }
          break;
        case 23 /* OP.BBCI */:
          if (((ar[is] >>> (t | ((r & 1) << 4))) & 1) === 0) { npc = tgt; jumped = true; }
          break;
        case 25 /* OP.BBSI */:
          if (((ar[is] >>> (t | ((r & 1) << 4))) & 1) !== 0) { npc = tgt; jumped = true; }
          break;
        case 27 /* OP.BEQI */:
          if ((ar[is] | 0) === B4C[r]) { npc = tgt; jumped = true; }
          break;
        case 43 /* OP.BNEI */:
          if ((ar[is] | 0) !== B4C[r]) { npc = tgt; jumped = true; }
          break;
        case 37 /* OP.BLTI */:
          if ((ar[is] | 0) < B4C[r]) { npc = tgt; jumped = true; }
          break;
        case 32 /* OP.BGEI */:
          if ((ar[is] | 0) >= B4C[r]) { npc = tgt; jumped = true; }
          break;
        case 39 /* OP.BLTUI */:
          if (ar[is] < B4CU[r]) { npc = tgt; jumped = true; }
          break;
        case 34 /* OP.BGEUI */:
          if (ar[is] >= B4CU[r]) { npc = tgt; jumped = true; }
          break;
        case 28 /* OP.BEQZ */:
        case 29 /* OP.BEQZ_N */:
          if (ar[is] === 0) { npc = tgt; jumped = true; }
          break;
        case 44 /* OP.BNEZ */:
        case 45 /* OP.BNEZ_N */:
          if (ar[is] !== 0) { npc = tgt; jumped = true; }
          break;
        case 40 /* OP.BLTZ */:
          if ((ar[is] | 0) < 0) { npc = tgt; jumped = true; }
          break;
        case 35 /* OP.BGEZ */:
          if ((ar[is] | 0) >= 0) { npc = tgt; jumped = true; }
          break;

        // ── Booleans (BR = SR 4, b0–b15) ──────────────────────────────────────────────────
        case 49 /* OP.BT */:
          if (((this.sr[SR.BR] >>> s) & 1) !== 0) { npc = tgt; jumped = true; }
          break;
        case 30 /* OP.BF */:
          if (((this.sr[SR.BR] >>> s) & 1) === 0) { npc = tgt; jumped = true; }
          break;
        case 16 /* OP.ANDB */:
        case 17 /* OP.ANDBC */:
        case 214 /* OP.ORB */:
        case 215 /* OP.ORBC */:
        case 449 /* OP.XORB */: {
          const br = this.sr[SR.BR];
          const bs = (br >>> s) & 1;
          const bt = (br >>> t) & 1;
          const v =
            op === OP.ANDB ? bs & bt : op === OP.ANDBC ? bs & (bt ^ 1) : op === OP.ORB ? bs | bt : op === OP.ORBC ? bs | (bt ^ 1) : bs ^ bt;
          this.sr[SR.BR] = v !== 0 ? br | (1 << r) : br & ~(1 << r);
          break;
        }
        case 13 /* OP.ALL4 */:
        case 18 /* OP.ANY4 */:
        case 14 /* OP.ALL8 */:
        case 19 /* OP.ANY8 */: {
          const eight = op === OP.ALL8 || op === OP.ANY8;
          const mask = eight ? 0xff : 0xf;
          const group = (this.sr[SR.BR] >>> (s & (eight ? ~7 : ~3))) & mask;
          const v = op === OP.ALL4 || op === OP.ALL8 ? group === mask : group !== 0;
          const br = this.sr[SR.BR];
          this.sr[SR.BR] = v ? br | (1 << t) : br & ~(1 << t);
          break;
        }
        case 130 /* OP.MOVT */:
          if (((this.sr[SR.BR] >>> t) & 1) !== 0) ar[ir] = ar[is];
          break;
        case 119 /* OP.MOVF */:
          if (((this.sr[SR.BR] >>> t) & 1) === 0) ar[ir] = ar[is];
          break;

        // ── Atomics: one thread runs both cores, so S32C1I is atomic as written ──────────
        case 322 /* OP.S32C1I */: {
          const address = (ar[is] + imm) >>> 0;
          const old = bus.read32(address);
          if (old === this.sr[SR.SCOMPARE1]) bus.write32(address, ar[it]);
          ar[it] = old;
          break;
        }
        case 90 /* OP.L32AI */: // acquire: ordering means nothing to a sequential emulator
          ar[it] = bus.read32((ar[is] + imm) >>> 0);
          break;
        case 327 /* OP.S32RI */: // release
        case 326 /* OP.S32NB */: // non-buffered
          bus.write32((ar[is] + imm) >>> 0, ar[it]);
          break;

        // ── Region protection (8 × 512 MB, identity-mapped) ───────────────────────────────
        case 372 /* OP.WITLB */:
        case 368 /* OP.WDTLB */:
          (op === OP.WITLB ? this.itlb : this.dtlb)[ar[is] >>> 29] = ar[it] & 0xf;
          if (bus.protectionChanged !== undefined) bus.protectionChanged(this.itlb, this.dtlb);
          break;
        case 240 /* OP.RITLB0 */:
        case 220 /* OP.RDTLB0 */:
          ar[it] = (ar[is] & 0xe0000000) >>> 0; // the entry's VPN
          break;
        case 241 /* OP.RITLB1 */:
          ar[it] = ((ar[is] & 0xe0000000) | this.itlb[ar[is] >>> 29]) >>> 0; // PPN | attribute
          break;
        case 221 /* OP.RDTLB1 */:
          ar[it] = ((ar[is] & 0xe0000000) | this.dtlb[ar[is] >>> 29]) >>> 0;
          break;
        case 82 /* OP.IITLB */:
        case 81 /* OP.IDTLB */:
          break; // the entries are fixed: nothing to invalidate

        // ── Zero-overhead loops ───────────────────────────────────────────────────────────
        case 99 /* OP.LOOP */:
        case 101 /* OP.LOOPNEZ */:
        case 100 /* OP.LOOPGTZ */: {
          const count = ar[is];
          this.lcount = (count - 1) >>> 0;
          this.lbeg = next;
          this.lend = tgt >>> 0;
          if ((op === OP.LOOPNEZ && count === 0) || (op === OP.LOOPGTZ && (count | 0) <= 0)) {
            npc = this.lend;
            jumped = true;
          }
          break;
        }

        // ── Exceptions, interrupts, special registers ─────────────────────────────────────
        case 235 /* OP.RFE */:
          this.ps &= ~PS_EXCM;
          npc = this.sr[SR.EPC1];
          jumped = true;
          this.updatePs();
          break;
        case 233 /* OP.RFDE */:
          // Back into the handler the double exception interrupted: PS (EXCM = 1) is unchanged.
          npc = this.sr[SR.DEPC];
          jumped = true;
          break;
        case 236 /* OP.RFI */:
        case 234 /* OP.RFDO */:
        case 232 /* OP.RFDD */: {
          // RFDO/RFDD (OCD debug-mode returns) return from the debug level like RFI 6.
          const level = op === OP.RFI ? imm : exc.DEBUG_LEVEL;
          if (level < 2 || level > 7) {
            this.illegal(pc);
            continue;
          }
          this.ps = this.sr[SR.EPS2 + level - 2] & PS_MASK;
          npc = this.sr[SR.EPC1 + level - 1];
          jumped = true;
          this.updatePs();
          break;
        }
        case 355 /* OP.SYSCALL */:
          this.raise(EXCCAUSE.SYSCALL, pc);
          continue;
        case 332 /* OP.SIMCALL */:
          break; // a simulator hook; a no-op on hardware
        case 244 /* OP.RSIL */:
          ar[it] = this.ps;
          this.ps = (this.ps & ~PS_INTLEVEL) | imm;
          this.updatePs();
          break;
        case 367 /* OP.WAITI */:
          this.ps = (this.ps & ~PS_INTLEVEL) | imm;
          this.waiting = true;
          this.stopAt = this.cycles; // the run loop sleeps from the next boundary (ends a cached block)
          this.updatePs();
          break;
        case 226 /* OP.RER */:
          ar[it] = this.eri.get(ar[is]) ?? 0;
          break;
        case 369 /* OP.WER */:
          this.eri.set(ar[is], ar[it]);
          break;

        // ── Synchronisation, no-ops, breaks ───────────────────────────────────────────────
        case 206 /* OP.NOP */:
        case 207 /* OP.NOP_N */:
        case 85 /* OP.ISYNC */:
        case 313 /* OP.RSYNC */:
        case 66 /* OP.ESYNC */:
        case 64 /* OP.DSYNC */:
        case 110 /* OP.MEMW */:
        case 69 /* OP.EXTW */:
        case 67 /* OP.EXCW */:
          break;
        case 47 /* OP.BREAK */:
        case 48 /* OP.BREAK_N */: {
          const bt = op === OP.BREAK ? t : -1;
          if (this.breakHook !== null && this.breakHook(imm, bt)) {
            this.halt = HALT.BREAK;
            this.haltReason = op === OP.BREAK ? `${imm}, ${bt}` : `${imm}`;
            this.stopAt = this.cycles;
            continue;
          }
          if ((this.ps & PS_INTLEVEL) < exc.DEBUG_LEVEL) {
            this.debugException(op === OP.BREAK ? exc.DEBUGCAUSE.BREAK : exc.DEBUGCAUSE.BREAKN, pc);
            continue;
          }
          break; // masked: ignored
        }
        case 83 /* OP.ILL */:
        case 84 /* OP.ILL_N */:
          this.illegal(pc);
          continue;
        default: {
          const ext = EXT_KIND[op];
          if (ext === 1) {
            if (!executeFpu(this, op, r, s, t, imm, pc)) continue;
            break;
          }
          if (ext === 2) {
            executeMac16(this, op, r, s, t);
            break;
          }
          const kind = SPECIAL_KIND[op];
          if (kind === 0) {
            this.fault(`unimplemented: ${OPS[op].name}`);
            continue;
          }
          const n = SPECIAL_NUMBER[op];
          // FCR and FSR are coprocessor 0 state: CPENABLE bit 0 gates them like any FPU access.
          if (kind >= 4 && (n === UR.FCR || n === UR.FSR) && (this.sr[SR.CPENABLE] & 1) === 0) {
            this.raise(EXCCAUSE.COPROCESSOR_DISABLED, pc);
            continue;
          }
          if (kind === 1) ar[it] = this.readSpecial(n);
          else if (kind === 2) this.writeSpecial(n, ar[it]);
          else if (kind === 3) {
            const old = this.readSpecial(n);
            this.writeSpecial(n, ar[it]);
            ar[it] = old;
          } else if (kind === 4) ar[ir] = this.ur[n];
          else this.ur[n] = ar[it] & UR_WRITABLE[n];
        }
      }
      // Zero-overhead loop: falling through to LEND loops back — not after a taken branch or jump,
      // even one whose target is LEND (`beqz a8, LEND` is how compiled loops exit early).
      if (!jumped && next === this.lend && this.lcount !== 0 && (this.ps & PS_EXCM) === 0) {
        this.lcount = (this.lcount - 1) >>> 0;
        npc = this.lbeg;
      }
      this.pc = npc >>> 0;
      this.cycles++;
    } while (code !== null && this.cycles < this.stopAt);
  }
}
