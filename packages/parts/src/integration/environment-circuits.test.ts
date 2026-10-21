import { avrMcuFactory } from '@benchtop/avr';
import { Bench, NS_PER_MS, parseProject, type PartInstance, type PartProps } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { readFixtureText } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { analogSpecFor } from '../analog-specs.ts';
import { benchEnvParts } from '../catalog.ts';
import { envSpecFor } from '../environment/specs.ts';

// BT55: the catalog's sensors read the environment through real firmware — a leak reaching an
// MQ-2, a candle in front of a flame sensor, a heater warming a DHT22, a box driving toward an
// HC-SR04, and a lamp, a heater, a sound source and a walking person around one Uno's inputs.

const ROOM: PartInstance = { id: 'room', type: 'environment', x: -150, y: 120, rotation: 0, props: {} };

function part(id: string, type: string, x: number, y: number, props: PartProps = {}): PartInstance {
  return { id, type, x, y, rotation: 0, props };
}

function load(project: string, firmware: string, extra: PartInstance[]) {
  const json = JSON.parse(readFixtureText(`fixtures/projects/${project}.json`)) as { parts: PartInstance[] };
  json.parts.push(ROOM, ...extra);
  const parsed = parseProject(json);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const bench = new Bench(parsed.doc, { part: benchEnvParts, createMcu: avrMcuFactory }, { analogSpecFor, envSpecFor });
  bench.attachFirmware('uno', { format: 'hex', text: readFixtureText(`fixtures/firmware/uno/${firmware}.hex`) });
  bench.reset();
  let serial = '';
  bench.onSerial('uno', (bytes) => (serial += String.fromCharCode(...bytes)));
  const runTo = (ms: number): void => {
    bench.runUntil(ms * NS_PER_MS);
    bench.collectFrame();
  };
  const lines = (): string[] => serial.split('\r\n').filter(Boolean);
  return { bench, runTo, lines };
}

describe('sensors in the environment (BT55)', () => {
  it('an MQ-2 reads a leak that opens 17 cm away, and the sketch raises the alarm', () => {
    // The sensor's centre is (103.1, 8.3); the leak's 17 bench mm to its left (0.17 m in the room).
    const t = load('gas-meter', 'gas-meter', [part('leak', 'gas-leak', 79.1, 1.3, { rate: 5, on: false })]);
    t.runTo(400);
    const clean = t.lines().at(-1) ?? '';
    expect(clean).toMatch(/alarm=0$/);
    const a0 = (line: string): number => Number(/a0=(\d+)/.exec(line)?.[1]);
    t.bench.input('leak', { kind: 'press' });
    t.runTo(4000);
    expect(a0(t.lines().at(-1) ?? '')).toBeGreaterThan(a0(clean) + 200);
    expect(t.lines().at(-1)).toMatch(/alarm=1$/);
    expect(t.bench.envSample('gas', 'gas')).toBeGreaterThan(500);
  });

  it('a flame sensor sees a candle to its left, not one behind it', () => {
    // The module (85, 0, 52.9 × 16.3) looks left from its centre (111.5, 8.1).
    const behind = load('flame-alarm', 'flame-alarm', [part('candle', 'flame', 150, 3.1, { strength: 2 })]);
    behind.runTo(500);
    expect(behind.lines().at(-1)).toMatch(/^clear/);
    const ahead = load('flame-alarm', 'flame-alarm', [part('candle', 'flame', 70, 3.1, { strength: 2 })]);
    ahead.runTo(500);
    expect(ahead.lines().at(-1)).toMatch(/^FLAME/);
  });

  it('a DHT22 beside a heater reads it warming and its relative humidity falling', () => {
    // DHT22 centre (57.6, −32.6); the heater's 30 mm (0.3 m) to its right.
    const t = load('dht22', 'dht22-adafruit', [part('heat', 'heater', 77.6, -38.6, { watts: 300, on: false })]);
    t.runTo(2500); // the library's first read is at ~2 s
    t.bench.input('heat', { kind: 'press' });
    t.runTo(8500);
    const reads = t.lines().map((line) => /^T=([\d.]+) H=([\d.]+)$/.exec(line)).filter((m) => m !== null);
    expect(reads.length).toBeGreaterThanOrEqual(3);
    const [first, last] = [reads[0], reads.at(-1)!];
    expect(Number(first[1])).toBeCloseTo(22, 1);
    expect(Number(first[2])).toBeCloseTo(45, 1);
    expect(Number(last[1])).toBeGreaterThan(23);
    expect(Number(last[2])).toBeLessThan(43);
  });

  it('an HC-SR04 follows a box driving toward it', () => {
    // Sensor centre (42.5, −33.5), looking up; the box's near face starts 90 cm away and stops 40 cm away.
    const t = load('hcsr04', 'hcsr04', [part('box', 'object', 22.5, -143.5, { width: 40, depth: 20, toY: 50, speed: 0.25, pause: 0.5 })]);
    t.runTo(400);
    const cm = (line: string | undefined): number => Number(/^D=([\d.]+)$/.exec(line ?? '')?.[1]);
    expect(cm(t.lines().at(-1))).toBeCloseTo(90, -0.5);
    t.runTo(2700);
    expect(cm(t.lines().at(-1))).toBeCloseTo(40, -0.5);
    const seen = t.lines().map(cm);
    // On the way: readings fall monotonically (to the sketch's 0.1 cm and pulseIn's ±1 %).
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeLessThanOrEqual(seen[i - 1] * 1.01 + 0.2);
  });

  it('a lamp, a heater, a sound source and a person passing move the LDR, NTC, sound and PIR inputs', () => {
    const t = load('inputs-analog', 'inputs-report', [
      part('lamp', 'lamp', -46, -19.9, { lumens: 800, on: false }), // 15 mm above the LDR's centre (−39, 10.1)
      part('heat', 'heater', -74, 29.5, { watts: 500, on: false }), // 10 mm left of the NTC's centre (−34.1, 35.5)
      part('noise', 'sound-source', 106.6, -0.3, { db: 90, on: false }), // 15 mm above the sound module
      part('walker', 'person', 40, -120, { toX: 100, toY: 0, speed: 1, pause: 0, on: false }), // 0.68 m in front of the PIR
    ]);
    const fields = (line: string | undefined): Record<string, string> =>
      Object.fromEntries((line ?? '').split(' ').map((kv) => kv.split('=') as [string, string]));
    t.runTo(500);
    const before = fields(t.lines().at(-1));
    expect(before.D?.[3]).toBe('0'); // the PIR on D5: nobody walking
    for (const id of ['lamp', 'heat', 'noise']) t.bench.input(id, { kind: 'press' });
    t.bench.input('walker', { kind: 'key', key: 'set:on=1', down: true });
    t.runTo(3000);
    const after = fields(t.lines().at(-1));
    expect(Number(after.A3)).toBeLessThan(Number(before.A3) - 50); // brighter → lower AO
    expect(Number(after.A4)).not.toBe(Number(before.A4)); // warmer NTC
    expect(Number(after.A5)).toBeGreaterThan(Number(before.A5) + 100); // louder
    expect(after.D?.[2]).toBe('1'); // the sound module's DOUT on D4
    expect(after.D?.[3]).toBe('1'); // the PIR fired
  });
});
