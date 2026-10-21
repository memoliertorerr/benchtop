import { avrMcuFactory } from '@benchtop/avr';
import { Bench, NS_PER_MS, parseProject, type ProjectDoc, type VisualState } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { readFixtureText } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { benchEnvParts } from '../catalog.ts';
import { channelInput } from '../shared/channel-input.ts';

// Timed-protocol and register sensors on a full Bench with real firmware. Each test reports its
// wall time and simulated MHz.

const project = (name: string): ProjectDoc => JSON.parse(readFixtureText(`fixtures/projects/${name}.json`)) as ProjectDoc;

function withProps(doc: ProjectDoc, id: string, props: Record<string, number | string>): ProjectDoc {
  return { ...doc, parts: doc.parts.map((p) => (p.id === id ? { ...p, props: { ...p.props, ...props } } : p)) };
}

function load(doc: ProjectDoc, firmware: string) {
  const parsed = parseProject(doc);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const bench = new Bench(parsed.doc, { part: benchEnvParts, createMcu: avrMcuFactory });
  bench.attachFirmware('uno', { format: 'hex', text: readFixtureText(`fixtures/firmware/uno/${firmware}.hex`) });
  let text = '';
  const lines: string[] = [];
  bench.onSerial('uno', (bytes) => {
    text += String.fromCharCode(...bytes);
    let end: number;
    while ((end = text.indexOf('\r\n')) >= 0) {
      lines.push(text.slice(0, end));
      text = text.slice(end + 2);
    }
  });
  const latest = new Map<string, VisualState>();
  let wall = 0;
  const runTo = (ms: number): void => {
    const start = performance.now();
    for (let t = Math.floor(bench.now() / NS_PER_MS) + 1; t <= ms; t++) {
      bench.runUntil(t * NS_PER_MS);
      for (const [part, visual] of bench.collectFrame().parts) latest.set(part, structuredClone(visual));
    }
    wall += performance.now() - start;
  };
  const report = (name: string): void => {
    const simMs = bench.now() / NS_PER_MS;
    console.info(`${name}: ${simMs.toFixed(0)} ms simulated in ${wall.toFixed(0)} ms wall = ${((simMs * 16e3) / (wall * 1e3)).toFixed(1)} simulated MHz`);
  };
  return { bench, lines, latest, runTo, report };
}

describe('DHT22', () => {
  it('dht22-adafruit: T=23.40 H=45.60, then the negative path after a live change', () => {
    const { bench, lines, latest, runTo, report } = load(project('dht22'), 'dht22-adafruit');
    expect(bench.problems()).toEqual([]);
    runTo(2500);
    expect(lines).toEqual(['T=23.40 H=45.60']);
    expect(Math.abs((latest.get('dht')?.startUs as number) - 1100)).toBeLessThanOrEqual(50);
    bench.input('dht', channelInput('temperature', -12.3));
    bench.input('dht', channelInput('humidity', 80));
    runTo(4500);
    expect(lines).toEqual(['T=23.40 H=45.60', 'T=-12.30 H=80.00']);
    report('dht22-adafruit');
  }, 30_000); // 4.5 s of simulated time: ~4 s of wall time alone, more under load

  it('dht22-dhtlib: the same values with a 1 ms wake-up', () => {
    const { lines, latest, runTo, report } = load(project('dht22'), 'dht22-dhtlib');
    runTo(2500);
    expect(lines).toEqual(['T=23.40 H=45.60']);
    expect(latest.get('dht')?.startUs as number).toBeGreaterThanOrEqual(950);
    report('dht22-dhtlib');
  });
});

describe('HC-SR04', () => {
  it('hcsr04: 100 cm, 2 cm, 400 cm, and a timeout beyond range', () => {
    const { bench, lines, runTo, report } = load(project('hcsr04'), 'hcsr04');
    expect(bench.problems()).toEqual([]);
    const distance = (): number => Number(lines.at(-1)?.slice(2));
    runTo(250);
    expect(lines.at(-1)).toMatch(/^D=\d+\.\d$/);
    expect(Math.abs(distance() - 100)).toBeLessThanOrEqual(1);
    bench.input('sonar', channelInput('distance', 2));
    runTo(500);
    expect(Math.abs(distance() - 2)).toBeLessThanOrEqual(1);
    bench.input('sonar', channelInput('distance', 400));
    runTo(800);
    expect(Math.abs(distance() - 400)).toBeLessThanOrEqual(2);
    bench.input('sonar', channelInput('distance', 500));
    runTo(1100);
    expect(lines.at(-1)).toBe('D=0.0');
    report('hcsr04');
  });
});

describe('DS1307', () => {
  it('ds1307: 23:59:58 rolls into 2026-10-20 00:00:01; CH freezes; RAM and pointer wrap', () => {
    const { bench, lines, runTo, report } = load(project('ds1307'), 'ds1307');
    // Unused SQW/INT pins are infos, not faults.
    expect(bench.problems().filter((p) => p.severity !== 'info')).toEqual([]);
    runTo(5000);
    expect(lines.slice(0, 4)).toEqual(['2026-10-19 23:59:58', '2026-10-19 23:59:59', '2026-10-20 00:00:00', '2026-10-20 00:00:01']);
    expect(lines[4]).toBe('frozen=1');
    expect(lines[5]).toBe('ram=ok');
    const wrap = /^wrap=(\d+) (\d+)$/.exec(lines[6] ?? '');
    expect(wrap).not.toBeNull();
    expect(Number(wrap![1])).toBe((55 * 7 + 3) & 0xff);
    const seconds = Number(wrap![2]);
    expect(seconds & 0x80).toBe(0); // CH cleared again
    expect(seconds >> 4).toBeLessThanOrEqual(5); // a BCD seconds value
    expect(lines[7]).toBe('done');
    report('ds1307');
  }, 30_000); // 5 s of simulated time: ~4.4 s of wall time alone, more under load
});

describe('MPU-6050', () => {
  it('mpu6050: WHO_AM_I, zeros asleep, scaled readings awake, ±8 g', () => {
    const { bench, lines, runTo, report } = load(withProps(project('mpu6050'), 'imu', { gx: 10 }), 'mpu6050');
    // Unused SQW/INT pins are infos, not faults.
    expect(bench.problems().filter((p) => p.severity !== 'info')).toEqual([]);
    runTo(200);
    expect(lines[0]).toBe('WHO=0x68');
    expect(lines[1]).toBe('AZ0=0');
    const values = Object.fromEntries((lines[2] ?? '').split(' ').map((kv) => kv.split('=')).map(([k, v]) => [k, Number(v)]));
    expect(Math.abs(values.AZ - 16384)).toBeLessThanOrEqual(1);
    expect(Math.abs(values.GX - 1310)).toBeLessThanOrEqual(1);
    expect(Math.abs(values.T - -4260)).toBeLessThanOrEqual(1);
    expect([values.AX, values.AY, values.GY, values.GZ]).toEqual([0, 0, 0, 0]);
    expect(lines[3]).toBe('AZ8=4096');
    expect(lines[4]).toBe('done');
    report('mpu6050');
  });

  it('mpu6050-ad0 on i2c-shared: AD0 high answers at 0x69 beside a DS1307 at 0x68', () => {
    const { bench, lines, runTo, report } = load(project('i2c-shared'), 'mpu6050-ad0');
    // Unused SQW/INT pins are infos, not faults.
    expect(bench.problems().filter((p) => p.severity !== 'info')).toEqual([]);
    runTo(200);
    expect(lines[0]).toBe('WHO=0x68');
    expect(lines[1]).toBe('AZ0=0');
    expect(lines[2]).toMatch(/ AZ=1638[345] /);
    expect(lines[4]).toBe('done');
    report('mpu6050-ad0');
  });
});
