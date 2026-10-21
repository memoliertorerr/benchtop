import { avrMcuFactory } from '@benchtop/avr';
import { Bench, NS_PER_MS, parseProject, type VisualState } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { readFixtureText } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { benchEnvParts } from '../catalog.ts';

// The first real circuits: committed projects (fixtures/projects/) with committed firmware
// (fixtures/firmware/uno/) on a full Bench — netlist, resolver, part models and the Uno.

function load(project: string, firmware: string) {
  const parsed = parseProject(JSON.parse(readFixtureText(`fixtures/projects/${project}.json`)));
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const bench = new Bench(parsed.doc, { part: benchEnvParts, createMcu: avrMcuFactory });
  bench.attachFirmware('uno', { format: 'hex', text: readFixtureText(`fixtures/firmware/uno/${firmware}.hex`) });
  const serial: number[] = [];
  bench.onSerial('uno', (bytes) => serial.push(...bytes));
  const lines = () => String.fromCharCode(...serial).split('\r\n').slice(0, -1);
  return { bench, lines };
}

/** Runs to `endMs` in `stepMs` steps, recording every visual a part reported, with its time. */
function frames(bench: Bench, endMs: number, stepMs: number) {
  const seen: { t: number; part: string; visual: VisualState }[] = [];
  for (let t = bench.now() / NS_PER_MS + stepMs; t <= endMs + 1e-9; t += stepMs) {
    bench.runUntil(t * NS_PER_MS);
    for (const [part, visual] of bench.collectFrame().parts) seen.push({ t, part, visual });
  }
  return seen;
}

describe('Uno circuits on the bench', () => {
  it('blink: the LED behind 220 Ω on a breadboard is 1 when on, 0 when off, flipping every 500 ± 1 ms', () => {
    const { bench, lines } = load('blink-led', 'blink');
    expect(bench.problems()).toEqual([]);
    const led = frames(bench, 2100, 1).filter((f) => f.part === 'led1');
    const values = led.map((f) => f.visual.brightness);
    expect(values).toEqual([1, 0, 1, 0, 1]);
    const times = led.map((f) => f.t);
    for (let i = 1; i < times.length; i++) expect(Math.abs(times[i] - times[i - 1] - 500)).toBeLessThanOrEqual(1);
    expect(lines()).toEqual(['hello']);
    // The board's own L LED follows D13 too.
    expect(bench.collectFrame().parts).toEqual([]);
    bench.input('uno', { kind: 'key', key: 'serial-tx', down: true });
    expect(bench.collectFrame().parts).toEqual([['uno', { ledL: 1, ledPower: true, ledTx: true, ledRx: false }]]);
    bench.runUntil(bench.now() + 40 * NS_PER_MS);
    expect(bench.collectFrame().parts).toEqual([['uno', { ledL: 1, ledPower: true, ledTx: false, ledRx: false }]]);
  });

  it('button-pullup: pressing D2 to GND at 100 ms lights D13 within 1 ms', () => {
    const { bench } = load('button-pullup', 'button-pullup');
    expect(bench.problems()).toEqual([]);
    bench.runUntil(100 * NS_PER_MS);
    bench.collectFrame();
    expect(bench.pinState('led1', 'A')?.level).toBe(0);
    bench.input('btn1', { kind: 'press' });
    bench.runUntil(101 * NS_PER_MS);
    const pressed = Object.fromEntries(bench.collectFrame().parts);
    expect(pressed.led1).toEqual({ brightness: 1 });
    expect(pressed.btn1).toEqual({ pressed: true });
    expect(pressed.uno?.ledL).toBe(1);
    bench.input('btn1', { kind: 'release' });
    bench.runUntil(102 * NS_PER_MS);
    expect(Object.fromEntries(bench.collectFrame().parts).led1).toEqual({ brightness: 0 });
  });

  it('pwm-fade: the LED on D9 rises monotonically over the first 1.2 s', () => {
    const { bench } = load('pwm-fade', 'pwm-fade');
    let brightness = 0;
    const samples: number[] = [];
    for (let t = 10; t <= 1200; t += 10) {
      bench.runUntil(t * NS_PER_MS);
      for (const [part, visual] of bench.collectFrame().parts) if (part === 'led1') brightness = visual.brightness as number;
      samples.push(brightness);
    }
    for (let i = 1; i < samples.length; i++) expect(samples[i]).toBeGreaterThanOrEqual(samples[i - 1]);
    expect(samples[10]).toBeGreaterThan(0);
    expect(samples[10]).toBeLessThan(0.1);
    // analogWrite steps by 1 every ≥ 10 ms, so after 1.2 s the duty is just under 120/255.
    expect(samples.at(-1)).toBeGreaterThan(0.35);
    expect(samples.at(-1)).toBeLessThan(120 / 255);
    expect(new Set(samples).size).toBeGreaterThan(50);
  });

  it('analog-read: a potentiometer at 0.25 on A0 prints 255 ± 2', () => {
    const { bench, lines } = load('analog-pot', 'analog-read');
    expect(bench.problems()).toEqual([]);
    bench.input('pot1', { kind: 'value', value: 0.25 });
    bench.runUntil(350 * NS_PER_MS);
    const last = Number(lines().at(-1));
    expect(Math.abs(last - 255)).toBeLessThanOrEqual(2);
    bench.input('pot1', { kind: 'value', value: 1 });
    bench.runUntil(500 * NS_PER_MS);
    expect(lines().at(-1)).toBe('1023');
  });

  it('D13 wired to GND reports a drive fight naming the Uno while blink drives it high', () => {
    const { bench } = load('short-d13', 'blink');
    bench.runUntil(250 * NS_PER_MS);
    const shorts = bench.problems().filter((p) => p.code === 'drive-fight');
    expect(shorts).toHaveLength(1);
    expect(shorts[0].parts).toEqual(['uno']);
    expect(shorts[0].severity).toBe('error');
    bench.runUntil(750 * NS_PER_MS); // D13 low: both sides agree, no fight
    expect(bench.problems().filter((p) => p.code === 'drive-fight')).toEqual([]);
  });
});
