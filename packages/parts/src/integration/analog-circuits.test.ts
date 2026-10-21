import { avrMcuFactory } from '@benchtop/avr';
import { Bench, type BenchOptions, NS_PER_MS, parseProject, type PartInstance, type ProjectDoc, type Wire } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { readFixtureText } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { analogSpecFor } from '../analog-specs.ts';
import { benchEnvParts } from '../catalog.ts';

// The analog layer (BT21) on full benches with real firmware.

const project = (name: string): ProjectDoc => JSON.parse(readFixtureText(`fixtures/projects/${name}.json`)) as ProjectDoc;

/** An Uno plus parts placed far apart (no contacts), wired as given ("part:pin" pairs). */
function circuit(parts: Omit<PartInstance, 'x' | 'y' | 'rotation'>[], wires: [string, string][]): ProjectDoc {
  return {
    format: 1,
    name: 'analog test',
    parts: [
      { id: 'uno', type: 'arduino-uno', x: 0, y: 0, rotation: 0, props: {} },
      ...parts.map((p, i) => ({ ...p, x: 100 + i * 40, y: 0, rotation: 0 as const })),
    ],
    wires: wires.map(([from, to], i): Wire => {
      const [fp, fn] = from.split(':');
      const [tp, tn] = to.split(':');
      return { id: `w${i}`, from: { part: fp, pin: fn }, to: { part: tp, pin: tn }, waypoints: [], color: 'green' };
    }),
    firmware: {},
  };
}

function load(doc: ProjectDoc, firmware: string, options: BenchOptions = { analogSpecFor }) {
  const parsed = parseProject(doc);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const bench = new Bench(parsed.doc, { part: benchEnvParts, createMcu: avrMcuFactory }, options);
  bench.attachFirmware('uno', { format: 'hex', text: readFixtureText(`fixtures/firmware/uno/${firmware}.hex`) });
  const lines: string[] = [];
  let text = '';
  bench.onSerial('uno', (bytes) => {
    text += String.fromCharCode(...bytes);
    let end: number;
    while ((end = text.indexOf('\r\n')) >= 0) {
      lines.push(text.slice(0, end));
      text = text.slice(end + 2);
    }
  });
  const visuals = new Map<string, Record<string, unknown>>();
  const runTo = (ms: number): void => {
    for (let t = Math.floor(bench.now() / NS_PER_MS) + 1; t <= ms; t++) {
      bench.runUntil(t * NS_PER_MS);
      for (const [part, visual] of bench.collectFrame().parts) visuals.set(part, structuredClone(visual));
    }
  };
  return { bench, lines, visuals, runTo };
}

describe('resistive islands', () => {
  it('a 10 k / 10 k divider into A0 reads 512', () => {
    const doc = circuit(
      [
        { id: 'r1', type: 'resistor', props: { ohms: 10_000 } },
        { id: 'r2', type: 'resistor', props: { ohms: 10_000 } },
      ],
      [
        ['uno:5V', 'r1:1'],
        ['r1:2', 'uno:A0'],
        ['uno:A0', 'r2:1'],
        ['r2:2', 'uno:GND.2'],
      ],
    );
    const { bench, lines, runTo } = load(doc, 'analog-read');
    runTo(150);
    expect(lines[0]).toBe('512');
    expect(bench.pinState('uno', 'A0')?.volts).toBeCloseTo(2.5, 6);
    expect(bench.problems()).toEqual([]);
  });

  it('a 10 k pot at 0.5 with a 10 kΩ load reads 2.000 V on its wiper (409), not 2.5 V', () => {
    const doc = circuit(
      [
        { id: 'pot', type: 'potentiometer', props: { value: 0.5 } },
        { id: 'load', type: 'resistor', props: { ohms: 10_000 } },
      ],
      [
        ['uno:5V', 'pot:VCC'],
        ['pot:GND', 'uno:GND.2'],
        ['pot:SIG', 'uno:A0'],
        ['pot:SIG', 'load:1'],
        ['load:2', 'uno:GND.3'],
      ],
    );
    const { bench, lines, runTo } = load(doc, 'analog-read');
    runTo(150);
    expect(Math.abs((bench.pinState('pot', 'SIG')?.volts ?? 0) - 2)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(Number(lines[0]) - 409)).toBeLessThanOrEqual(1);
  });

  it('INPUT_PULLUP on A0 (35 kΩ) with 10 kΩ to GND sits at 1.111 V (227)', () => {
    const doc = circuit([{ id: 'r1', type: 'resistor', props: { ohms: 10_000 } }], [
      ['uno:A0', 'r1:1'],
      ['r1:2', 'uno:GND.2'],
    ]);
    const { bench, lines, runTo } = load(doc, 'analog-pullup');
    runTo(150);
    expect(Math.abs((bench.pinState('uno', 'A0')?.volts ?? 0) - 1.111)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(Number(lines[0]) - 227)).toBeLessThanOrEqual(1);
  });

  it('an island of more than 256 nets reports analog-island-too-large and keeps switch-level values', () => {
    const resistors = Array.from({ length: 260 }, (_, i) => ({ id: `r${i}`, type: 'resistor', props: { ohms: 1000 } }));
    const wires: [string, string][] = [['uno:5V', 'r0:1']];
    for (let i = 0; i < 259; i++) wires.push([`r${i}:2`, `r${i + 1}:1`]);
    const { bench } = load(circuit(resistors, wires), 'blink');
    expect(bench.problems()).toEqual([expect.objectContaining({ code: 'analog-island-too-large', severity: 'warning' })]);
    expect(bench.pinState('r30', '2')).toMatchObject({ level: 1, volts: 5 });
  });
});

describe('a pin driving 100 LED branches (fixtures/projects/perf-100-leds.json)', () => {
  it('solves the 101-net network: D13 sags under the load and every LED carries the same current', () => {
    const { bench, visuals, runTo } = load(project('perf-100-leds'), 'blink');
    runTo(250); // blink: D13 high
    // D13 is a 5 V source behind 25 Ω; each branch is 220 Ω + a red LED (1.8 V, 10 Ω):
    // 100·(V − 1.8)/230 = (5 − V)/25.
    const v = (5 / 25 + (100 * 1.8) / 230) / (1 / 25 + 100 / 230);
    expect(bench.pinState('uno', '13')?.volts).toBeCloseTo(v, 6);
    const ma = ((v - 1.8) / 230) * 1000;
    const leds = [...visuals].filter(([id]) => id.startsWith('led'));
    expect(leds).toHaveLength(100);
    for (const [, visual] of leds) expect(Math.abs((visual.milliamps as number) - ma)).toBeLessThanOrEqual(0.01);
    // A real (dim) current per LED, so no LED overcurrent and no unsolved network — but D13 itself
    // carries all 100 branches, (5 − V)/25 Ω ≈ 117 mA, far past its 40 mA (BT47).
    expect(bench.problems()).toEqual([
      expect.objectContaining({ code: 'pin-overcurrent', severity: 'error', parts: expect.arrayContaining(['uno']), message: expect.stringContaining(`uno:13 carries about ${Math.round(((5 - v) / 25) * 1000)} mA`) }),
    ]);
    runTo(750); // D13 low
    for (const [id, visual] of visuals) if (id.startsWith('led')) expect(visual.milliamps).toBe(0);
  });

  it("doesn't report an LED overcurrent from a network it left at switch level", () => {
    // 257 + 1 nets: 5 V into a chain of 258 resistors, the chain's end through an LED to GND.
    const resistors = Array.from({ length: 258 }, (_, i) => ({ id: `r${i}`, type: 'resistor', props: { ohms: 10 } }));
    const wires: [string, string][] = [['uno:5V', 'r0:1']];
    for (let i = 0; i < 257; i++) wires.push([`r${i}:2`, `r${i + 1}:1`]);
    wires.push(['r257:2', 'led1:A'], ['led1:C', 'uno:GND.2']);
    const { bench, runTo } = load(circuit([...resistors, { id: 'led1', type: 'led', props: { color: 'red' } }], wires), 'blink');
    runTo(5);
    expect(bench.problems().map((p) => p.code)).toEqual(['analog-island-too-large']);
  });
});

describe('LEDs with real currents', () => {
  it('an LED sinking into a pin that is still an input settles dark — no analog-no-convergence — and lights when it drives low', () => {
    // 5V → 220 Ω → LED → D13: before setup() runs, D13 is a hi-Z input, so the cathode floats.
    const doc = circuit(
      [
        { id: 'r1', type: 'resistor', props: { ohms: 220 } },
        { id: 'led1', type: 'led', props: { color: 'red' } },
      ],
      [
        ['uno:5V', 'r1:1'],
        ['r1:2', 'led1:A'],
        ['led1:C', 'uno:13'],
      ],
    );
    const { bench, visuals, runTo } = load(doc, 'blink');
    expect(bench.problems()).toEqual([]);
    runTo(250); // blink: D13 high — no current
    expect(visuals.get('led1')?.milliamps ?? 0).toBe(0);
    runTo(750); // D13 low: (5 − 1.8) / (220 + 10 + 25) ≈ 12.5 mA
    expect(Math.abs((visuals.get('led1')?.milliamps as number) - 12.5)).toBeLessThanOrEqual(0.3);
    expect(bench.problems()).toEqual([]);
  });

  it('two LEDs in series both light with the current their two drops leave', () => {
    const doc = circuit(
      [
        { id: 'r1', type: 'resistor', props: { ohms: 220 } },
        { id: 'led1', type: 'led', props: { color: 'red' } },
        { id: 'led2', type: 'led', props: { color: 'red' } },
      ],
      [
        ['uno:5V', 'r1:1'],
        ['r1:2', 'led1:A'],
        ['led1:C', 'led2:A'],
        ['led2:C', 'uno:GND.1'],
      ],
    );
    const { bench, visuals, runTo } = load(doc, 'blink');
    runTo(10);
    const ma = ((5 - 1.8 - 1.8) / (220 + 10 + 10)) * 1000; // ≈ 5.8 mA
    for (const id of ['led1', 'led2']) expect(Math.abs((visuals.get(id)?.milliamps as number) - ma), id).toBeLessThanOrEqual(0.05);
    expect(bench.problems()).toEqual([]);
  });

  const ledCircuit = (color: string, reversed = false) =>
    circuit(
      [
        { id: 'r1', type: 'resistor', props: { ohms: 220 } },
        { id: 'led1', type: 'led', props: { color } },
      ],
      [
        ['uno:13', 'r1:1'],
        ['r1:2', reversed ? 'led1:C' : 'led1:A'],
        [reversed ? 'led1:A' : 'led1:C', 'uno:GND.1'],
      ],
    );

  it('D13 → 220 Ω → red LED → GND: 12.5 mA, brightness 0.91, no problem', () => {
    const { bench, visuals, runTo } = load(ledCircuit('red'), 'blink');
    runTo(300);
    const led = visuals.get('led1');
    expect(Math.abs((led?.milliamps as number) - 12.5)).toBeLessThanOrEqual(0.3);
    expect(Math.abs((led?.brightness as number) - 0.91)).toBeLessThanOrEqual(0.02);
    expect(bench.problems()).toEqual([]);
  });

  it('the fixture blink circuit (breadboard, 220 Ω) lights the same', () => {
    const { bench, visuals, runTo } = load(project('blink-led'), 'blink');
    runTo(300);
    expect(Math.abs((visuals.get('led1')?.milliamps as number) - 12.5)).toBeLessThanOrEqual(0.3);
    expect(bench.problems()).toEqual([]);
  });

  it('a red LED straight from D13 to GND draws ~91 mA: led-overcurrent, and pin-overcurrent on D13', () => {
    const doc = circuit([{ id: 'led1', type: 'led', props: { color: 'red' } }], [
      ['uno:13', 'led1:A'],
      ['led1:C', 'uno:GND.1'],
    ]);
    const { bench, visuals, runTo } = load(doc, 'blink');
    runTo(300);
    expect(Math.abs((visuals.get('led1')?.milliamps as number) - 91)).toBeLessThanOrEqual(3);
    expect(bench.problems()).toEqual([
      expect.objectContaining({ code: 'pin-overcurrent', severity: 'error', parts: ['led1', 'uno'], message: expect.stringMatching(/uno:13 carries about (8[89]|9[0-4]) mA/) }),
      expect.objectContaining({ code: 'led-overcurrent', severity: 'error', parts: ['led1'], message: expect.stringContaining('~91 mA') }),
    ]);
    runTo(700); // D13 low from 500 ms: the LED's problem clears; the pin's is held for 1 s, so a
    // blinking pin stays reported (packages/core/src/check/dynamic.test.ts checks that it clears)
    expect(bench.problems().map((p) => p.code)).toEqual(['pin-overcurrent']);
  });

  it('a reversed LED carries 0 mA; a blue one with 220 Ω carries 8.6 mA', () => {
    const reversed = load(ledCircuit('red', true), 'blink');
    reversed.runTo(300);
    expect(reversed.visuals.get('led1')?.milliamps ?? 0).toBe(0);
    const blue = load(ledCircuit('blue'), 'blink');
    blue.runTo(300);
    expect(Math.abs((blue.visuals.get('led1')?.milliamps as number) - 8.6)).toBeLessThanOrEqual(0.3);
  });
});

describe('digital nets are unchanged', () => {
  /** Every (time, net, level) change on nets an MCU sees or outside analog islands, over 1 s. */
  function trace(doc: ProjectDoc, firmware: string, analog: boolean, inputs: (bench: Bench, ms: number) => void, keep: (net: number) => boolean) {
    const { bench } = load(doc, firmware, { analogSpecFor, analog });
    const events: string[] = [];
    const last = new Map<number, number | null>();
    bench.netWatcher = (net, state) => {
      if (!keep(net) || last.get(net) === state.level) return;
      last.set(net, state.level);
      events.push(`${bench.now()} ${net} ${state.level}`);
    };
    for (let ms = 1; ms <= 1000; ms++) {
      inputs(bench, ms);
      bench.runUntil(ms * NS_PER_MS);
    }
    return { events, bench };
  }

  for (const [name, firmware] of [
    ['blink-led', 'blink'],
    ['button-pullup', 'button-pullup'],
    ['lcd-4bit', 'lcd-4bit'],
  ] as const) {
    it(`${name}: identical (time, net, level) sequences with analog on and off`, () => {
      const doc = project(name);
      const press = (bench: Bench, ms: number): void => {
        if (name !== 'button-pullup') return;
        if (ms === 300) bench.input('btn1', { kind: 'press' });
        if (ms === 600) bench.input('btn1', { kind: 'release' });
      };
      const probe = load(doc, firmware).bench;
      const keep = (net: number): boolean => !probe.isAnalogNet(net) || probe.netHasMcuPin(net);
      const on = trace(doc, firmware, true, press, keep);
      const off = trace(doc, firmware, false, press, keep);
      expect(on.events.length).toBeGreaterThan(name === 'lcd-4bit' ? 100 : 2);
      expect(on.events).toEqual(off.events);
    });
  }

  it('Blink: simulated MHz with the analog layer on and off', () => {
    const mhz = (analog: boolean): number => {
      const { bench } = load(project('blink-led'), 'blink', { analogSpecFor, analog });
      const start = performance.now();
      bench.runUntil(2000 * NS_PER_MS);
      return (2 * 16e6) / ((performance.now() - start) * 1000);
    };
    mhz(true); // warm up
    const on = mhz(true);
    const off = mhz(false);
    console.info(`blink: ${on.toFixed(1)} simulated MHz with analog on, ${off.toFixed(1)} off (${(((on - off) / off) * 100).toFixed(1)} %)`);
    expect(on).toBeGreaterThan(0);
  }, 30_000); // 6 s of simulated time: ~6 s of wall time alone, more under load
});
