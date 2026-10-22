import { analogSpecFor, envSpecFor } from '../index.ts';
import { Bench, NS_PER_MS, type PartInstance, type ProjectDoc, type Wire } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { LED_RS_OHMS, ledVf } from '../analog-specs.ts';
import { benchEnvParts, CATALOG } from '../catalog.ts';
import { channelInput } from '../shared/channel-input.ts';
import { BATTERY_VOLTS } from './sources.ts';

// BT83: batteries, the bench supply and the ground symbol on real benches (the analog layer on).

const part = (id: string, type: string, x: number, y: number, props: PartInstance['props'] = {}): PartInstance => ({ id, type, x, y, rotation: 0, props });
const wire = (id: string, a: string, b: string): Wire => {
  const [ap, aq] = a.split(':');
  const [bp, bq] = b.split(':');
  return { id, from: { part: ap, pin: aq }, to: { part: bp, pin: bq }, waypoints: [], color: 'green' };
};
const doc = (parts: PartInstance[], wires: Wire[]): ProjectDoc => ({ format: 1, name: 't', parts, wires, firmware: {} });
const bench = (d: ProjectDoc): Bench => new Bench(d, { part: benchEnvParts, createMcu: () => undefined }, { analogSpecFor, envSpecFor });

/** A source's + through `ohms` into a red LED back to its −: the LED's milliamps after a little while. */
function ledCircuit(source: PartInstance, ohms: number): { b: Bench; milliamps: () => number; latest: Map<string, Record<string, unknown>> } {
  const b = bench(
    doc(
      [source, part('r1', 'resistor', 200, 0, { ohms }), part('led1', 'led', 300, 0, { color: 'red' })],
      [wire('w1', `${source.id}:+`, 'r1:1'), wire('w2', 'r1:2', 'led1:A'), wire('w3', 'led1:C', `${source.id}:-`)],
    ),
  );
  const latest = new Map<string, Record<string, unknown>>();
  const milliamps = (): number => {
    b.runFor(5 * NS_PER_MS);
    for (const [id, visual] of b.collectFrame().parts) latest.set(id, { ...visual });
    return Number(latest.get('led1')?.milliamps ?? Number.NaN);
  };
  return { b, milliamps, latest };
}

const expected = (volts: number, ohms: number): number => (1000 * (volts - ledVf('red'))) / (ohms + LED_RS_OHMS);

describe('power sources (BT83)', () => {
  it.each(Object.entries(BATTERY_VOLTS))('%s drives + at its volts and − at 0 V', (type, volts) => {
    const b = bench(doc([part('bat', type, 0, 0)], []));
    expect(b.pinState('bat', '+')?.volts).toBeCloseTo(volts, 6);
    expect(b.pinState('bat', '-')?.volts).toBe(0);
    expect(CATALOG.get(type)?.category).toBe('power');
  });

  it('a 9 V battery lights an LED through 1 kΩ at (9 − Vf) / 1 kΩ', () => {
    const { milliamps } = ledCircuit(part('bat', 'battery-9v', 0, 0), 1000);
    expect(milliamps()).toBeCloseTo(expected(9, 1000), 1);
  });

  it('the bench supply follows its volts while running; past the LED\'s limit it is led-overcurrent', () => {
    const { b, milliamps, latest } = ledCircuit(part('psu', 'bench-supply', 0, 0, { volts: 3 }), 220);
    const at3 = milliamps();
    expect(at3).toBeCloseTo(expected(3, 220), 1);
    b.input('psu', { kind: 'value', value: 5 });
    expect(milliamps()).toBeCloseTo(expected(5, 220), 1);
    expect(b.problems().some((p) => p.code === 'led-overcurrent')).toBe(false);
    b.input('psu', channelInput('volts', 12)); // the Inspector's slider while running
    expect(milliamps()).toBeCloseTo(expected(12, 220), 1);
    expect(b.problems().some((p) => p.code === 'led-overcurrent' && p.parts.includes('led1'))).toBe(true);
    expect(latest.get('psu')).toEqual({ volts: 12 });
    b.input('psu', { kind: 'value', value: 99 });
    b.runFor(NS_PER_MS);
    expect(b.pinState('psu', '+')?.volts).toBe(30); // clamped to its range
  });

  it('a battery tied to a board\'s 5 V is a supply fight; a ground symbol is 0 V', () => {
    const b = bench(doc([part('uno', 'arduino-uno', 0, 0), part('bat', 'battery-9v', 100, 0), part('gnd', 'ground', 200, 0)], [wire('w1', 'bat:+', 'uno:5V'), wire('w2', 'bat:-', 'gnd:GND')]));
    b.runFor(NS_PER_MS);
    expect(b.problems()).toContainEqual(expect.objectContaining({ code: 'supply-fight', parts: ['bat'], message: expect.stringContaining('tied to another supply') }));
    expect(b.pinState('gnd', 'GND')?.volts).toBe(0);
  });

  it('a module on a battery is powered', () => {
    const b = bench(doc([part('bat', 'battery-4aa', 0, 0), part('dht', 'dht22', 100, 0)], [wire('w1', 'bat:+', 'dht:VCC'), wire('w2', 'bat:-', 'dht:GND')]));
    b.runFor(20 * NS_PER_MS);
    expect(b.problems().filter((p) => p.code === 'unpowered-part')).toEqual([]);
    expect(b.pinState('dht', 'VCC')?.volts).toBe(6);
  });
});
