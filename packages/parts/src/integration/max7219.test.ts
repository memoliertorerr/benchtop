import { avrMcuFactory } from '@benchtop/avr';
import { Bench, type BenchEnv, NS_PER_MS, parseProject, type PartInstance, type ProjectDoc, type VisualState, type Wire } from '@benchtop/core';
import { esp32McuFactory } from '@benchtop/esp32';
import { describe, expect, it } from 'vitest';
import { readFixture, readFixtureText } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { loadCachedRom } from '../../../esp32/src/test-support/rom.test-helper.ts';
import { benchEnvParts } from '../catalog.ts';
import { sevenSegmentText } from '../displays/seven-segment.ts';

// BT185: MAX7219 modules on real firmware — uno/max7219 (the FC-16 on hardware SPI, as MD_MAX72XX
// frames it) and esp32/max7219-7seg (the 8-digit module bit-banged, as LedControl does).

const esp32 = esp32McuFactory(loadCachedRom());
const env: BenchEnv = { part: benchEnvParts, createMcu: (board, id, report) => avrMcuFactory(board) ?? esp32(board, id, report) };

function circuit(board: { id: string; type: string }, parts: Omit<PartInstance, 'x' | 'y' | 'rotation'>[], wires: [string, string][]): ProjectDoc {
  return {
    format: 1,
    name: 'max7219 test',
    parts: [{ id: board.id, type: board.type, x: 0, y: 0, rotation: 0, props: {} }, ...parts.map((p, i) => ({ ...p, x: 100 + i * 140, y: 0, rotation: 0 as const }))],
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
  else bench.attachFirmware(board.id, { format: 'esp32-bin', app: readFixture(`fixtures/firmware/esp32/${firmware}.bin`), partitions: readFixture(`fixtures/firmware/esp32/${firmware}.partitions.bin`) });
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
  const latest = new Map<string, VisualState>();
  const runTo = (ms: number): void => {
    bench.runUntil(ms * NS_PER_MS);
    for (const [part, visual] of bench.collectFrame().parts) latest.set(part, structuredClone(visual));
  };
  /** Runs in 10 ms slices until a line matching `test` arrives (at most `limit` ms). */
  const until = (test: (line: string) => boolean, limit: number): string | undefined => {
    for (let t = Math.floor(bench.now() / NS_PER_MS) + 10; t <= limit; t += 10) {
      runTo(t);
      const line = [...lines].reverse().find(test);
      if (line !== undefined) return line;
    }
    return undefined;
  };
  return { bench, latest, lines, runTo, until };
}

const PICTURES = [
  [0x00, 0x66, 0xff, 0xff, 0xff, 0x7e, 0x3c, 0x18],
  [0x3c, 0x42, 0xa5, 0x81, 0xa5, 0x99, 0x42, 0x3c],
  [0x08, 0x0c, 0xfe, 0xff, 0xfe, 0x0c, 0x08, 0x00],
  [0xaa, 0x55, 0xaa, 0x55, 0xaa, 0x55, 0xaa, 0x55],
];

describe('MAX7219 modules on real firmware (BT185)', () => {
  it('uno/max7219: the FC-16 on hardware SPI shows its four pictures left to right, the intensity steps', () => {
    const doc = circuit({ id: 'uno', type: 'arduino-uno' }, [{ id: 'fc', type: 'max7219-matrix-4', props: {} }], [
      ['uno:11', 'fc:DIN'],
      ['uno:13', 'fc:CLK'],
      ['uno:10', 'fc:CS'],
      ['uno:5V', 'fc:VCC'],
      ['uno:GND.1', 'fc:GND'],
    ]);
    const { bench, latest, until } = load(doc, 'max7219');
    expect(until((l) => l === 'drawn', 500)).toBe('drawn');
    const rows = latest.get('fc')?.rows as number[];
    // Chip 0 is the rightmost: the leftmost picture is chip 3's.
    expect([3, 2, 1, 0].map((chip) => rows.slice(chip * 8, chip * 8 + 8))).toEqual(PICTURES);
    expect(latest.get('fc')?.level).toEqual(Array(4).fill(5 / 32)); // intensity 2
    expect(until((l) => l === 'intensity 15', 1500)).toBe('intensity 15');
    expect(latest.get('fc')?.level).toEqual(Array(4).fill(31 / 32));
    expect(bench.problems().filter((p) => p.code === 'spi-unattached')).toEqual([]);
  });

  it('esp32/max7219-7seg: bit-banged words show "-HELP-01." in Code B, then the count right-aligned', () => {
    const doc = circuit({ id: 'esp', type: 'esp32-devkit-v1' }, [{ id: 'seg', type: 'max7219-7seg-8', props: {} }], [
      ['esp:D13', 'seg:DIN'],
      ['esp:D14', 'seg:CLK'],
      ['esp:D27', 'seg:CS'],
      ['esp:VIN', 'seg:VCC'],
      ['esp:GND.1', 'seg:GND'],
    ]);
    const { latest, until } = load(doc, 'max7219-7seg');
    expect(until((l) => l === 'help', 3000)).toBe('help');
    const seg = (): VisualState => latest.get('seg') ?? {};
    expect(sevenSegmentText(seg().values as number[])).toBe('-HELP-01');
    expect(((seg().segments as number[])[7] >> 7) & 1).toBe(1); // the point after the 1
    const line = until((l) => l === 'n=12', 6000);
    expect(line).toBe('n=12');
    expect(sevenSegmentText(seg().values as number[])).toBe('      12');
  }, 60_000);
});
