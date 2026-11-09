import { describe, expect, it } from 'vitest';
import type { Level, Strength } from '../contracts/signal.ts';
import { buildIslands } from './islands.ts';
import { type AnalogHost, AnalogLayer, type DiodeInstance, TRANSISTOR, type TransistorInstance } from './layer.ts';

// BT168: transistors in the analog layer, on hand-built islands. Net 0 is GND, net 9 a fixed
// supply; a "pin" is a Norton driver through 25 Ω, as an MCU output.

const NPN = { beta: 150, vbe: 0.65, rb: 25, vceSat: 0.2, rsat: 0.5, vth: 0, rdsOn: 0, vgsOn: 0 };
const IRLZ44N = { beta: 0, vbe: 0, rb: 1, vceSat: 0, rsat: 1, vth: 1.5, rdsOn: 0.025, vgsOn: 5 };
const IRF9540N = { beta: 0, vbe: 0, rb: 1, vceSat: 0, rsat: 1, vth: 3, rdsOn: 0.117, vgsOn: 10 };

interface Circuit {
  netCount: number;
  supply: number;
  resistors: [number, number, number][];
  transistors: TransistorInstance[];
  diodes?: DiodeInstance[];
  capacitors?: { a: number; b: number; farads: number }[];
}

function build(c: Circuit) {
  const links = c.resistors.map(([a, b]) => ({ a, b, kind: 'resistive' as const }));
  const fixed = new Map<number, number>([
    [0, 0],
    [9, c.supply],
  ]);
  const diodes = c.diodes ?? [];
  const capacitors = c.capacitors ?? [];
  const { islands, netIsland } = buildIslands({
    netCount: c.netCount,
    links,
    diodes: diodes.map((d) => ({ a: d.anode, b: d.cathode })),
    capacitors,
    transistors: c.transistors.map((t) => ({ a: t.x, b: t.ctl, c: t.ref })),
    fixed: (net) => fixed.has(net),
  });
  const layer = new AnalogLayer(c.netCount, islands, netIsland, links, diodes, capacitors, c.transistors);
  c.resistors.forEach(([, , ohms], i) => (layer.linkOhms[i] = ohms));
  const drivers = new Map<number, [number, number]>();
  const published = new Map<number, number>();
  let noConvergence = 0;
  layer.onNoConvergence = () => noConvergence++;
  let now = 0;
  let planned = Number.POSITIVE_INFINITY;
  layer.clock = () => now;
  layer.plan = (_i, at) => (planned = at);
  const h: AnalogHost = {
    driverG: (net) => drivers.get(net)?.[0] ?? 0,
    driverGV: (net) => drivers.get(net)?.[1] ?? 0,
    isLinkClosed: () => true,
    isFixed: (net) => fixed.has(net),
    fixedVolts: (net) => fixed.get(net) ?? 0,
    swLevel: () => null as Level | null,
    swStrength: () => 0 as Strength,
    swVolts: () => 0,
    swConflict: () => false,
    publishedLevel: () => null,
    publish: (net, _l, _s, _c, volts) => published.set(net, volts),
  };
  return {
    /** Drives `net` at `volts` through 25 Ω (null: released), solves at time t (ns). */
    pin(net: number, volts: number | null, t = now): void {
      now = t;
      if (volts === null) drivers.delete(net);
      else drivers.set(net, [1 / 25, volts / 25]);
      for (let i = 0; i < islands.length; i++) layer.markDirty(i);
      layer.solveDirty(h);
    },
    runTo(t: number): void {
      while (planned <= t) {
        now = planned;
        planned = Number.POSITIVE_INFINITY;
        for (let i = 0; i < islands.length; i++) layer.step(i, h);
      }
      now = t;
    },
    v: (net: number): number => (net === 9 ? c.supply : net === 0 ? 0 : (published.get(net) ?? Number.NaN)),
    noConvergence: () => noConvergence,
  };
}

describe('transistors in the analog layer (BT168)', () => {
  it('an NPN low-side switch: cut off with its base low, saturated at ≈ 0.2 V with it high, Ic = β·Ib in between', () => {
    // pin 1 → R 2 (base resistor) → base 2; 5 V (9) → 1 kΩ load → collector 3; emitter GND.
    const circuit = (baseOhms: number) =>
      build({ netCount: 10, supply: 5, resistors: [[1, 2, baseOhms], [9, 3, 1000]], transistors: [{ kind: TRANSISTOR.NPN, x: 3, ctl: 2, ref: 0, ...NPN }] });
    const sw = circuit(1000);
    sw.pin(1, 0);
    expect(sw.v(3)).toBeCloseTo(5, 3); // no collector current
    sw.pin(1, 5);
    const ic = (5 - sw.v(3)) / 1000;
    expect(sw.v(3)).toBeGreaterThan(0.2);
    expect(sw.v(3)).toBeLessThan(0.21); // Vce(sat) + 0.5 Ω · 4.8 mA
    expect(ic).toBeCloseTo(4.8e-3, 4);
    expect(sw.v(2)).toBeCloseTo(0.65 + 25 * ((5 - 0.65) / (1025 + 25)), 3); // the junction's knee and rb
    // 1 MΩ on the base: Ib ≈ 4.35 µA, active, Ic = β·Ib ≈ 0.65 mA.
    const amp = circuit(1e6);
    amp.pin(1, 5);
    const ib = (amp.v(1) - amp.v(2)) / 1e6;
    const icActive = (5 - amp.v(3)) / 1000;
    expect(Math.abs(icActive - 150 * ib) / (150 * ib)).toBeLessThan(2e-5); // the 1 nS C–E leak: 7e-6
    expect(amp.v(3)).toBeGreaterThan(4);
    expect(amp.noConvergence()).toBe(0);
  });

  it('a PNP high-side switch, mirrored: on with its base pulled low, off with it high', () => {
    // emitter 5 V (9); pin 1 → 1 kΩ → base 2; collector 3 → 1 kΩ load → GND.
    const sw = build({ netCount: 10, supply: 5, resistors: [[1, 2, 1000], [3, 0, 1000]], transistors: [{ kind: TRANSISTOR.PNP, x: 3, ctl: 2, ref: 9, ...NPN }] });
    sw.pin(1, 5);
    expect(sw.v(3)).toBeCloseTo(0, 3);
    sw.pin(1, 0);
    expect(sw.v(3)).toBeGreaterThan(4.79);
    expect(sw.v(3)).toBeLessThan(4.8);
    expect(sw.v(2)).toBeCloseTo(5 - 0.65 - 25 * ((5 - 0.65) / (1025 + 25)), 3);
  });

  it('an N-MOSFET’s on-resistance follows Vgs: off below Vth, a ramp to Rds(on) at Vgs(on), flat above; its gate takes no current', () => {
    // 9 V (9) → 10 Ω load → drain 3; gate on pin 1; source GND.
    const fet = build({ netCount: 10, supply: 9, resistors: [[9, 3, 10]], transistors: [{ kind: TRANSISTOR.NMOS, x: 3, ctl: 1, ref: 0, ...IRLZ44N }] });
    const rds = (): number => (fet.v(3) * 10) / (9 - fet.v(3));
    fet.pin(1, 1.0);
    expect(fet.v(3)).toBeCloseTo(9, 3);
    fet.pin(1, 3.3);
    expect(rds()).toBeCloseTo(0.025 / ((3.3 - 1.5) / (5 - 1.5)), 4);
    expect(fet.v(1)).toBeCloseTo(3.3, 6); // no gate current through the pin's 25 Ω
    fet.pin(1, 5);
    expect(rds()).toBeCloseTo(0.025, 5);
    fet.pin(1, 10);
    expect(rds()).toBeCloseTo(0.025, 5);
  });

  it('a P-MOSFET mirrored: on with its gate 9 V below its source, off with them equal', () => {
    // source 9 V (9); gate on pin 1; drain 3 → 10 Ω load → GND.
    const fet = build({ netCount: 10, supply: 9, resistors: [[3, 0, 10]], transistors: [{ kind: TRANSISTOR.PMOS, x: 3, ctl: 1, ref: 9, ...IRF9540N }] });
    fet.pin(1, 9);
    expect(fet.v(3)).toBeCloseTo(0, 3);
    fet.pin(1, 0);
    const r = 0.117 / ((9 - 3) / (10 - 3));
    expect(fet.v(3)).toBeCloseTo((9 * 10) / (10 + r), 3);
  });

  it('settles with an LED on its collector and a capacitor on its base: the LED fades in as the base charges', () => {
    // pin 1 → 10 kΩ → base 2 (100 nF to GND); 5 V → 220 Ω → anode 4 → red LED → collector 3; emitter GND.
    const c = build({
      netCount: 10,
      supply: 5,
      resistors: [[1, 2, 10_000], [9, 4, 220]],
      transistors: [{ kind: TRANSISTOR.NPN, x: 3, ctl: 2, ref: 0, ...NPN }],
      diodes: [{ anode: 4, cathode: 3, vf: 1.8, rs: 10 }],
      capacitors: [{ a: 2, b: 0, farads: 100e-9 }],
    });
    c.pin(1, 5, 0);
    expect(c.v(2)).toBeLessThan(0.01); // the base capacitor is empty: still off
    expect(c.v(3)).toBeGreaterThan(3); // the LED's cathode floats up near its anode
    c.runTo(10_000_000); // 10 ms: τ ≈ 1 ms on the base
    const led = (5 - c.v(4)) / 220;
    expect(led).toBeCloseTo((5 - 1.8 - 0.2) / (220 + 10 + 0.5), 3);
    expect(c.noConvergence()).toBe(0);
  });
});
