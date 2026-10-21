import { Bench, type BenchEnv, NS_PER_MS, parseProject, type VisualState } from '@benchtop/core';
import { rp2040McuFactory } from '@benchtop/rp2040';
import { describe, expect, it } from 'vitest';
import { readFixture, readFixtureText } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { benchEnvParts } from '../catalog.ts';
import { applyTftUpdate, TFT_PACKED, TFT_WIDTH, unpackPixel } from '../displays/ili9341.ts';

// BT61: the Raspberry Pi Pico on full benches with arduino-pico 6.2.0 firmware — the ADC from a
// potentiometer, PWM into an LED, Wire to the SSD1306, SPI to the ILI9341, a pin interrupt.

const env: BenchEnv = { part: benchEnvParts, createMcu: (board, id, report) => rp2040McuFactory(board, id, report) };

function load(project: string, firmware: string) {
  const parsed = parseProject(JSON.parse(readFixtureText(`fixtures/projects/${project}.json`)));
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const bench = new Bench(parsed.doc, env);
  bench.attachFirmware('pico', { format: 'uf2', bytes: readFixture(`fixtures/firmware/pico/${firmware}.uf2`) });
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

/** The SSD1306's packed framebuffer as 1024 page-major bytes. */
function oledBytes(visual: VisualState | undefined): number[] {
  const fb = (visual?.fb ?? []) as number[];
  return Array.from({ length: 1024 }, (_, i) => (fb[i >> 2] >>> (8 * (i & 3))) & 0xff);
}
const oledPixel = (bytes: number[], x: number, y: number): number => (bytes[(y >> 3) * 128 + x] >> (y & 7)) & 1;

describe('Raspberry Pi Pico circuits (BT61)', () => {
  it('analog-read: the pot on GP26 reads 12-bit within ±8', () => {
    const t = load('pico-analog-read', 'analog-read');
    for (const position of [0.25, 0.75, 1, 0]) {
      t.bench.input('pot', { kind: 'value', value: position });
      const before = t.serial().length;
      t.runTo(Math.floor(t.bench.now() / NS_PER_MS) + 250);
      const readings = [...t.serial().slice(before).matchAll(/adc=(\d+)/g)].map((m) => Number(m[1]));
      expect(readings.length).toBeGreaterThan(0);
      const last = readings.at(-1) as number;
      expect(Math.abs(last - Math.round(position * 4095)), `position ${position}: ${last}`).toBeLessThanOrEqual(8);
    }
    expect(t.bench.problems().filter((p) => p.severity !== 'info')).toEqual([]);
  }, 30_000);

  it('pwm-fade: the LED on GP15 steps through the duties', () => {
    const t = load('pico-pwm-fade', 'pwm-fade');
    const brightness: number[] = [];
    t.runTo(1000, 50, (ms) => {
      if ((ms - 100) % 200 === 0) brightness.push(Number(t.latest.get('led1')?.brightness ?? 0));
    });
    // Sampled mid-step (100, 300, … ms): duty 0, 64, 128, 192, 255 of 255.
    expect(brightness.map((b) => Math.round(b * 100))).toEqual([0, 25, 50, 75, 100].map((d) => expect.closeTo(d, -1) as unknown as number));
  }, 30_000);

  it('i2c-oled: Adafruit SSD1306 over Wire on GP4/GP5 draws the box and text', () => {
    const t = load('pico-i2c-oled', 'i2c-oled');
    t.runTo(1500);
    expect(t.serial()).toContain('frame 1\r\n');
    const bytes = oledBytes(t.latest.get('oled'));
    expect([oledPixel(bytes, 0, 0), oledPixel(bytes, 31, 15), oledPixel(bytes, 32, 15), oledPixel(bytes, 100, 60)]).toEqual([1, 1, 0, 0]);
    // "PICO" at size 2 from x = 40: the P's first column is lit from the top.
    expect(oledPixel(bytes, 40, 0) + oledPixel(bytes, 40, 4) + oledPixel(bytes, 40, 8)).toBe(3);
  }, 30_000);

  it('spi-tft: the sketch-local driver on SPI0 draws the TFT demo picture', () => {
    const t = load('pico-spi-tft', 'spi-tft');
    t.runTo(1600);
    expect(t.serial()).toContain('drawn\r\n');
    const at = (x: number, y: number): number => unpackPixel(t.tft, y * TFT_WIDTH + x);
    expect([at(5, 5), at(15, 15), at(109, 59), at(110, 59), at(140, 30), at(20, 80), at(229, 109), at(5, 300)]).toEqual([
      0x0000, 0xf800, 0xf800, 0x0000, 0x07e0, 0x001f, 0x001f, 0x0000,
    ]);
    expect([at(10, 130), at(12, 150), at(28, 130), at(16, 133)]).toEqual([0xffff, 0xffff, 0xffff, 0x0000]);
  }, 60_000);

  it('button-irq: each press of the button on GP14 raises one falling-edge interrupt', () => {
    const t = load('pico-button-irq', 'button-irq');
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
});

describe('Raspberry Pi Pico PIO and DMA (BT62)', () => {
  it('neopixel: the PIO WS2812 program lights the strip with the sketch\'s colors', () => {
    const t = load('pico-neopixel', 'neopixel');
    const firsts: number[] = [];
    t.runTo(1600, 50, (ms) => {
      if (ms % 500 === 250) firsts.push(Number((t.latest.get('strip')?.pixels as number[] | undefined)?.[0] ?? -1));
    });
    expect(t.serial()).toContain('shown 2\r\n');
    // Pixel 0 steps red → green → blue every 500 ms (sampled mid-step); 1–7 hold their colors.
    expect(firsts).toEqual([0xff0000, 0x00ff00, 0x0000ff]);
    const strip = t.latest.get('strip');
    expect((strip?.pixels as number[]).slice(1)).toEqual([0x00ff00, 0x0000ff, 0x101010, 0xffff00, 0x00ffff, 0xff00ff, 0x000000]);
    expect(strip?.errors).toBe(0);
    expect(t.bench.problems().filter((p) => p.severity !== 'info')).toEqual([]);
  }, 30_000);

  it('spi-tft-dma: DMA paced by SPI0\'s TX DREQ, in 16-bit frames, draws the spi-tft picture', () => {
    const dma = load('pico-spi-tft', 'spi-tft-dma');
    dma.runTo(1600);
    expect(dma.serial()).toContain('drawn\r\n');
    const plain = load('pico-spi-tft', 'spi-tft');
    plain.runTo(1600);
    expect(dma.tft).toEqual(plain.tft);
    expect(dma.tft.some((word) => word !== 0)).toBe(true);
  }, 60_000);
});
