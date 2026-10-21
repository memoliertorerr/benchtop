import { describe, expect, it } from 'vitest';
import type { Level, Strength } from '../contracts/signal.ts';
import { buildIslands } from './islands.ts';
import { type AnalogHost, AnalogLayer } from './layer.ts';
import { DenseSolver } from './solve.ts';

describe('DenseSolver', () => {
  it('solves a small nodal system', () => {
    const s = new DenseSolver();
    s.reset(3, 0);
    s.conductance(0, 1, 1);
    s.conductance(1, 2, 2);
    s.toFixed(0, 1, 0);
    s.toFixed(2, 1, 0);
    s.current(0, 1);
    s.current(2, 4);
    expect(s.solve()).toBe(true);
    // Node equations: 2v0 − v1 = 1; −v0 + 3v1 − 2v2 = 0; −2v1 + 3v2 = 4.
    const [v0, v1, v2] = [s.x[0], s.x[1], s.x[2]];
    expect(2 * v0 - v1).toBeCloseTo(1, 12);
    expect(-v0 + 3 * v1 - 2 * v2).toBeCloseTo(0, 12);
    expect(-2 * v1 + 3 * v2).toBeCloseTo(4, 12);
  });

  it('reports a singular system', () => {
    const s = new DenseSolver();
    s.reset(2, 0);
    s.conductance(0, 1, 1);
    expect(s.solve()).toBe(false);
  });
});

describe('islands', () => {
  const fixed = new Set([0]); // net 0 is a supply (GND)
  it('keeps only components with a resistor or diode, splits at supply nets, keeps switches', () => {
    const { islands, netIsland } = buildIslands({
      netCount: 8,
      links: [
        { a: 1, b: 0, kind: 'resistive' }, // island A: 1–0 (0 fixed)
        { a: 1, b: 2, kind: 'switch' }, // the switch joins 2 to island A
        { a: 3, b: 0, kind: 'resistive' }, // island B: 3 (separate: 0 is a boundary)
        { a: 4, b: 5, kind: 'switch' }, // digital only
      ],
      diodes: [{ a: 6, b: 7 }], // island C: a diode alone
      fixed: (net) => fixed.has(net),
    });
    expect(islands).toHaveLength(3);
    expect(netIsland[0]).toBe(-1);
    expect(netIsland[1]).toBe(netIsland[2]);
    expect(netIsland[3]).not.toBe(netIsland[1]);
    expect([netIsland[4], netIsland[5]]).toEqual([-1, -1]);
    expect(netIsland[6]).toBe(netIsland[7]);
    expect(islands[netIsland[1]].switches).toHaveLength(1);
  });
});

/** A host with fixed nets, Norton drivers per net and published states, for layer tests. */
function host(fixedVolts: Map<number, number>, drivers: Map<number, [number, number]>) {
  const published = new Map<number, { level: Level | null; volts: number }>();
  const h: AnalogHost = {
    driverG: (net) => drivers.get(net)?.[0] ?? 0,
    driverGV: (net) => drivers.get(net)?.[1] ?? 0,
    isLinkClosed: () => true,
    isFixed: (net) => fixedVolts.has(net),
    fixedVolts: (net) => fixedVolts.get(net) ?? 0,
    swLevel: () => null,
    swStrength: () => 1 as Strength,
    swVolts: () => 0,
    swConflict: () => false,
    publishedLevel: (net) => published.get(net)?.level ?? null,
    publish: (net, level, _strength, _conflict, volts) => published.set(net, { level, volts }),
  };
  return { h, published };
}

/** A resistor ladder: net 0 = GND (fixed), nets 1..n in a chain, net 1 driven at 5 V via 25 Ω. */
function ladder(n: number) {
  const links = [{ a: 0, b: n, kind: 'resistive' as const }];
  for (let i = 1; i < n; i++) links.push({ a: i, b: i + 1, kind: 'resistive' as const });
  const { islands, netIsland } = buildIslands({ netCount: n + 1, links, diodes: [], fixed: (net) => net === 0 });
  const layer = new AnalogLayer(n + 1, islands, netIsland, links, []);
  const { h, published } = host(new Map([[0, 0]]), new Map([[1, [1 / 25, 5 / 25]]]));
  return { layer, h, published };
}

/** A star: net 0 = GND (fixed), net 1 = the hub driven at 5 V via 25 Ω, nets 2… = anodes, each 220 Ω from the hub and a red LED to GND. */
function star(branches: number) {
  const links = Array.from({ length: branches }, (_, k) => ({ a: 1, b: 2 + k, kind: 'resistive' as const }));
  const diodes = Array.from({ length: branches }, (_, k) => ({ anode: 2 + k, cathode: 0, vf: 1.8, rs: 10 }));
  const netCount = branches + 2;
  const { islands, netIsland } = buildIslands({ netCount, links, diodes: diodes.map((d) => ({ a: d.anode, b: d.cathode })), fixed: (net) => net === 0 });
  const layer = new AnalogLayer(netCount, islands, netIsland, links, diodes);
  layer.linkOhms.fill(220);
  const { h, published } = host(new Map([[0, 0]]), new Map([[1, [1 / 25, 5 / 25]]]));
  return { layer, h, published };
}

describe('AnalogLayer', () => {
  it('solves a ladder to the divider voltages', () => {
    const { layer, h, published } = ladder(4);
    layer.markDirty(0);
    layer.solveDirty(h);
    // 25 Ω source, then 3 × 1 kΩ in series to GND through the last 1 kΩ: 4 kΩ total below net 1.
    const i = 5 / (25 + 4000);
    expect(published.get(1)?.volts).toBeCloseTo(5 - 25 * i, 9);
    expect(published.get(4)?.volts).toBeCloseTo(1000 * i, 9);
    expect(published.get(1)?.level).toBe(1);
    expect(published.get(4)?.level).toBe(0);
  });

  it('iterates diode states: a red LED with 220 Ω from a 5 V/25 Ω source carries 12.55 mA', () => {
    // net 1: source; net 2: anode; net 0: GND. Resistor 1–2 (220 Ω), diode 2 → 0.
    const links = [{ a: 1, b: 2, kind: 'resistive' as const }];
    const diodes = [{ anode: 2, cathode: 0, vf: 1.8, rs: 10 }];
    const { islands, netIsland } = buildIslands({ netCount: 3, links, diodes: [{ a: 2, b: 0 }], fixed: (net) => net === 0 });
    const layer = new AnalogLayer(3, islands, netIsland, links, diodes);
    layer.linkOhms[0] = 220;
    const { h, published } = host(new Map([[0, 0]]), new Map([[1, [1 / 25, 5 / 25]]]));
    layer.markDirty(0);
    layer.solveDirty(h);
    const amps = ((published.get(2)?.volts ?? 0) - 1.8) / 10;
    expect(amps * 1000).toBeCloseTo((5 - 1.8) / 255 * 1000, 6);
  });

  it('a released source lets the LED anode float instead of holding it at Vf', () => {
    const links = [{ a: 1, b: 2, kind: 'resistive' as const }];
    const diodes = [{ anode: 2, cathode: 0, vf: 1.8, rs: 10 }];
    const { islands, netIsland } = buildIslands({ netCount: 3, links, diodes: [{ a: 2, b: 0 }], fixed: (net) => net === 0 });
    const layer = new AnalogLayer(3, islands, netIsland, links, diodes);
    layer.linkOhms[0] = 220;
    const drivers = new Map<number, [number, number]>([[1, [1 / 25, 5 / 25]]]);
    const { h, published } = host(new Map([[0, 0]]), drivers);
    layer.markDirty(0);
    layer.solveDirty(h);
    expect(published.get(2)?.volts).toBeGreaterThan(1.8);
    drivers.clear(); // the MCU pin goes back to INPUT
    layer.markDirty(0);
    layer.solveDirty(h);
    // Nothing reaches a source: both nets publish their switch-level (floating) state.
    expect(published.get(1)).toEqual({ level: null, volts: 0 });
    expect(published.get(2)).toEqual({ level: null, volts: 0 });
  });

  it('solves a star: one 5 V/25 Ω source driving 100 branches of 220 Ω + a red LED', () => {
    const { layer, h, published } = star(100);
    layer.markDirty(0);
    layer.solveDirty(h);
    // 100·(V − 1.8)/230 = (5 − V)/25 at the hub; each anode sits 10 Ω × I above 1.8 V.
    const v = (5 / 25 + (100 * 1.8) / 230) / (1 / 25 + 100 / 230);
    expect(published.get(1)?.volts).toBeCloseTo(v, 9);
    const amps = (v - 1.8) / 230;
    for (let k = 0; k < 100; k++) expect(published.get(2 + k)?.volts).toBeCloseTo(1.8 + 10 * amps, 9);
  });

  it('benchmark: solves per second for 3-, 16-, 64- and 256-node ladders and a 101-node star', () => {
    const report: string[] = [];
    for (const n of [3, 16, 64, 256]) {
      const { layer, h } = ladder(n);
      const rounds = n >= 64 ? 300 : 3000;
      const start = performance.now();
      for (let k = 0; k < rounds; k++) {
        layer.markDirty(0);
        layer.solveDirty(h);
      }
      const perSecond = rounds / ((performance.now() - start) / 1000);
      report.push(`${n} nodes: ${Math.round(perSecond).toLocaleString('en-US')} solves/s`);
      expect(perSecond).toBeGreaterThan(0);
    }
    {
      const { layer, h } = star(100);
      const start = performance.now();
      for (let k = 0; k < 300; k++) {
        layer.markDirty(0);
        layer.solveDirty(h);
      }
      report.push(`star of 100 LED branches: ${Math.round(300 / ((performance.now() - start) / 1000)).toLocaleString('en-US')} solves/s`);
    }
    console.info(`analog solver — ${report.join('; ')}`);
  });
});
