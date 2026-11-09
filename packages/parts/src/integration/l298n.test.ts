import { avrMcuFactory } from '@benchtop/avr';
import { Bench, type BenchEnv, NS_PER_MS, parseProject, type PartInstance, type ProjectDoc, type Wire } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { readFixtureText } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { L298_HIGH_DROP, L298_LOW_VOLTS } from '../actuators/l298n.ts';
import { analogSpecFor } from '../analog-specs.ts';
import { benchEnvParts } from '../catalog.ts';

// BT173: an L298N on an Uno — a DC motor on channel A under uno/l298n-motor (a pot's duty PWM'd on
// IN1/IN2, ENA on 8, a button reversing it with a brake), and a bipolar stepper on both channels
// under uno/l298n-stepper (the Stepper library).

const env: BenchEnv = { part: benchEnvParts, createMcu: (board) => avrMcuFactory(board) };

function circuit(parts: Omit<PartInstance, 'x' | 'y' | 'rotation'>[], wires: [string, string][]): ProjectDoc {
  return {
    format: 1,
    name: 'l298n test',
    parts: [{ id: 'uno', type: 'arduino-uno', x: 0, y: 0, rotation: 0, props: {} }, ...parts.map((p, i) => ({ ...p, x: 100 + i * 60, y: 0, rotation: 0 as const }))],
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
  bench.attachFirmware('uno', { format: 'hex', text: readFixtureText(`fixtures/firmware/uno/${firmware}.hex`) });
  bench.reset();
  let serial = '';
  bench.onSerial('uno', (bytes) => (serial += String.fromCharCode(...bytes)));
  const seen = new Map<string, Record<string, unknown>>();
  const visual = (id: string): Record<string, unknown> => {
    for (const [part, state] of bench.collectFrame().parts) seen.set(part, state as Record<string, unknown>);
    return seen.get(id) ?? {};
  };
  return { bench, serial: () => serial, visual };
}

/** The motor's speed on a 9 V supply through the bridge's drops, at full duty: 200 rpm per 6 V. */
const FULL_RPM = (200 * (9 - L298_HIGH_DROP - L298_LOW_VOLTS)) / 6;

describe('an L298N H-bridge (BT173)', () => {
  const motorDoc = circuit(
    [
      { id: 'drv', type: 'l298n', props: { enaJumper: false } },
      { id: 'm1', type: 'dc-motor', props: {} },
      { id: 'bat', type: 'battery-9v', props: {} },
      { id: 'pot', type: 'potentiometer', props: { value: 1 } },
      { id: 'btn', type: 'pushbutton', props: {} },
    ],
    [
      ['uno:8', 'drv:ENA'],
      ['uno:9', 'drv:IN1'],
      ['uno:10', 'drv:IN2'],
      ['drv:OUT1', 'm1:+'],
      ['drv:OUT2', 'm1:-'],
      ['bat:+', 'drv:+12V'],
      ['bat:-', 'drv:GND'],
      ['drv:GND', 'uno:GND.1'],
      ['pot:VCC', 'uno:5V'],
      ['pot:GND', 'uno:GND.2'],
      ['pot:SIG', 'uno:A0'],
      ['btn:1.l', 'uno:2'],
      ['btn:2.l', 'uno:GND.3'],
    ],
  );

  it('uno/l298n-motor: full duty forward, half duty half the speed (it brakes between pulses), a button brakes and reverses, a duty under 10 coasts', () => {
    const { bench, serial, visual } = load(motorDoc, 'l298n-motor');
    bench.runUntil(800 * NS_PER_MS);
    expect(serial()).toContain('fwd 255');
    expect(Math.abs((visual('m1').rpm as number) - FULL_RPM) / FULL_RPM).toBeLessThan(0.03);
    expect(visual('drv')).toMatchObject({ powered: true, regulator: true });
    expect(bench.pinState('drv', '+5V')?.volts).toBeCloseTo(5, 6);
    // Half duty: half the speed (2.5 V on A0 reads 512 → 128 of 255).
    bench.input('pot', { kind: 'value', value: 0.5 });
    bench.runUntil(1600 * NS_PER_MS);
    expect(serial()).toMatch(/fwd 128\r\n/);
    const half = visual('m1').rpm as number;
    expect(Math.abs(half - (FULL_RPM * 128) / 255) / ((FULL_RPM * 128) / 255)).toBeLessThan(0.05);
    // The button: a 200 ms brake, then the other way.
    bench.input('pot', { kind: 'value', value: 1 });
    bench.runUntil(2400 * NS_PER_MS);
    bench.input('btn', { kind: 'press' });
    bench.runUntil(2400 * NS_PER_MS + 150 * 1e6);
    expect(serial()).toContain('brake\r\n');
    expect(Math.abs(visual('m1').rpm as number)).toBeLessThan(FULL_RPM * 0.2); // braking: τ ≈ 54 ms
    bench.input('btn', { kind: 'release' });
    bench.runUntil(3400 * NS_PER_MS);
    expect(serial()).toContain('rev 255');
    expect(Math.abs((visual('m1').rpm as number) + FULL_RPM) / FULL_RPM).toBeLessThan(0.03);
    // A duty under 10: disabled, it coasts (τ = C·Rm ≈ 0.54 s, far slower than the brake).
    bench.input('pot', { kind: 'value', value: 0 });
    bench.runUntil(3600 * NS_PER_MS);
    expect(serial()).toContain('coast\r\n');
    expect((visual('drv').outs as number[]).slice(0, 2)).toEqual([0, 0]); // A released (B's jumper keeps it on, both low)
    const coasting = Math.abs(visual('m1').rpm as number);
    expect(coasting).toBeGreaterThan(FULL_RPM * 0.5);
    expect(coasting).toBeLessThan(FULL_RPM);
    expect(bench.problems().filter((p) => p.severity === 'error')).toEqual([]);
  }, 60_000);

  it('uno/l298n-stepper: the Stepper library turns a bipolar stepper on both channels one turn each way', () => {
    const doc = circuit(
      [
        { id: 'drv', type: 'l298n', props: {} },
        { id: 'st', type: 'stepper-bipolar', props: {} },
        { id: 'bat', type: 'battery-9v', props: {} },
      ],
      [
        ['uno:8', 'drv:IN1'],
        ['uno:9', 'drv:IN2'],
        ['uno:10', 'drv:IN3'],
        ['uno:11', 'drv:IN4'],
        ['drv:OUT1', 'st:A+'],
        ['drv:OUT2', 'st:A-'],
        ['drv:OUT3', 'st:B+'],
        ['drv:OUT4', 'st:B-'],
        ['bat:+', 'drv:+12V'],
        ['bat:-', 'drv:GND'],
        ['drv:GND', 'uno:GND.1'],
      ],
    );
    const { bench, serial, visual } = load(doc, 'l298n-stepper');
    // 200 steps at 60 rpm take 1 s each way; the first coil state only sets the reference, so the
    // first turn shows 199 steps (358.2°) and the way back ends one step short of 0.
    let most = Number.NEGATIVE_INFINITY;
    let least = Number.POSITIVE_INFINITY;
    for (let ms = 5; ms <= 2200 && !serial().includes('back'); ms += 5) {
      bench.runUntil(ms * NS_PER_MS);
      const angle = visual('st').angle as number;
      most = Math.max(most, angle);
      if (serial().includes('turned')) least = Math.min(least, angle);
    }
    expect(serial()).toContain('turned\r\nback');
    expect(most).toBeCloseTo(358.2, 1);
    expect(least).toBeCloseTo(-1.8, 1);
  }, 60_000);
});
