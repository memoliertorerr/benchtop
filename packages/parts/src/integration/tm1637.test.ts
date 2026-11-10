import { avrMcuFactory } from '@benchtop/avr';
import { Bench, type BenchEnv, NS_PER_MS, parseProject, type PartInstance, type ProjectDoc, type VisualState, type Wire } from '@benchtop/core';
import { rp2040McuFactory } from '@benchtop/rp2040';
import { describe, expect, it } from 'vitest';
import { readFixture, readFixtureText } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { benchEnvParts } from '../catalog.ts';
import { sevenSegmentText } from '../displays/seven-segment.ts';

// BT186: TM1637 modules on real firmware, driven as TM1637Display does — uno/tm1637 (a counter)
// and pico/tm1637 (a clock with the colon, the module on 3V3).

const env: BenchEnv = { part: benchEnvParts, createMcu: (board, id, report) => avrMcuFactory(board) ?? rp2040McuFactory(board, id, report) };

function circuit(board: { id: string; type: string }, wires: [string, string][]): ProjectDoc {
  const parts: PartInstance[] = [
    { id: board.id, type: board.type, x: 0, y: 0, rotation: 0, props: {} },
    { id: 'tm', type: 'tm1637-4digit', x: 100, y: 0, rotation: 0, props: {} },
  ];
  return {
    format: 1,
    name: 'tm1637 test',
    parts,
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
  const bench = new Bench(parsed.doc, env);
  const board = parsed.doc.parts[0];
  if (board.type === 'arduino-uno') bench.attachFirmware(board.id, { format: 'hex', text: readFixtureText(`fixtures/firmware/uno/${firmware}.hex`) });
  else bench.attachFirmware(board.id, { format: 'uf2', bytes: readFixture(`fixtures/firmware/pico/${firmware}.uf2`) });
  bench.reset();
  let text = '';
  const lines: string[] = [];
  bench.onSerial(board.id, (bytes) => {
    text += String.fromCharCode(...bytes);
    let end: number;
    while ((end = text.indexOf('\n')) >= 0) {
      lines.push(text.slice(0, end).replace(/\r$/, ''));
      text = text.slice(end + 1);
    }
  });
  let latest: VisualState = {};
  /** Runs in 5 ms slices until a line matching `test` arrives (at most `limit` ms). */
  const until = (test: (line: string) => boolean, limit: number): string | undefined => {
    for (let t = Math.floor(bench.now() / NS_PER_MS) + 5; t <= limit; t += 5) {
      bench.runUntil(t * NS_PER_MS);
      for (const [part, visual] of bench.collectFrame().parts) if (part === 'tm') latest = structuredClone(visual);
      const line = lines.find(test);
      if (line !== undefined) return line;
    }
    return undefined;
  };
  return { bench, until, shown: () => latest };
}

describe('TM1637 modules on real firmware (BT186)', () => {
  it('uno/tm1637: every byte ACKed, "1234", then the count right-aligned with the colon on odd counts', () => {
    const { until, shown } = load(
      circuit({ id: 'uno', type: 'arduino-uno' }, [
        ['uno:2', 'tm:CLK'],
        ['uno:3', 'tm:DIO'],
        ['uno:5V', 'tm:VCC'],
        ['uno:GND.1', 'tm:GND'],
      ]),
      'tm1637',
    );
    expect(until((l) => l.startsWith('acks '), 500)).toBe('acks 7/7');
    expect(sevenSegmentText(shown().values as number[])).toBe('1234');
    expect(shown().level).toBe(14 / 16);
    expect(until((l) => l === 'n=7', 3000)).toBe('n=7');
    expect(sevenSegmentText(shown().values as number[])).toBe('   7');
    expect(shown().colon).toBe(14 / 16);
    expect(until((l) => l === 'n=12', 5000)).toBe('n=12'); // each update takes ≈ 21 ms of 100 µs bits
    expect(sevenSegmentText(shown().values as number[])).toBe('  12');
    expect(shown().colon).toBe(0);
  });

  it('pico/tm1637: a clock from 3.3 V — "00:02" two seconds in, the colon for half of each second', () => {
    const { until, shown, bench } = load(
      circuit({ id: 'pico', type: 'raspberry-pi-pico' }, [
        ['pico:GP2', 'tm:CLK'],
        ['pico:GP3', 'tm:DIO'],
        ['pico:3V3', 'tm:VCC'],
        ['pico:GND.1', 'tm:GND'],
      ]),
      'tm1637',
    );
    expect(until((l) => l === 'time 00:02', 4000)).toBe('time 00:02');
    expect(sevenSegmentText(shown().values as number[])).toBe('0002');
    expect(shown().level).toBe(4 / 16);
    expect(shown().colon).toBe(4 / 16);
    // 600 ms later the colon is off for the second half of the second.
    const at = bench.now() / NS_PER_MS;
    until(() => false, Math.ceil(at + 600));
    expect(shown().colon).toBe(0);
    expect(sevenSegmentText(shown().values as number[])).toBe('0002');
  });
});
