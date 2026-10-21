import { avrMcuFactory } from '@benchtop/avr';
import { Bench, type BenchEnv, type FirmwareImage, NS_PER_MS, parseProject } from '@benchtop/core';
import { esp32McuFactory } from '@benchtop/esp32';
import { describe, expect, it } from 'vitest';
import { readFixture, readFixtureText } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { loadCachedRom } from '../../../esp32/src/test-support/rom.test-helper.ts';
import { benchEnvParts } from '../catalog.ts';
import { applyTftUpdate, TFT_PACKED, TFT_WIDTH, unpackPixel } from '../displays/ili9341.ts';

// BT51: the ILI9341 driven by real firmware — a sketch-local driver on the Uno's hardware SPI and
// on the ESP32's VSPI — read back from the framebuffer the frames stream (as the UI accumulates it).

const ROM = loadCachedRom();

function load(project: string, board: string, image: FirmwareImage) {
  const parsed = parseProject(JSON.parse(readFixtureText(`fixtures/projects/${project}.json`)));
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const esp32 = esp32McuFactory(ROM);
  const env: BenchEnv = { part: benchEnvParts, createMcu: (b, id, report) => avrMcuFactory(b) ?? esp32(b, id, report) };
  const bench = new Bench(parsed.doc, env);
  bench.attachFirmware(board, image);
  bench.reset();
  let serial = '';
  bench.onSerial(board, (bytes) => (serial += String.fromCharCode(...bytes)));
  const frame = new Array<number>(TFT_PACKED).fill(0);
  /** Packed numbers each partial update carried, with its time (ms). */
  const sizes: { t: number; n: number }[] = [];
  let on = false;
  const runTo = (ms: number): void => {
    for (let t = Math.floor(bench.now() / NS_PER_MS) + 5; t <= ms; t += 5) {
      bench.runUntil(t * NS_PER_MS);
      for (const [part, visual] of bench.collectFrame().parts) {
        if (part !== 'tft') continue;
        on = visual.on === true;
        applyTftUpdate(frame, visual);
        if (visual.tftFull !== true && Array.isArray(visual.tftPixels)) sizes.push({ t, n: visual.tftPixels.length });
      }
    }
  };
  const at = (x: number, y: number): number => unpackPixel(frame, y * TFT_WIDTH + x);
  const largestSince = (ms: number): number => Math.max(0, ...sizes.filter((s) => s.t > ms).map((s) => s.n));
  return { bench, runTo, at, serial: () => serial, largestSince, on: () => on };
}

const BLACK = 0x0000;
const RED = 0xf800;
const GREEN = 0x07e0;
const BLUE = 0x001f;
const WHITE = 0xffff;
const YELLOW = 0xffe0;

/** The picture both sketches draw (see fixtures/sketches/uno/tft-demo). */
function expectPicture(t: ReturnType<typeof load>): void {
  expect(t.on()).toBe(true);
  expect([t.at(5, 5), t.at(15, 15), t.at(109, 59), t.at(110, 59), t.at(140, 30), t.at(20, 80), t.at(229, 109), t.at(5, 300)]).toEqual([
    BLACK, RED, RED, BLACK, GREEN, BLUE, BLUE, BLACK,
  ]);
  // "B" at (10, 130), ×3: its first column is all seven rows; "E" starts 18 px on.
  expect([t.at(10, 130), t.at(12, 150), t.at(28, 130), t.at(16, 133)]).toEqual([WHITE, WHITE, WHITE, BLACK]);
}

describe('ILI9341 TFT circuits (BT51)', () => {
  it('Uno: the sketch-local driver draws the picture, then yellow digits; updates travel as small rectangles', () => {
    const t = load('tft-demo', 'uno', { format: 'hex', text: readFixtureText('fixtures/firmware/uno/tft-demo.hex') });
    t.runTo(1100); // "drawn" at ~0.73 s, then "0"; "1" follows 500 ms later
    expect(t.serial()).toBe('drawn\r\n0\r\n');
    expectPicture(t);
    // "0" ×4 at (10, 200): its first column has rows 1–5 lit (0x3E).
    expect([t.at(10, 200), t.at(10, 204), t.at(10, 220)]).toEqual([BLACK, YELLOW, YELLOW]);
    // Once the picture is up, an update carries only what changed — the digit's 20×28 box
    // (280 numbers), not the 240×320 screen (38,400).
    t.runTo(2600);
    expect(t.largestSince(800)).toBeGreaterThan(0);
    expect(t.largestSince(800)).toBeLessThanOrEqual((20 * 28) / 2);
  }, 60_000);

  it('ESP32: the same picture over VSPI', () => {
    const t = load('esp32-tft-demo', 'esp', {
      format: 'esp32-bin',
      app: readFixture('fixtures/firmware/esp32/tft-demo.bin'),
      partitions: readFixture('fixtures/firmware/esp32/tft-demo.partitions.bin'),
    });
    t.runTo(1000);
    expect(t.serial()).toContain('drawn');
    expectPicture(t);
  }, 60_000);
});
