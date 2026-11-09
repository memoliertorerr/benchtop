import { avrMcuFactory } from '@benchtop/avr';
import { Bench, type BenchEnv, NS_PER_MS, parseProject, type ProjectDoc, type VisualState } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { readFixtureText } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { benchEnvParts } from '../catalog.ts';

// BT182: the 1.3″ SH1106 on an Uno under Adafruit_SH110X; and an SSD1306 sketch on it, which can't
// work (no horizontal addressing), as on a board.

const env: BenchEnv = { part: benchEnvParts, createMcu: avrMcuFactory };

const doc: ProjectDoc = {
  format: 1,
  name: 'sh1106 test',
  parts: [
    { id: 'uno', type: 'arduino-uno', x: 0, y: 0, rotation: 0, props: {} },
    { id: 'oled', type: 'sh1106', x: 10, y: -40, rotation: 0, props: { address: '0x3C' } },
  ],
  wires: [
    { id: 'w1', from: { part: 'oled', pin: 'SDA' }, to: { part: 'uno', pin: 'A4' }, waypoints: [], color: 'green' },
    { id: 'w2', from: { part: 'oled', pin: 'SCL' }, to: { part: 'uno', pin: 'A5' }, waypoints: [], color: 'yellow' },
    { id: 'w3', from: { part: 'oled', pin: 'VCC' }, to: { part: 'uno', pin: '5V' }, waypoints: [], color: 'red' },
    { id: 'w4', from: { part: 'oled', pin: 'GND' }, to: { part: 'uno', pin: 'GND.1' }, waypoints: [], color: 'black' },
  ],
  firmware: {},
};

function load(firmware: string) {
  const parsed = parseProject(doc);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const bench = new Bench(parsed.doc, env);
  bench.attachFirmware('uno', { format: 'hex', text: readFixtureText(`fixtures/firmware/uno/${firmware}.hex`) });
  bench.reset();
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
  const until = (test: (line: string) => boolean, limit: number): string | undefined => {
    for (let t = Math.floor(bench.now() / NS_PER_MS) + 10; t <= limit; t += 10) {
      bench.runUntil(t * NS_PER_MS);
      for (const [part, visual] of bench.collectFrame().parts) latest.set(part, structuredClone(visual));
      const line = lines.find(test);
      if (line !== undefined) return line;
    }
    return undefined;
  };
  return { bench, latest, until };
}

function unpack(visual: VisualState | undefined): number[] {
  const fb = (visual?.fb ?? []) as number[];
  return Array.from({ length: 1024 }, (_, i) => (fb[i >> 2] >>> (8 * (i & 3))) & 0xff);
}

const bufferOf = (line: string): number[] => Array.from({ length: (line.length - 3) / 2 }, (_, i) => Number.parseInt(line.slice(3 + 2 * i, 5 + 2 * i), 16));

describe('the SH1106 (BT182)', () => {
  it('uno/sh1106: Adafruit_SH110X draws its buffer on the 1.3″ module (columns 2–129), then the counter', () => {
    const { bench, latest, until } = load('sh1106');
    const fb = until((l) => l.startsWith('FB:'), 3000);
    const buffer = bufferOf(fb ?? '');
    expect(buffer).toHaveLength(1024);
    expect(buffer.some((b) => b !== 0)).toBe(true);
    expect(latest.get('oled')?.on).toBe(true);
    expect(unpack(latest.get('oled'))).toEqual(buffer);
    expect(until((l) => l === 'count 2', 5000)).toBe('count 2');
    const now = unpack(latest.get('oled'));
    const changed = now.map((b, i) => (b !== buffer[i] ? i : -1)).filter((i) => i >= 0);
    expect(changed.length).toBeGreaterThan(0);
    for (const i of changed) expect(i & 127, `byte ${i}`).toBeGreaterThanOrEqual(100); // the counter at x 100
    expect(bench.problems().filter((p) => p.severity !== 'info')).toEqual([]);
  }, 60_000);

  it('an SSD1306 sketch on the SH1106 does not show its buffer (it has no horizontal addressing)', () => {
    const { latest, until } = load('ssd1306-adafruit');
    const fb = until((l) => l.startsWith('FB:'), 3000);
    const buffer = bufferOf(fb ?? '');
    expect(buffer).toHaveLength(1024);
    expect(unpack(latest.get('oled'))).not.toEqual(buffer);
  }, 60_000);
});
