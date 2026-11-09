import { avrMcuFactory } from '@benchtop/avr';
import { Bench, type BenchEnv, NS_PER_MS, parseProject, type PartInstance, type ProjectDoc, type Wire } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { readFixtureText } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { motorParams } from '../actuators/dc-motor.ts';
import { analogSpecFor } from '../analog-specs.ts';
import { benchEnvParts } from '../catalog.ts';

// BT172: a DC motor on the analog layer — straight on a 6 V battery pack, and through an IRLZ44N
// from blink's D13 with a 1N4007 across it.

const env: BenchEnv = { part: benchEnvParts, createMcu: (board) => avrMcuFactory(board) };

function circuit(parts: Omit<PartInstance, 'x' | 'y' | 'rotation'>[], wires: [string, string][]): ProjectDoc {
  return {
    format: 1,
    name: 'motor test',
    parts: parts.map((p, i) => ({ ...p, x: i * 40, y: 0, rotation: 0 as const })),
    wires: wires.map(([from, to], i): Wire => {
      const [fp, fn] = from.split(':');
      const [tp, tn] = to.split(':');
      return { id: `w${i}`, from: { part: fp, pin: fn }, to: { part: tp, pin: tn }, waypoints: [], color: 'green' };
    }),
    firmware: {},
  };
}

function bench(doc: ProjectDoc): Bench {
  const parsed = parseProject(doc);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const b = new Bench(parsed.doc, env, { analogSpecFor });
  if (parsed.doc.parts.some((p) => p.id === 'uno')) b.attachFirmware('uno', { format: 'hex', text: readFixtureText('fixtures/firmware/uno/blink.hex') });
  b.reset();
  return b;
}

const latest = new WeakMap<Bench, Map<string, Record<string, unknown>>>();
function visual(b: Bench, id: string): Record<string, unknown> {
  let seen = latest.get(b);
  if (seen === undefined) latest.set(b, (seen = new Map()));
  for (const [part, state] of b.collectFrame().parts) seen.set(part, state as Record<string, unknown>);
  return seen.get(id) ?? {};
}

describe('a DC motor (BT172)', () => {
  // The defaults: a geared hobby motor, 200 rpm at 6 V, 4 Ω, 60 ms, 10 % no-load current.
  const p = motorParams({ volts: 6, rpm: 200, ohms: 4, msTau: 60, noLoadPct: 10 });
  /** The spin-up's time constant on a stiff 6 V: C·(Rw ∥ Rm). */
  const tau = p.c * ((p.rw * p.rm) / (p.rw + p.rm));

  it('on a 6 V pack: stall current V/Rw at the start, spins up with its time constant to its rated 200 rpm and 10 % current', () => {
    const doc = circuit([{ id: 'bat', type: 'battery-4aa', props: {} }, { id: 'm1', type: 'dc-motor', props: {} }], [
      ['bat:+', 'm1:+'],
      ['bat:-', 'm1:-'],
    ]);
    const b = bench(doc);
    b.runUntil(1000); // 1 µs
    expect(visual(b, 'm1').milliamps as number).toBeCloseTo(1500, -1); // 6 V / 4 Ω
    b.runUntil(tau * 1e9);
    expect(Math.abs((visual(b, 'm1').rpm as number) - 200 * (1 - Math.exp(-1))) / 200).toBeLessThan(0.02);
    b.runUntil(1000 * NS_PER_MS);
    const rpm = visual(b, 'm1').rpm as number;
    expect(Math.abs(rpm - 200) / 200).toBeLessThan(0.02);
    expect(visual(b, 'm1').milliamps as number).toBeCloseTo(150, -1); // 10 % of 1.5 A
    expect((visual(b, 'm1').angle as number) / 360).toBeGreaterThan(2.8); // ≈ 3 turns in 1 s at 200 rpm
    // Turned round, it runs backwards.
    const back = bench(
      circuit([{ id: 'bat', type: 'battery-4aa', props: {} }, { id: 'm1', type: 'dc-motor', props: {} }], [
        ['bat:-', 'm1:+'],
        ['bat:+', 'm1:-'],
      ]),
    );
    back.runUntil(500 * NS_PER_MS);
    expect(visual(back, 'm1').rpm as number).toBeLessThan(-195);
  });

  it('through an IRLZ44N from blink’s D13 with a 1N4007 across it: spins up while D13 is high, coasts slowly while it is low', () => {
    const doc = circuit(
      [
        { id: 'uno', type: 'arduino-uno', props: {} },
        { id: 'bat', type: 'battery-4aa', props: {} },
        { id: 'q1', type: 'n-mosfet', props: { model: 'IRLZ44N' } },
        { id: 'rg', type: 'resistor', props: { ohms: 10_000 } },
        { id: 'm1', type: 'dc-motor', props: {} },
        { id: 'd1', type: 'diode', props: { model: '1N4007' } },
      ],
      [
        ['uno:13', 'q1:G'],
        ['q1:G', 'rg:1'],
        ['rg:2', 'uno:GND.1'],
        ['q1:S', 'uno:GND.1'],
        ['bat:-', 'uno:GND.1'],
        ['bat:+', 'm1:+'],
        ['m1:-', 'q1:D'],
        ['d1:A', 'q1:D'],
        ['d1:C', 'm1:+'],
      ],
    );
    const b = bench(doc);
    b.runUntil(490 * NS_PER_MS); // D13 high since ≈ 0: ≈ 10τ
    const on = visual(b, 'm1').rpm as number;
    expect(Math.abs(on - 200) / 200).toBeLessThan(0.03); // an IRLZ44N drops next to nothing
    b.runUntil(990 * NS_PER_MS); // D13 low for ≈ 0.49 s: coasting, τ = C·Rm
    const coast = visual(b, 'm1').rpm as number;
    const expected = on * Math.exp(-0.49 / (p.c * p.rm));
    expect(Math.abs(coast - expected) / expected).toBeLessThan(0.05);
    expect(Math.abs(visual(b, 'm1').milliamps as number)).toBeLessThan(5); // floating: next to no winding current
    expect(b.problems().filter((x) => x.code === 'transistor-overcurrent' || x.code === 'analog-no-convergence')).toEqual([]);
  }, 60_000);
});
