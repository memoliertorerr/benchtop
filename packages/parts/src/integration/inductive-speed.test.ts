import { avrMcuFactory } from '@benchtop/avr';
import { Bench, type BenchEnv, NS_PER_MS, parseProject, type ProjectDoc } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { readFixtureText } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { analogSpecFor } from '../analog-specs.ts';
import { benchEnvParts } from '../catalog.ts';

// BT179: what a motor's winding inductance costs. uno/rc-filter's 490 Hz PWM on pin 9 drives an
// IRLZ44N switching the geared motor from a 6 V pack, a 1N4007 across it — with its 1 mH, the
// island is fast (τ = L/R ≈ 0.25 ms: 100 µs quanta) and steps through every pulse; without it
// (`mH` 0) it only has the mechanical time constant. Timed by the process's CPU time, the best of
// three alternating runs each; the inductance may cost at most 1.5× (measured ≈ 1.03×: the steps
// through each pulse are cheap next to the Uno's own emulation).

const env: BenchEnv = { part: benchEnvParts, createMcu: (board) => avrMcuFactory(board) };
const HEX = readFixtureText('fixtures/firmware/uno/rc-filter.hex');

function doc(mH: number): ProjectDoc {
  const wire = (id: string, a: string, ap: string, b: string, bp: string) => ({ id, from: { part: a, pin: ap }, to: { part: b, pin: bp }, waypoints: [], color: 'green' });
  const part = (id: string, type: string, x: number, props: Record<string, string | number | boolean> = {}) => ({ id, type, x, y: 0, rotation: 0 as const, props });
  return {
    format: 1,
    name: 'inductive speed',
    parts: [part('uno', 'arduino-uno', 0), part('q1', 'n-mosfet', 100), part('rg', 'resistor', 140, { ohms: 10_000 }), part('bat', 'battery-4aa', 180), part('m1', 'dc-motor', 260, { mH }), part('d1', 'diode', 300, { model: '1N4007' })],
    wires: [
      wire('w1', 'uno', '9', 'q1', 'G'),
      wire('w2', 'q1', 'G', 'rg', '1'),
      wire('w3', 'rg', '2', 'uno', 'GND.1'),
      wire('w4', 'q1', 'S', 'uno', 'GND.1'),
      wire('w5', 'bat', '-', 'uno', 'GND.2'),
      wire('w6', 'bat', '+', 'm1', '+'),
      wire('w7', 'm1', '-', 'q1', 'D'),
      wire('w8', 'd1', 'A', 'q1', 'D'),
      wire('w9', 'd1', 'C', 'm1', '+'),
    ],
    firmware: {},
  } as ProjectDoc;
}

/** CPU milliseconds to simulate one second. */
function cpuMs(mH: number): number {
  const parsed = parseProject(doc(mH));
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const bench = new Bench(parsed.doc, env, { analogSpecFor });
  bench.attachFirmware('uno', { format: 'hex', text: HEX });
  bench.reset();
  bench.runUntil(100 * NS_PER_MS); // warm up
  const before = process.cpuUsage();
  bench.runUntil(1100 * NS_PER_MS);
  const used = process.cpuUsage(before);
  return (used.user + used.system) / 1000;
}

describe('a motor’s inductance under PWM (BT179)', () => {
  it('uno/rc-filter driving a motor through an IRLZ44N: its 1 mH costs at most 1.5× the CPU time of the same circuit without it', () => {
    let inductive = Number.POSITIVE_INFINITY;
    let plain = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 3; i++) {
      plain = Math.min(plain, cpuMs(0));
      inductive = Math.min(inductive, cpuMs(1));
    }
    expect(inductive / plain, `${inductive.toFixed(0)} ms with, ${plain.toFixed(0)} ms without`).toBeLessThanOrEqual(1.5);
  }, 180_000);
});
