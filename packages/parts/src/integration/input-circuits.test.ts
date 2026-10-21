import { avrMcuFactory } from '@benchtop/avr';
import { Bench, NS_PER_MS, parseProject, type PartInput, type ProjectDoc } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { readFixtureText } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { benchEnvParts } from '../catalog.ts';
import { channelInput } from '../shared/channel-input.ts';

// Input parts on a full Bench with real firmware (fixtures/projects/, fixtures/firmware/uno/).

const project = (name: string): ProjectDoc => JSON.parse(readFixtureText(`fixtures/projects/${name}.json`)) as ProjectDoc;

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
  const runFor = (ms: number): void => {
    bench.runUntil(bench.now() + ms * NS_PER_MS);
  };
  const send = (part: string, input: PartInput): void => bench.input(part, input);
  return { bench, lines, runFor, send };
}

/** The latest inputs-report line as numbers and the D2..D9 bit string. */
function report(lines: string[]) {
  const line = lines.at(-1) ?? '';
  const match = /^A0=(\d+) A1=(\d+) A2=(\d+) A3=(\d+) A4=(\d+) A5=(\d+) D=([01]{8})$/.exec(line);
  if (match === null) throw new Error(`not a report line: ${JSON.stringify(line)}`);
  const a = match.slice(1, 7).map(Number);
  const d = match[7];
  return { a, d, bit: (pin: number) => Number(d[pin - 2]) };
}

describe('analog and sensor modules (inputs-report)', () => {
  it('reads the slide pot, joystick, LDR, NTC and sound modules', () => {
    const { bench, lines, runFor, send } = load(project('inputs-analog'), 'inputs-report');
    expect(bench.problems()).toEqual([]);
    send('pot', { kind: 'value', value: 0.25 });
    send('joy', channelInput('x', 1));
    send('joy', channelInput('y', 0));
    send('joy', { kind: 'press' });
    send('ldr', { kind: 'value', value: 100 });
    send('ntc', { kind: 'value', value: 25 });
    send('snd', { kind: 'value', value: 0 });
    runFor(120);
    let r = report(lines);
    expect(Math.abs(r.a[0] - 256)).toBeLessThanOrEqual(1);
    expect(r.a[1]).toBe(1023);
    expect(Math.abs(r.a[2] - 512)).toBeLessThanOrEqual(1);
    expect(r.bit(2)).toBe(0);
    expect(Math.abs(r.a[3] - 292)).toBeLessThanOrEqual(2);
    expect(r.bit(3)).toBe(0);
    expect(Math.abs(r.a[4] - 512)).toBeLessThanOrEqual(1);
    expect(Math.abs(r.a[5] - 512)).toBeLessThanOrEqual(1);

    send('ldr', { kind: 'value', value: 10 });
    send('ntc', { kind: 'value', value: 50 });
    send('joy', { kind: 'release' });
    runFor(60);
    r = report(lines);
    expect(Math.abs(r.a[3] - 682)).toBeLessThanOrEqual(2);
    expect(r.bit(3)).toBe(1);
    expect(Math.abs(r.a[4] - 270)).toBeLessThanOrEqual(1);
    expect(r.bit(2)).toBe(1);
  });

  it('the tilt toggle flips D6', () => {
    const { lines, runFor, send } = load(project('inputs-analog'), 'inputs-report');
    runFor(60);
    const before = report(lines).bit(6);
    send('tilt', { kind: 'press' });
    runFor(60);
    expect(report(lines).bit(6)).toBe(1 - before);
    send('tilt', { kind: 'press' });
    runFor(60);
    expect(report(lines).bit(6)).toBe(before);
  });

  it('DIP switches 1, 3 and 8 on: D2, D4 and D9 read 0, the rest 1', () => {
    const { bench, lines, runFor } = load(project('inputs-dip'), 'inputs-report');
    expect(bench.problems()).toEqual([]);
    runFor(60);
    expect(report(lines).d).toBe('01011110');
  });
});

/** Samples a net's level every 0.1 ms; returns the times (ms) it changed, from `fromMs`. */
function watch(bench: Bench, part: string, pin: string, untilMs: number) {
  const changes: { ms: number; level: number | null }[] = [];
  let last = bench.pinState(part, pin)?.level ?? null;
  while (bench.now() < untilMs * NS_PER_MS) {
    bench.runUntil(bench.now() + 100_000);
    const level = bench.pinState(part, pin)?.level ?? null;
    if (level !== last) changes.push({ ms: Math.round(bench.now() / 1e5) / 10, level });
    last = level;
  }
  return changes;
}

describe('net timing', () => {
  it('a clap holds the sound DO net at 1 for 100 ± 1 ms', () => {
    const { bench, runFor, send } = load(project('inputs-analog'), 'inputs-report');
    runFor(50);
    expect(bench.pinState('snd', 'DOUT')?.level).toBe(0);
    send('snd', { kind: 'press' });
    const start = bench.now() / NS_PER_MS;
    expect(bench.pinState('snd', 'DOUT')?.level).toBe(1);
    const changes = watch(bench, 'snd', 'DOUT', start + 150);
    expect(changes).toHaveLength(1);
    expect(changes[0].level).toBe(0);
    expect(Math.abs(changes[0].ms - start - 100)).toBeLessThanOrEqual(1);
  });

  it('PIR (hold 500 ms, block 250 ms): retrigger extends the hold, motion during the block is ignored', () => {
    const doc = project('inputs-analog');
    doc.parts = doc.parts.map((p) => (p.id === 'pir' ? { ...p, props: { ...p.props, holdMs: 500, blockMs: 250 } } : p));
    const { bench, runFor, send } = load(doc, 'inputs-report');
    runFor(100);
    send('pir', { kind: 'press' });
    const out = bench.pinState('pir', 'OUT');
    expect(out?.level).toBe(1);
    expect(out?.volts).toBeCloseTo(3.3, 6);
    runFor(200); // 300 ms
    send('pir', { kind: 'press' });
    const changes = watch(bench, 'pir', 'OUT', 900);
    expect(changes).toHaveLength(1);
    expect(changes[0].level).toBe(0);
    expect(Math.abs(changes[0].ms - 800)).toBeLessThanOrEqual(1);
    send('pir', { kind: 'press' }); // 900 ms: inside the 250 ms block after 800 ms
    runFor(50);
    expect(bench.pinState('pir', 'OUT')?.level).toBe(0);
  });
});

describe('keypad and encoder', () => {
  it('keypad-scan prints each of the 16 keys once, and the phantom 5 for 1+2+4', () => {
    const { bench, lines, runFor, send } = load(project('keypad'), 'keypad-scan');
    expect(bench.problems()).toEqual([]);
    runFor(20);
    const keys = ['1', '2', '3', 'A', '4', '5', '6', 'B', '7', '8', '9', 'C', '*', '0', '#', 'D'];
    for (const key of keys) {
      send('pad', { kind: 'key', key, down: true });
      runFor(30);
      send('pad', { kind: 'key', key, down: false });
      runFor(30);
    }
    expect(lines).toEqual(keys);
    lines.length = 0;
    for (const key of ['1', '2', '4']) send('pad', { kind: 'key', key, down: true });
    runFor(40);
    expect([...lines].sort()).toEqual(['1', '2', '4', '5']);
    expect(bench.problems()).toEqual([]);
  });

  it('encoder-count: 5 CW and 2 CCW detents give count=3; a shaft press prints SW', () => {
    const { bench, lines, runFor, send } = load(project('encoder'), 'encoder-count');
    expect(bench.problems()).toEqual([]);
    runFor(10);
    for (let i = 0; i < 5; i++) send('enc', { kind: 'key', key: 'cw', down: true });
    for (let i = 0; i < 2; i++) send('enc', { kind: 'key', key: 'ccw', down: true });
    runFor(60);
    expect(lines).toEqual(['count=1', 'count=2', 'count=3', 'count=4', 'count=5', 'count=4', 'count=3']);
    send('enc', { kind: 'press' });
    runFor(10);
    send('enc', { kind: 'release' });
    runFor(10);
    expect(lines.at(-1)).toBe('SW');
  });
});

describe('speed', () => {
  it('inputs-report: simulated MHz over 1 s', () => {
    const { bench } = load(project('inputs-analog'), 'inputs-report');
    const start = performance.now();
    bench.runUntil(1000 * NS_PER_MS);
    const wallMs = performance.now() - start;
    console.info(`inputs-report: 1 s simulated in ${wallMs.toFixed(0)} ms wall = ${(16e6 / (wallMs * 1000)).toFixed(1)} simulated MHz`);
    expect(wallMs).toBeGreaterThan(0);
  });
});
