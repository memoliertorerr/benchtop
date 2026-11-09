import { avrMcuFactory } from '@benchtop/avr';
import { Bench, type BenchEnv, NS_PER_MS, parseProject, type ProjectDoc } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { readFixtureText } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { analogSpecFor } from '../analog-specs.ts';
import { benchEnvParts } from '../catalog.ts';

// BT170: what a moving capacitor costs. uno/rc-filter's PWM on pin 9 through 10 kΩ, with and
// without the 10 µF on A0: with it, the island steps on every PWM edge (980 a second) and never
// settles. Timed by the process's CPU time (wall time counts other processes), the best of three
// alternating runs each; a capacitor may cost at most 30 % (measured ≈ 9 %).

const env: BenchEnv = { part: benchEnvParts, createMcu: (board) => avrMcuFactory(board) };
const HEX = readFixtureText('fixtures/firmware/uno/rc-filter.hex');

function doc(capacitor: boolean): ProjectDoc {
  const wire = (id: string, a: string, ap: string, b: string, bp: string) => ({ id, from: { part: a, pin: ap }, to: { part: b, pin: bp }, waypoints: [], color: 'green' });
  return {
    format: 1,
    name: 'rc speed',
    parts: [
      { id: 'uno', type: 'arduino-uno', x: 0, y: 0, rotation: 0, props: {} },
      { id: 'r1', type: 'resistor', x: 100, y: 0, rotation: 0, props: { ohms: 10_000 } },
      ...(capacitor ? [{ id: 'c1', type: 'capacitor-electrolytic', x: 140, y: 0, rotation: 0 as const, props: { farads: 10e-6 } }] : []),
    ],
    wires: [wire('w1', 'uno', '9', 'r1', '1'), wire('w2', 'r1', '2', 'uno', 'A0'), ...(capacitor ? [wire('w3', 'c1', '+', 'uno', 'A0'), wire('w4', 'c1', '-', 'uno', 'GND.1')] : [])],
    firmware: {},
  } as ProjectDoc;
}

/** CPU milliseconds to simulate one second. */
function cpuMs(capacitor: boolean): number {
  const parsed = parseProject(doc(capacitor));
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

describe('a moving capacitor’s cost (BT170)', () => {
  it('uno/rc-filter with its capacitor takes at most 1.3× the CPU time of the same circuit without it', () => {
    let withCap = Number.POSITIVE_INFINITY;
    let without = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 3; i++) {
      without = Math.min(without, cpuMs(false));
      withCap = Math.min(withCap, cpuMs(true));
    }
    expect(withCap / without, `${withCap.toFixed(0)} ms with, ${without.toFixed(0)} ms without`).toBeLessThanOrEqual(1.3);
  }, 120_000);
});
