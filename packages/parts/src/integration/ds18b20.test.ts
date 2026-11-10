import { avrMcuFactory } from '@benchtop/avr';
import { Bench, type BenchEnv, NS_PER_MS, parseProject, type PartInstance, type ProjectDoc, type Wire } from '@benchtop/core';
import { esp32McuFactory } from '@benchtop/esp32';
import { describe, expect, it } from 'vitest';
import { readFixture, readFixtureText } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { loadCachedRom } from '../../../esp32/src/test-support/rom.test-helper.ts';
import { analogSpecFor } from '../analog-specs.ts';
import { benchEnvParts } from '../catalog.ts';
import { rawCelsius, temperatureRaw } from '../sensors/ds18b20.ts';

// BT187: DS18B20s on real firmware with OneWire's timings — uno/ds18b20 (two sensors found by Search
// ROM, converted together, read by Match ROM) and esp32/ds18b20 (one sensor, read ROM, 9 and 12 bits).

const esp32 = esp32McuFactory(loadCachedRom());
const env: BenchEnv = { part: benchEnvParts, createMcu: (board, id, report) => avrMcuFactory(board) ?? esp32(board, id, report) };

function circuit(board: { id: string; type: string }, parts: Omit<PartInstance, 'x' | 'y' | 'rotation'>[], wires: [string, string][]): ProjectDoc {
  return {
    format: 1,
    name: 'ds18b20 test',
    parts: [{ id: board.id, type: board.type, x: 0, y: 0, rotation: 0, props: {} }, ...parts.map((p, i) => ({ ...p, x: 100 + i * 20, y: 0, rotation: 0 as const }))],
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
  const bench = new Bench(parsed.doc, env, { analogSpecFor });
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
  /** Runs in 10 ms slices until a line matching `test` arrives (at most `limit` ms). */
  const until = (test: (line: string) => boolean, limit: number): string | undefined => {
    for (let t = Math.floor(bench.now() / NS_PER_MS) + 10; t <= limit; t += 10) {
      bench.runUntil(t * NS_PER_MS);
      const line = lines.find(test);
      if (line !== undefined) return line;
    }
    return undefined;
  };
  return { bench, lines, until };
}

const at12 = (celsius: number): string => rawCelsius(temperatureRaw(celsius, 12)).toFixed(4);

describe('DS18B20s on real firmware (BT187)', () => {
  it('uno/ds18b20: Search ROM finds both, a conversion takes 750 ms, Match ROM reads each', () => {
    const doc = circuit(
      { id: 'uno', type: 'arduino-uno' },
      [
        { id: 'out', type: 'ds18b20', props: { serial: '0000075a1b2c', temperature: 21.3 } },
        { id: 'in', type: 'ds18b20', props: { serial: '00000a0b0c0d', temperature: -10.13 } },
        { id: 'r', type: 'resistor', props: { ohms: 4700 } },
      ],
      [
        ['uno:2', 'out:DQ'],
        ['uno:2', 'in:DQ'],
        ['uno:2', 'r:1'],
        ['r:2', 'uno:5V'],
        ['out:VDD', 'uno:5V'],
        ['in:VDD', 'uno:5V'],
        ['out:GND', 'uno:GND.1'],
        ['in:GND', 'uno:GND.1'],
      ],
    );
    const { bench, lines, until } = load(doc, 'ds18b20');
    expect(until((l) => l.startsWith('sensors '), 1000)).toBe('sensors 2');
    expect(lines.filter((l) => l.startsWith('found ')).sort()).toEqual(['found 28-0000075A1B2C crc ok', 'found 28-00000A0B0C0D crc ok']);
    const converted = until((l) => l.startsWith('converted in '), 2000) ?? '';
    const ms = Number(/converted in (\d+) ms/.exec(converted)?.[1]);
    expect(ms).toBeGreaterThanOrEqual(749);
    expect(ms).toBeLessThanOrEqual(752);
    expect(until((l) => l.startsWith('28-00000A0B0C0D '), 2500)).toBe(`28-00000A0B0C0D ${at12(-10.13)} C`);
    expect(lines).toContain(`28-0000075A1B2C ${at12(21.3)} C`);
    // A new temperature shows at the next conversion.
    bench.input('out', { kind: 'key', key: 'set:temperature=30.5', down: true });
    const count = lines.length;
    expect(until((l) => l === '28-0000075A1B2C 30.5000 C', 5000)).toBe('28-0000075A1B2C 30.5000 C');
    expect(lines.slice(count).some((l) => l.includes('crc bad'))).toBe(false);
    expect(bench.problems().filter((p) => p.code === 'onewire-no-pullup')).toEqual([]);
  }, 30_000);

  it('esp32/ds18b20: read ROM, external power, 9 bits in 94 ms, 12 bits in 750 ms', () => {
    const doc = circuit(
      { id: 'esp', type: 'esp32-devkit-v1' },
      [
        { id: 'ow', type: 'ds18b20', props: { serial: '000001234abc', temperature: 23.3 } },
        { id: 'r', type: 'resistor', props: { ohms: 4700 } },
      ],
      [
        ['esp:D4', 'ow:DQ'],
        ['esp:D4', 'r:1'],
        ['r:2', 'esp:3V3'],
        ['ow:VDD', 'esp:3V3'],
        ['ow:GND', 'esp:GND.1'],
      ],
    );
    const { until, lines } = load(doc, 'ds18b20');
    expect(until((l) => l.startsWith('12 bit '), 5000)).toBeDefined();
    expect(lines).toContain('rom 28-000001234ABC crc ok');
    expect(lines).toContain('power external');
    const nine = lines.find((l) => l.startsWith('9 bit ')) ?? '';
    expect(nine.startsWith(`9 bit ${rawCelsius(temperatureRaw(23.3, 9)).toFixed(4)} C in `)).toBe(true);
    expect(Number(/in (\d+) ms/.exec(nine)?.[1])).toBeGreaterThanOrEqual(93);
    expect(Number(/in (\d+) ms/.exec(nine)?.[1])).toBeLessThanOrEqual(95);
    const twelve = lines.find((l) => l.startsWith('12 bit ')) ?? '';
    expect(twelve.startsWith(`12 bit ${at12(23.3)} C in `)).toBe(true);
    expect(Number(/in (\d+) ms/.exec(twelve)?.[1])).toBeGreaterThanOrEqual(749);
    expect(Number(/in (\d+) ms/.exec(twelve)?.[1])).toBeLessThanOrEqual(752);
  }, 60_000);
});
