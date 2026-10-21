import { avrMcuFactory } from '@benchtop/avr';
import { Bench, NS_PER_MS, parseProject } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { readFixtureText } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { benchEnvParts } from '../catalog.ts';
import { NEC, necFrame } from '../inputs/ir-receiver.ts';

// BT52: the IR receiver's NEC frames, measured with a probe on DAT while real firmware decodes
// them, and the HX711 read by a real shift-in.

function load(project: string, firmware: string) {
  const parsed = parseProject(JSON.parse(readFixtureText(`fixtures/projects/${project}.json`)));
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const bench = new Bench(parsed.doc, { part: benchEnvParts, createMcu: avrMcuFactory });
  bench.attachFirmware('uno', { format: 'hex', text: readFixtureText(`fixtures/firmware/uno/${firmware}.hex`) });
  let serial = '';
  bench.onSerial('uno', (bytes) => (serial += String.fromCharCode(...bytes)));
  return { bench, serial: () => serial, runTo: (ms: number) => bench.runUntil(ms * NS_PER_MS) };
}

/** DAT's low/high segment lengths (ns) from the first falling edge on, as a probe saw them. */
function segments(bench: Bench, probe: number): { start: number; lengths: number[] } {
  const read = bench.readProbe(probe, 0);
  if (read === undefined) throw new Error('no probe');
  const edges: { t: number; level: number }[] = [];
  for (let i = 0; i < read.times.length; i++) {
    if (edges.length === 0 || edges[edges.length - 1].level !== read.levels[i]) edges.push({ t: read.times[i], level: read.levels[i] });
  }
  const first = edges.findIndex((e) => e.level === 0);
  const lengths: number[] = [];
  for (let i = first + 1; i < edges.length; i++) lengths.push(edges[i].t - edges[i - 1].t);
  return { start: edges[first].t, lengths };
}

const within1 = (actual: readonly number[], expected: readonly number[]): void => {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((v, i) => expect(Math.abs(v - expected[i]) / expected[i], `segment ${i}`).toBeLessThanOrEqual(0.01));
};

describe('IR receiver (BT52)', () => {
  it('a key sends one NEC frame on DAT (±1 %), which the sketch decodes', () => {
    const t = load('ir-remote', 'ir-decode');
    const probe = t.bench.addProbe({ part: 'ir1', pin: 'DAT' });
    t.runTo(100);
    t.bench.input('ir1', { kind: 'key', key: 'ir:0x30', down: true });
    t.runTo(150);
    t.bench.input('ir1', { kind: 'key', key: 'ir:0x30', down: false });
    t.runTo(300);
    const { start, lengths } = segments(t.bench, probe);
    expect(start).toBe(100 * NS_PER_MS);
    // mark, space, … the final mark (67.5 ms in all); the line then idles high.
    within1(lengths, necFrame(0x00, 0x30));
    expect(t.serial()).toBe('ready\r\nkey 1 0x30\r\n');
  });

  it('held, it repeats every 108 ms; a key pressed mid-frame is ignored', () => {
    const t = load('ir-remote', 'ir-decode');
    const probe = t.bench.addProbe({ part: 'ir1', pin: 'DAT' });
    t.runTo(10);
    t.bench.input('ir1', { kind: 'key', key: 'ir:0xa8', down: true });
    t.runTo(30);
    t.bench.input('ir1', { kind: 'key', key: 'ir:0x18', down: true }); // mid-frame: ignored
    t.runTo(300);
    t.bench.input('ir1', { kind: 'key', key: 'ir:0xa8', down: false });
    t.runTo(500);
    const { lengths } = segments(t.bench, probe);
    const frame = necFrame(0x00, 0xa8);
    const frameLength = frame.reduce((a, b) => a + b, 0);
    const repeat = [NEC.leaderMark, NEC.repeatSpace, NEC.bitMark];
    const repeatLength = repeat.reduce((a, b) => a + b, 0);
    // frame, idle up to 108 ms, repeat, idle up to 108 ms, repeat (the key is up before a third).
    within1(lengths, [...frame, NEC.repeatPeriod - frameLength, ...repeat, NEC.repeatPeriod - repeatLength, ...repeat]);
    expect(t.serial()).toBe('ready\r\nkey play 0xA8\r\nrepeat\r\nrepeat\r\n');
  });
});

describe('HX711 load cell (BT52)', () => {
  it('the sketch tares at 0 g, then reads the weight it is given (100 counts a gram)', () => {
    const t = load('scale', 'scale');
    t.runTo(700);
    t.bench.input('cell', { kind: 'value', value: 1234 });
    t.runTo(1800);
    t.bench.input('cell', { kind: 'value', value: 2.5 });
    t.runTo(2900);
    const lines = t.serial().split('\r\n');
    expect(lines.slice(0, 2)).toEqual(['tared', 'g=0.0']);
    expect(lines).toContain('g=1234.0');
    expect(lines.filter(Boolean).at(-1)).toBe('g=2.5');
    expect(t.bench.problems()).toEqual([]);
  });
});
