import { avrMcuFactory } from '@benchtop/avr';
import { Bench, type BenchEnv, NS_PER_MS, parseProject, type PartInstance, type ProjectDoc, type Wire } from '@benchtop/core';
import { esp32McuFactory } from '@benchtop/esp32';
import { describe, expect, it } from 'vitest';
import { readFixture, readFixtureText } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { loadCachedRom } from '../../../esp32/src/test-support/rom.test-helper.ts';
import { benchEnvParts } from '../catalog.ts';
import { measurementMs } from '../sensors/bme280.ts';

// BT191: a BME280 on an Uno's I2C (forced mode, x1) and a BMP280 on an ESP32's VSPI (normal mode,
// filter x16), each with the datasheet's compensation in the sketch.

const esp32 = esp32McuFactory(loadCachedRom());
const env: BenchEnv = { part: benchEnvParts, createMcu: (board, id, report) => avrMcuFactory(board) ?? esp32(board, id, report) };

function circuit(board: { id: string; type: string }, parts: Omit<PartInstance, 'x' | 'y' | 'rotation'>[], wires: [string, string][]): ProjectDoc {
  return {
    format: 1,
    name: 'bme280 test',
    parts: [{ id: board.id, type: board.type, x: 0, y: 0, rotation: 0, props: {} }, ...parts.map((p, i) => ({ ...p, x: 100 + i * 30, y: 0, rotation: 0 as const }))],
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
  const until = (test: (line: string) => boolean, limit: number): string | undefined => {
    for (let t = Math.floor(bench.now() / NS_PER_MS) + 10; t <= limit; t += 10) {
      bench.runUntil(t * NS_PER_MS);
      const line = [...lines].reverse().find(test);
      if (line !== undefined) return line;
    }
    return undefined;
  };
  return { bench, lines, until };
}

const reading = (line: string | undefined): number[] => (line ?? '').match(/-?\d+\.\d+/g)?.map(Number) ?? [];

describe('BME280 / BMP280 on real firmware (BT191)', () => {
  it('uno/bme280: I2C, forced mode — the set temperature, pressure and humidity, the measurement time', () => {
    const doc = circuit({ id: 'uno', type: 'arduino-uno' }, [{ id: 'env', type: 'bme280', props: { temperature: 24.6, humidity: 38.5, pressure: 1002.4 } }], [
      ['uno:A4.2', 'env:SDA'],
      ['uno:A5.2', 'env:SCL'],
      ['uno:5V', 'env:VCC'],
      ['uno:GND.1', 'env:GND'],
    ]);
    const { bench, lines, until } = load(doc, 'bme280');
    const first = until((l) => l.startsWith('t '), 2000);
    expect(lines).toContain('id 0x60');
    const wait = Number(/wait (\d+) ms/.exec(lines.find((l) => l.startsWith('wait')) ?? '')?.[1]);
    expect(Math.abs(wait - measurementMs(1, 1, 1))).toBeLessThanOrEqual(1); // 9.3 ms
    const [t, p, h] = reading(first);
    // x1 oversampling: 16-bit words, so within their steps.
    expect(Math.abs(t - 24.6)).toBeLessThan(0.1);
    expect(Math.abs(p - 1002.4)).toBeLessThan(0.1);
    expect(Math.abs(h - 38.5)).toBeLessThan(0.02);
    bench.input('env', { kind: 'key', key: 'set:humidity=71', down: true });
    const count = lines.length;
    expect(until((l) => lines.indexOf(l) >= count && l.startsWith('t '), 3000)).toBeDefined();
    expect(Math.abs(reading(lines[lines.length - 1])[2] - 71)).toBeLessThan(0.02);
  }, 30_000);

  it('esp32/bmp280-spi: SPI, normal mode with the filter — the value, then a step eased in', () => {
    const doc = circuit({ id: 'esp', type: 'esp32-devkit-v1' }, [{ id: 'baro', type: 'bmp280', props: { temperature: 18.2, pressure: 950 } }], [
      ['esp:D18', 'baro:SCL'],
      ['esp:D23', 'baro:SDA'],
      ['esp:D19', 'baro:SDO'],
      ['esp:D5', 'baro:CSB'],
      ['esp:3V3', 'baro:VCC'],
      ['esp:GND.1', 'baro:GND'],
    ]);
    const { bench, lines, until } = load(doc, 'bmp280-spi');
    expect(until((l) => l.startsWith('t '), 3000)).toBeDefined();
    expect(lines).toContain('id 0x58');
    // The filter starts from its first sample: the first reading is already the value.
    const [t, p] = reading(lines.find((l) => l.startsWith('t ')));
    expect(t).toBeCloseTo(18.2, 1);
    expect(p).toBeCloseTo(950, 1);
    bench.input('baro', { kind: 'key', key: 'set:pressure=960', down: true });
    const count = lines.length;
    until((l) => lines.indexOf(l) >= count && l.startsWith('t '), Math.floor(bench.now() / NS_PER_MS) + 600);
    const eased = reading(lines[lines.length - 1])[1];
    expect(eased).toBeGreaterThan(951); // under way…
    expect(eased).toBeLessThan(959.5); // …not there yet (×16, one sample every ≈ 99 ms)
    until(() => false, Math.floor(bench.now() / NS_PER_MS) + 8000);
    expect(reading(lines[lines.length - 1])[1]).toBeCloseTo(960, 1);
  }, 60_000);

  it('BT194: uno/bme280-adafruit — Adafruit_BME280 in forced mode reads the set values and the altitude', () => {
    const doc = circuit({ id: 'uno', type: 'arduino-uno' }, [{ id: 'env', type: 'bme280', props: { temperature: 19.8, humidity: 55, pressure: 954.6 } }], [
      ['uno:A4.2', 'env:SDA'],
      ['uno:A5.2', 'env:SCL'],
      ['uno:5V', 'env:VCC'],
      ['uno:GND.1', 'env:GND'],
    ]);
    const { lines, until } = load(doc, 'bme280-adafruit');
    const line = until((l) => l.startsWith('t '), 2000);
    expect(lines).toContain('begin ok');
    const [t, p, h, alt] = reading(line);
    expect(Math.abs(t - 19.8)).toBeLessThan(0.1); // ×1: 16-bit words
    expect(Math.abs(p - 954.6)).toBeLessThan(0.1);
    expect(Math.abs(h - 55)).toBeLessThan(0.05);
    // The library's formula: 44330 · (1 − (p / 1013.25)^0.1903).
    expect(alt).toBeCloseTo(44330 * (1 - (p / 1013.25) ** 0.1903), 0);
  }, 30_000);

  it('BT194: esp32/bmp280-adafruit — Adafruit_BMP280 on hardware SPI, normal mode with the filter', () => {
    const doc = circuit({ id: 'esp', type: 'esp32-devkit-v1' }, [{ id: 'baro', type: 'bmp280', props: { temperature: 31.4, pressure: 1021.3 } }], [
      ['esp:D18', 'baro:SCL'],
      ['esp:D23', 'baro:SDA'],
      ['esp:D19', 'baro:SDO'],
      ['esp:D5', 'baro:CSB'],
      ['esp:3V3', 'baro:VCC'],
      ['esp:GND.1', 'baro:GND'],
    ]);
    const { lines, until } = load(doc, 'bmp280-adafruit');
    until((l) => l.startsWith('t '), 4000);
    expect(lines).toContain('begin ok');
    const [t, p] = reading(lines.filter((l) => l.startsWith('t ')).at(-1));
    expect(t).toBeCloseTo(31.4, 1);
    expect(p).toBeCloseTo(1021.3, 1);
  }, 60_000);
});
