/**
 * Switch-level signal resolution: drivers on nets plus links between nets → one `NetState` per
 * net, with a callback when a net's state actually changes. This is the hottest code outside
 * the CPU cores: no allocation in setDriver, setLinkClosed or propagation.
 *
 * Rules
 * - Strengths order hiz < weak < strong < supply. A net's level comes from its strongest
 *   source (its own drivers, plus what its links pass in).
 * - conflict = sources with opposite levels both at strength ≥ strong (a short). The level is
 *   then that of the strictly stronger side, or null when both sides are equally strong.
 * - Opposite levels tied at `weak` (a divider: one resistor up, one down) are not a conflict;
 *   the level is null (undetermined) with strength weak and the average of the two volts.
 * - A closed switch link passes the other net's resolved level and strength unchanged. A
 *   resistive link passes it reduced to weak (never raises strength). An open link passes
 *   nothing. Links pass volts along with the level.
 * - volts: a digital driver carries 0 V for level 0 and its highVolts for level 1; a volts
 *   driver carries its value, with level = volts ≥ highVolts / 2. A net reports the volts of
 *   its winning source (the average when several drivers of the net itself tie).
 * - A net passes on only what it resolved to: a weak 1 arriving at a net held strong 0 stops
 *   there. That is what lets one strong driver override a pull-up behind a resistor.
 *
 * Algorithm (decided in BT4 instead of the plan's per-link "contribution slots", which let a
 * level keep itself alive around a cycle of links after its source is gone):
 * - A net with no conducting link resolves in O(1) from its per-net driver counts
 *   (Uint16Array indexed [net][strength][level], plus volts sums).
 * - Otherwise its whole link-connected component is re-resolved from the drivers, strongest
 *   first: supply, then strong, then weak. Within a strength, signals spread through switches
 *   (and, at weak, through resistors) by worklist until nothing new arrives; a net first
 *   reached at a strength is settled at that strength, so weaker signals can't override it,
 *   and a cycle can never feed a level back to itself. Cost is O(component) per change.
 * - Changes go through a dirty-net queue (an Int32Array ring). onChange runs after every net
 *   of a recomputed component holds its new state. A listener may call setDriver or
 *   setLinkClosed re-entrantly: the change is queued and applied after the current
 *   notifications. A zero-delay feedback loop through listeners would never settle, so one
 *   top-level call does at most 4 × (nets + links + 1) recomputations; past that the nets
 *   involved are recorded in `oscillations()` and the queue is dropped.
 */

import type { AnalogHost, AnalogLayer } from '../analog/layer.ts';
import { STRONG_OHMS } from '../analog/layer.ts';
import { type Level, type NetState, Strength } from '../contracts/signal.ts';

/** A link between two nets, as the bench derives it from a part's `LinkDef`. */
export interface ResolverLink {
  /** Net id of one end. */
  a: number;
  /** Net id of the other end. */
  b: number;
  /** `resistive` passes signals reduced to weak; `switch` passes them unchanged. */
  kind: 'resistive' | 'switch';
  /** Whether the link conducts. Resistive links are normally created closed. */
  closed: boolean;
}

const WEAK = Strength.weak;
const STRONG = Strength.strong;
const SUPPLY = Strength.supply;

/** Default resistance of a weak driver for the analog layer (MCU pull-ups pass their own). */
export const WEAK_OHMS = 10_000;

export class SignalResolver implements AnalogHost {
  /**
   * Called once for each net whose resolved state changed, after the change is complete. One
   * callback for all nets; the bench fans out to pin listeners.
   */
  onChange: ((net: number) => void) | null = null;
  readonly netCount: number;
  readonly linkCount: number;

  // Links, plus net → incident links in CSR form.
  private readonly linkA: Int32Array;
  private readonly linkB: Int32Array;
  private readonly linkSwitch: Uint8Array;
  private readonly linkClosed: Uint8Array;
  private readonly adjStart: Int32Array;
  private readonly adjLink: Int32Array;
  /** Per net: how many incident links conduct now (0 ⇒ the O(1) path). */
  private readonly conducting: Int32Array;

  // Drivers (grown by doubling in allocDriver, never on the hot path).
  private driverCount = 0;
  private dNet = new Int32Array(16);
  private dLevel = new Uint8Array(16);
  private dStrength = new Uint8Array(16);
  private dVolts = new Float64Array(16);
  private dHigh = new Float64Array(16);
  private dWeakOhms = new Float64Array(16);
  private readonly netDrivers: Int32Array;
  /** Per net: weak drivers' count, Σ 1/R and Σ V/R (for the analog layer's Norton sources). */
  private readonly weakCount: Uint16Array;
  private readonly weakG: Float64Array;
  private readonly weakGV: Float64Array;

  // Analog layer (optional): island nets resolve to switch level here, then the layer publishes.
  private analog: AnalogLayer | null = null;
  private netIsland: Int32Array | null = null;
  private swLevelOf: Int8Array = new Int8Array(0);
  private swStrengthOf: Uint8Array = new Uint8Array(0);
  private swVoltsOf: Float64Array = new Float64Array(0);
  private swConflictOf: Uint8Array = new Uint8Array(0);
  /** Driver counts and volts sums per [net][strength][level]: index net * 8 + strength * 2 + level. */
  private readonly count: Uint16Array;
  private readonly voltsSum: Float64Array;

  /** The published states, one preallocated object per net, mutated in place. */
  private readonly states: NetState[];

  // Dirty-net queue.
  private readonly queue: Int32Array;
  private qHead = 0;
  private qLen = 0;
  private readonly queued: Uint8Array;
  /** Set when a net was recomputed after it was last dirtied: its queue entry is stale. */
  private readonly fresh: Uint8Array;
  private busy = false;
  private readonly maxIterations: number;

  // Component scratch: member list, membership flags, per-net arrival strength and volts per
  // level, levels already passed on, and the per-strength worklist.
  private readonly comp: Int32Array;
  private compLen = 0;
  private readonly inComp: Uint8Array;
  private readonly arr0: Int8Array;
  private readonly arr1: Int8Array;
  private readonly vol0: Float64Array;
  private readonly vol1: Float64Array;
  private readonly emitted: Uint8Array;
  private readonly work: Int32Array;
  private wHead = 0;
  private wLen = 0;
  private readonly inWork: Uint8Array;

  // Nets whose state changed in the current recomputation, notified afterwards.
  private readonly changed: Int32Array;
  private changedLen = 0;

  private readonly oscillating: number[] = [];
  private readonly oscFlag: Uint8Array;

  constructor(netCount: number, links: readonly ResolverLink[]) {
    if (!Number.isInteger(netCount) || netCount < 0) throw new RangeError(`bad net count ${netCount}`);
    this.netCount = netCount;
    const n = netCount;
    const l = links.length;
    this.linkCount = l;
    this.linkA = new Int32Array(l);
    this.linkB = new Int32Array(l);
    this.linkSwitch = new Uint8Array(l);
    this.linkClosed = new Uint8Array(l);
    this.conducting = new Int32Array(n);
    this.adjStart = new Int32Array(n + 1);
    const inRange = (net: number): boolean => Number.isInteger(net) && net >= 0 && net < n;
    for (let i = 0; i < l; i++) {
      const link = links[i];
      if (!inRange(link.a) || !inRange(link.b)) {
        throw new RangeError(`link ${i} joins nets ${link.a} and ${link.b}, outside 0..${n - 1}`);
      }
      this.linkA[i] = link.a;
      this.linkB[i] = link.b;
      this.linkSwitch[i] = link.kind === 'switch' ? 1 : 0;
      this.linkClosed[i] = link.closed ? 1 : 0;
      if (link.a === link.b) continue; // a link from a net to itself does nothing
      this.adjStart[link.a + 1]++;
      this.adjStart[link.b + 1]++;
      if (link.closed) {
        this.conducting[link.a]++;
        this.conducting[link.b]++;
      }
    }
    for (let i = 0; i < n; i++) this.adjStart[i + 1] += this.adjStart[i];
    this.adjLink = new Int32Array(this.adjStart[n]);
    const fill = this.adjStart.slice(0, n);
    for (let i = 0; i < l; i++) {
      const a = this.linkA[i];
      const b = this.linkB[i];
      if (a === b) continue;
      this.adjLink[fill[a]++] = i;
      this.adjLink[fill[b]++] = i;
    }

    this.netDrivers = new Int32Array(n);
    this.weakCount = new Uint16Array(n);
    this.weakG = new Float64Array(n);
    this.weakGV = new Float64Array(n);
    this.count = new Uint16Array(n * 8);
    this.voltsSum = new Float64Array(n * 8);
    this.states = [];
    for (let i = 0; i < n; i++) this.states.push({ level: null, strength: Strength.hiz, conflict: false, volts: 0 });

    this.queue = new Int32Array(Math.max(1, n));
    this.queued = new Uint8Array(n);
    this.fresh = new Uint8Array(n);
    this.maxIterations = 4 * (n + l + 1);
    this.comp = new Int32Array(n);
    this.inComp = new Uint8Array(n);
    this.arr0 = new Int8Array(n);
    this.arr1 = new Int8Array(n);
    this.vol0 = new Float64Array(n);
    this.vol1 = new Float64Array(n);
    this.emitted = new Uint8Array(n);
    this.work = new Int32Array(Math.max(1, n));
    this.inWork = new Uint8Array(n);
    this.changed = new Int32Array(n);
    this.oscFlag = new Uint8Array(n);
  }

  /**
   * Adds a driver on `net`, initially hiz. `highVolts` is what level 1 carries (the driving
   * chip's supply); `weakOhms` is its resistance when it drives weak (the analog layer's model of
   * a pull-up). Returns its id. Called while building, not on the hot path.
   */
  allocDriver(net: number, highVolts: number, weakOhms = WEAK_OHMS): number {
    if (!Number.isInteger(net) || net < 0 || net >= this.netCount) throw new RangeError(`no net ${net}`);
    if (this.netDrivers[net] >= 0xffff) throw new RangeError(`net ${net} has too many drivers`);
    this.netDrivers[net]++;
    const id = this.driverCount++;
    if (id >= this.dNet.length) this.grow();
    this.dNet[id] = net;
    this.dLevel[id] = 0;
    this.dStrength[id] = Strength.hiz;
    this.dVolts[id] = 0;
    this.dHigh[id] = highVolts;
    this.dWeakOhms[id] = weakOhms;
    return id;
  }

  /**
   * Turns on the analog layer: island nets resolve to switch level as before, then the layer
   * solves their islands and publishes true voltages. Every island is solved once now.
   */
  attachAnalog(layer: AnalogLayer): void {
    const n = this.netCount;
    this.analog = layer;
    this.netIsland = layer.netIsland;
    this.swLevelOf = new Int8Array(n).fill(-1);
    this.swStrengthOf = new Uint8Array(n);
    this.swVoltsOf = new Float64Array(n);
    this.swConflictOf = new Uint8Array(n);
    for (let net = 0; net < n; net++) if (layer.netIsland[net] >= 0) this.enqueue(net);
    if (!this.busy) this.process();
  }

  /** A link's analog value changed (setOhms): re-solve its island. */
  touchLink(linkIndex: number): void {
    if (!(linkIndex >= 0 && linkIndex < this.linkCount)) throw new RangeError(`no link ${linkIndex}`);
    this.enqueue(this.linkA[linkIndex]);
    this.enqueue(this.linkB[linkIndex]);
    if (!this.busy) this.process();
  }

  // ── AnalogHost ───────────────────────────────────────────────────────────────────────────

  driverG(net: number): number {
    const base = net * 8 + STRONG * 2;
    return (this.count[base] + this.count[base + 1]) / STRONG_OHMS + this.weakG[net];
  }

  driverGV(net: number): number {
    const base = net * 8 + STRONG * 2;
    return (this.voltsSum[base] + this.voltsSum[base + 1]) / STRONG_OHMS + this.weakGV[net];
  }

  isLinkClosed(link: number): boolean {
    return this.linkClosed[link] === 1;
  }

  isFixed(net: number): boolean {
    const base = net * 8 + SUPPLY * 2;
    return this.count[base] + this.count[base + 1] > 0;
  }

  fixedVolts(net: number): number {
    const base = net * 8 + SUPPLY * 2;
    const c = this.count[base] + this.count[base + 1];
    return c === 0 ? 0 : (this.voltsSum[base] + this.voltsSum[base + 1]) / c;
  }

  swLevel(net: number): Level | null {
    const level = this.swLevelOf[net];
    return level < 0 ? null : (level as Level);
  }

  swStrength(net: number): Strength {
    return this.swStrengthOf[net] as Strength;
  }

  swVolts(net: number): number {
    return this.swVoltsOf[net];
  }

  swConflict(net: number): boolean {
    return this.swConflictOf[net] === 1;
  }

  publishedLevel(net: number): Level | null {
    return this.states[net].level;
  }

  publish(net: number, level: Level | null, strength: Strength, conflict: boolean, volts: number): void {
    const state = this.states[net];
    if (state.level === level && state.strength === strength && state.conflict === conflict && state.volts === volts) return;
    state.level = level;
    state.strength = strength;
    state.conflict = conflict;
    state.volts = volts;
    this.changed[this.changedLen++] = net;
  }

  /** Drives a digital level: 0 V for 0, the driver's highVolts for 1. */
  setDriver(id: number, level: Level, strength: Strength): void {
    this.update(id, level, strength, level === 1 ? this.dHigh[id] : 0);
  }

  /** Drives an analog voltage; the level is volts ≥ highVolts / 2. */
  setDriverVolts(id: number, volts: number, strength: Strength): void {
    this.update(id, volts >= this.dHigh[id] / 2 ? 1 : 0, strength, volts);
  }

  /** Stops driving: back to hiz. */
  releaseDriver(id: number): void {
    this.update(id, 0, Strength.hiz, 0);
  }

  /** Opens or closes link `linkIndex` (an index into the constructor's `links`). */
  setLinkClosed(linkIndex: number, closed: boolean): void {
    if (!(linkIndex >= 0 && linkIndex < this.linkCount)) throw new RangeError(`no link ${linkIndex}`);
    const value = closed ? 1 : 0;
    if (this.linkClosed[linkIndex] === value) return;
    this.linkClosed[linkIndex] = value;
    const a = this.linkA[linkIndex];
    const b = this.linkB[linkIndex];
    if (a === b) return;
    const delta = closed ? 1 : -1;
    this.conducting[a] += delta;
    this.conducting[b] += delta;
    this.enqueue(a);
    this.enqueue(b);
    if (!this.busy) this.process();
  }

  /**
   * The resolved state of `net`. The object is preallocated and mutated in place on every
   * change: copy its fields if you keep them.
   */
  state(net: number): NetState {
    return this.states[net];
  }

  /** Nets cut off by the iteration bound (a feedback loop that never settles), in order seen. */
  oscillations(): readonly number[] {
    return this.oscillating;
  }

  /** Forgets recorded oscillations (the bench calls this on reset). */
  clearOscillations(): void {
    for (const net of this.oscillating) this.oscFlag[net] = 0;
    this.oscillating.length = 0;
  }

  private update(id: number, level: Level, strength: Strength, volts: number): void {
    if (!(id >= 0 && id < this.driverCount)) throw new RangeError(`no driver ${id}`);
    const oldStrength = this.dStrength[id];
    const oldLevel = this.dLevel[id];
    if (oldStrength === strength && oldLevel === level && this.dVolts[id] === volts) return;
    const net = this.dNet[id];
    const base = net * 8;
    if (oldStrength !== Strength.hiz) {
      const slot = base + oldStrength * 2 + oldLevel;
      const c = --this.count[slot];
      // Reset to exactly 0 when the slot empties so float error can't accumulate.
      this.voltsSum[slot] = c === 0 ? 0 : this.voltsSum[slot] - this.dVolts[id];
      if (oldStrength === WEAK) {
        const w = --this.weakCount[net];
        const g = 1 / this.dWeakOhms[id];
        this.weakG[net] = w === 0 ? 0 : this.weakG[net] - g;
        this.weakGV[net] = w === 0 ? 0 : this.weakGV[net] - g * this.dVolts[id];
      }
    }
    this.dLevel[id] = level;
    this.dStrength[id] = strength;
    this.dVolts[id] = volts;
    if (strength !== Strength.hiz) {
      const slot = base + strength * 2 + level;
      this.count[slot]++;
      this.voltsSum[slot] += volts;
      if (strength === WEAK) {
        const g = 1 / this.dWeakOhms[id];
        this.weakCount[net]++;
        this.weakG[net] += g;
        this.weakGV[net] += g * volts;
      }
    }
    this.enqueue(net);
    if (!this.busy) this.process();
  }

  private enqueue(net: number): void {
    this.fresh[net] = 0;
    if (this.queued[net] === 1) return;
    this.queued[net] = 1;
    const cap = this.queue.length;
    this.queue[(this.qHead + this.qLen) % cap] = net;
    this.qLen++;
  }

  private process(): void {
    this.busy = true;
    let iterations = 0;
    try {
      while (this.qLen > 0) {
        const net = this.queue[this.qHead];
        this.qHead = (this.qHead + 1) % this.queue.length;
        this.qLen--;
        this.queued[net] = 0;
        if (this.fresh[net] === 1) continue; // recomputed with its component since it was queued
        if (++iterations > this.maxIterations) {
          this.cutOff(net);
          return;
        }
        this.changedLen = 0;
        if (this.conducting[net] === 0) {
          this.comp[0] = net;
          this.compLen = 1;
          this.seed(net);
          this.settle(net);
        } else {
          this.resolveComponent(net);
        }
        const analog = this.analog;
        if (analog !== null && analog.pending) analog.solveDirty(this);
        const onChange = this.onChange;
        if (onChange !== null) for (let i = 0; i < this.changedLen; i++) onChange(this.changed[i]);
      }
    } finally {
      this.busy = false;
    }
  }

  /** Records the nets of the runaway loop and drops the rest of the queue. */
  private cutOff(net: number): void {
    this.recordOscillation(net);
    for (let i = 0; i < this.compLen; i++) this.recordOscillation(this.comp[i]);
    while (this.qLen > 0) {
      const queuedNet = this.queue[this.qHead];
      this.qHead = (this.qHead + 1) % this.queue.length;
      this.qLen--;
      this.queued[queuedNet] = 0;
      this.recordOscillation(queuedNet);
    }
  }

  private recordOscillation(net: number): void {
    if (this.oscFlag[net] === 1) return;
    this.oscFlag[net] = 1;
    this.oscillating.push(net);
  }

  /** Re-resolves every net reachable from `start` through conducting links. */
  private resolveComponent(start: number): void {
    // Collect the component breadth-first; the member list doubles as the queue.
    const comp = this.comp;
    comp[0] = start;
    this.inComp[start] = 1;
    let len = 1;
    for (let i = 0; i < len; i++) {
      const net = comp[i];
      for (let k = this.adjStart[net]; k < this.adjStart[net + 1]; k++) {
        const link = this.adjLink[k];
        if (this.linkClosed[link] === 0) continue;
        const other = this.linkA[link] === net ? this.linkB[link] : this.linkA[link];
        if (this.inComp[other] === 1) continue;
        this.inComp[other] = 1;
        comp[len++] = other;
      }
    }
    this.compLen = len;
    for (let i = 0; i < len; i++) this.seed(comp[i]);

    // Strongest first. A net whose strongest arrival is `s` is settled in this pass: it passes
    // on its level(s) at `s` — through switches unchanged, through resistors as weak.
    for (let s = SUPPLY; s >= WEAK; s--) {
      for (let i = 0; i < len; i++) {
        const net = comp[i];
        if (Math.max(this.arr0[net], this.arr1[net]) === s) this.pushWork(net);
      }
      while (this.wLen > 0) {
        const net = this.work[this.wHead];
        this.wHead = (this.wHead + 1) % this.work.length;
        this.wLen--;
        this.inWork[net] = 0;
        const levels = (this.arr0[net] === s ? 1 : 0) | (this.arr1[net] === s ? 2 : 0);
        const newLevels = levels & ~this.emitted[net];
        if (newLevels === 0) continue;
        this.emitted[net] |= newLevels;
        for (let k = this.adjStart[net]; k < this.adjStart[net + 1]; k++) {
          const link = this.adjLink[k];
          if (this.linkClosed[link] === 0) continue;
          const other = this.linkA[link] === net ? this.linkB[link] : this.linkA[link];
          const out = this.linkSwitch[link] === 1 ? s : WEAK;
          if ((newLevels & 1) !== 0 && this.arr0[other] < out) {
            this.arr0[other] = out;
            this.vol0[other] = this.vol0[net];
            if (out === s && this.arr1[other] <= s) this.pushWork(other);
          }
          if ((newLevels & 2) !== 0 && this.arr1[other] < out) {
            this.arr1[other] = out;
            this.vol1[other] = this.vol1[net];
            if (out === s && this.arr0[other] <= s) this.pushWork(other);
          }
        }
      }
    }

    for (let i = 0; i < len; i++) {
      const net = comp[i];
      this.inComp[net] = 0;
      this.settle(net);
    }
  }

  private pushWork(net: number): void {
    if (this.inWork[net] === 1) return;
    this.inWork[net] = 1;
    this.work[(this.wHead + this.wLen) % this.work.length] = net;
    this.wLen++;
  }

  /** Starts a net from its own drivers: the strongest strength per level and its average volts. */
  private seed(net: number): void {
    const base = net * 8;
    let s0 = 0;
    let s1 = 0;
    for (let s = SUPPLY; s >= WEAK && (s0 === 0 || s1 === 0); s--) {
      if (s0 === 0 && this.count[base + s * 2] > 0) s0 = s;
      if (s1 === 0 && this.count[base + s * 2 + 1] > 0) s1 = s;
    }
    this.arr0[net] = s0;
    this.arr1[net] = s1;
    this.vol0[net] = s0 === 0 ? 0 : this.voltsSum[base + s0 * 2] / this.count[base + s0 * 2];
    this.vol1[net] = s1 === 0 ? 0 : this.voltsSum[base + s1 * 2 + 1] / this.count[base + s1 * 2 + 1];
    this.emitted[net] = 0;
  }

  /** Publishes a net's resolved state; records it as changed when any field differs. */
  private settle(net: number): void {
    this.fresh[net] = 1;
    const s0 = this.arr0[net];
    const s1 = this.arr1[net];
    let level: Level | null;
    let strength: number;
    let volts: number;
    if (s0 > s1) {
      level = 0;
      strength = s0;
      volts = this.vol0[net];
    } else if (s1 > s0) {
      level = 1;
      strength = s1;
      volts = this.vol1[net];
    } else if (s0 === 0) {
      level = null;
      strength = Strength.hiz;
      volts = 0;
    } else {
      level = null;
      strength = s0;
      volts = (this.vol0[net] + this.vol1[net]) / 2;
    }
    const conflict = s0 >= STRONG && s1 >= STRONG;
    const island = this.netIsland === null ? -1 : this.netIsland[net];
    if (island >= 0) {
      // An island net: keep the switch-level answer for the analog layer, which publishes.
      this.swLevelOf[net] = level === null ? -1 : level;
      this.swStrengthOf[net] = strength;
      this.swVoltsOf[net] = volts;
      this.swConflictOf[net] = conflict ? 1 : 0;
      (this.analog as AnalogLayer).markDirty(island);
      return;
    }
    const state = this.states[net];
    if (state.level !== level || state.strength !== strength || state.conflict !== conflict || state.volts !== volts) {
      state.level = level;
      state.strength = strength as Strength;
      state.conflict = conflict;
      state.volts = volts;
      this.changed[this.changedLen++] = net;
    }
  }

  private grow(): void {
    const size = this.dNet.length * 2;
    const dNet = new Int32Array(size);
    dNet.set(this.dNet);
    this.dNet = dNet;
    const dLevel = new Uint8Array(size);
    dLevel.set(this.dLevel);
    this.dLevel = dLevel;
    const dStrength = new Uint8Array(size);
    dStrength.set(this.dStrength);
    this.dStrength = dStrength;
    const dVolts = new Float64Array(size);
    dVolts.set(this.dVolts);
    this.dVolts = dVolts;
    const dHigh = new Float64Array(size);
    dHigh.set(this.dHigh);
    this.dHigh = dHigh;
    const dWeakOhms = new Float64Array(size);
    dWeakOhms.set(this.dWeakOhms);
    this.dWeakOhms = dWeakOhms;
  }
}
