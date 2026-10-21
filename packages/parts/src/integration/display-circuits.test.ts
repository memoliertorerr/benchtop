import { avrMcuFactory } from '@benchtop/avr';
import { Bench, NS_PER_MS, parseProject, type ProjectDoc, type VisualState } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { readFixtureText } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { benchEnvParts } from '../catalog.ts';

// Display parts on a full Bench with real firmware: committed projects (fixtures/projects/) and
// committed builds (fixtures/firmware/uno/).

function project(name: string): ProjectDoc {
  return JSON.parse(readFixtureText(`fixtures/projects/${name}.json`)) as ProjectDoc;
}

function load(doc: ProjectDoc, firmware: string) {
  const parsed = parseProject(doc);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const bench = new Bench(parsed.doc, { part: benchEnvParts, createMcu: avrMcuFactory });
  bench.attachFirmware('uno', { format: 'hex', text: readFixtureText(`fixtures/firmware/uno/${firmware}.hex`) });
  const serial: number[] = [];
  bench.onSerial('uno', (bytes) => serial.push(...bytes));
  const latest = new Map<string, VisualState>();
  /** Runs to `ms` in 1 ms steps, keeping a copy of each part's latest visual state. */
  const runTo = (ms: number): void => {
    for (let t = Math.floor(bench.now() / NS_PER_MS) + 1; t <= ms; t++) {
      bench.runUntil(t * NS_PER_MS);
      for (const [part, visual] of bench.collectFrame().parts) latest.set(part, structuredClone(visual));
    }
  };
  const lines = () => String.fromCharCode(...serial).split('\r\n').slice(0, -1);
  return { bench, latest, runTo, lines };
}

function rows(visual: VisualState | undefined, cols: number): string[] {
  const chars = (visual?.characters ?? []) as number[];
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += cols) out.push(String.fromCharCode(...chars.slice(i, i + cols)));
  return out;
}

describe('LCDs', () => {
  it('lcd-4bit: "Hello, Benchtop!" and t=1 at 1.2 s through LiquidCrystal in 4-bit mode', () => {
    const { bench, latest, runTo } = load(project('lcd-4bit'), 'lcd-4bit');
    // 4-bit wiring leaves D0–D3 (and the unmodelled V0) unconnected: infos, not faults.
    expect(bench.problems().filter((p) => p.severity !== 'info')).toEqual([]);
    runTo(1200);
    const lcd = latest.get('lcd1');
    expect(rows(lcd, 16)).toEqual(['Hello, Benchtop!', 't=1             ']);
    expect(lcd).toMatchObject({ displayOn: true, cursor: false, blink: false, backlight: true });
  });

  it('lcd-4bit: simulated MHz over 2 s of simulated time', () => {
    const { bench } = load(project('lcd-4bit'), 'lcd-4bit');
    const start = performance.now();
    bench.runUntil(2000 * NS_PER_MS);
    const wallMs = performance.now() - start;
    const mhz = (2 * 16e6) / (wallMs * 1000);
    console.info(`lcd-4bit: 2 s simulated in ${wallMs.toFixed(0)} ms wall = ${mhz.toFixed(1)} simulated MHz`);
    expect(mhz).toBeGreaterThan(1);
  });

  it('lcd-8bit-2004: four exact rows and a blinking cursor at (5, 3)', () => {
    const { bench, latest, runTo } = load(project('lcd-8bit-2004'), 'lcd-8bit-2004');
    expect(bench.problems().filter((p) => p.severity !== 'info')).toEqual([]);
    runTo(300);
    const lcd = latest.get('lcd1');
    expect(rows(lcd, 20)).toEqual(['Benchtop 20x4 8-bit!', 'Row 1 ABCDEFGHIJKLMN', 'Row 2 0123456789+-*/', 'Row 3 abcdefghijklmn']);
    expect(lcd).toMatchObject({ cursor: true, blink: true, cursorX: 5, cursorY: 3, displayOn: true });
  });

  it('lcd-i2c: the same text through a PCF8574 at 0x27, backlight off at 1.5 s, nack=2 for 0x3F', () => {
    const { bench, latest, runTo, lines } = load(project('lcd-i2c'), 'lcd-i2c');
    expect(bench.problems()).toEqual([]);
    runTo(1200);
    expect(rows(latest.get('lcd1'), 16)).toEqual(['Hello, Benchtop!', 't=1             ']);
    expect(latest.get('lcd1')?.backlight).toBe(true);
    expect(lines()).toEqual(['nack=2']);
    runTo(1490);
    expect(latest.get('lcd1')?.backlight).toBe(true);
    runTo(1520);
    expect(latest.get('lcd1')?.backlight).toBe(false);
    expect(rows(latest.get('lcd1'), 16)[0]).toBe('Hello, Benchtop!');
  });

  it('refuses a backpack address outside 0x20–0x27 and 0x38–0x3F', () => {
    const doc = project('lcd-i2c');
    doc.parts = doc.parts.map((p) => (p.id === 'lcd1' ? { ...p, props: { ...p.props, address: '0x50' } } : p));
    const { bench } = load(doc, 'lcd-i2c');
    expect(bench.problems()).toEqual([expect.objectContaining({ code: 'part-model-error', parts: ['lcd1'], message: expect.stringContaining('0x20–0x27') })]);
  });
});

describe('I2C bus', () => {
  /** An Uno with I2C LCD backpacks on A4/A5 at the given addresses. */
  function busDoc(addresses: string[]): ProjectDoc {
    return {
      format: 1,
      name: 'two backpacks',
      parts: [
        { id: 'uno', type: 'arduino-uno', x: 0, y: 0, rotation: 0, props: {} },
        ...addresses.map((address, i) => ({ id: `lcd${i + 1}`, type: 'lcd1602-i2c', x: 100, y: i * 50, rotation: 0 as const, props: { address } })),
      ],
      wires: addresses.flatMap((_, i) => [
        { id: `sda${i}`, from: { part: 'uno', pin: 'A4' }, to: { part: `lcd${i + 1}`, pin: 'SDA' }, waypoints: [], color: 'blue' },
        { id: `scl${i}`, from: { part: 'uno', pin: 'A5' }, to: { part: `lcd${i + 1}`, pin: 'SCL' }, waypoints: [], color: 'yellow' },
        { id: `vcc${i}`, from: { part: 'uno', pin: '5V' }, to: { part: `lcd${i + 1}`, pin: 'VCC' }, waypoints: [], color: 'red' },
        { id: `gnd${i}`, from: { part: 'uno', pin: 'GND.2' }, to: { part: `lcd${i + 1}`, pin: 'GND' }, waypoints: [], color: 'black' },
      ]),
      firmware: {},
    };
  }

  it('two devices at different addresses on one bus both answer a scan', () => {
    const { bench, runTo, lines } = load(busDoc(['0x27', '0x3F']), 'i2c-scan');
    expect(bench.problems()).toEqual([]);
    runTo(200);
    expect(lines()).toEqual(['0x27', '0x3F', 'done']);
  });

  it('two devices at one address: an i2c-address-conflict naming both, and the first answers', () => {
    const { bench, runTo, lines } = load(busDoc(['0x27', '39']), 'i2c-scan');
    expect(bench.problems()).toEqual([expect.objectContaining({ code: 'i2c-address-conflict', severity: 'error', parts: ['lcd1', 'lcd2'] })]);
    runTo(200);
    expect(lines()).toEqual(['0x27', 'done']);
  });
});

describe('7-segment and bar graph', () => {
  it('seven-seg-mux: 1234, each lit segment at 0.25 ± 0.05, unlit segments < 0.01', () => {
    const { bench, latest, runTo } = load(project('seven-seg-mux'), 'seven-seg-mux');
    expect(bench.problems()).toEqual([]);
    runTo(600);
    const values = latest.get('disp')?.values as number[];
    expect(values).toHaveLength(32);
    // Segments A..G, DP per digit for 1, 2, 3, 4.
    const expected = ['0110000', '1101101', '1111001', '0110011'];
    for (let d = 0; d < 4; d++) {
      for (let s = 0; s < 8; s++) {
        const value = values[d * 8 + s];
        const lit = s < 7 && expected[d][s] === '1';
        if (lit) expect(Math.abs(value - 0.25), `digit ${d + 1} segment ${'ABCDEFGP'[s]}: ${value}`).toBeLessThanOrEqual(0.05);
        else expect(value, `digit ${d + 1} segment ${'ABCDEFGP'[s]}`).toBeLessThan(0.01);
      }
    }
  });

  it('bargraph: bars 1–6 lit, 7–10 dark', () => {
    const { bench, latest, runTo } = load(project('bargraph'), 'bargraph');
    expect(bench.problems()).toEqual([]);
    runTo(200);
    const values = latest.get('bar')?.values as number[];
    expect(values.slice(0, 6).every((v) => v >= 0.99)).toBe(true);
    expect(values.slice(6)).toEqual([0, 0, 0, 0]);
  });
});
