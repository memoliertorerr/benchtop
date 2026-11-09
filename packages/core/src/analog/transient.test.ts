import { describe, expect, it } from 'vitest';
import type { PartDefinition } from '../contracts/part.ts';
import type { Level, Strength } from '../contracts/signal.ts';
import { NS_PER_MS } from '../contracts/time.ts';
import { FakeMcu, type FakeStep, fakeBoard, makeBenchEnv, testDoc } from '../testing.ts';
import { Bench } from '../bench/bench.ts';
import { buildIslands } from './islands.ts';
import { type AnalogHost, AnalogLayer } from './layer.ts';

// BT166: capacitors in the analog layer — the layer alone with a hand-driven clock, then on a
// bench with an MCU pin charging an RC.

/** A host with fixed nets and Norton drivers a test can change, recording what is published. */
function host(fixedVolts: Map<number, number>) {
  const drivers = new Map<number, [number, number]>();
  const published = new Map<number, { level: Level | null; volts: number }>();
  const h: AnalogHost = {
    driverG: (net) => drivers.get(net)?.[0] ?? 0,
    driverGV: (net) => drivers.get(net)?.[1] ?? 0,
    isLinkClosed: () => true,
    isFixed: (net) => fixedVolts.has(net),
    fixedVolts: (net) => fixedVolts.get(net) ?? 0,
    swLevel: () => null,
    swStrength: () => 0 as Strength,
    swVolts: () => 0,
    swConflict: () => false,
    publishedLevel: (net) => published.get(net)?.level ?? null,
    publish: (net, level, _strength, _conflict, volts) => published.set(net, { level, volts }),
  };
  return { h, published, drivers };
}

/**
 * An RC: net 0 = GND (fixed), net 1 driven through 25 Ω (a strong pin), R ohms to net 2, C farads
 * from net 2 to GND. The clock and the planned steps are the test's: `runTo(t)` fires the steps
 * due by t, recording the cap node's published volts at each.
 */
function rc(ohms: number, farads: number) {
  const links = [{ a: 1, b: 2, kind: 'resistive' as const }];
  const capacitors = [{ a: 2, b: 0, farads }];
  const { islands, netIsland } = buildIslands({ netCount: 3, links, diodes: [], capacitors, fixed: (net) => net === 0 });
  const layer = new AnalogLayer(3, islands, netIsland, links, [], capacitors);
  layer.linkOhms[0] = ohms;
  const { h, published, drivers } = host(new Map([[0, 0]]));
  let now = 0;
  let planned = Number.POSITIVE_INFINITY;
  let plans = 0;
  layer.clock = () => now;
  layer.plan = (_island, at) => {
    planned = at;
    plans++;
  };
  const samples: { t: number; v: number }[] = [];
  const volts = (): number => published.get(2)?.volts ?? Number.NaN;
  return {
    layer,
    published,
    volts,
    samples,
    plans: () => plans,
    planned: () => planned,
    /** Sets the pin's drive at time t (ns): volts through 25 Ω, or released (null). */
    drive(t: number, v: number | null): void {
      now = t;
      if (v === null) drivers.delete(1);
      else drivers.set(1, [1 / 25, v / 25]);
      layer.markDirty(0);
      layer.solveDirty(h);
      samples.push({ t: now, v: volts() });
    },
    runTo(t: number): void {
      while (planned <= t) {
        now = planned;
        planned = Number.POSITIVE_INFINITY;
        layer.step(0, h);
        samples.push({ t: now, v: volts() });
      }
      now = t;
    },
  };
}

describe('capacitors in the analog layer (BT166)', () => {
  it('an RC charges as V·(1 − e^(−t/RC)) and discharges as V·e^(−t/RC), within 0.5 % of the swing at every step', () => {
    const r = rc(10_000, 1e-6);
    const tau = (10_000 + 25) * 1e-6 * 1e9; // ns
    r.drive(0, 5);
    expect(r.volts()).toBeCloseTo(0, 3); // the instant after: the capacitor is still empty
    r.runTo(40 * tau);
    for (const { t, v } of r.samples) expect(Math.abs(v - 5 * (1 - Math.exp(-t / tau)))).toBeLessThanOrEqual(0.025);
    // Steps landed near τ, 2τ and 5τ.
    for (const k of [1, 2, 5]) expect(r.samples.some(({ t }) => Math.abs(t - k * tau) < 0.25 * tau)).toBe(true);
    expect(r.layer.isIslandMoving(0)).toBe(false); // settled (no step moves 50 µV) by 40τ
    const start = 50 * tau;
    r.samples.length = 0;
    r.drive(start, 0);
    const v0 = r.volts();
    expect(v0).toBeGreaterThan(4.99);
    r.runTo(start + 8 * tau);
    for (const { t, v } of r.samples) expect(Math.abs(v - v0 * Math.exp(-(t - start) / tau))).toBeLessThanOrEqual(0.025);
  });

  it('a settled island plans nothing until an input changes; a released net keeps the capacitor’s volts and level', () => {
    const r = rc(1_000, 1e-6);
    r.drive(0, 5);
    r.runTo(50 * NS_PER_MS); // τ ≈ 1 ms: settled (no step moves 50 µV) by about 30τ
    expect(r.layer.isIslandMoving(0)).toBe(false);
    expect(r.layer.moving).toBe(0);
    const plans = r.plans();
    r.runTo(100 * NS_PER_MS);
    expect(r.plans()).toBe(plans);
    expect(r.planned()).toBe(Number.POSITIVE_INFINITY);
    r.drive(100 * NS_PER_MS, null); // the pin lets go: the capacitor holds both nets
    r.runTo(200 * NS_PER_MS);
    expect(r.volts()).toBeGreaterThan(4.99);
    expect(r.published.get(1)?.volts).toBeGreaterThan(4.99);
    expect(r.published.get(2)?.level).toBe(1);
    expect(r.layer.isIslandMoving(0)).toBe(false);
  });

  it('a 500 Hz square wave into 10 kΩ/1 µF averages V/2 with the ripple V·tanh(T/4τ), in about three solves an edge', () => {
    const r = rc(10_000, 1e-6);
    const tau = (10_000 + 25) * 1e-6;
    const half = 1 * NS_PER_MS;
    let t = 0;
    let level = 1;
    for (let k = 0; k < 200; k++) {
      r.runTo(t);
      r.drive(t, level === 1 ? 5 : 0);
      level ^= 1;
      t += half;
    }
    // The last cycles: the capacitor at the edges is the ripple's extremes.
    const solvesBefore = r.layer.transientSolves;
    const highs: number[] = [];
    const lows: number[] = [];
    for (let k = 0; k < 20; k++) {
      r.runTo(t);
      r.drive(t, level === 1 ? 5 : 0);
      // The instant after an edge the node is the capacitor's voltage at the edge: a rising edge
      // finds it at its low, a falling one at its high.
      (level === 1 ? lows : highs).push(r.volts());
      level ^= 1;
      t += half;
    }
    const perEdge = (r.layer.transientSolves - solvesBefore) / 20;
    expect(perEdge).toBeLessThanOrEqual(4);
    const high = highs.reduce((a, b) => a + b) / highs.length;
    const low = lows.reduce((a, b) => a + b) / lows.length;
    expect(Math.abs((high + low) / 2 - 2.5)).toBeLessThanOrEqual(0.025);
    const ripple = 5 * Math.tanh(2e-3 / (4 * tau));
    expect(Math.abs(high - low - ripple) / ripple).toBeLessThanOrEqual(0.1);
  });

  it('reset empties the capacitors and stops every island', () => {
    const r = rc(1_000, 1e-6);
    r.drive(0, 5);
    r.runTo(0.5 * NS_PER_MS);
    expect(r.layer.moving).toBe(1);
    r.layer.reset();
    expect(r.layer.moving).toBe(0);
    expect(r.layer.capacitorVolts(0)).toBe(0);
  });
});

describe('a capacitor with series and parallel resistance (BT172)', () => {
  it('charges to V·Rp/(Rsrc + Rs + Rp) with τ = C·((Rsrc + Rs) ∥ Rp), and leaks away through Rp alone once released', () => {
    // net 1 driven through 25 Ω; the element from net 1 to GND: 1 mF behind 10 Ω, 90 Ω across it.
    const links: { a: number; b: number; kind: 'resistive' }[] = [];
    const capacitors = [{ a: 1, b: 0, farads: 1e-3, seriesOhms: 10, parallelOhms: 90 }];
    const { islands, netIsland } = buildIslands({ netCount: 2, links, diodes: [], capacitors, fixed: (net) => net === 0 });
    const layer = new AnalogLayer(2, islands, netIsland, links, [], capacitors);
    const { h, drivers } = host(new Map([[0, 0]]));
    let now = 0;
    let planned = Number.POSITIVE_INFINITY;
    layer.clock = () => now;
    layer.plan = (_i, at) => (planned = at);
    const runTo = (t: number, check: (t: number) => void): void => {
      while (planned <= t) {
        now = planned;
        planned = Number.POSITIVE_INFINITY;
        layer.step(0, h);
        check(now);
      }
      now = t;
    };
    drivers.set(1, [1 / 25, 5 / 25]);
    layer.markDirty(0);
    layer.solveDirty(h);
    expect(layer.capacitorVolts(0)).toBeCloseTo(0, 4); // its own voltage can't jump: only the series resistor takes the edge
    const final = (5 * 90) / (35 + 90);
    const tau = 1e-3 * ((35 * 90) / (35 + 90)) * 1e9;
    runTo(10 * tau, (t) => expect(Math.abs(layer.capacitorVolts(0) - final * (1 - Math.exp(-t / tau)))).toBeLessThanOrEqual(0.005 * 5));
    runTo(40 * tau, () => {});
    const start = now;
    const e0 = layer.capacitorVolts(0);
    drivers.delete(1);
    layer.markDirty(0);
    layer.solveDirty(h);
    const leak = 1e-3 * 90 * 1e9;
    runTo(start + 5 * leak, (t) => expect(Math.abs(layer.capacitorVolts(0) - e0 * Math.exp(-(t - start) / leak))).toBeLessThanOrEqual(0.005 * 5));
  });
});

describe('inductance in the element chain (BT176)', () => {
  /** Net 1 driven through 25 Ω; one element from net 1 to GND; an optional diode GND → net 1 (a flyback). */
  function rig(element: { farads: number; seriesOhms: number; henries: number }, flyback: boolean) {
    const links: { a: number; b: number; kind: 'resistive' }[] = [];
    const capacitors = [{ a: 1, b: 0, ...element }];
    const diodes = flyback ? [{ anode: 0, cathode: 1, vf: 0.65, rs: 0.3 }] : [];
    const { islands, netIsland } = buildIslands({ netCount: 2, links, diodes: diodes.map((d) => ({ a: d.anode, b: d.cathode })), capacitors, fixed: (net) => net === 0 });
    const layer = new AnalogLayer(2, islands, netIsland, links, diodes, capacitors);
    const { h, drivers, published } = host(new Map([[0, 0]]));
    let now = 0;
    let planned = Number.POSITIVE_INFINITY;
    layer.clock = () => now;
    layer.plan = (_i, at) => (planned = at);
    return {
      layer,
      published,
      drive(t: number, volts: number | null): void {
        now = t;
        if (volts === null) drivers.delete(1);
        else drivers.set(1, [1 / 25, volts / 25]);
        layer.markDirty(0);
        layer.solveDirty(h);
      },
      runTo(t: number, check: (t: number) => void): void {
        while (planned <= t) {
          now = planned;
          planned = Number.POSITIVE_INFINITY;
          layer.step(0, h);
          check(now);
        }
        now = t;
      },
    };
  }

  it('an R–L branch’s current rises as (V/R)(1 − e^(−tR/L)), and freewheels down through a flyback diode when the source lets go', () => {
    const r = rig({ farads: 0, seriesOhms: 75, henries: 10e-3 }, true);
    r.drive(0, 5);
    expect(r.layer.inductorAmps(0)).toBeCloseTo(0, 6); // an inductor's current can't jump
    const final = 5 / 100;
    const tau = (10e-3 / 100) * 1e9;
    r.runTo(10 * tau, (t) => expect(Math.abs(r.layer.inductorAmps(0) - final * (1 - Math.exp(-t / tau)))).toBeLessThanOrEqual(0.005 * final));
    // The source lets go: the current keeps flowing, now round the diode, and dies away.
    const start = 10 * tau;
    r.drive(start, null);
    expect(r.layer.inductorAmps(0)).toBeCloseTo(final, 3);
    expect(r.published.get(1)?.volts).toBeLessThan(-0.6); // the diode's drop, not a kick
    expect(r.published.get(1)?.volts).toBeGreaterThan(-1);
    r.runTo(start + 10 * tau, () => {});
    expect(Math.abs(r.layer.inductorAmps(0))).toBeLessThan(0.002 * final);
  });

  it('an RLC branch rings at its damped frequency: V[1 − e^(−αt)(cos ωt + (α/ω) sin ωt)] on the capacitor', () => {
    // 25 Ω source + 5 Ω series, 10 mH, 1 µF: ω0 = 10,000 rad/s, α = R/2L = 1,500/s.
    const r = rig({ farads: 1e-6, seriesOhms: 5, henries: 10e-3 }, false);
    const alpha = 30 / (2 * 10e-3);
    const w = Math.sqrt(1e8 - alpha * alpha);
    const expected = (t: number): number => 5 * (1 - Math.exp(-alpha * t) * (Math.cos(w * t) + (alpha / w) * Math.sin(w * t)));
    r.drive(0, 5);
    let overshoot = 0;
    r.runTo(3e6, (t) => {
      const v = r.layer.capacitorVolts(0);
      expect(Math.abs(v - expected(t / 1e9))).toBeLessThanOrEqual(0.05); // 1 % of the step
      overshoot = Math.max(overshoot, v);
    });
    expect(overshoot).toBeGreaterThan(5 * (1 + 0.9 * Math.exp((-alpha * Math.PI) / w))); // ≈ 62 % over
  });
});

describe('capacitors on a bench (BT166)', () => {
  const BOARD_PINS = ['D1', 'D2'];
  const board = fakeBoard('fake-board', BOARD_PINS);
  const resistor: PartDefinition = {
    type: 'res',
    title: 'Resistor',
    category: 'basic',
    size: { w: 5, h: 2 },
    pins: [
      { name: '1', x: 0, y: 0, role: 'passive' },
      { name: '2', x: 2.54, y: 0, role: 'passive' },
    ],
    links: [{ id: 'r', a: '1', b: '2', kind: 'resistive', ohms: 10_000 }],
    defaults: {},
  };
  const capacitor: PartDefinition = {
    type: 'cap',
    title: 'Capacitor',
    category: 'basic',
    size: { w: 5, h: 2 },
    pins: [
      { name: '1', x: 0, y: 0, role: 'passive' },
      { name: '2', x: 2.54, y: 0, role: 'passive' },
    ],
    defaults: {},
  };
  const analogSpecFor = (type: string) => (type === 'cap' ? { diodes: [], capacitors: [{ a: '1', b: '2', farads: 1e-6 }] } : undefined);
  /** BT167: records when its IN net's level changes (ctx.now()). */
  const edges: { t: number; level: 0 | 1 | null }[] = [];
  const probe: PartDefinition = {
    type: 'probe',
    title: 'Probe',
    category: 'basic',
    size: { w: 2, h: 2 },
    pins: [{ name: 'IN', x: 0, y: 0, role: 'digital' }],
    defaults: {},
    createModel(ctx) {
      let last: 0 | 1 | null = null;
      ctx.pin('IN').onChange((state) => {
        if (state.level === last) return;
        last = state.level;
        edges.push({ t: ctx.now(), level: state.level });
      });
      return {};
    },
  };

  function bench(script: FakeStep[]) {
    const mcu = new FakeMcu({ pins: BOARD_PINS, script });
    const env = makeBenchEnv([board, resistor, capacitor, probe], () => mcu);
    const doc = testDoc({ uno: 'fake-board', r1: 'res', c1: 'cap', p1: 'probe' }, [
      ['uno:D1', 'r1:1'],
      ['r1:2', 'c1:1'],
      ['c1:2', 'uno:GND'],
      ['c1:1', 'uno:D2'],
      ['c1:1', 'p1:IN'],
    ]);
    edges.length = 0;
    const b = new Bench(doc, env, { analogSpecFor });
    b.reset();
    return { b, mcu };
  }

  it('an MCU pin charges an RC: the net between follows the curve, an input on it reads high after RC·ln(5/2), and reset empties it', () => {
    // D1 goes high at 1 ms (16 MHz: cycle 16,000); D2 reads the capacitor.
    const { b, mcu } = bench([{ cycle: 16_000, pin: 'D1', mode: 'output', level: 1 }]);
    const tau = (10_000 + 25) * 1e-6; // s
    b.runUntil(1 * NS_PER_MS);
    expect(b.pinState('c1', '1')?.volts).toBeCloseTo(0, 3);
    b.runUntil(1 * NS_PER_MS + tau * 1e9);
    // Published at the last step: within a step (τ/5 at most) of τ.
    const v = b.pinState('c1', '1')?.volts ?? Number.NaN;
    expect(v).toBeGreaterThan(5 * (1 - Math.exp(-0.8)) - 0.03);
    expect(v).toBeLessThanOrEqual(5 * (1 - Math.exp(-1)) + 0.03);
    b.runUntil(1 * NS_PER_MS + 8 * tau * 1e9);
    expect(b.pinState('c1', '1')?.volts).toBeGreaterThan(4.99);
    // D2 (an input) saw its level rise once the capacitor passed 0.6 · 5 V: RC·ln(5/2) after 1 ms.
    const d2 = mcu.pins.get('D2');
    const rise = d2?.inputs.findIndex((s) => s.level === 1) ?? -1;
    expect(rise).toBeGreaterThan(0);
    // BT167: the steps land on the ATmega's VIH (3.0 V): the level rises RC·ln(5/2) after the edge (±5 %).
    const high = edges.find((e) => e.level === 1);
    const delay = ((high?.t ?? 0) - 1 * NS_PER_MS) / 1e9;
    expect(Math.abs(delay - tau * Math.log(5 / 2)) / (tau * Math.log(5 / 2))).toBeLessThanOrEqual(0.05);
    b.reset();
    expect(b.pinState('c1', '1')?.volts).toBeCloseTo(0, 3);
  });

  it('while a capacitor moves the bench runs short quanta; settled, the quanta are long again', () => {
    const { b } = bench([{ cycle: 16_000, pin: 'D1', mode: 'output', level: 1 }]);
    b.runUntil(1.05 * NS_PER_MS);
    const before = b.now();
    expect(before).toBeCloseTo(1.05 * NS_PER_MS, 0);
    b.runUntil(200 * NS_PER_MS);
    expect(b.pinState('c1', '1')?.volts).toBeGreaterThan(4.99);
  });
});
