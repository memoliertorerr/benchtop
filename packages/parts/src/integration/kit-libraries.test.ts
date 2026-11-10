import { avrMcuFactory } from '@benchtop/avr';
import { Bench, type BenchEnv, NS_PER_MS, parseProject, type PartInstance, type ProjectDoc, type VisualState, type Wire } from '@benchtop/core';
import { esp32McuFactory } from '@benchtop/esp32';
import { describe, expect, it } from 'vitest';
import { readFixture, readFixtureText } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { loadCachedRom } from '../../../esp32/src/test-support/rom.test-helper.ts';
import { analogSpecFor } from '../analog-specs.ts';
import { benchEnvParts } from '../catalog.ts';
import { displayText, sevenSegmentText } from '../displays/seven-segment.ts';
import { rawCelsius, temperatureRaw } from '../sensors/ds18b20.ts';

// BT188: the kit chips under the libraries people use — OneWire 2.3.8 + DallasTemperature 4.0.6 on
// an Uno (two sensors) and an ESP32, LedControl 1.0.6 on an Uno (a 7-segment module chained into
// an 8×8 matrix through DOUT); BT190: TM1637Display 1.2.0 alone and in a DS18B20 thermometer.

const esp32 = esp32McuFactory(loadCachedRom());
const env: BenchEnv = { part: benchEnvParts, createMcu: (board, id, report) => avrMcuFactory(board) ?? esp32(board, id, report) };

function circuit(board: { id: string; type: string }, parts: Omit<PartInstance, 'x' | 'y' | 'rotation'>[], wires: [string, string][]): ProjectDoc {
  return {
    format: 1,
    name: 'kit libraries test',
    parts: [{ id: board.id, type: board.type, x: 0, y: 0, rotation: 0, props: {} }, ...parts.map((p, i) => ({ ...p, x: 100 + i * 100, y: 0, rotation: 0 as const }))],
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
  const latest = new Map<string, VisualState>();
  /** Runs in 10 ms slices until a line matching `test` arrives (at most `limit` ms). */
  const until = (test: (line: string) => boolean, limit: number): string | undefined => {
    for (let t = Math.floor(bench.now() / NS_PER_MS) + 10; t <= limit; t += 10) {
      bench.runUntil(t * NS_PER_MS);
      for (const [part, visual] of bench.collectFrame().parts) latest.set(part, structuredClone(visual));
      const line = lines.find(test);
      if (line !== undefined) return line;
    }
    return undefined;
  };
  return { bench, lines, until, latest };
}

const at = (celsius: number, bits: number): string => rawCelsius(temperatureRaw(celsius, bits)).toFixed(4);

describe('kit chips under their libraries (BT188)', () => {
  it('uno/dallas-temperature: DallasTemperature finds both, reads them at 11 bits, and alarm-searches', () => {
    const doc = circuit(
      { id: 'uno', type: 'arduino-uno' },
      [
        { id: 'a', type: 'ds18b20', props: { serial: '0000075a1b2c', temperature: 21.3 } },
        { id: 'b', type: 'ds18b20', props: { serial: '00000a0b0c0d', temperature: 27.6 } },
        { id: 'r', type: 'resistor', props: { ohms: 4700 } },
      ],
      [
        ['uno:2', 'a:DQ'],
        ['uno:2', 'b:DQ'],
        ['uno:2', 'r:1'],
        ['r:2', 'uno:5V'],
        ['a:VDD', 'uno:5V'],
        ['b:VDD', 'uno:5V'],
        ['a:GND', 'uno:GND.1'],
        ['b:GND', 'uno:GND.1'],
      ],
    );
    const { bench, lines, until } = load(doc, 'dallas-temperature');
    // b at 27.6 °C is above its high alarm (25); a keeps the power-up TL, 70 °C, so it alarms too.
    expect(until((l) => l.startsWith('alarms '), 3000)).toBe('alarms 2');
    expect(lines).toContain('count 2');
    expect(lines.filter((l) => l.startsWith('addr ')).map((l) => l.slice(7)).sort()).toEqual(['28-0000075A1B2C', '28-00000A0B0C0D']);
    expect(lines).toContain('parasite no');
    const took = Number(/took (\d+) ms/.exec(lines.find((l) => l.startsWith('took ')) ?? '')?.[1]);
    expect(took).toBeGreaterThanOrEqual(375); // 11 bits: 375 ms, polled until done
    expect(took).toBeLessThan(400);
    const temps = lines.filter((l) => /^t\d /.test(l)).map((l) => l.slice(3));
    expect(temps.sort()).toEqual([at(21.3, 11), at(27.6, 11)].sort());
    // Cool b to 22 °C (between its alarms): the next round finds a alone.
    bench.input('b', { kind: 'key', key: 'set:temperature=22', down: true });
    const seen = lines.length;
    for (let t = Math.floor(bench.now() / NS_PER_MS); t < 6000 && !lines.slice(seen).includes('alarms 1'); t += 50) bench.runUntil(t * NS_PER_MS);
    expect(lines.slice(seen)).toContain('alarms 1');
  }, 60_000);

  it('esp32/dallas-temperature: one sensor at 9 and 12 bits, as fast as the conversion', () => {
    const doc = circuit(
      { id: 'esp', type: 'esp32-devkit-v1' },
      [
        { id: 'ow', type: 'ds18b20', props: { serial: '000001234abc', temperature: 19.7 } },
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
    const { lines, until } = load(doc, 'dallas-temperature');
    const twelve = until((l) => l.startsWith('12 bit '), 5000) ?? '';
    expect(lines).toContain('count 1');
    const nine = lines.find((l) => l.startsWith('9 bit ')) ?? '';
    expect(nine.startsWith(`9 bit ${at(19.7, 9)} C in `)).toBe(true);
    expect(twelve.startsWith(`12 bit ${at(19.7, 12)} C in `)).toBe(true);
    expect(Number(/in (\d+) ms/.exec(twelve)?.[1])).toBeGreaterThanOrEqual(750);
    expect(Number(/in (\d+) ms/.exec(twelve)?.[1])).toBeLessThan(780);
  }, 60_000);

  it('uno/ledcontrol: "HELP 123." on the 7-segment module, a smiley on the matrix chained after it, then the count', () => {
    const doc = circuit(
      { id: 'uno', type: 'arduino-uno' },
      [
        { id: 'seg', type: 'max7219-7seg-8', props: {} },
        { id: 'm', type: 'max7219-matrix', props: {} },
      ],
      [
        ['uno:12', 'seg:DIN'],
        ['uno:11', 'seg:CLK'],
        ['uno:10', 'seg:CS'],
        ['uno:5V', 'seg:VCC'],
        ['uno:GND.1', 'seg:GND'],
        ['seg:DOUT', 'm:DIN'],
        ['seg:CLK.2', 'm:CLK'],
        ['seg:CS.2', 'm:CS'],
        ['seg:VCC.2', 'm:VCC'],
        ['seg:GND.2', 'm:GND'],
      ],
    );
    const { until, latest } = load(doc, 'ledcontrol');
    expect(until((l) => l === 'drawn', 1000)).toBe('drawn');
    expect(sevenSegmentText(latest.get('seg')?.values as number[])).toBe('HELP 123');
    expect(((latest.get('seg')?.segments as number[])[7] >> 7) & 1).toBe(1); // the point after the 3
    expect(latest.get('m')?.rows).toEqual([0x3c, 0x42, 0xa5, 0x81, 0xa5, 0x99, 0x42, 0x3c]);
    expect(until((l) => l === 'n=37', 6000)).toBe('n=37');
    expect(sevenSegmentText(latest.get('seg')?.values as number[])).toBe('HELP0037');
    expect((latest.get('m')?.rows as number[])[0]).toBe(37);
  }, 60_000);

  it('uno/tm1637-display: TM1637Display’s number with the colon, raw segments, off, leading zeros, then the count', () => {
    const doc = circuit({ id: 'uno', type: 'arduino-uno' }, [{ id: 'tm', type: 'tm1637-4digit', props: {} }], [
      ['uno:2', 'tm:CLK'],
      ['uno:3', 'tm:DIO'],
      ['uno:5V', 'tm:VCC'],
      ['uno:GND.1', 'tm:GND'],
    ]);
    const { until, latest } = load(doc, 'tm1637-display');
    const tm = (): VisualState => latest.get('tm') ?? {};
    expect(until((l) => l === '1234:', 500)).toBe('1234:');
    expect(displayText(tm())).toBe('1234');
    expect([tm().colon, tm().level]).toEqual([14 / 16, 14 / 16]);
    expect(until((l) => l === 'done', 1000)).toBe('done');
    expect(tm().segments).toEqual([0x5e, 0x3f, 0x54, 0x79]); // d O n E
    expect(tm().colon).toBe(0);
    expect(until((l) => l === 'off', 1500)).toBe('off');
    expect([tm().level, displayText(tm())]).toEqual([0, '    ']);
    expect(until((l) => l === '0042', 2000)).toBe('0042');
    expect([displayText(tm()), tm().level]).toEqual(['0042', 2 / 16]);
    expect(until((l) => l === 'n=23', 6000)).toBe('n=23');
    expect(displayText(tm())).toBe('  23');
  }, 60_000);

  it('uno/tm1637-thermometer: a DS18B20 under DallasTemperature shown on the TM1637 as "21°C", following the sensor', () => {
    const doc = circuit(
      { id: 'uno', type: 'arduino-uno' },
      [
        { id: 'ow', type: 'ds18b20', props: { serial: '0000075a1b2c', temperature: 21.3 } },
        { id: 'r', type: 'resistor', props: { ohms: 4700 } },
        { id: 'tm', type: 'tm1637-4digit', props: {} },
      ],
      [
        ['uno:2', 'ow:DQ'],
        ['uno:2', 'r:1'],
        ['r:2', 'uno:5V'],
        ['ow:VDD', 'uno:5V'],
        ['ow:GND', 'uno:GND.1'],
        ['uno:3', 'tm:CLK'],
        ['uno:4', 'tm:DIO'],
        ['tm:VCC', 'uno:5V'],
        ['tm:GND', 'uno:GND.1'],
      ],
    );
    const { bench, lines, until, latest } = load(doc, 'tm1637-thermometer');
    expect(until((l) => l.startsWith('t '), 2000)).toBe('t 21.31'); // 12 bits: 21.3125
    until(() => false, Math.floor(bench.now() / NS_PER_MS) + 50);
    expect(displayText(latest.get('tm'))).toBe('21°C');
    expect(latest.get('tm')?.level).toBe(12 / 16); // brightness 5
    for (const [celsius, shown] of [
      [-4.6, '-5°C'],
      [7, ' 7°C'],
      [-12.2, '-12C'],
      [125, '125C'],
    ] as const) {
      bench.input('ow', { kind: 'key', key: `set:temperature=${celsius}`, down: true });
      const seen = lines.length;
      // The next conversion samples it; the one after shows it for sure.
      until((l) => lines.indexOf(l) >= seen + 1 && l.startsWith('t '), Math.floor(bench.now() / NS_PER_MS) + 4000);
      until(() => false, Math.floor(bench.now() / NS_PER_MS) + 50);
      expect(displayText(latest.get('tm')), `${celsius} °C`).toBe(shown);
    }
    expect(lines).not.toContain('t no sensor');
  }, 60_000);
});
