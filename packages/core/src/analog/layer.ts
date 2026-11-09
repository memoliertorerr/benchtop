/**
 * The analog layer: solves resistive islands and publishes true voltages on their nets.
 *
 * Sources (decided): supply nets are fixed voltages; strong drivers are Norton sources with
 * 25 Ω; weak drivers carry their own resistance (MCU pull-ups 35 kΩ on an ATmega328P, other weak
 * drivers 10 kΩ). Resistive links use their ohms; a closed switch is 1 mΩ, an open one absent;
 * diodes are piecewise linear (off below Vf, (Vd − Vf)/rs above), iterated from the last
 * solution for at most 20 rounds. Nets with no conductive path to a source (through resistors,
 * closed switches, conducting diodes and capacitors) get gmin 1e-12 S to ground and keep their
 * switch-level state; the others carry no gmin, so their voltages are exact; islands with a short
 * (a switch-level conflict) or more than MAX_NODES (256) unknown nets are left at switch level.
 * Each island's nets get solver indices fewest-neighbors first, so the solver eliminates leaves
 * before hubs and never fills in a star (a pin driving 100 LED branches) or a ladder.
 *
 * Results: a solved net's volts; its level from the reading MCU's thresholds (≥ 0.6·Vcc → 1,
 * ≤ 0.3·Vcc → 0, in between the previous level holds and, on a net an MCU pin reads, an
 * 'analog-undefined-level' is reported once); strength as switch level gave it; conflict false.
 * An island without capacitors is solved synchronously, only when its inputs change. No
 * allocation per solve.
 *
 * BT166: capacitors. An island with capacitors keeps transient state — each capacitor's voltage
 * (a − b) and current (a → b) and the time `tAt` they hold for — and steps in time. Integration is
 * the trapezoidal rule (companion G = 2C/h, I = G·v + i), with a backward-Euler step (G = C/h,
 * I = G·v) after every input change (the trapezoidal rule rings on a jump) and for any step longer
 * than the island's shortest time constant τ (L-stable; the trapezoidal rule rings above 2τ). τ is
 * estimated per capacitor as C over the conductance the rest of the island puts at its ends (the
 * assembled matrix's diagonal). An input change at time t (the layer's `clock`) first advances the
 * island to t on the inputs it was last solved with (kept: `inG`, `inGV`, `inClosed`, `inOhms`),
 * then solves the instant after it on the new ones (a 1 ns backward-Euler step: capacitor voltages
 * are continuous) and plans the next step (`plan`, which the bench turns into a timer): h = τ/5,
 * the first one after a jump h/10 (backward Euler's error grows with h²).
 * Each step doubles h while it moves no capacitor by more than 2 mV (up to 10 ms); a step that
 * moves none by more than 50 µV settles the island: no more steps until its inputs change.
 * `moving` counts the islands still stepping. A capacitor conducts for the "reached" rule, so a net
 * a charged capacitor holds after its driver lets go publishes the capacitor's volts and a level.
 * Capacitors start empty (0 V) at build and reset.
 */

import type { Level, Strength } from '../contracts/signal.ts';
import type { Island } from './islands.ts';
import { DenseSolver, MAX_NODES } from './solve.ts';

/** What the layer reads from (and writes to) the switch-level resolver. */
export interface AnalogHost {
  /** Σ 1/R and Σ V/R of the strong and weak drivers on `net` (Norton). */
  driverG(net: number): number;
  driverGV(net: number): number;
  /** Whether resolver link `link` conducts. */
  isLinkClosed(link: number): boolean;
  /** Whether `net` is fixed by a supply, and its voltage. */
  isFixed(net: number): boolean;
  fixedVolts(net: number): number;
  /** The switch-level resolution of an island net (not yet published). */
  swLevel(net: number): Level | null;
  swStrength(net: number): Strength;
  swVolts(net: number): number;
  swConflict(net: number): boolean;
  /** The net's currently published level. */
  publishedLevel(net: number): Level | null;
  /** Publishes a net's state (the host notifies listeners if it changed). */
  publish(net: number, level: Level | null, strength: Strength, conflict: boolean, volts: number): void;
}

export interface DiodeInstance {
  anode: number;
  cathode: number;
  vf: number;
  rs: number;
}

/** BT168: transistor kinds, as `TransistorInstance.kind`. */
export const TRANSISTOR = { NPN: 0, PNP: 1, NMOS: 2, PMOS: 3 } as const;

/**
 * BT168: a transistor's nets and model: `x` the collector or drain, `ctl` the base or gate, `ref`
 * the emitter or source. BJTs use beta, vbe (the junction's knee), rb (above it), vceSat, rsat;
 * MOSFETs vth, rdsOn, vgsOn (magnitudes: a P-channel's are negated where used).
 */
export interface TransistorInstance {
  kind: (typeof TRANSISTOR)[keyof typeof TRANSISTOR];
  x: number;
  ctl: number;
  ref: number;
  beta: number;
  vbe: number;
  rb: number;
  vceSat: number;
  rsat: number;
  vth: number;
  rdsOn: number;
  vgsOn: number;
  /** BT171: its current rating, amps (0: none). */
  iMax?: number;
}

/**
 * BT166: a capacitor between nets `a` and `b`; BT172: in series with `seriesOhms`, shunted by
 * `parallelOhms`; BT176: with `henries` in the same series chain (`farads` 0 and no leak: an R–L).
 */
export interface CapacitorInstance {
  a: number;
  b: number;
  farads: number;
  seriesOhms?: number;
  parallelOhms?: number;
  henries?: number;
}

export const STRONG_OHMS = 25;
export const SWITCH_OHMS = 1e-3;
export const GMIN = 1e-12;
/**
 * An off diode's conductance (1 GΩ). Off diodes leak this little instead of opening fully, so a
 * node reached only through them (an LED's cathode on a pin that is still an input, the node
 * between two LEDs in series) follows its neighbors instead of sitting at 0 V on GMIN — which
 * made such a diode look forward-biased, turn on with no current, turn off, and never settle.
 * 5 V across it is 5 nA: no reading anywhere moves by a count.
 */
export const GOFF = 1e-9;
export const MAX_DIODE_ITERATIONS = 20;
const HIGH_FRACTION = 0.6;
const LOW_FRACTION = 0.3;

/** BT166: the instant after an input change, as a backward-Euler step (seconds). */
export const INSTANT_STEP_S = 1e-9;
/** BT176: the shortest time constant the step size follows, seconds. */
export const MIN_TAU_S = 1e-6;
/** BT166: the first step after a change is the island's shortest time constant over this. */
export const STEP_FRACTION = 5;
/** BT166: the longest step, seconds. */
export const MAX_STEP_S = 10e-3;
/** BT166: a step that moves no capacitor by more than this (volts) lets h double. */
export const GROW_BELOW_V = 2e-3;
/** BT166: a step that moves no capacitor by more than this (volts) settles the island. */
export const SETTLED_BELOW_V = 50e-6;
/** BT170: an island whose time constant is under this (seconds; 5 one-MCU quanta) makes the bench's quanta short. */
export const FAST_TAU_S = 5e-3;
/** BT166: the first step after a jump is h over this (backward Euler, accurate while short). */
export const FIRST_STEP_DIVISOR = 10;
/** BT166: the most steps one catch-up takes before finishing with one backward-Euler step. */
const MAX_CATCH_UP_STEPS = 64;
const NS_PER_S = 1e9;
const MODE_BE = 0;
const MODE_TR = 1;

export class AnalogLayer {
  readonly islands: readonly Island[];
  readonly netIsland: Int32Array;
  /** Ohms per resolver link (resistive links; others unused). */
  readonly linkOhms: Float64Array;
  /** Logic supply of the MCU whose pin is on a net (default 5 V), and whether one reads it. */
  readonly netVcc: Float64Array;
  readonly netReader: Uint8Array;
  /** BT167: the input thresholds (VIH, VIL) of the MCU pin reading a net (0 when none). */
  readonly netHigh: Float64Array;
  readonly netLow: Float64Array;
  /** Islands too large to solve (left at switch level). */
  readonly tooLarge: Uint8Array;
  /** A read net sits between the thresholds; return true if it was reported (once per run). */
  onUndefinedLevel: ((net: number, volts: number) => boolean) | null = null;
  onNoConvergence: ((island: number) => void) | null = null;
  /** BT166: the time now, ns (the bench's). */
  clock: () => number = () => 0;
  /** BT166: steps island `island` at time `at` (ns), replacing its earlier plan (the bench's timer). */
  plan: ((island: number, at: number) => void) | null = null;
  /** BT166: islands whose capacitors are still moving. */
  moving = 0;
  /**
   * BT170: islands whose shortest time constant is under FAST_TAU_S: the bench runs short quanta
   * while there are any, so a step planned inside an MCU run (after a pin edge) is at most 100 µs
   * late. A slower island's steps come later than a quantum's end anyway.
   */
  fast = 0;
  /**
   * BT171: transistor `t`'s collector/drain current went over its rating (`over`) or back under;
   * `amps` its magnitude now.
   */
  onTransistorCurrent: ((t: number, over: boolean, amps: number) => void) | null = null;
  /** BT166: transient solves so far (instants and steps), for tests and budgets. */
  transientSolves = 0;
  /** BT166: the islands that have capacitors. */
  readonly capacitorIslands: Int32Array;
  private readonly diodeAnode: Int32Array;
  private readonly diodeCathode: Int32Array;
  private readonly diodeVf: Float64Array;
  private readonly diodeRs: Float64Array;
  private readonly diodeOn: Uint8Array;
  private readonly linkA: Int32Array;
  private readonly linkB: Int32Array;
  /** Local index of a net within its island, or −1. */
  private readonly local: Int32Array;
  private readonly dirty: Uint8Array;
  private readonly dirtyList: Int32Array;
  private dirtyLen = 0;
  private readonly reportedUndefined: Uint8Array;
  private readonly reportedConvergence: Uint8Array;
  private readonly solver = new DenseSolver();
  private readonly reached = new Uint8Array(MAX_NODES);
  // BT166: capacitors and the transient state of the islands that have them.
  private readonly capA: Int32Array;
  private readonly capB: Int32Array;
  private readonly capF: Float64Array;
  private readonly capV: Float64Array;
  private readonly capI: Float64Array;
  /** BT172: the series conductance (Infinity: none) and the leak's (0: none). */
  private readonly capGs: Float64Array;
  private readonly capGp: Float64Array;
  /** BT176: the series inductance (0: none), its current (the branch's, a → b) and voltage. */
  private readonly capL: Float64Array;
  private readonly capIL: Float64Array;
  private readonly capVL: Float64Array;
  /** BT176: the chain the last `chain()` call worked out: its resistance and Thevenin pieces. */
  private chainR = 0;
  private chainRl = 0;
  private chainEl = 0;
  private chainRc = 0;
  private chainEc = 0;
  private chainKc = 0;
  private readonly isMoving: Uint8Array;
  private readonly isFast: Uint8Array;
  /** The time (ns) an island's capacitor state holds for. */
  private readonly tAt: Float64Array;
  /** Its next step, seconds. */
  private readonly stepS: Float64Array;
  /** Its shortest time constant, seconds (Infinity when nothing charges its capacitors). */
  private readonly tauS: Float64Array;
  /** Its next step is backward Euler (an input changed). */
  private readonly jump: Uint8Array;
  /** The inputs it was last solved with: drivers per net, link states and ohms per link. */
  private readonly inG: Float64Array;
  private readonly inGV: Float64Array;
  private readonly inClosed: Uint8Array;
  private readonly inOhms: Float64Array;
  /** BT177: and whether each of its nets was fixed by a supply, at what volts. */
  private readonly inFixed: Uint8Array;
  private readonly inFixedV: Float64Array;
  // BT168: transistors — their nets, models and states (BJT: 0 off, 1 active, 2 saturated;
  // MOSFET: 0 off, 1 on with conductance tG).
  private readonly tKind: Uint8Array;
  private readonly tX: Int32Array;
  private readonly tCtl: Int32Array;
  private readonly tRef: Int32Array;
  private readonly tBeta: Float64Array;
  private readonly tVbe: Float64Array;
  private readonly tRb: Float64Array;
  private readonly tVceSat: Float64Array;
  private readonly tRsat: Float64Array;
  private readonly tVth: Float64Array;
  private readonly tRds: Float64Array;
  private readonly tVgsOn: Float64Array;
  private readonly tState: Uint8Array;
  private readonly tG: Float64Array;
  private readonly tIMax: Float64Array;
  private readonly tOver: Uint8Array;
  /** The current assembly reads the kept inputs instead of the host's. */
  private kept = false;
  /** The current assembly's capacitor stamps: mode and step (seconds). */
  private mode = MODE_BE;
  private hS = INSTANT_STEP_S;
  /** The largest capacitor voltage change of the last commit; −1 when `advance` took no step. */
  private lastMove = -1;
  /** BT167: the last step's length (seconds), and each read net's volts after it (NaN: none yet). */
  private lastStepS = 0;
  private readonly netV: Float64Array;

  constructor(
    netCount: number,
    islands: readonly Island[],
    netIsland: Int32Array,
    links: readonly { a: number; b: number }[],
    diodes: readonly DiodeInstance[],
    capacitors: readonly CapacitorInstance[] = [],
    transistors: readonly TransistorInstance[] = [],
  ) {
    this.islands = islands;
    this.netIsland = netIsland;
    this.linkOhms = new Float64Array(links.length).fill(1000);
    this.linkA = Int32Array.from(links.map((l) => l.a));
    this.linkB = Int32Array.from(links.map((l) => l.b));
    this.netVcc = new Float64Array(netCount).fill(5);
    this.netReader = new Uint8Array(netCount);
    this.netHigh = new Float64Array(netCount);
    this.netLow = new Float64Array(netCount);
    this.netV = new Float64Array(netCount).fill(Number.NaN);
    this.local = new Int32Array(netCount).fill(-1);
    this.tooLarge = new Uint8Array(islands.length);
    islands.forEach((island, i) => (this.tooLarge[i] = island.nets.length > MAX_NODES ? 1 : 0));
    this.dirty = new Uint8Array(islands.length);
    this.dirtyList = new Int32Array(Math.max(1, islands.length));
    this.diodeAnode = Int32Array.from(diodes.map((d) => d.anode));
    this.diodeCathode = Int32Array.from(diodes.map((d) => d.cathode));
    this.diodeVf = Float64Array.from(diodes.map((d) => d.vf));
    this.diodeRs = Float64Array.from(diodes.map((d) => d.rs));
    this.diodeOn = new Uint8Array(diodes.length);
    this.capA = Int32Array.from(capacitors.map((c) => c.a));
    this.capB = Int32Array.from(capacitors.map((c) => c.b));
    this.capF = Float64Array.from(capacitors.map((c) => c.farads));
    this.capV = new Float64Array(capacitors.length);
    this.capI = new Float64Array(capacitors.length);
    this.capGs = Float64Array.from(capacitors.map((c) => (c.seriesOhms !== undefined && c.seriesOhms > 0 ? 1 / c.seriesOhms : Number.POSITIVE_INFINITY)));
    this.capGp = Float64Array.from(capacitors.map((c) => (c.parallelOhms !== undefined && c.parallelOhms > 0 ? 1 / c.parallelOhms : 0)));
    this.capL = Float64Array.from(capacitors.map((c) => (c.henries !== undefined && c.henries > 0 ? c.henries : 0)));
    this.capIL = new Float64Array(capacitors.length);
    this.capVL = new Float64Array(capacitors.length);
    this.isMoving = new Uint8Array(islands.length);
    this.isFast = new Uint8Array(islands.length);
    this.tAt = new Float64Array(islands.length);
    this.stepS = new Float64Array(islands.length);
    this.tauS = new Float64Array(islands.length).fill(Number.POSITIVE_INFINITY);
    this.jump = new Uint8Array(islands.length);
    this.inG = new Float64Array(netCount);
    this.inGV = new Float64Array(netCount);
    this.inClosed = new Uint8Array(links.length);
    this.inFixed = new Uint8Array(netCount);
    this.inFixedV = new Float64Array(netCount);
    this.inOhms = new Float64Array(links.length);
    this.tKind = Uint8Array.from(transistors.map((t) => t.kind));
    this.tX = Int32Array.from(transistors.map((t) => t.x));
    this.tCtl = Int32Array.from(transistors.map((t) => t.ctl));
    this.tRef = Int32Array.from(transistors.map((t) => t.ref));
    this.tBeta = Float64Array.from(transistors.map((t) => t.beta));
    this.tVbe = Float64Array.from(transistors.map((t) => t.vbe));
    this.tRb = Float64Array.from(transistors.map((t) => t.rb));
    this.tVceSat = Float64Array.from(transistors.map((t) => t.vceSat));
    this.tRsat = Float64Array.from(transistors.map((t) => t.rsat));
    this.tVth = Float64Array.from(transistors.map((t) => t.vth));
    this.tRds = Float64Array.from(transistors.map((t) => t.rdsOn));
    this.tVgsOn = Float64Array.from(transistors.map((t) => t.vgsOn));
    this.tState = new Uint8Array(transistors.length);
    this.tG = new Float64Array(transistors.length);
    this.tIMax = Float64Array.from(transistors.map((t) => t.iMax ?? 0));
    this.tOver = new Uint8Array(transistors.length);
    this.capacitorIslands = Int32Array.from(islands.flatMap((island, i) => (island.capacitors.length > 0 ? [i] : [])));
    for (const island of islands) this.orderNodes(island);
    this.reportedUndefined = new Uint8Array(netCount);
    this.reportedConvergence = new Uint8Array(islands.length);
  }

  /**
   * Solver indices for an island's nets: fewest neighbors (other nets of the island across a
   * resistor, switch, diode or capacitor) first, ties in net order — a static minimum-degree order.
   */
  private orderNodes(island: Island): void {
    const nets = island.nets;
    const member = (net: number): boolean => nets.includes(net);
    const degree = new Map<number, number>();
    for (const net of nets) degree.set(net, 0);
    const count = (a: number, b: number): void => {
      if (a === b || !member(a) || !member(b)) return;
      degree.set(a, (degree.get(a) ?? 0) + 1);
      degree.set(b, (degree.get(b) ?? 0) + 1);
    };
    for (const link of island.resistors) count(this.linkA[link], this.linkB[link]);
    for (const link of island.switches) count(this.linkA[link], this.linkB[link]);
    for (const d of island.diodes) count(this.diodeAnode[d], this.diodeCathode[d]);
    for (const c of island.capacitors) count(this.capA[c], this.capB[c]);
    for (const t of island.transistors) {
      count(this.tX[t], this.tRef[t]);
      count(this.tCtl[t], this.tRef[t]);
    }
    const order = Array.from(nets).sort((x, y) => (degree.get(x) ?? 0) - (degree.get(y) ?? 0) || x - y);
    order.forEach((net, i) => (this.local[net] = i));
  }

  markDirty(island: number): void {
    if (this.dirty[island] === 1) return;
    this.dirty[island] = 1;
    this.dirtyList[this.dirtyLen++] = island;
  }

  get pending(): boolean {
    return this.dirtyLen > 0;
  }

  /** Solves every dirty island and publishes its nets. */
  solveDirty(host: AnalogHost): void {
    for (let k = 0; k < this.dirtyLen; k++) {
      const island = this.dirtyList[k];
      this.dirty[island] = 0;
      this.solveIsland(island, host);
    }
    this.dirtyLen = 0;
  }

  /**
   * Back to a fresh layer's state (bench reset): once-per-run reports, diode states, and (BT166)
   * empty capacitors, no island moving, at time 0.
   */
  reset(): void {
    this.reportedUndefined.fill(0);
    this.reportedConvergence.fill(0);
    this.diodeOn.fill(0);
    this.tState.fill(0);
    this.tG.fill(0);
    this.tOver.fill(0);
    this.capV.fill(0);
    this.capI.fill(0);
    this.capIL.fill(0);
    this.capVL.fill(0);
    this.isMoving.fill(0);
    this.moving = 0;
    this.isFast.fill(0);
    this.fast = 0;
    this.tAt.fill(0);
    this.jump.fill(0);
  }

  /** BT166: whether island `island` is still stepping. */
  isIslandMoving(island: number): boolean {
    return this.isMoving[island] === 1;
  }

  /** BT166: capacitor `k`'s voltage (a − b). */
  capacitorVolts(k: number): number {
    return this.capV[k];
  }

  /** BT176: element `k`'s inductor current (a → b; 0 without inductance). */
  inductorAmps(k: number): number {
    return this.capIL[k];
  }

  /**
   * BT166: a planned step of island `index` (the bench's timer): advances its capacitors to now on
   * its kept inputs, publishes, and plans the next step or settles.
   */
  step(index: number, host: AnalogHost): void {
    if (this.isMoving[index] === 0) return;
    const now = this.clock();
    if (!this.advance(index, now, host)) {
      this.publishSwitchLevel(this.islands[index], host);
      this.stop(index);
      return;
    }
    // No step taken (nothing elapsed): the solver holds another island's solution; plan again.
    let next = this.stepS[index];
    if (this.lastMove >= 0) {
      next = this.untilCrossing(index, next);
      this.publishIsland(index, host);
      if (this.lastMove < SETTLED_BELOW_V) {
        this.stop(index);
        return;
      }
    }
    this.planStep(index, now, next);
  }

  /**
   * BT167: the next step, shortened so it lands just past the next threshold crossing of a net an
   * MCU pin reads (its VIH rising, its VIL falling) at the last step's slope; a step at most 64
   * times shorter. Records the read nets' volts for the next slope.
   */
  private untilCrossing(index: number, stepS: number): number {
    const island = this.islands[index];
    let next = stepS;
    for (let i = 0; i < island.nets.length; i++) {
      const net = island.nets[i];
      if (this.netReader[net] === 0 || !(this.netHigh[net] > 0)) continue;
      const v = this.solver.x[this.local[net]];
      const before = this.netV[net];
      this.netV[net] = v;
      if (Number.isNaN(before) || !(this.lastStepS > 0)) continue;
      const slope = (v - before) / this.lastStepS;
      let until: number;
      if (slope > 0 && v < this.netHigh[net]) until = (this.netHigh[net] - v) / slope;
      else if (slope < 0 && v > this.netLow[net]) until = (this.netLow[net] - v) / slope;
      else continue;
      // A little past the linear estimate: a charging curve is concave, so it crosses later.
      const h = until * 1.02;
      if (h < next) next = h;
    }
    const least = stepS / 64;
    return next < least ? least : next;
  }

  /** BT167: records the read nets' volts after an instant (no slope across a jump). */
  private recordReadNets(index: number): void {
    const island = this.islands[index];
    for (let i = 0; i < island.nets.length; i++) {
      const net = island.nets[i];
      if (this.netReader[net] === 1) this.netV[net] = this.solver.x[this.local[net]];
    }
  }

  private stop(index: number): void {
    if (this.isMoving[index] === 0) return;
    this.isMoving[index] = 0;
    this.moving--;
  }

  /** Plans island `index`'s next step `stepS` (seconds) after `from` (ns). */
  private planStep(index: number, from: number, stepS: number): void {
    this.plan?.(index, from + stepS * NS_PER_S);
  }

  private setFast(index: number, fast: boolean): void {
    const value = fast ? 1 : 0;
    if (this.isFast[index] === value) return;
    this.isFast[index] = value;
    this.fast += fast ? 1 : -1;
  }

  private publishSwitchLevel(island: Island, host: AnalogHost): void {
    for (let i = 0; i < island.nets.length; i++) {
      const net = island.nets[i];
      host.publish(net, host.swLevel(net), host.swStrength(net), host.swConflict(net), host.swVolts(net));
    }
  }

  /** An element end as a local node index, or −1 for a fixed net. */
  private node(net: number, host: AnalogHost): number {
    return this.isFixed(net, host) ? -1 : this.local[net];
  }

  private solveIsland(index: number, host: AnalogHost): void {
    const island = this.islands[index];
    const n = island.nets.length;
    if (this.tooLarge[index] === 1) {
      this.publishSwitchLevel(island, host);
      return;
    }
    for (let i = 0; i < n; i++) {
      if (host.swConflict(island.nets[i])) {
        this.publishSwitchLevel(island, host);
        return;
      }
    }
    if (island.capacitors.length === 0) {
      this.kept = false;
      if (!this.iterate(index, host)) {
        this.publishSwitchLevel(island, host);
        return;
      }
      this.publishIsland(index, host);
      return;
    }
    // BT166: catch up to now on the old inputs, then the instant after the change on the new.
    const now = this.clock();
    if (this.isMoving[index] === 1) this.advance(index, now, host);
    else if (now > this.tAt[index]) this.tAt[index] = now;
    this.keepInputs(island, host);
    this.kept = true;
    this.mode = MODE_BE;
    this.hS = INSTANT_STEP_S;
    this.transientSolves++;
    if (!this.iterate(index, host)) {
      this.publishSwitchLevel(island, host);
      this.stop(index);
      return;
    }
    this.commitCapacitors(index, host);
    this.recordReadNets(index);
    this.lastStepS = 0;
    this.publishIsland(index, host);
    const tau = this.tauS[index];
    this.setFast(index, tau < FAST_TAU_S);
    if (!(tau < Number.POSITIVE_INFINITY)) {
      this.stop(index);
      return;
    }
    this.stepS[index] = Math.min(tau / STEP_FRACTION, MAX_STEP_S);
    this.jump[index] = 1;
    if (this.isMoving[index] === 0) {
      this.isMoving[index] = 1;
      this.moving++;
    }
    this.planStep(index, this.tAt[index], this.stepS[index] / FIRST_STEP_DIVISOR);
  }

  /**
   * BT166: steps island `index`'s capacitors from `tAt` to `t` (ns) on its kept inputs: steps of
   * `stepS` (the last one shorter), backward Euler after a jump or above τ, else trapezoidal; h
   * doubles after a full step that moved no capacitor by more than GROW_BELOW_V. False when a
   * solve fails (the state stays).
   */
  private advance(index: number, t: number, host: AnalogHost): boolean {
    this.kept = true;
    this.lastMove = -1;
    let at = this.tAt[index];
    let steps = 0;
    while (t - at > 0.5) {
      // After a jump the first step is a tenth of h: backward Euler's error grows with h².
      const first = this.jump[index] === 1;
      let hS = first ? this.stepS[index] / FIRST_STEP_DIVISOR : this.stepS[index];
      const leftS = (t - at) / NS_PER_S;
      let full = !first;
      if (++steps > MAX_CATCH_UP_STEPS) {
        // Far behind (a step planned inside a long MCU run): finish in one L-stable step.
        hS = leftS;
        this.jump[index] = 1;
        full = false;
      } else if (leftS < hS) {
        hS = leftS;
        full = false;
      }
      this.mode = this.jump[index] === 1 || hS > this.tauS[index] ? MODE_BE : MODE_TR;
      this.hS = hS;
      this.transientSolves++;
      if (!this.iterate(index, host)) return false;
      const moved = this.commitCapacitors(index, host);
      this.lastStepS = hS;
      this.jump[index] = 0;
      at += hS * NS_PER_S;
      if (full && moved < GROW_BELOW_V) this.stepS[index] = Math.min(this.stepS[index] * 2, MAX_STEP_S);
      if (steps > MAX_CATCH_UP_STEPS) break;
    }
    if (t > this.tAt[index]) this.tAt[index] = t;
    return true;
  }

  /** BT166: an island's inputs as the host has them now, kept for its catch-up steps. */
  private keepInputs(island: Island, host: AnalogHost): void {
    for (let i = 0; i < island.nets.length; i++) {
      const net = island.nets[i];
      this.inG[net] = host.driverG(net);
      this.inGV[net] = host.driverGV(net);
      this.inFixed[net] = host.isFixed(net) ? 1 : 0;
      this.inFixedV[net] = host.fixedVolts(net);
    }
    for (let k = 0; k < island.resistors.length; k++) {
      const link = island.resistors[k];
      this.inOhms[link] = this.linkOhms[link];
    }
    for (let k = 0; k < island.switches.length; k++) {
      const link = island.switches[k];
      this.inClosed[link] = host.isLinkClosed(link) ? 1 : 0;
    }
  }

  /**
   * BT177: whether a net is fixed, and at what — for an island's own nets, as the kept inputs say
   * while catching up (a bridge that just released its outputs was still driving them then); the
   * nets around an island are supplies and read live.
   */
  private isFixed(net: number, host: AnalogHost): boolean {
    return this.kept && this.netIsland[net] >= 0 ? this.inFixed[net] === 1 : host.isFixed(net);
  }

  private fixedVolts(net: number, host: AnalogHost): number {
    return this.kept && this.netIsland[net] >= 0 ? this.inFixedV[net] : host.fixedVolts(net);
  }

  private driverG(net: number, host: AnalogHost): number {
    return this.kept ? this.inG[net] : host.driverG(net);
  }

  private driverGV(net: number, host: AnalogHost): number {
    return this.kept ? this.inGV[net] : host.driverGV(net);
  }

  private closed(link: number, host: AnalogHost): boolean {
    return this.kept ? this.inClosed[link] === 1 : host.isLinkClosed(link);
  }

  private ohms(link: number): number {
    return this.kept ? this.inOhms[link] : this.linkOhms[link];
  }

  /**
   * Assembles and solves island `index` (its diodes iterated), leaving the solution in the solver;
   * capacitors stamp as `mode` with step `hS`. False when the system is singular.
   */
  private iterate(index: number, host: AnalogHost): boolean {
    const island = this.islands[index];
    const n = island.nets.length;
    const solver = this.solver;
    let converged = false;
    for (let round = 0; round < MAX_DIODE_ITERATIONS; round++) {
      // gmin only where nothing conducts to a source (those nets publish switch level anyway),
      // so solved voltages carry no gmin error (a 10 k/10 k divider is exactly 2.5 V).
      this.markReached(island, host);
      solver.reset(n, 0);
      for (let i = 0; i < n; i++) if (this.reached[i] === 0) solver.conductance(i, -1, GMIN);
      for (let i = 0; i < n; i++) {
        const net = island.nets[i];
        if (this.isFixed(net, host)) {
          // A supply a part model drives (a battery, BT83): fixed at run time, after the islands
          // were built. Its row pins it to its volts; its neighbours already see it as fixed.
          const li = this.local[net];
          solver.conductance(li, -1, 1);
          solver.current(li, this.fixedVolts(net, host));
          continue;
        }
        const g = this.driverG(net, host);
        if (g > 0) {
          // Norton source: g to ground plus g·V injected.
          const li = this.local[net];
          solver.conductance(li, -1, g);
          solver.current(li, this.driverGV(net, host));
        }
      }
      for (let k = 0; k < island.resistors.length; k++) {
        const link = island.resistors[k];
        this.stamp(this.linkA[link], this.linkB[link], 1 / Math.max(this.ohms(link), SWITCH_OHMS), host);
      }
      for (let k = 0; k < island.switches.length; k++) {
        const link = island.switches[k];
        if (this.closed(link, host)) this.stamp(this.linkA[link], this.linkB[link], 1 / SWITCH_OHMS, host);
      }
      for (let k = 0; k < island.diodes.length; k++) {
        const d = island.diodes[k];
        if (this.diodeOn[d] === 0) {
          this.stamp(this.diodeAnode[d], this.diodeCathode[d], GOFF, host);
          continue;
        }
        const g = 1 / this.diodeRs[d];
        const a = this.diodeAnode[d];
        const c = this.diodeCathode[d];
        this.stamp(a, c, g, host);
        // I = g·(Va − Vc − Vf): a current g·Vf pushed out of the cathode into the anode.
        solver.current(this.node(a, host), g * this.diodeVf[d]);
        solver.current(this.node(c, host), -g * this.diodeVf[d]);
      }
      if (island.transistors.length > 0) this.stampTransistors(island, host);
      if (island.capacitors.length > 0) {
        // Every round, so the converged one's states (a flyback diode turning on) set τ (BT176) —
        // and on every step, not only after a change (BT177): a diode that stops conducting mid-way
        // leaves a coil on its leaks alone, τ far below h, and the next step must be backward Euler
        // or the trapezoidal rule rings.
        this.estimateTau(index, host);
        this.stampCapacitors(island, host);
      }
      if (!solver.solve()) return false;
      let changed = island.transistors.length > 0 && this.updateTransistors(island, host);
      for (let k = 0; k < island.diodes.length; k++) {
        const d = island.diodes[k];
        const vd = this.volts(this.diodeAnode[d], host) - this.volts(this.diodeCathode[d], host);
        const on = this.diodeOn[d] === 1;
        // An on diode carrying no current is off: otherwise an undriven anode (a released
        // MCU pin) would stay pinned at Vf by the diode's own previous state.
        if (on && vd <= this.diodeVf[d] + 1e-9) {
          this.diodeOn[d] = 0;
          changed = true;
        } else if (!on && vd > this.diodeVf[d] + 1e-9) {
          this.diodeOn[d] = 1;
          changed = true;
        }
      }
      if (!changed) {
        converged = true;
        break;
      }
    }
    if (!converged && this.reportedConvergence[index] === 0) {
      this.reportedConvergence[index] = 1;
      this.onNoConvergence?.(index);
    }
    return true;
  }

  /**
   * BT166: the island's shortest time constant, from the matrix assembled so far (everything but
   * the capacitors): each capacitor's C over the conductance at its ends (one end fixed: the
   * other's; both unknown: the two in series).
   */
  private estimateTau(index: number, host: AnalogHost): void {
    const island = this.islands[index];
    let tau = Number.POSITIVE_INFINITY;
    for (let k = 0; k < island.capacitors.length; k++) {
      const c = island.capacitors[k];
      const la = this.node(this.capA[c], host);
      const lb = this.node(this.capB[c], host);
      const ga = la >= 0 ? this.solver.diag(la) : Number.POSITIVE_INFINITY;
      const gb = lb >= 0 ? this.solver.diag(lb) : Number.POSITIVE_INFINITY;
      const outside = ga === Number.POSITIVE_INFINITY ? gb : gb === Number.POSITIVE_INFINITY ? ga : (ga * gb) / (ga + gb);
      // BT172: through its series resistance, plus its own leak.
      const gs = this.capGs[c];
      const g = (gs === Number.POSITIVE_INFINITY ? outside : outside === Number.POSITIVE_INFINITY ? gs : (outside * gs) / (outside + gs)) + this.capGp[c];
      if (this.capL[c] > 0) {
        // BT176: the inductor's L over the loop's resistance (its series one and the outside's).
        const loop = (gs === Number.POSITIVE_INFINITY ? 0 : 1 / gs) + (outside === Number.POSITIVE_INFINITY ? 0 : 1 / outside);
        const tl = this.capL[c] / (loop > 1e-3 ? loop : 1e-3);
        if (tl < tau) tau = tl;
      }
      if (!(this.capF[c] > 0) || !(g > 1e-6)) continue; // nothing (but leaks) charges it
      const t = this.capF[c] / g;
      if (t < tau) tau = t;
    }
    // BT176: no shorter than MIN_TAU_S — a coil with nothing but leaks to carry its current would
    // otherwise ask for picosecond steps; backward Euler takes anything faster in its stride.
    this.tauS[index] = tau < MIN_TAU_S ? MIN_TAU_S : tau;
  }

  /**
   * BT168: each transistor's linearization in its present state. A BJT's base–emitter junction is
   * a diode (b → e for an NPN, e → b for a PNP); active, Ice = gm·(Vb − Ve) − s·gm·Vbe with
   * gm = β/rb (s = +1 NPN, −1 PNP) — a controlled current, the matrix's nonsymmetric entries;
   * saturated, Ice = (Vce − s·Vce(sat))/rsat. A MOSFET's gate leaks GOFF to its source; on, its
   * drain–source is the conductance its gate set.
   */
  private stampTransistors(island: Island, host: AnalogHost): void {
    const solver = this.solver;
    for (let k = 0; k < island.transistors.length; k++) {
      const t = island.transistors[k];
      const kind = this.tKind[t];
      const x = this.tX[t];
      const ctl = this.tCtl[t];
      const ref = this.tRef[t];
      if (kind === TRANSISTOR.NMOS || kind === TRANSISTOR.PMOS) {
        this.stamp(ctl, ref, GOFF, host);
        this.stamp(x, ref, this.tState[t] === 1 && this.tG[t] > GOFF ? this.tG[t] : GOFF, host);
        continue;
      }
      const s = kind === TRANSISTOR.NPN ? 1 : -1;
      const anode = s > 0 ? ctl : ref;
      const cathode = s > 0 ? ref : ctl;
      this.stamp(x, ref, GOFF, host);
      const state = this.tState[t];
      if (state === 0) {
        this.stamp(anode, cathode, GOFF, host);
        continue;
      }
      const g = 1 / this.tRb[t];
      const vbe = this.tVbe[t];
      this.stamp(anode, cathode, g, host);
      solver.current(this.node(anode, host), g * vbe);
      solver.current(this.node(cathode, host), -g * vbe);
      if (state === 1) {
        const gm = this.tBeta[t] * g;
        this.controlled(x, ref, ctl, ref, gm, host);
        solver.current(this.node(x, host), s * gm * vbe);
        solver.current(this.node(ref, host), -s * gm * vbe);
      } else {
        const gs = 1 / this.tRsat[t];
        this.stamp(x, ref, gs, host);
        solver.current(this.node(x, host), s * gs * this.tVceSat[t]);
        solver.current(this.node(ref, host), -s * gs * this.tVceSat[t]);
      }
    }
  }

  /** BT168: a current gm·(Vp − Vn) leaving net `a` and entering net `b` (fixed nets go to the right side). */
  private controlled(a: number, b: number, p: number, n: number, gm: number, host: AnalogHost): void {
    const solver = this.solver;
    const la = this.node(a, host);
    const lb = this.node(b, host);
    const lp = this.node(p, host);
    const ln = this.node(n, host);
    if (lp >= 0) {
      solver.entry(la, lp, gm);
      solver.entry(lb, lp, -gm);
    } else {
      const vp = this.fixedVolts(p, host);
      solver.current(la, -gm * vp);
      solver.current(lb, gm * vp);
    }
    if (ln >= 0) {
      solver.entry(la, ln, -gm);
      solver.entry(lb, ln, gm);
    } else {
      const vn = this.fixedVolts(n, host);
      solver.current(la, gm * vn);
      solver.current(lb, -gm * vn);
    }
  }

  /**
   * BT168: each transistor's state from the solution; true when one changed. A BJT is off while its
   * junction is (Vbe at or below the knee), active once it conducts, saturated when active would
   * put Vce below Vce(sat), active again when saturation would carry more than β·Ib. A MOSFET's
   * conductance follows its Vgs (a change past 1e-9 relative counts).
   */
  private updateTransistors(island: Island, host: AnalogHost): boolean {
    let changed = false;
    for (let k = 0; k < island.transistors.length; k++) {
      const t = island.transistors[k];
      const kind = this.tKind[t];
      const s = kind === TRANSISTOR.NPN || kind === TRANSISTOR.NMOS ? 1 : -1;
      const vRef = this.volts(this.tRef[t], host);
      const vCtl = s * (this.volts(this.tCtl[t], host) - vRef);
      if (kind === TRANSISTOR.NMOS || kind === TRANSISTOR.PMOS) {
        const vth = this.tVth[t];
        let g = 0;
        if (vCtl > vth) g = Math.min(1, (vCtl - vth) / (this.tVgsOn[t] - vth)) / this.tRds[t];
        const on = g > 0 ? 1 : 0;
        const before = this.tG[t];
        if (on !== this.tState[t] || (on === 1 && Math.abs(g - before) > 1e-9 * (g > before ? g : before))) {
          this.tState[t] = on;
          this.tG[t] = g;
          changed = true;
        }
        continue;
      }
      const knee = this.tVbe[t];
      const vce = s * (this.volts(this.tX[t], host) - vRef);
      const state = this.tState[t];
      let next = state;
      if (state === 0) {
        if (vCtl > knee + 1e-9) next = 1;
      } else if (vCtl <= knee + 1e-9) {
        next = 0;
      } else if (state === 1) {
        if (vce < this.tVceSat[t]) next = 2;
      } else {
        const ib = (vCtl - knee) / this.tRb[t];
        const ic = (vce - this.tVceSat[t]) / this.tRsat[t];
        if (ic > this.tBeta[t] * ib * (1 + 1e-9)) next = 1;
      }
      if (next !== state) {
        this.tState[t] = next;
        changed = true;
      }
    }
    return changed;
  }

  /**
   * BT166: each capacitor's companion: a conductance and the current its history injects. BT172:
   * with its leak beside it (Gc = k + gp) and its series conductance gs in front, the branch is
   * gs·Gc/(gs + Gc) carrying gs/(gs + Gc) of the history current — no internal node.
   */
  private stampCapacitors(island: Island, host: AnalogHost): void {
    const solver = this.solver;
    const tr = this.mode === MODE_TR;
    for (let k = 0; k < island.capacitors.length; k++) {
      const c = island.capacitors[k];
      if (this.capL[c] > 0) {
        // BT176: the whole chain as one conductance and one current.
        this.chain(c, tr);
        const g = 1 / this.chainR;
        const amps = g * (this.chainEl + this.chainEc);
        this.stamp(this.capA[c], this.capB[c], g, host);
        solver.current(this.node(this.capA[c], host), amps);
        solver.current(this.node(this.capB[c], host), -amps);
        continue;
      }
      const kc = (tr ? 2 : 1) * (this.capF[c] / this.hS);
      const gc = kc + this.capGp[c];
      const hist = kc * this.capV[c] + (tr ? this.capI[c] : 0);
      const gs = this.capGs[c];
      const g = gs === Number.POSITIVE_INFINITY ? gc : (gs * gc) / (gs + gc);
      const amps = gs === Number.POSITIVE_INFINITY ? hist : (gs * hist) / (gs + gc);
      const a = this.capA[c];
      const b = this.capB[c];
      this.stamp(a, b, g, host);
      solver.current(this.node(a, host), amps);
      solver.current(this.node(b, host), -amps);
    }
  }

  /** BT166: the capacitors' new voltages and currents from the solution; returns the largest move. */
  private commitCapacitors(index: number, host: AnalogHost): number {
    const island = this.islands[index];
    const tr = this.mode === MODE_TR;
    let moved = 0;
    for (let k = 0; k < island.capacitors.length; k++) {
      const c = island.capacitors[k];
      const vab = this.volts(this.capA[c], host) - this.volts(this.capB[c], host);
      if (this.capL[c] > 0) {
        // BT176: the branch current from the terminals, then each piece's state from it.
        this.chain(c, tr);
        const i = (vab - this.chainEl - this.chainEc) / this.chainR;
        const di = i - this.capIL[c];
        const vl = this.chainRl * i + this.chainEl;
        const dvl = vl - this.capVL[c];
        this.capIL[c] = i;
        this.capVL[c] = vl;
        let m = (di < 0 ? -di : di) * (this.capGs[c] === Number.POSITIVE_INFINITY ? 1 : 1 / this.capGs[c]);
        const mv = dvl < 0 ? -dvl : dvl;
        if (mv > m) m = mv;
        if (this.chainRc > 0) {
          const v = this.chainRc * i + this.chainEc;
          const dv = v - this.capV[c];
          this.capI[c] = this.chainKc * dv - (tr ? this.capI[c] : 0);
          this.capV[c] = v;
          const mc = dv < 0 ? -dv : dv;
          if (mc > m) m = mc;
        }
        if (m > moved) moved = m;
        continue;
      }
      const kc = (tr ? 2 : 1) * (this.capF[c] / this.hS);
      const gs = this.capGs[c];
      // BT172: behind a series resistance, the capacitor's own voltage from the terminals'.
      let v = vab;
      if (gs !== Number.POSITIVE_INFINITY) v = (gs * vab + kc * this.capV[c] + (tr ? this.capI[c] : 0)) / (gs + kc + this.capGp[c]);
      const dv = v - this.capV[c];
      this.capI[c] = kc * dv - (tr ? this.capI[c] : 0);
      this.capV[c] = v;
      const m = dv < 0 ? -dv : dv;
      if (m > moved) moved = m;
    }
    this.lastMove = moved;
    return moved;
  }

  /**
   * BT176: element `c`'s series chain this step — Rs, the inductor (L/h or 2L/h with its history
   * −R·i − vL), the capacitor stage (1/Gc with hist/Gc; none when it has neither C nor a leak) — as
   * a total resistance and the Thevenin voltages it adds (`chainR`, `chainEl`, `chainEc`).
   */
  private chain(c: number, tr: boolean): void {
    const rl = (tr ? 2 : 1) * (this.capL[c] / this.hS);
    this.chainRl = rl;
    this.chainEl = -rl * this.capIL[c] - (tr ? this.capVL[c] : 0);
    const kc = (tr ? 2 : 1) * (this.capF[c] / this.hS);
    const gc = kc + this.capGp[c];
    this.chainKc = kc;
    this.chainRc = gc > 0 ? 1 / gc : 0;
    this.chainEc = gc > 0 ? (kc * this.capV[c] + (tr ? this.capI[c] : 0)) / gc : 0;
    const gs = this.capGs[c];
    this.chainR = (gs === Number.POSITIVE_INFINITY ? 0 : 1 / gs) + rl + this.chainRc;
  }

  /** BT171: transistor `t`'s collector/drain current (magnitude) from the solution in its present state. */
  transistorAmps(t: number, host: AnalogHost): number {
    const kind = this.tKind[t];
    const state = this.tState[t];
    if (state === 0) return 0;
    const s = kind === TRANSISTOR.NPN || kind === TRANSISTOR.NMOS ? 1 : -1;
    const vRef = this.volts(this.tRef[t], host);
    let amps: number;
    if (kind === TRANSISTOR.NMOS || kind === TRANSISTOR.PMOS) amps = this.tG[t] * (this.volts(this.tX[t], host) - vRef);
    else if (state === 1) amps = this.tBeta[t] * ((s * (this.volts(this.tCtl[t], host) - vRef) - this.tVbe[t]) / this.tRb[t]);
    else amps = (s * (this.volts(this.tX[t], host) - vRef) - this.tVceSat[t]) / this.tRsat[t];
    return amps < 0 ? -amps : amps;
  }

  /** BT171: reports the island's transistors that crossed their ratings either way. */
  private checkRatings(island: Island, host: AnalogHost): void {
    for (let k = 0; k < island.transistors.length; k++) {
      const t = island.transistors[k];
      const max = this.tIMax[t];
      if (!(max > 0)) continue;
      const amps = this.transistorAmps(t, host);
      const over = amps > max ? 1 : 0;
      if (over === this.tOver[t]) continue;
      this.tOver[t] = over;
      this.onTransistorCurrent?.(t, over === 1, amps);
    }
  }

  /** Publishes the solved island: volts, levels from the readers' thresholds; BT171: its transistors' ratings. */
  private publishIsland(index: number, host: AnalogHost): void {
    const island = this.islands[index];
    if (island.transistors.length > 0) this.checkRatings(island, host);
    const n = island.nets.length;
    const solver = this.solver;
    for (let i = 0; i < n; i++) {
      const net = island.nets[i];
      const li = this.local[net];
      if (host.isFixed(net)) {
        host.publish(net, host.swLevel(net), host.swStrength(net), host.swConflict(net), host.fixedVolts(net));
        continue;
      }
      if (this.reached[li] === 0) {
        // Floating: its switch-level state, but the volts the solve gives it — 0 V through GMIN,
        // or what an off diode's GOFF leak lets it follow (an LED's cathode on an input pin sits
        // near its anode, so the LED computes no current instead of a phantom 300 mA).
        host.publish(net, host.swLevel(net), host.swStrength(net), host.swConflict(net), solver.x[li]);
        continue;
      }
      const v = solver.x[li];
      const vcc = this.netVcc[net];
      let level: Level | null;
      if (v >= HIGH_FRACTION * vcc) level = 1;
      else if (v <= LOW_FRACTION * vcc) level = 0;
      else {
        level = host.publishedLevel(net);
        if (this.netReader[net] === 1 && this.reportedUndefined[net] === 0 && this.onUndefinedLevel?.(net, v) === true) {
          this.reportedUndefined[net] = 1;
        }
      }
      host.publish(net, level, host.swStrength(net), false, v);
    }
  }

  /** Solved voltage of a net: its fixed value or the last solution. */
  private volts(net: number, host: AnalogHost): number {
    return this.isFixed(net, host) ? this.fixedVolts(net, host) : this.solver.x[this.local[net]];
  }

  /** A conductance between two nets, either of which may be fixed. */
  private stamp(a: number, b: number, g: number, host: AnalogHost): void {
    const la = this.node(a, host);
    const lb = this.node(b, host);
    if (la >= 0 && lb >= 0) this.solver.conductance(la, lb, g);
    else if (la >= 0) this.solver.toFixed(la, g, this.fixedVolts(b, host));
    else if (lb >= 0) this.solver.toFixed(lb, g, this.fixedVolts(a, host));
  }

  /** Marks the island's nets with a conductive path (resistors, closed switches, conducting diodes, capacitors) to a source. */
  private markReached(island: Island, host: AnalogHost): void {
    const n = island.nets.length;
    for (let i = 0; i < n; i++) {
      const net = island.nets[i];
      this.reached[this.local[net]] = this.driverG(net, host) > 0 ? 1 : 0;
    }
    // Spread through conducting elements (a fixed end reaches the other end) until nothing new.
    // Islands are small, so repeated sweeps are cheap; no closures, no allocation.
    let grew = true;
    while (grew) {
      grew = false;
      for (let k = 0; k < island.resistors.length; k++) {
        const link = island.resistors[k];
        if (this.spread(this.linkA[link], this.linkB[link], host)) grew = true;
      }
      for (let k = 0; k < island.switches.length; k++) {
        const link = island.switches[k];
        if (this.closed(link, host) && this.spread(this.linkA[link], this.linkB[link], host)) grew = true;
      }
      for (let k = 0; k < island.diodes.length; k++) {
        const d = island.diodes[k];
        if (this.diodeOn[d] === 1 && this.spread(this.diodeAnode[d], this.diodeCathode[d], host)) grew = true;
      }
      for (let k = 0; k < island.capacitors.length; k++) {
        const c = island.capacitors[k];
        if (this.spread(this.capA[c], this.capB[c], host)) grew = true;
      }
      // BT168: a conducting transistor's collector/drain and (a BJT's) base reach its emitter/source.
      for (let k = 0; k < island.transistors.length; k++) {
        const t = island.transistors[k];
        if (this.tState[t] === 0) continue;
        if (this.spread(this.tX[t], this.tRef[t], host)) grew = true;
        if (this.tKind[t] <= TRANSISTOR.PNP && this.spread(this.tCtl[t], this.tRef[t], host)) grew = true;
      }
    }
  }

  /** One element's ends: if one end is a source (fixed, or reached), reach the other. */
  private spread(a: number, b: number, host: AnalogHost): boolean {
    const la = this.node(a, host);
    const lb = this.node(b, host);
    const aIn = la < 0 || this.reached[la] === 1;
    const bIn = lb < 0 || this.reached[lb] === 1;
    if (aIn && lb >= 0 && this.reached[lb] === 0) {
      this.reached[lb] = 1;
      return true;
    }
    if (bIn && la >= 0 && this.reached[la] === 0) {
      this.reached[la] = 1;
      return true;
    }
    return false;
  }
}
