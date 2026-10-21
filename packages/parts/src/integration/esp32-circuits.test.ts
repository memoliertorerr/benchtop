import { avrMcuFactory } from '@benchtop/avr';
import { Bench, type BenchEnv, NS_PER_MS, parseProject } from '@benchtop/core';
import { type Esp32Mcu, esp32McuFactory } from '@benchtop/esp32';
import { describe, expect, it } from 'vitest';
import { readFixture, readFixtureText } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { loadCachedRom } from '../../../esp32/src/test-support/rom.test-helper.ts';
import { benchEnvParts } from '../catalog.ts';

// BT34: real ESP32 firmware on an ESP32 DevKit V1 on a full Bench — the same path the worker
// and the CLI take (esp32McuFactory with the cached ROM).

const ROM = loadCachedRom();

function load(project: string, firmware: string) {
  const parsed = parseProject(JSON.parse(readFixtureText(`fixtures/projects/${project}.json`)));
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const esp32 = esp32McuFactory(ROM);
  let mcu: Esp32Mcu | null = null;
  const env: BenchEnv = {
    part: benchEnvParts,
    createMcu: (board, id, report) => {
      const created = avrMcuFactory(board) ?? esp32(board, id, report);
      if (board.mcu === 'esp32') mcu = created as Esp32Mcu;
      return created;
    },
  };
  const bench = new Bench(parsed.doc, env);
  bench.attachFirmware('esp', {
    format: 'esp32-bin',
    app: readFixture(`fixtures/firmware/esp32/${firmware}.bin`),
    partitions: readFixture(`fixtures/firmware/esp32/${firmware}.partitions.bin`),
  });
  bench.reset();
  const serial: number[] = [];
  bench.onSerial('esp', (bytes) => serial.push(...bytes));
  return { bench, text: () => String.fromCharCode(...serial), mcu: (): Esp32Mcu => mcu! };
}

/** Runs the bench in 10 ms steps until `done()` or `maxMs`. */
function runTo(bench: Bench, maxMs: number, done: () => boolean): void {
  for (let t = bench.now() / NS_PER_MS + 10; t <= maxMs && !done(); t += 10) bench.runUntil(t * NS_PER_MS);
}

describe('ESP32 DevKit V1 on the bench (BT34)', () => {
  it('blink: the LED on D2 and the onboard LED toggle every 500 ms ±1 % of bench time', () => {
    const { bench } = load('esp32-blink', 'blink');
    const led: [number, number][] = [];
    const board: [number, number][] = [];
    for (let t = 1; t <= 4500; t++) {
      bench.runUntil(t * NS_PER_MS);
      for (const [part, visual] of bench.collectFrame().parts) {
        if (part === 'led1') led.push([t, Number(visual.brightness)]);
        if (part === 'esp') board.push([t, Number(visual.led1)]);
      }
    }
    expect(bench.mcuStopped('esp')).toBeNull();
    const edges = (series: [number, number][]): number[] => series.filter(([, v], i) => i > 0 && v !== series[i - 1][1]).map(([t]) => t);
    const ledEdges = edges(led).filter((t) => t >= 1000);
    expect(ledEdges.length).toBeGreaterThanOrEqual(6);
    for (let i = 1; i < ledEdges.length; i++) {
      expect(ledEdges[i] - ledEdges[i - 1]).toBeGreaterThanOrEqual(495);
      expect(ledEdges[i] - ledEdges[i - 1]).toBeLessThanOrEqual(505);
    }
    // The onboard LED follows GPIO2 at the same instants (to the 1 ms frame step).
    expect(edges(board).filter((t) => t >= 1000)).toEqual(ledEdges);
    expect(bench.problems().filter((p) => p.severity === 'error')).toEqual([]);
  }, 120_000);

  it('ledc-fade: the LED on D2 shows analogWrite(2, 64) as 25 % brightness (±2 %)', () => {
    const { bench } = load('esp32-blink', 'ledc-fade');
    let brightness = -1;
    for (let t = 50; t <= 900; t += 50) {
      bench.runUntil(t * NS_PER_MS);
      for (const [part, visual] of bench.collectFrame().parts) if (part === 'led1') brightness = Number(visual.brightness);
    }
    expect(Math.abs(brightness - 64 / 255)).toBeLessThanOrEqual(0.02);
  }, 60_000);

  it('gpio-input: a button from D4 to GND (INPUT_PULLUP) lights the LED on D2 within 2 ms of the press', () => {
    const { bench } = load('esp32-button', 'gpio-input');
    let t = 300; // past boot and setup()
    bench.runUntil(t * NS_PER_MS);
    expect(bench.pinState('esp', 'D2')?.level).toBe(0);
    expect(bench.pinState('esp', 'D4')?.level).toBe(1); // the pull-up
    bench.input('btn1', { kind: 'press' });
    t += 2;
    bench.runUntil(t * NS_PER_MS);
    expect(bench.pinState('esp', 'D2')?.level).toBe(1);
    bench.input('btn1', { kind: 'release' });
    t += 2;
    bench.runUntil(t * NS_PER_MS);
    expect(bench.pinState('esp', 'D2')?.level).toBe(0);
  }, 60_000);

  it('gpio-interrupt: attachInterrupt(4, FALLING) counts five presses → "count=5"', () => {
    const { bench, text } = load('esp32-button', 'gpio-interrupt');
    let t = 300;
    bench.runUntil(t * NS_PER_MS);
    for (let i = 0; i < 5; i++) {
      bench.input('btn1', { kind: 'press' });
      t += 20;
      bench.runUntil(t * NS_PER_MS);
      bench.input('btn1', { kind: 'release' });
      t += 20;
      bench.runUntil(t * NS_PER_MS);
    }
    t += 50;
    bench.runUntil(t * NS_PER_MS);
    expect(text()).toContain('count=5\n');
    expect(text()).not.toContain('count=6');
  }, 60_000);

  it('i2c-scan: Wire.begin() on 21/22 finds the SSD1306 (0x3C) and the DS1307 (0x68), and nothing on an empty bus', () => {
    const withParts = load('esp32-i2c', 'i2c-scan');
    runTo(withParts.bench, 2000, () => withParts.text().includes('done'));
    expect(withParts.text()).toBe('found 0x3C\nfound 0x68\ndone\r\n');
    const empty = load('esp32-blink', 'i2c-scan');
    runTo(empty.bench, 2000, () => empty.text().includes('done'));
    expect(empty.text()).toBe('done\r\n');
  }, 60_000);

  it('i2c-ds1307: raw register access sets 12:34:56 and reads 12:34:59 three seconds later; a 1-byte write takes 20 SCL periods', () => {
    const { bench, text, mcu } = load('esp32-i2c', 'i2c-ds1307');
    const transactions: { start: number; end: number; bytes: number }[] = [];
    mcu().soc.i2c[0].onTransaction = (start, end, bytes) => transactions.push({ start, end, bytes });
    runTo(bench, 6000, () => text().includes('done'));
    const time = /(\d\d):(\d\d):(\d\d)/.exec(text());
    expect(time).not.toBeNull();
    const seconds = Number(time![1]) * 3600 + Number(time![2]) * 60 + Number(time![3]);
    expect(Math.abs(seconds - (12 * 3600 + 34 * 60 + 59))).toBeLessThanOrEqual(1);
    // The last two: address + one byte at 100 kHz, then at 400 kHz (START + 2 × 9 bits + STOP).
    const [slow, fast] = transactions.slice(-2);
    expect([slow.bytes, fast.bytes]).toEqual([2, 2]);
    const us = (t: { start: number; end: number }): number => ((t.end - t.start) / 240e6) * 1e6;
    console.info(`1-byte I2C write: ${us(slow).toFixed(1)} µs at 100 kHz, ${us(fast).toFixed(1)} µs at 400 kHz`);
    expect(Math.abs(us(slow) / 200 - 1)).toBeLessThanOrEqual(0.05);
    expect(Math.abs(us(fast) / 50 - 1)).toBeLessThanOrEqual(0.05);
  }, 60_000);

  it('i2c-remap: Wire.begin(16, 17) moves I2C0 there; a DS1307 on 16/17 answers, one on 21/22 does not', () => {
    const remapped = load('esp32-i2c-remap', 'i2c-remap');
    runTo(remapped.bench, 2000, () => remapped.text().includes('done'));
    expect(remapped.text()).toBe('found 0x68\ndone\r\n');
    expect(remapped.mcu().i2c(0)!.pins()).toEqual({ sda: 'GPIO16', scl: 'GPIO17' });
    const old = load('esp32-i2c', 'i2c-remap');
    runTo(old.bench, 2000, () => old.text().includes('done'));
    expect(old.text()).toBe('done\r\n');
  }, 60_000);

  it('neopixel (BT37): a NeoPixel strip on D4 shows red, green, blue, dim white in turn, with clean WS2812 timing', () => {
    const { bench, text } = load('esp32-neopixel', 'neopixel');
    const seen: number[] = [];
    let stats: Record<string, unknown> = {};
    for (let t = 10; t <= 2500 && seen.length < 4; t += 10) {
      bench.runUntil(t * NS_PER_MS);
      for (const [part, visual] of bench.collectFrame().parts) {
        if (part !== 'strip') continue;
        const first = (visual.pixels as number[])[0];
        if (visual.bits === 24 && (seen.length === 0 || seen[seen.length - 1] !== first)) {
          seen.push(first);
          stats = visual;
        }
      }
    }
    expect(bench.mcuStopped('esp')).toBeNull();
    expect(text().startsWith('color 0\ncolor 1\ncolor 2\ncolor 3\n')).toBe(true);
    expect(seen).toEqual([0xff0000, 0x00ff00, 0x0000ff, 0x202020]);
    expect(stats.errors).toBe(0);
    for (const [key, ns] of [['t0hMin', 400], ['t0hMax', 400], ['t1hMin', 800], ['t1hMax', 800]] as const) expect(Math.abs(Number(stats[key]) - ns)).toBeLessThanOrEqual(50);
    expect(bench.problems().filter((p) => p.code === 'neopixel-timing' || p.severity === 'error')).toEqual([]);
  }, 60_000);
});
