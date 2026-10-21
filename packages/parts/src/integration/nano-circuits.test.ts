import { avrMcuFactory } from '@benchtop/avr';
import { Bench, NS_PER_MS, parseProject } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { readFixtureText } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { benchEnvParts } from '../catalog.ts';

// BT45: the Arduino Nano — the Uno's ATmega328P on the Nano pinout, built with arduino:avr:nano
// (fixtures/firmware/nano/). A6/A7 are ADC6/ADC7: analog inputs with no digital function.

function load(project: string, firmware: string) {
  const parsed = parseProject(JSON.parse(readFixtureText(`fixtures/projects/${project}.json`)));
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const bench = new Bench(parsed.doc, { part: benchEnvParts, createMcu: avrMcuFactory });
  bench.attachFirmware('nano', { format: 'hex', text: readFixtureText(`fixtures/firmware/nano/${firmware}.hex`) });
  const serial: number[] = [];
  bench.onSerial('nano', (bytes) => serial.push(...bytes));
  const lines = () => String.fromCharCode(...serial).split('\r\n').slice(0, -1);
  return { bench, lines };
}

describe('Arduino Nano on the bench (BT45)', () => {
  it('blink: D13 toggles every 1,000 ms ±1 %, starting high, and the L LED follows; serial says "nano"', () => {
    const { bench, lines } = load('nano-blink', 'blink');
    expect(bench.problems()).toEqual([]);
    const probe = bench.addProbe({ part: 'nano', pin: '13' });
    const ledL = () => Object.fromEntries(bench.collectFrame().parts).nano?.ledL as number | undefined;
    bench.runUntil(500 * NS_PER_MS);
    expect(ledL()).toBeGreaterThan(0.5);
    bench.runUntil(1500 * NS_PER_MS);
    expect(ledL()).toBeLessThan(0.5);
    bench.runUntil(2100 * NS_PER_MS);
    const { times, levels } = bench.readProbe(probe, 0) ?? { times: new Float64Array(), levels: new Uint8Array() };
    const edges: { t: number; level: number }[] = [];
    for (let i = 0; i < times.length; i++) {
      if (levels[i] > 1) continue;
      if (edges.length === 0 || edges[edges.length - 1].level !== levels[i]) edges.push({ t: times[i] / NS_PER_MS, level: levels[i] });
    }
    // Low at reset, then high (setup's end) and a flip every second.
    expect(edges.map((e) => e.level)).toEqual([0, 1, 0, 1]);
    for (let i = 2; i < edges.length; i++) expect(Math.abs(edges[i].t - edges[i - 1].t - 1000)).toBeLessThanOrEqual(10);
    expect(lines()).toEqual(['nano']);
  });

  it('analog-a6: potentiometers at 0.25 and 0.75 on A6/A7 read 256 and 768 (±2), and follow the knobs', () => {
    const { bench, lines } = load('nano-analog', 'analog-a6');
    expect(bench.problems().filter((p) => p.severity !== 'info')).toEqual([]);
    bench.runUntil(350 * NS_PER_MS);
    const read = (): [number, number] => {
      const last = lines().at(-1) ?? '';
      const [a6, a7] = last.split(' ').map(Number);
      return [a6, a7];
    };
    const [a6, a7] = read();
    expect(Math.abs(a6 - 256)).toBeLessThanOrEqual(2);
    expect(Math.abs(a7 - 768)).toBeLessThanOrEqual(2);
    bench.input('pot1', { kind: 'value', value: 1 });
    bench.input('pot2', { kind: 'value', value: 0 });
    bench.runUntil(600 * NS_PER_MS);
    const [hi, lo] = read();
    expect(hi).toBeGreaterThanOrEqual(1021);
    expect(lo).toBeLessThanOrEqual(2);
  });

  it('A6/A7 never drive their nets: the board reports them as analog inputs', () => {
    const { bench } = load('nano-analog', 'analog-a6');
    bench.runUntil(50 * NS_PER_MS);
    // A6 sits on pot1's wiper: 1.25 V, set by the pot alone (a driven pin would pull it to 0 or 5 V).
    const a6 = bench.pinState('nano', 'A6');
    expect(a6?.volts).toBeCloseTo(1.25, 1);
    expect(bench.pinState('nano', 'A7')?.volts).toBeCloseTo(3.75, 1);
  });
});
