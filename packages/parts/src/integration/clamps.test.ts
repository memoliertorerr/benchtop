import { avrMcuFactory } from '@benchtop/avr';
import { Bench, type BenchEnv, NS_PER_MS, NS_PER_US, parseProject, type PartDefinition, type PartInstance, type PartProps, type ProjectDoc, type Wire } from '@benchtop/core';
import { FakeMcu, fakeBoard } from '@benchtop/core/testing';
import { describe, expect, it } from 'vitest';
import { readFixtureText } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { analogSpecFor } from '../analog-specs.ts';
import { benchEnvParts } from '../catalog.ts';

// BT177: what stops an inductor's kick — the transistors' breakdown and body diodes, a flyback
// diode, the L298N's own diodes — on benches with a test coil (100 Ω, 100 mH: τ = 1 ms).

const coil: PartDefinition = {
  type: 'test-coil',
  title: 'Coil',
  category: 'basic',
  size: { w: 5.08, h: 2.54 },
  pins: [
    { name: '1', x: 0, y: 0, role: 'passive' },
    { name: '2', x: 2.54, y: 0, role: 'passive' },
  ],
  defaults: {},
};
const specFor = (type: string, props: PartProps) => (type === 'test-coil' ? { diodes: [], capacitors: [{ a: '1', b: '2', farads: 0, seriesOhms: 100, henries: 0.1 }] } : analogSpecFor(type, props));

function circuit(board: PartInstance, parts: Omit<PartInstance, 'x' | 'y' | 'rotation'>[], wires: [string, string][]): ProjectDoc {
  return {
    format: 1,
    name: 'clamp test',
    parts: [board, ...parts.map((p, i) => ({ ...p, x: 100 + i * 40, y: 0, rotation: 0 as const }))],
    wires: wires.map(([from, to], i): Wire => {
      const [fp, fn] = from.split(':');
      const [tp, tn] = to.split(':');
      return { id: `w${i}`, from: { part: fp, pin: fn }, to: { part: tp, pin: tn }, waypoints: [], color: 'green' };
    }),
    firmware: {},
  };
}

const UNO: PartInstance = { id: 'uno', type: 'arduino-uno', x: 0, y: 0, rotation: 0, props: {} };

/** An Uno running blink (D13: high 0–500 ms, low 500–1000 ms, …), recording the highest volts on a pin. */
function blinkBench(doc: ProjectDoc, watch: [string, string]) {
  const env: BenchEnv = { part: (t) => (t === 'test-coil' ? coil : benchEnvParts(t)), createMcu: (b) => avrMcuFactory(b) };
  const parsed = parseProject(doc);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const bench = new Bench(parsed.doc, env, { analogSpecFor: specFor });
  bench.attachFirmware('uno', { format: 'hex', text: readFixtureText('fixtures/firmware/uno/blink.hex') });
  bench.reset();
  let peak = Number.NEGATIVE_INFINITY;
  const sample = (): void => {
    const v = bench.pinState(watch[0], watch[1])?.volts ?? Number.NaN;
    if (v > peak) peak = v;
  };
  return {
    bench,
    peak: () => peak,
    /** Runs in 20 µs slices from `from` to `to` (ms), sampling the watched pin. */
    run(from: number, to: number): void {
      for (let t = from * NS_PER_MS; t <= to * NS_PER_MS; t += 20 * NS_PER_US) {
        bench.runUntil(t);
        sample();
      }
    },
    avalanche: () => bench.problems().find((p) => p.code === 'transistor-avalanche'),
  };
}

describe('clamps and kicks (BT177)', () => {
  it('a 2N2222A switching a coil off with no diode breaks down at its 40 V Vceo and says so; a 1N4007 across the coil keeps it at 5.7 V', () => {
    const bare = circuit(UNO, [{ id: 'rb', type: 'resistor', props: { ohms: 1000 } }, { id: 'q1', type: 'npn-transistor', props: {} }, { id: 'l1', type: 'test-coil', props: {} }], [
      ['uno:13', 'rb:1'],
      ['rb:2', 'q1:B'],
      ['q1:E', 'uno:GND.1'],
      ['uno:5V', 'l1:1'],
      ['l1:2', 'q1:C'],
    ]);
    const a = blinkBench(bare, ['q1', 'C']);
    a.run(400, 520); // D13 falls at 500 ms
    expect(a.peak()).toBeGreaterThan(40);
    expect(a.peak()).toBeLessThan(42); // the breakdown's knee plus 0.5 Ω × 50 mA
    expect(a.avalanche()?.message).toMatch(/kicked its collector to about 4\d V, into breakdown \(40 V\): put a flyback diode across the load/);
    expect(a.avalanche()?.parts).toEqual(['q1']);

    const guarded = circuit(UNO, [
      { id: 'rb', type: 'resistor', props: { ohms: 1000 } },
      { id: 'q1', type: 'npn-transistor', props: {} },
      { id: 'l1', type: 'test-coil', props: {} },
      { id: 'd1', type: 'diode', props: { model: '1N4007' } },
    ], [
      ['uno:13', 'rb:1'],
      ['rb:2', 'q1:B'],
      ['q1:E', 'uno:GND.1'],
      ['uno:5V', 'l1:1'],
      ['l1:2', 'q1:C'],
      ['d1:A', 'q1:C'],
      ['d1:C', 'uno:5V'],
    ]);
    const b = blinkBench(guarded, ['q1', 'C']);
    b.run(400, 520);
    expect(b.peak()).toBeGreaterThan(5.6);
    expect(b.peak()).toBeLessThan(5.75); // 5 V plus the diode's drop at ≈ 48 mA
    expect(b.avalanche()).toBeUndefined();
  }, 60_000);

  it('an IRLZ44N switching the coil off with no diode avalanches at its 55 V Vdss', () => {
    const doc = circuit(UNO, [{ id: 'q1', type: 'n-mosfet', props: {} }, { id: 'l1', type: 'test-coil', props: {} }], [
      ['uno:13', 'q1:G'],
      ['q1:S', 'uno:GND.1'],
      ['uno:5V', 'l1:1'],
      ['l1:2', 'q1:D'],
    ]);
    const a = blinkBench(doc, ['q1', 'D']);
    a.run(400, 520);
    expect(a.peak()).toBeGreaterThan(55);
    expect(a.peak()).toBeLessThan(56);
    expect(a.avalanche()?.message).toMatch(/kicked its drain to about 5\d V, into breakdown \(55 V\)/);
  }, 60_000);

  it('a MOSFET’s body diode conducts from source to drain: an N-MOSFET held off, its source on 5 V, its drain to GND through 1 kΩ', () => {
    const doc = circuit(UNO, [{ id: 'q1', type: 'n-mosfet', props: {} }, { id: 'r1', type: 'resistor', props: { ohms: 1000 } }], [
      ['q1:G', 'uno:5V'],
      ['q1:S', 'uno:5V'],
      ['q1:D', 'r1:1'],
      ['r1:2', 'uno:GND.1'],
    ]);
    const a = blinkBench(doc, ['q1', 'D']);
    a.run(1, 2);
    const i = (5 - 0.8) / (1000 + 0.05);
    expect(a.bench.pinState('q1', 'D')?.volts).toBeCloseTo(1000 * i, 4); // 5 V less the body diode's 0.8 V
  }, 60_000);

  it('a disabled L298N returns the coil’s current to its supply through its own diodes, then lets the outputs float', () => {
    // ENA on D1, IN1 on D2 (high), IN2 on D3 (low); enabled at 1 ms, disabled at 30 ms.
    const board = fakeBoard('fake-board', ['D1', 'D2', 'D3']);
    const mcu = new FakeMcu({
      pins: ['D1', 'D2', 'D3'],
      script: [
        { cycle: 16_000, pin: 'D2', mode: 'output', level: 1 },
        { cycle: 16_000, pin: 'D3', mode: 'output', level: 0 },
        { cycle: 16_000, pin: 'D1', mode: 'output', level: 1 },
        { cycle: 480_000, pin: 'D1', mode: 'output', level: 0 },
      ],
    });
    const env: BenchEnv = { part: (t) => (t === 'test-coil' ? coil : t === 'fake-board' ? board : benchEnvParts(t)), createMcu: () => mcu };
    const doc = circuit({ id: 'mcu', type: 'fake-board', x: 0, y: 0, rotation: 0, props: {} }, [
      { id: 'drv', type: 'l298n', props: { enaJumper: false } },
      { id: 'bat', type: 'battery-9v', props: {} },
      { id: 'l1', type: 'test-coil', props: {} },
    ], [
      ['mcu:D1', 'drv:ENA'],
      ['mcu:D2', 'drv:IN1'],
      ['mcu:D3', 'drv:IN2'],
      ['drv:OUT1', 'l1:1'],
      ['drv:OUT2', 'l1:2'],
      ['bat:+', 'drv:+12V'],
      ['bat:-', 'drv:GND'],
      ['drv:GND', 'mcu:GND'],
    ]);
    const parsed = parseProject(doc);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    const bench = new Bench(parsed.doc, env, { analogSpecFor: specFor });
    bench.reset();
    bench.runUntil(29 * NS_PER_MS);
    expect(bench.pinState('drv', 'OUT1')?.volts).toBeCloseTo(9 - 1.4, 6);
    bench.runUntil(30 * NS_PER_MS + 100 * NS_PER_US); // just after the disable: the diodes carry it
    const out1 = bench.pinState('drv', 'OUT1')?.volts ?? Number.NaN;
    const out2 = bench.pinState('drv', 'OUT2')?.volts ?? Number.NaN;
    expect(out1).toBeLessThan(-0.6); // GND → OUT1
    expect(out2).toBeGreaterThan(9.6); // OUT2 → +12V
    bench.runUntil(35 * NS_PER_MS); // ≈ 0.7 ms of fast decay, long gone
    const after1 = bench.pinState('drv', 'OUT1')?.volts ?? Number.NaN;
    const after2 = bench.pinState('drv', 'OUT2')?.volts ?? Number.NaN;
    expect(Math.abs(after1 - after2)).toBeLessThan(0.01); // no current: no drop across the coil
  }, 60_000);
});
