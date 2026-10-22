import { Bench, NS_PER_MS, type PartInstance, type ProjectDoc, Strength, type Wire } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { analogSpecFor, envSpecFor } from '../index.ts';
import { LED_RS_OHMS, ledVf } from '../analog-specs.ts';
import { benchEnvParts } from '../catalog.ts';
import { REGULATORS } from './regulators.ts';

// BT84: linear regulators between a source and a load, on real benches (the analog layer on).

/** Parts 100 mm apart, so no leg touches another part's (contacts would join nets). */
let placed = 0;
const part = (id: string, type: string, props: PartInstance['props'] = {}): PartInstance => ({ id, type, x: (placed++ % 50) * 100, y: 0, rotation: 0, props });
const wire = (id: string, a: string, b: string): Wire => {
  const [ap, aq] = a.split(':');
  const [bp, bq] = b.split(':');
  return { id, from: { part: ap, pin: aq }, to: { part: bp, pin: bq }, waypoints: [], color: 'green' };
};
const bench = (parts: PartInstance[], wires: Wire[]): Bench =>
  new Bench({ format: 1, name: 't', parts, wires, firmware: {} } satisfies ProjectDoc, { part: benchEnvParts, createMcu: () => undefined }, { analogSpecFor, envSpecFor });

/** source → regulator → 220 Ω → red LED → ground. */
function circuit(source: PartInstance, reg: string, pins: { in: string; gnd: string; out: string }) {
  const b = bench(
    [source, part('reg', reg), part('r1', 'resistor', { ohms: 220 }), part('led1', 'led', { color: 'red' })],
    [wire('w1', `${source.id}:+`, `reg:${pins.in}`), wire('w2', `${source.id}:-`, `reg:${pins.gnd}`), wire('w3', `reg:${pins.out}`, 'r1:1'), wire('w4', 'r1:2', 'led1:A'), wire('w5', 'led1:C', `reg:${pins.gnd}`)],
  );
  const run = (): { out: number; milliamps: number; codes: string[] } => {
    b.runFor(5 * NS_PER_MS);
    const led = b.collectFrame().parts.find(([id]) => id === 'led1')?.[1];
    return { out: b.pinState('reg', pins.out)?.volts ?? Number.NaN, milliamps: Number(led?.milliamps ?? 0), codes: b.problems().map((p) => p.code) };
  };
  return { b, run };
}

const LM = { in: 'IN', gnd: 'GND', out: 'OUT' };
const AMS = { in: 'VIN', gnd: 'GND', out: 'VOUT' };
const MCP = { in: 'VIN', gnd: 'GND', out: 'VOUT' };

describe('linear regulators (BT84)', () => {
  it('9 V → LM7805 → 5 V: the LED carries (5 − Vf) / 230 Ω, no problems', () => {
    const r = circuit(part('bat', 'battery-9v'), 'lm7805', LM).run();
    expect(r.out).toBeCloseTo(5, 6);
    expect(r.milliamps).toBeCloseTo((1000 * (5 - ledVf('red'))) / (220 + LED_RS_OHMS), 1);
    expect(r.codes.filter((c) => c.startsWith('regulator') || c === 'supply-fight')).toEqual([]);
  });

  it('4 × AA (6 V) → LM7805: it drops out — 4 V out and regulator-dropout', () => {
    const { b, run } = circuit(part('bat', 'battery-4aa'), 'lm7805', LM);
    const r = run();
    expect(r.out).toBeCloseTo(6 - REGULATORS.lm7805.dropout, 6);
    expect(r.codes).toContain('regulator-dropout');
    expect(b.problems().find((p) => p.code === 'regulator-dropout')).toMatchObject({ severity: 'warning', parts: ['reg'] });
  });

  it('the AMS1117 follows a bench supply: 12 V regulates, 20 V is over its rating, 3.7 V drops out', () => {
    const { b, run } = circuit(part('psu', 'bench-supply', { volts: 12 }), 'ams1117-3v3', AMS);
    let r = run();
    expect(r.out).toBeCloseTo(3.3, 6);
    expect(r.codes.filter((c) => c.startsWith('regulator'))).toEqual([]);
    b.input('psu', { kind: 'value', value: 20 });
    r = run();
    expect(r.codes).toContain('regulator-overvoltage');
    expect(b.problems().find((p) => p.code === 'regulator-overvoltage')?.severity).toBe('error');
    b.input('psu', { kind: 'value', value: 3.7 }); // a LiPo's volts: a 1.1 V dropout leaves 2.6 V
    r = run();
    expect(r.out).toBeCloseTo(2.6, 6);
    expect(r.codes).toContain('regulator-dropout');
    expect(r.codes).not.toContain('regulator-overvoltage'); // cleared
  });

  it('a LiPo through the MCP1700 (low dropout) gives a clean 3.3 V', () => {
    const r = circuit(part('bat', 'battery-lipo'), 'mcp1700-3v3', MCP).run();
    expect(r.out).toBeCloseTo(3.3, 6);
    expect(r.codes.filter((c) => c.startsWith('regulator'))).toEqual([]);
    expect(r.milliamps).toBeGreaterThan(5);
  });

  it('an unpowered regulator drives nothing; powering it later turns its output on', () => {
    const b = bench([part('reg', 'lm7805'), part('psu', 'bench-supply', { volts: 0 })], [wire('w1', 'psu:+', 'reg:IN'), wire('w2', 'psu:-', 'reg:GND')]);
    b.runFor(NS_PER_MS);
    expect(b.pinState('reg', 'OUT')?.strength).toBe(Strength.hiz);
    b.input('psu', { kind: 'value', value: 9 });
    b.runFor(NS_PER_MS);
    expect(b.pinState('reg', 'OUT')).toMatchObject({ strength: Strength.supply, volts: 5, level: 1 });
    expect(b.collectFrame().parts.find(([id]) => id === 'reg')?.[1]).toEqual({ volts: 5, on: true });
  });

  it('a 3.3 V output reads as a logic 1 even when fed 9 V', () => {
    const b = bench([part('bat', 'battery-9v'), part('reg', 'ams1117-3v3')], [wire('w1', 'bat:+', 'reg:VIN'), wire('w2', 'bat:-', 'reg:GND')]);
    b.runFor(NS_PER_MS);
    expect(b.pinState('reg', 'VOUT')).toMatchObject({ volts: 3.3, level: 1 });
  });
});
