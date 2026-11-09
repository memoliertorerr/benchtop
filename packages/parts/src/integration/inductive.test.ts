import { avrMcuFactory } from '@benchtop/avr';
import { Bench, type BenchEnv, NS_PER_MS, NS_PER_US, parseProject, type PartInstance, type ProjectDoc, type Wire } from '@benchtop/core';
import { esp32McuFactory } from '@benchtop/esp32';
import { describe, expect, it } from 'vitest';
import { readFixture, readFixtureText } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { loadCachedRom } from '../../../esp32/src/test-support/rom.test-helper.ts';
import { analogSpecFor } from '../analog-specs.ts';
import { benchEnvParts } from '../catalog.ts';

// BT178: the inductive parts on real firmware — a geared motor PWM'd through an IRLZ44N by
// esp32/mosfet-dimmer (a pot's duty at 1 kHz on GPIO25), and the relay's 150 mH coil switched off
// through a 2N2222A by blink's D13, with and without a flyback diode.

const esp32 = esp32McuFactory(loadCachedRom());
const env: BenchEnv = { part: benchEnvParts, createMcu: (b, id, report) => avrMcuFactory(b) ?? esp32(b, id, report) };

function circuit(board: PartInstance, parts: Omit<PartInstance, 'x' | 'y' | 'rotation'>[], wires: [string, string][]): ProjectDoc {
  return {
    format: 1,
    name: 'inductive test',
    parts: [board, ...parts.map((p, i) => ({ ...p, x: 100 + i * 40, y: 0, rotation: 0 as const }))],
    wires: wires.map(([from, to], i): Wire => {
      const [fp, fn] = from.split(':');
      const [tp, tn] = to.split(':');
      return { id: `w${i}`, from: { part: fp, pin: fn }, to: { part: tp, pin: tn }, waypoints: [], color: 'green' };
    }),
    firmware: {},
  };
}

function load(doc: ProjectDoc): Bench {
  const parsed = parseProject(doc);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const bench = new Bench(parsed.doc, env, { analogSpecFor });
  const board = parsed.doc.parts[0];
  if (board.type === 'arduino-uno') bench.attachFirmware(board.id, { format: 'hex', text: readFixtureText('fixtures/firmware/uno/blink.hex') });
  else bench.attachFirmware(board.id, { format: 'esp32-bin', app: readFixture('fixtures/firmware/esp32/mosfet-dimmer.bin'), partitions: readFixture('fixtures/firmware/esp32/mosfet-dimmer.partitions.bin') });
  bench.reset();
  return bench;
}

const latest = new WeakMap<Bench, Map<string, Record<string, unknown>>>();
function visual(b: Bench, id: string): Record<string, unknown> {
  let seen = latest.get(b);
  if (seen === undefined) latest.set(b, (seen = new Map()));
  for (const [part, state] of b.collectFrame().parts) seen.set(part, state as Record<string, unknown>);
  return seen.get(id) ?? {};
}

describe('inductive parts (BT178)', () => {
  /** The motor's speed after 1.5 s of esp32/mosfet-dimmer with the pot at `pot`. */
  function motorAt(pot: number, flyback: boolean, mH = 1): { rpm: number; bench: Bench } {
    const doc = circuit({ id: 'esp', type: 'esp32-devkit-v1', x: 0, y: 0, rotation: 0, props: {} }, [
      { id: 'pot', type: 'potentiometer', props: { value: pot } },
      { id: 'q1', type: 'n-mosfet', props: {} },
      { id: 'rg', type: 'resistor', props: { ohms: 10_000 } },
      { id: 'bat', type: 'battery-4aa', props: {} },
      { id: 'm1', type: 'dc-motor', props: { mH } },
      ...(flyback ? [{ id: 'd1', type: 'diode', props: { model: '1N4007' } }] : []),
    ], [
      ['pot:SIG', 'esp:D34'],
      ['pot:VCC', 'esp:3V3'],
      ['pot:GND', 'esp:GND.1'],
      ['esp:D25', 'q1:G'],
      ['q1:G', 'rg:1'],
      ['rg:2', 'esp:GND.2'],
      ['q1:S', 'esp:GND.2'],
      ['bat:-', 'esp:GND.2'],
      ['bat:+', 'm1:+'],
      ['m1:-', 'q1:D'],
      ...(flyback
        ? ([
            ['d1:A', 'q1:D'],
            ['d1:C', 'm1:+'],
          ] as [string, string][])
        : []),
    ]);
    const bench = load(doc);
    bench.runUntil(1500 * NS_PER_MS);
    return { rpm: visual(bench, 'm1').rpm as number, bench };
  }

  it('esp32/mosfet-dimmer: with a flyback diode the duty sets the speed — the winding’s current freewheels between pulses', () => {
    const full = motorAt(1, true).rpm;
    const half = motorAt(0.5, true).rpm;
    const quarter = motorAt(0.25, true).rpm;
    expect(Math.abs(full - 200)).toBeLessThanOrEqual(4);
    // Unloaded, the current runs out before each next pulse (discontinuous conduction), so half the
    // duty isn't half the speed — but the inductance pulls it well below the 90 % it was without.
    expect(half / full).toBeGreaterThan(0.75);
    expect(half / full).toBeLessThan(0.86);
    expect(quarter / full).toBeGreaterThan(0.5);
    expect(quarter / full).toBeLessThan(0.7);
    const bare = motorAt(0.5, true, 0).rpm;
    expect(bare / full).toBeGreaterThan(0.88); // no inductance: barely slower (BT172's notes)
  }, 120_000);

  it('esp32/mosfet-dimmer without the flyback diode: the IRLZ44N avalanches on every pulse and says so', () => {
    const { bench } = motorAt(0.5, false);
    expect(bench.problems().find((p) => p.code === 'transistor-avalanche')?.message).toMatch(/kicked its drain to about 5\d V, into breakdown \(55 V\)/);
  }, 60_000);

  it('uno blink: the relay’s coil through a 2N2222A — no diode, an avalanche and a quick release; a 1N4007 across it, the contacts held ≈ 2.5 ms longer', () => {
    /** How long after D13 fell (≈ 500 ms) the contacts opened, and the problems. */
    const release = (diode: boolean): { after: number; avalanche: boolean } => {
      const doc = circuit({ id: 'uno', type: 'arduino-uno', x: 0, y: 0, rotation: 0, props: {} }, [
        { id: 'rb', type: 'resistor', props: { ohms: 1000 } },
        { id: 'q1', type: 'npn-transistor', props: {} },
        { id: 'relay', type: 'relay-ks2e-m-dc5', props: {} },
        ...(diode ? [{ id: 'd1', type: 'diode', props: { model: '1N4007' } }] : []),
      ], [
        ['uno:13', 'rb:1'],
        ['rb:2', 'q1:B'],
        ['q1:E', 'uno:GND.1'],
        ['relay:COIL1', 'uno:5V'],
        ['relay:COIL2', 'q1:C'],
        ...(diode
          ? ([
              ['d1:A', 'q1:C'],
              ['d1:C', 'uno:5V'],
            ] as [string, string][])
          : []),
      ]);
      const bench = load(doc);
      bench.runUntil(490 * NS_PER_MS);
      expect(visual(bench, 'relay').contactsNO).toBe(true);
      let fell = Number.NaN;
      let at = Number.NaN;
      for (let t = 490 * NS_PER_MS; t <= 520 * NS_PER_MS && Number.isNaN(at); t += 50 * NS_PER_US) {
        bench.runUntil(t);
        if (Number.isNaN(fell) && bench.pinState('uno', '13')?.level === 0) fell = t / NS_PER_MS;
        if (visual(bench, 'relay').contactsNO === false) at = t / NS_PER_MS;
      }
      return { after: at - fell, avalanche: bench.problems().some((p) => p.code === 'transistor-avalanche') };
    };
    const bare = release(false);
    const guarded = release(true);
    expect(bare.avalanche).toBe(true);
    expect(guarded.avalanche).toBe(false);
    // The contacts move 4 ms (operateMs) after the coil lets go: the kick is over in ≈ 0.14 ms, but
    // the layer sees the breakdown stop at its next step (h ≈ τ/5 = 0.24 ms), so ≈ 4.5 ms.
    expect(bare.after).toBeGreaterThan(3.9);
    expect(bare.after).toBeLessThan(4.8);
    // Through the diode the coil's current decays over τ·ln(1 + I·R/Vf) ≈ 2.5 ms before it lets go.
    expect(guarded.after - bare.after).toBeGreaterThan(1.5);
    expect(guarded.after - bare.after).toBeLessThan(3.5);
  }, 60_000);
});
