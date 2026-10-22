/**
 * The analog layer: solves resistive islands and publishes true voltages on their nets.
 *
 * Sources (decided): supply nets are fixed voltages; strong drivers are Norton sources with
 * 25 Ω; weak drivers carry their own resistance (MCU pull-ups 35 kΩ on an ATmega328P, other weak
 * drivers 10 kΩ). Resistive links use their ohms; a closed switch is 1 mΩ, an open one absent;
 * diodes are piecewise linear (off below Vf, (Vd − Vf)/rs above), iterated from the last
 * solution for at most 20 rounds. Nets with no conductive path to a source (through resistors,
 * closed switches and conducting diodes) get gmin 1e-12 S to ground and keep their switch-level
 * state; the others carry no gmin, so their voltages are exact; islands with a short (a switch-level conflict) or more than
 * MAX_NODES (256) unknown nets are left at switch level. Each island's nets get solver indices
 * fewest-neighbors first, so the solver eliminates leaves before hubs and never fills in a star
 * (a pin driving 100 LED branches) or a ladder.
 *
 * Results: a solved net's volts; its level from the reading MCU's thresholds (≥ 0.6·Vcc → 1,
 * ≤ 0.3·Vcc → 0, in between the previous level holds and, on a net an MCU pin reads, an
 * 'analog-undefined-level' is reported once); strength as switch level gave it; conflict false.
 * Solving is synchronous and happens only when an island's inputs change. No allocation per
 * solve.
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

export class AnalogLayer {
  readonly islands: readonly Island[];
  readonly netIsland: Int32Array;
  /** Ohms per resolver link (resistive links; others unused). */
  readonly linkOhms: Float64Array;
  /** Logic supply of the MCU whose pin is on a net (default 5 V), and whether one reads it. */
  readonly netVcc: Float64Array;
  readonly netReader: Uint8Array;
  /** Islands too large to solve (left at switch level). */
  readonly tooLarge: Uint8Array;
  /** A read net sits between the thresholds; return true if it was reported (once per run). */
  onUndefinedLevel: ((net: number, volts: number) => boolean) | null = null;
  onNoConvergence: ((island: number) => void) | null = null;
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

  constructor(netCount: number, islands: readonly Island[], netIsland: Int32Array, links: readonly { a: number; b: number }[], diodes: readonly DiodeInstance[]) {
    this.islands = islands;
    this.netIsland = netIsland;
    this.linkOhms = new Float64Array(links.length).fill(1000);
    this.linkA = Int32Array.from(links.map((l) => l.a));
    this.linkB = Int32Array.from(links.map((l) => l.b));
    this.netVcc = new Float64Array(netCount).fill(5);
    this.netReader = new Uint8Array(netCount);
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
    for (const island of islands) this.orderNodes(island);
    this.reportedUndefined = new Uint8Array(netCount);
    this.reportedConvergence = new Uint8Array(islands.length);
  }

  /**
   * Solver indices for an island's nets: fewest neighbors (other nets of the island across a
   * resistor, switch or diode) first, ties in net order — a static minimum-degree order.
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

  /** Back to a fresh layer's state (bench reset): once-per-run reports and diode states. */
  reset(): void {
    this.reportedUndefined.fill(0);
    this.reportedConvergence.fill(0);
    this.diodeOn.fill(0);
  }

  private publishSwitchLevel(island: Island, host: AnalogHost): void {
    for (let i = 0; i < island.nets.length; i++) {
      const net = island.nets[i];
      host.publish(net, host.swLevel(net), host.swStrength(net), host.swConflict(net), host.swVolts(net));
    }
  }

  /** An element end as a local node index, or −1 for a fixed net. */
  private node(net: number, host: AnalogHost): number {
    return host.isFixed(net) ? -1 : this.local[net];
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
        if (host.isFixed(net)) {
          // A supply a part model drives (a battery, BT83): fixed at run time, after the islands
          // were built. Its row pins it to its volts; its neighbours already see it as fixed.
          const li = this.local[net];
          solver.conductance(li, -1, 1);
          solver.current(li, host.fixedVolts(net));
          continue;
        }
        const g = host.driverG(net);
        if (g > 0) {
          // Norton source: g to ground plus g·V injected.
          const li = this.local[net];
          solver.conductance(li, -1, g);
          solver.current(li, host.driverGV(net));
        }
      }
      for (let k = 0; k < island.resistors.length; k++) {
        const link = island.resistors[k];
        this.stamp(this.linkA[link], this.linkB[link], 1 / Math.max(this.linkOhms[link], SWITCH_OHMS), host);
      }
      for (let k = 0; k < island.switches.length; k++) {
        const link = island.switches[k];
        if (host.isLinkClosed(link)) this.stamp(this.linkA[link], this.linkB[link], 1 / SWITCH_OHMS, host);
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
      if (!solver.solve()) {
        this.publishSwitchLevel(island, host);
        return;
      }
      let changed = false;
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
    return host.isFixed(net) ? host.fixedVolts(net) : this.solver.x[this.local[net]];
  }

  /** A conductance between two nets, either of which may be fixed. */
  private stamp(a: number, b: number, g: number, host: AnalogHost): void {
    const la = this.node(a, host);
    const lb = this.node(b, host);
    if (la >= 0 && lb >= 0) this.solver.conductance(la, lb, g);
    else if (la >= 0) this.solver.toFixed(la, g, host.fixedVolts(b));
    else if (lb >= 0) this.solver.toFixed(lb, g, host.fixedVolts(a));
  }

  /** Marks the island's nets with a conductive path (resistors, closed switches, conducting diodes) to a source. */
  private markReached(island: Island, host: AnalogHost): void {
    const n = island.nets.length;
    for (let i = 0; i < n; i++) {
      const net = island.nets[i];
      this.reached[this.local[net]] = host.driverG(net) > 0 ? 1 : 0;
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
        if (host.isLinkClosed(link) && this.spread(this.linkA[link], this.linkB[link], host)) grew = true;
      }
      for (let k = 0; k < island.diodes.length; k++) {
        const d = island.diodes[k];
        if (this.diodeOn[d] === 1 && this.spread(this.diodeAnode[d], this.diodeCathode[d], host)) grew = true;
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
