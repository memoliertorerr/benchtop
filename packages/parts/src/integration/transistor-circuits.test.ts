import { avrMcuFactory } from '@benchtop/avr';
import { Bench, type BenchEnv, NS_PER_MS, parseProject, type PartInstance, type ProjectDoc, type Wire } from '@benchtop/core';
import { esp32McuFactory } from '@benchtop/esp32';
import { describe, expect, it } from 'vitest';
import { readFixture, readFixtureText } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { loadCachedRom } from '../../../esp32/src/test-support/rom.test-helper.ts';
import { COIL_OHMS } from '../actuators/relay.ts';
import { analogSpecFor } from '../analog-specs.ts';
import { benchEnvParts } from '../catalog.ts';

// BT169: transistor parts on a bench with real firmware — blink's pin switching a relay through a
// 2N2222A (a 1N4007 across the coil), an LED through a 2N3906 high-side switch, and an ESP32's
// 3.3 V pin switching a 9 V LED load through an IRLZ44N (and barely through an IRF540N).

const esp32 = esp32McuFactory(loadCachedRom());
const env: BenchEnv = { part: benchEnvParts, createMcu: (board, id, report) => avrMcuFactory(board) ?? esp32(board, id, report) };

function circuit(board: { id: string; type: string }, parts: Omit<PartInstance, 'x' | 'y' | 'rotation'>[], wires: [string, string][]): ProjectDoc {
  return {
    format: 1,
    name: 'transistor test',
    parts: [{ id: board.id, type: board.type, x: 0, y: 0, rotation: 0, props: {} }, ...parts.map((p, i) => ({ ...p, x: 100 + i * 40, y: 0, rotation: 0 as const }))],
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
  const board = parsed.doc.parts[0];
  if (board.type === 'arduino-uno') b.attachFirmware(board.id, { format: 'hex', text: readFixtureText('fixtures/firmware/uno/blink.hex') });
  else b.attachFirmware(board.id, { format: 'esp32-bin', app: readFixture('fixtures/firmware/esp32/blink.bin'), partitions: readFixture('fixtures/firmware/esp32/blink.partitions.bin') });
  b.reset();
  return b;
}

/** A part's latest visual state (a frame holds only the parts that changed since the last one). */
const latest = new WeakMap<Bench, Map<string, Record<string, unknown>>>();
function visual(b: Bench, id: string): Record<string, unknown> {
  let seen = latest.get(b);
  if (seen === undefined) latest.set(b, (seen = new Map()));
  for (const [part, state] of b.collectFrame().parts) seen.set(part, state as Record<string, unknown>);
  return seen.get(id) ?? {};
}

describe('transistor parts on a bench (BT169)', () => {
  it('uno blink: D13 through 1 kΩ into a 2N2222A switches the relay (a 1N4007 across its coil); its contact lights an LED', () => {
    const doc = circuit(
      { id: 'uno', type: 'arduino-uno' },
      [
        { id: 'rb', type: 'resistor', props: { ohms: 1000 } },
        { id: 'q1', type: 'npn-transistor', props: { model: '2N2222A' } },
        { id: 'relay', type: 'relay-ks2e-m-dc5', props: {} },
        { id: 'd1', type: 'diode', props: { model: '1N4007' } },
        { id: 'r1', type: 'resistor', props: { ohms: 220 } },
        { id: 'led1', type: 'led', props: { color: 'green' } },
      ],
      [
        ['uno:13', 'rb:1'],
        ['rb:2', 'q1:B'],
        ['q1:E', 'uno:GND.1'],
        ['relay:COIL1', 'uno:5V'],
        ['relay:COIL2', 'q1:C'],
        ['d1:A', 'q1:C'],
        ['d1:C', 'uno:5V'],
        ['relay:P1', 'uno:5V'],
        ['relay:NO1', 'r1:1'],
        ['r1:2', 'led1:A'],
        ['led1:C', 'uno:GND.2'],
      ],
    );
    const b = bench(doc);
    b.runUntil(250 * NS_PER_MS); // D13 high: the transistor saturates
    const vce = b.pinState('q1', 'C')?.volts ?? Number.NaN;
    expect(vce).toBeGreaterThan(0.2);
    expect(vce).toBeLessThan(0.25); // Vce(sat) + 0.5 Ω · ≈ 38 mA
    expect(visual(b, 'relay')).toMatchObject({ energized: true, contactsNO: true });
    expect(visual(b, 'led1').brightness as number).toBeGreaterThan(0.5);
    // The coil's current is the collector's: (5 − Vce) / 125 Ω.
    expect((5 - vce) / COIL_OHMS).toBeCloseTo(0.038, 3);
    b.runUntil(750 * NS_PER_MS); // D13 low: off, the coil lets go
    expect(b.pinState('q1', 'C')?.volts).toBeCloseTo(5, 2);
    expect(visual(b, 'relay')).toMatchObject({ energized: false, contactsNO: false });
    expect(visual(b, 'led1').brightness as number).toBeLessThan(0.05);
    expect(b.problems().filter((p) => p.code === 'pin-overcurrent' || p.code === 'analog-no-convergence')).toEqual([]);
  }, 60_000);

  it('uno blink: a 2N3906 high-side switch lights its LED while D13 is low', () => {
    const doc = circuit(
      { id: 'uno', type: 'arduino-uno' },
      [
        { id: 'rb', type: 'resistor', props: { ohms: 1000 } },
        { id: 'q1', type: 'pnp-transistor', props: {} },
        { id: 'r1', type: 'resistor', props: { ohms: 220 } },
        { id: 'led1', type: 'led', props: { color: 'red' } },
      ],
      [
        ['uno:13', 'rb:1'],
        ['rb:2', 'q1:B'],
        ['q1:E', 'uno:5V'],
        ['q1:C', 'r1:1'],
        ['r1:2', 'led1:A'],
        ['led1:C', 'uno:GND.1'],
      ],
    );
    const b = bench(doc);
    b.runUntil(250 * NS_PER_MS); // D13 high: off
    expect(visual(b, 'led1').milliamps as number).toBeLessThan(0.01);
    b.runUntil(750 * NS_PER_MS); // D13 low: on, saturated
    expect(visual(b, 'led1').milliamps as number).toBeCloseTo(((5 - 0.25 - 1.8) / (220 + 10 + 0.5)) * 1000, 0);
  }, 60_000);

  it('esp32 blink: GPIO2 at 3.3 V on an IRLZ44N’s gate switches a 9 V LED load fully; an IRF540N barely conducts', () => {
    const doc = (model: string) =>
      circuit(
        { id: 'esp', type: 'esp32-devkit-v1' },
        [
          { id: 'q1', type: 'n-mosfet', props: { model } },
          { id: 'rg', type: 'resistor', props: { ohms: 10_000 } },
          { id: 'bat', type: 'battery-9v', props: {} },
          { id: 'r1', type: 'resistor', props: { ohms: 470 } },
          { id: 'led1', type: 'led', props: { color: 'white' } },
        ],
        [
          ['esp:D2', 'q1:G'],
          ['q1:G', 'rg:1'],
          ['rg:2', 'esp:GND.1'],
          ['q1:S', 'esp:GND.1'],
          ['bat:-', 'esp:GND.1'],
          ['bat:+', 'r1:1'],
          ['r1:2', 'led1:A'],
          ['led1:C', 'q1:D'],
        ],
      );
    const b = bench(doc('IRLZ44N'));
    let lit = Number.NaN;
    let dark = Number.NaN;
    let gate = Number.NaN;
    let drain = Number.NaN;
    for (let ms = 50; ms <= 3000 && (Number.isNaN(lit) || Number.isNaN(dark)); ms += 50) {
      b.runUntil(ms * NS_PER_MS);
      const level = b.pinState('esp', 'D2')?.level;
      const ma = visual(b, 'led1').milliamps as number;
      if (level === 1) {
        lit = ma;
        gate = b.pinState('q1', 'G')?.volts ?? Number.NaN;
        drain = b.pinState('q1', 'D')?.volts ?? Number.NaN;
      }
      if (level === 0 && !Number.isNaN(lit)) dark = ma;
    }
    expect(gate).toBeGreaterThan(3.28); // the gate takes nothing: the pin carries only the pull-down's 0.33 mA
    expect(lit).toBeCloseTo(((9 - 2.8) / (470 + 10)) * 1000, 0); // Rds ≈ 0.05 Ω at 3.3 V
    expect(dark).toBeLessThan(0.01);
    const weak = bench(doc('IRF540N'));
    for (let ms = 50; ms <= 3000; ms += 50) {
      weak.runUntil(ms * NS_PER_MS);
      if (weak.pinState('esp', 'D2')?.level === 1) break;
    }
    weak.runUntil(weak.now() + 20 * NS_PER_MS);
    // Vgs 3.3 V is just above its 3 V threshold: about 1 Ω (0.044 Ω · 7 V / 0.3 V), twenty times an IRLZ44N's.
    const weakDrain = weak.pinState('q1', 'D')?.volts ?? Number.NaN;
    expect(weakDrain).toBeGreaterThan(10 * drain);
    const rds = 0.044 / ((3.3 - 3) / (10 - 3));
    expect(Math.abs(weakDrain - rds * ((9 - 2.8) / (470 + 10 + rds))) / weakDrain).toBeLessThan(0.15);
    expect(b.problems().filter((p) => p.code === 'analog-no-convergence')).toEqual([]);
  }, 60_000);
});
