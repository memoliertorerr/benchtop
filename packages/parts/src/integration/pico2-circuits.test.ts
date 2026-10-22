import { Bench, type BenchEnv, NS_PER_MS, parseProject, type VisualState } from '@benchtop/core';
import { rp2350McuFactory } from '@benchtop/rp2350';
import { describe, expect, it } from 'vitest';
import { readFixture, readFixtureText } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { cachedRom } from '../../../rp2350/src/rp2350.test-helper.ts';
import { benchEnvParts } from '../catalog.ts';
import { applyTftUpdate, TFT_PACKED, TFT_WIDTH, unpackPixel } from '../displays/ili9341.ts';

// BT66: the Raspberry Pi Pico 2 (RP2350, RISC-V cores) on full benches with the Pico's sketches
// rebuilt for it — USB serial, the ADC from a potentiometer, PWM into an LED, Wire to the SSD1306,
// SPI to the ILI9341, a pin interrupt, NeoPixels through PIO. The bootrom comes from
// .cache/rp2350-rom (these tests fail with the fetch command without it).

function load(project: string, firmware: string) {
  const rom = cachedRom();
  const env: BenchEnv = { part: benchEnvParts, createMcu: (board, id, report) => rp2350McuFactory(board, id, report, { rom }) };
  const parsed = parseProject(JSON.parse(readFixtureText(`fixtures/projects/${project}.json`)));
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const bench = new Bench(parsed.doc, env);
  bench.attachFirmware('pico', { format: 'uf2', bytes: readFixture(`fixtures/firmware/pico2/${firmware}.uf2`) });
  bench.reset();
  let serial = '';
  bench.onSerial('pico', (bytes) => (serial += String.fromCharCode(...bytes)));
  const latest = new Map<string, VisualState>();
  const tft = new Array<number>(TFT_PACKED).fill(0);
  const runTo = (ms: number, every = 5, each?: (ms: number) => void): void => {
    for (let t = Math.floor(bench.now() / NS_PER_MS) + every; t <= ms; t += every) {
      bench.runUntil(t * NS_PER_MS);
      for (const [part, visual] of bench.collectFrame().parts) {
        latest.set(part, structuredClone(visual));
        if (part === 'tft') applyTftUpdate(tft, visual);
      }
      each?.(t);
    }
  };
  return { bench, runTo, latest, tft, serial: () => serial };
}

const oledPixel = (fb: number[], x: number, y: number): number => (((fb[((y >> 3) * 128 + x) >> 2] >>> (8 * (((y >> 3) * 128 + x) & 3))) & 0xff) >> (y & 7)) & 1;

describe('Raspberry Pi Pico 2 circuits (BT66)', () => {
  it('blink: the onboard LED (GP25 through TP5) blinks; USB serial comes up', () => {
    const t = load('pico2-blink', 'blink');
    let flips = 0;
    let last: boolean | undefined;
    t.runTo(2200, 20, () => {
      const on = Number(t.latest.get('pico')?.led ?? 0) > 0.5;
      if (last !== undefined && on !== last) flips++;
      last = on;
    });
    expect(flips).toBeGreaterThanOrEqual(3);
  }, 30_000);

  it('analog-read: the pot on GP26 reads 12-bit within ±8, on USB serial', () => {
    const t = load('pico2-analog-read', 'analog-read');
    t.runTo(300); // the pot's starting position (mid-way) reaches the ADC without an input
    expect(Math.abs(Number([...t.serial().matchAll(/adc=(\d+)/g)].at(-1)?.[1]) - 2048)).toBeLessThanOrEqual(8);
    for (const position of [0.25, 0.75, 1, 0]) {
      t.bench.input('pot', { kind: 'value', value: position });
      const before = t.serial().length;
      t.runTo(Math.floor(t.bench.now() / NS_PER_MS) + 300);
      const readings = [...t.serial().slice(before).matchAll(/adc=(\d+)/g)].map((m) => Number(m[1]));
      expect(readings.length).toBeGreaterThan(0);
      expect(Math.abs((readings.at(-1) as number) - Math.round(position * 4095)), `position ${position}`).toBeLessThanOrEqual(8);
    }
    expect(t.bench.problems().filter((p) => p.severity !== 'info')).toEqual([]);
  }, 30_000);

  it('pwm-fade: the LED on GP15 steps through the duties', () => {
    const t = load('pico2-pwm-fade', 'pwm-fade');
    const brightness: number[] = [];
    t.runTo(1000, 50, (ms) => {
      if ((ms - 100) % 200 === 0) brightness.push(Number(t.latest.get('led1')?.brightness ?? 0));
    });
    expect(brightness.map((b) => Math.round(b * 100))).toEqual([0, 25, 50, 75, 100].map((d) => expect.closeTo(d, -1) as unknown as number));
  }, 30_000);

  it('i2c-oled: Adafruit SSD1306 over Wire on GP4/GP5 draws the box and text', () => {
    const t = load('pico2-i2c-oled', 'i2c-oled');
    t.runTo(1500);
    expect(t.serial()).toContain('frame 1\r\n');
    const fb = (t.latest.get('oled')?.fb ?? []) as number[];
    expect([oledPixel(fb, 0, 0), oledPixel(fb, 31, 15), oledPixel(fb, 32, 15), oledPixel(fb, 100, 60)]).toEqual([1, 1, 0, 0]);
  }, 30_000);

  it('i2c-scan: one-byte writes to 0x08–0x77 find the SSD1306 alone, within a millisecond', () => {
    // An address NACK used to wait out Wire's 1 s timeout per empty address (a 111 s scan).
    const t = load('pico2-i2c-oled', 'i2c-scan');
    t.runTo(400);
    const scans = [...t.serial().matchAll(/scan \d+:(.*?) \| codes ([\d ]+) \| read (\d+) \| timeout (\d) \| (\d+) us\r\n/g)];
    expect(scans.length).toBeGreaterThanOrEqual(2);
    for (const [, found, codes, read, timeout, us] of scans) {
      expect({ found, codes, read, timeout }).toEqual({ found: ' 0x3C', codes: '1 0 0 0 111 0', read: '0', timeout: '0' });
      expect(Number(us)).toBeLessThan(2000);
    }
    expect(t.bench.problems().filter((p) => p.severity !== 'info')).toEqual([]);
  }, 30_000);

  it('spi-tft: the ILI9341 over SPI0 shows the TFT demo picture', () => {
    const t = load('pico2-spi-tft', 'spi-tft');
    t.runTo(1600);
    expect(t.serial()).toContain('drawn\r\n');
    const at = (x: number, y: number): number => unpackPixel(t.tft, y * TFT_WIDTH + x);
    expect([at(5, 5), at(15, 15), at(109, 59), at(110, 59), at(140, 30), at(20, 80), at(229, 109), at(5, 300)]).toEqual([0x0000, 0xf800, 0xf800, 0x0000, 0x07e0, 0x001f, 0x001f, 0x0000]);
  }, 60_000);

  it('button-irq: each press of the button on GP14 raises one falling-edge interrupt', () => {
    const t = load('pico2-button-irq', 'button-irq');
    t.runTo(300);
    for (let i = 0; i < 3; i++) {
      t.bench.input('btn1', { kind: 'press' });
      t.runTo(Math.floor(t.bench.now() / NS_PER_MS) + 50);
      t.bench.input('btn1', { kind: 'release' });
      t.runTo(Math.floor(t.bench.now() / NS_PER_MS) + 50);
    }
    expect(t.serial()).toContain('presses=3\r\n');
    expect(t.serial()).not.toContain('presses=4');
  }, 30_000);

  it('neopixel: the PIO WS2812 program lights the strip with the sketch\'s colors', () => {
    const t = load('pico2-neopixel', 'neopixel');
    const firsts: number[] = [];
    t.runTo(1600, 50, (ms) => {
      if (ms % 500 === 250) firsts.push(Number((t.latest.get('strip')?.pixels as number[] | undefined)?.[0] ?? -1));
    });
    expect(firsts).toEqual([0xff0000, 0x00ff00, 0x0000ff]);
    const strip = t.latest.get('strip');
    expect((strip?.pixels as number[]).slice(1)).toEqual([0x00ff00, 0x0000ff, 0x101010, 0xffff00, 0x00ffff, 0xff00ff, 0x000000]);
    expect(strip?.errors).toBe(0);
  }, 30_000);
});
