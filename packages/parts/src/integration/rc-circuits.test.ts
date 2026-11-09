import { avrMcuFactory } from '@benchtop/avr';
import { Bench, type BenchEnv, NS_PER_MS, parseProject, type PartInstance, type ProjectDoc, type Wire } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { readFixtureText } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { analogSpecFor } from '../analog-specs.ts';
import { benchEnvParts } from '../catalog.ts';

// BT167: capacitors and a diode on a bench with an Uno running real firmware — an RC filter on a
// PWM pin read by the ADC, an RC delay timed by an input, a reversed electrolytic, a diode's drop.

const env: BenchEnv = { part: benchEnvParts, createMcu: (board) => avrMcuFactory(board) };

/** An Uno plus parts placed far apart (no contacts), wired as given ("part:pin" pairs). */
function circuit(parts: Omit<PartInstance, 'x' | 'y' | 'rotation'>[], wires: [string, string][]): ProjectDoc {
  return {
    format: 1,
    name: 'rc test',
    parts: [{ id: 'uno', type: 'arduino-uno', x: 0, y: 0, rotation: 0, props: {} }, ...parts.map((p, i) => ({ ...p, x: 100 + i * 40, y: 0, rotation: 0 as const }))],
    wires: wires.map(([from, to], i): Wire => {
      const [fp, fn] = from.split(':');
      const [tp, tn] = to.split(':');
      return { id: `w${i}`, from: { part: fp, pin: fn }, to: { part: tp, pin: tn }, waypoints: [], color: 'green' };
    }),
    firmware: {},
  };
}

function load(doc: ProjectDoc, firmware: string) {
  const parsed = parseProject(doc);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const bench = new Bench(parsed.doc, env, { analogSpecFor });
  if (firmware !== '') bench.attachFirmware('uno', { format: 'hex', text: readFixtureText(`fixtures/firmware/uno/${firmware}.hex`) });
  bench.reset();
  let serial = '';
  bench.onSerial('uno', (bytes) => (serial += String.fromCharCode(...bytes)));
  return { bench, serial: () => serial };
}

describe('RC circuits on an Uno (BT167)', () => {
  it('uno/rc-filter: PWM through 10 kΩ into 10 µF reads duty · 1023 on A0 once settled, with a few counts of ripple', () => {
    const doc = circuit(
      [
        { id: 'r1', type: 'resistor', props: { ohms: 10_000 } },
        { id: 'c1', type: 'capacitor-electrolytic', props: { farads: 10e-6 } },
      ],
      [
        ['uno:9', 'r1:1'],
        ['r1:2', 'c1:+'],
        ['c1:-', 'uno:GND.1'],
        ['c1:+', 'uno:A0'],
      ],
    );
    const { bench, serial } = load(doc, 'rc-filter');
    bench.runUntil(3000 * NS_PER_MS);
    const lines = [...serial().matchAll(/pwm:(\d+),a0:(\d+)\r\n/g)].map((m) => ({ pwm: Number(m[1]), a0: Number(m[2]) }));
    expect(lines.length).toBeGreaterThan(50);
    // The last few readings of each second (≥ 6 RC after its step): the target, within 2 % of full scale.
    for (const second of [0, 1, 2]) {
      const settled = lines.slice(second * 20 + 14, second * 20 + 19);
      for (const { pwm, a0 } of settled) expect(Math.abs(a0 - pwm), JSON.stringify(settled)).toBeLessThanOrEqual(20);
      const spread = Math.max(...settled.map((l) => l.a0)) - Math.min(...settled.map((l) => l.a0));
      expect(spread).toBeLessThanOrEqual(8);
    }
    // Right after a step it climbs: the first reading of the second second sits well below its target.
    expect(lines[20].a0).toBeLessThan(lines[20].pwm - 60);
    expect(bench.problems().some((p) => p.code === 'capacitor-reversed')).toBe(false);
  }, 60_000);

  it('uno/rc-delay: an input on an RC reads high RC·ln(5/2) after its pin rises and low RC·ln(5/1.5) after it falls (±5 %)', () => {
    const doc = circuit(
      [
        { id: 'r1', type: 'resistor', props: { ohms: 10_000 } },
        { id: 'c1', type: 'capacitor', props: { farads: 100e-9 } },
      ],
      [
        ['uno:8', 'r1:1'],
        ['r1:2', 'c1:1'],
        ['c1:2', 'uno:GND.1'],
        ['c1:1', 'uno:2'],
      ],
    );
    const { bench, serial } = load(doc, 'rc-delay');
    bench.runUntil(400 * NS_PER_MS);
    const rc = (10_000 + 25) * 100e-9 * 1e6; // µs
    const rises = [...serial().matchAll(/rise (\d+)\r\n/g)].map((m) => Number(m[1]));
    const falls = [...serial().matchAll(/fall (\d+)\r\n/g)].map((m) => Number(m[1]));
    expect(rises.length).toBeGreaterThanOrEqual(5);
    expect(falls.length).toBeGreaterThanOrEqual(5);
    for (const rise of rises) expect(Math.abs(rise - rc * Math.log(5 / 2)) / (rc * Math.log(5 / 2))).toBeLessThanOrEqual(0.05);
    for (const fall of falls) expect(Math.abs(fall - rc * Math.log(5 / 1.5)) / (rc * Math.log(5 / 1.5))).toBeLessThanOrEqual(0.05);
  }, 60_000);

  it('an electrolytic in backwards on 5 V is reported, and the report goes when it is turned round', () => {
    const backwards = circuit([{ id: 'c1', type: 'capacitor-electrolytic', props: {} }], [
      ['c1:-', 'uno:5V'],
      ['c1:+', 'uno:GND.1'],
    ]);
    const a = load(backwards, '');
    a.bench.runUntil(10 * NS_PER_MS);
    expect(a.bench.problems().find((p) => p.code === 'capacitor-reversed')?.message).toMatch(/5\.0 V across it backwards/);
    expect(a.bench.collectFrame().parts.find(([id]) => id === 'c1')?.[1]).toMatchObject({ reversed: true });
    const right = circuit([{ id: 'c1', type: 'capacitor-electrolytic', props: {} }], [
      ['c1:+', 'uno:5V'],
      ['c1:-', 'uno:GND.1'],
    ]);
    const b = load(right, '');
    b.bench.runUntil(10 * NS_PER_MS);
    expect(b.bench.problems().some((p) => p.code === 'capacitor-reversed')).toBe(false);
  });

  it('a 1N4007 in series with an LED drops ≈ 0.65 V; turned round it blocks', () => {
    const forward = circuit(
      [
        { id: 'd1', type: 'diode', props: { model: '1N4007' } },
        { id: 'r1', type: 'resistor', props: { ohms: 220 } },
        { id: 'led1', type: 'led', props: { color: 'red' } },
      ],
      [
        ['uno:5V', 'd1:A'],
        ['d1:C', 'r1:1'],
        ['r1:2', 'led1:A'],
        ['led1:C', 'uno:GND.1'],
      ],
    );
    const a = load(forward, '');
    a.bench.runUntil(5 * NS_PER_MS);
    const drop = 5 - (a.bench.pinState('d1', 'C')?.volts ?? 0);
    expect(drop).toBeGreaterThan(0.64);
    expect(drop).toBeLessThan(0.67);
    const led = a.bench.collectFrame().parts.find(([id]) => id === 'led1')?.[1] as { milliamps: number };
    expect(led.milliamps).toBeCloseTo(((5 - 0.65 - 1.8) / (220 + 10 + 0.3)) * 1000, 0);
    const reversed = circuit(
      [
        { id: 'd1', type: 'diode', props: { model: '1N4007' } },
        { id: 'r1', type: 'resistor', props: { ohms: 220 } },
        { id: 'led1', type: 'led', props: { color: 'red' } },
      ],
      [
        ['uno:5V', 'd1:C'],
        ['d1:A', 'r1:1'],
        ['r1:2', 'led1:A'],
        ['led1:C', 'uno:GND.1'],
      ],
    );
    const b = load(reversed, '');
    b.bench.runUntil(5 * NS_PER_MS);
    const off = b.bench.collectFrame().parts.find(([id]) => id === 'led1')?.[1] as { milliamps: number };
    expect(off.milliamps).toBeLessThan(0.01);
  });
});
