import { avrMcuFactory } from '@benchtop/avr';
import { Bench, type BenchEnv, NS_PER_MS, parseProject, type PartInstance, type ProjectDoc, type VisualState, type Wire } from '@benchtop/core';
import { esp32McuFactory } from '@benchtop/esp32';
import { describe, expect, it } from 'vitest';
import { readFixture, readFixtureText } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { loadCachedRom } from '../../../esp32/src/test-support/rom.test-helper.ts';
import { benchEnvParts } from '../catalog.ts';

// BT181: the 0.91″ 128×32 on I2C and the 7-pin 128×64 on SPI — bit-banged from an Uno on
// Adafruit's example pins, hardware SPI (VSPI) from an ESP32. Each sketch prints the library's
// buffer; the panel must show exactly it (a byte seen twice, or lost, would shift the image).

const esp32 = esp32McuFactory(loadCachedRom());
const env: BenchEnv = { part: benchEnvParts, createMcu: (board, id, report) => avrMcuFactory(board) ?? esp32(board, id, report) };

function circuit(board: { id: string; type: string }, parts: Omit<PartInstance, 'x' | 'y' | 'rotation'>[], wires: [string, string][]): ProjectDoc {
  return {
    format: 1,
    name: 'oled module test',
    parts: [{ id: board.id, type: board.type, x: 0, y: 0, rotation: 0, props: {} }, ...parts.map((p, i) => ({ ...p, x: 100 + i * 40, y: 0, rotation: 0 as const }))],
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
      const line = lines.find(test);
      if (line !== undefined) return line;
    }
    return undefined;
  };
  return { bench, latest, lines, runTo, until };
}

/** A packed fb (rows × 4 numbers) as page-major bytes. */
function unpack(visual: VisualState | undefined, rows: number): number[] {
  const fb = (visual?.fb ?? []) as number[];
  const bytes: number[] = [];
  for (let i = 0; i < rows * 16; i++) bytes.push((fb[i >> 2] >>> (8 * (i & 3))) & 0xff);
  return bytes;
}

/** "FB:" + hex → bytes. */
function bufferOf(line: string): number[] {
  const hex = line.slice(3);
  return Array.from({ length: hex.length / 2 }, (_, i) => Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16));
}

describe('more SSD1306 modules (BT181)', () => {
  const i2c32 = (firmware: string) =>
    load(
      circuit({ id: 'uno', type: 'arduino-uno' }, [{ id: 'oled', type: 'ssd1306-128x32', props: {} }], [
        ['uno:A4', 'oled:SDA'],
        ['uno:A5', 'oled:SCL'],
        ['uno:5V', 'oled:VCC'],
        ['uno:GND.1', 'oled:GND'],
      ]),
      firmware,
    );

  it('uno/oled-128x32: the 0.91″ module shows the 512-byte buffer Adafruit_SSD1306 drew; its scroll moves it left', () => {
    const { bench, latest, lines, runTo, until } = i2c32('oled-128x32');
    const fb = until((l) => l.startsWith('FB:'), 3000);
    expect(fb).toBeDefined();
    const buffer = bufferOf(fb ?? '');
    expect(buffer).toHaveLength(512);
    expect(buffer.some((b) => b !== 0)).toBe(true);
    expect(latest.get('oled')?.on).toBe(true);
    expect(unpack(latest.get('oled'), 32)).toEqual(buffer);
    expect((latest.get('oled')?.fb as number[]).length).toBe(128);
    // 2 s later, "scroll": left at 175 Hz frames (MUX 32), a step every 5 → 35 a second.
    expect(until((l) => l === 'scroll', 6000)).toBe('scroll');
    runTo(bench.now() / NS_PER_MS + 1000);
    const moving = unpack(latest.get('oled'), 32);
    expect(moving).not.toEqual(buffer);
    // 35 steps a second (175 Hz frames at MUX 32, a step every 5): the image one second left.
    const shift = 35;
    const left = buffer.map((_, i) => buffer[(i & ~127) | (((i & 127) + shift + 128) % 128)]);
    expect(moving).toEqual(left);
    expect(until((l) => l === 'home', 9000)).toBe('home');
    expect(unpack(latest.get('oled'), 32)).toEqual(buffer); // redrawn after the stop
    expect(lines.filter((l) => l === 'scroll')).toHaveLength(1);
    expect(bench.problems().filter((p) => p.severity !== 'info')).toEqual([]);
  }, 60_000);

  it('a 128×64 sketch on the 128×32 module draws every other RAM row (squashed), as on a board', () => {
    const { latest, until } = i2c32('ssd1306-adafruit');
    const fb = until((l) => l.startsWith('FB:'), 3000);
    const buffer = bufferOf(fb ?? '');
    expect(buffer).toHaveLength(1024);
    const shown = unpack(latest.get('oled'), 32);
    const bit = (bytes: number[], x: number, y: number): number => (bytes[(y >> 3) * 128 + x] >> (y & 7)) & 1;
    for (let y = 0; y < 32; y++) for (let x = 0; x < 128; x += 7) expect(bit(shown, x, y), `${x},${y}`).toBe(bit(buffer, x, 2 * y + 1));
  }, 60_000);

  it('uno/oled-spi: bit-banged SPI on Adafruit’s example pins shows the library’s buffer, then the counter', () => {
    const doc = circuit({ id: 'uno', type: 'arduino-uno' }, [{ id: 'oled', type: 'ssd1306-spi', props: {} }], [
      ['uno:9', 'oled:D1'],
      ['uno:10', 'oled:D0'],
      ['uno:11', 'oled:DC'],
      ['uno:12', 'oled:CS'],
      ['uno:13', 'oled:RES'],
      ['uno:5V', 'oled:VCC'],
      ['uno:GND.1', 'oled:GND'],
    ]);
    const { bench, latest, until } = load(doc, 'oled-spi');
    const fb = until((l) => l.startsWith('FB:'), 3000);
    const buffer = bufferOf(fb ?? '');
    expect(buffer).toHaveLength(1024);
    expect(latest.get('oled')?.on).toBe(true);
    expect(unpack(latest.get('oled'), 64)).toEqual(buffer);
    expect(until((l) => l === 'count 2', 5000)).toBe('count 2');
    // The counter's digits at (52, 52) changed; nothing else did.
    const now = unpack(latest.get('oled'), 64);
    const changed = now.map((b, i) => (b !== buffer[i] ? i : -1)).filter((i) => i >= 0);
    expect(changed.length).toBeGreaterThan(0);
    for (const i of changed) {
      expect([6, 7], `byte ${i}`).toContain(i >> 7); // rows 52–59: pages 6 and 7
      expect(i & 127).toBeGreaterThanOrEqual(52);
    }
    // Software SPI on pins 9/10 is on no SPI controller: an info, nothing worse.
    expect(bench.problems().filter((p) => p.severity !== 'info')).toEqual([]);
    expect(bench.problems().map((p) => p.code)).toContain('spi-unattached');
  }, 60_000);

  it('RES held low keeps the module in reset: dark, and nothing it is sent lands', () => {
    const doc = circuit({ id: 'uno', type: 'arduino-uno' }, [{ id: 'oled', type: 'ssd1306-spi', props: {} }], [
      ['uno:9', 'oled:D1'],
      ['uno:10', 'oled:D0'],
      ['uno:11', 'oled:DC'],
      ['uno:12', 'oled:CS'],
      ['uno:GND.2', 'oled:RES'],
      ['uno:5V', 'oled:VCC'],
      ['uno:GND.1', 'oled:GND'],
    ]);
    const { latest, until } = load(doc, 'oled-spi');
    expect(until((l) => l.startsWith('FB:'), 3000)).toBeDefined();
    expect(latest.get('oled')?.on ?? false).toBe(false);
    expect(unpack(latest.get('oled'), 64).every((b) => b === 0)).toBe(true);
  }, 60_000);

  it('esp32/oled-spi: hardware SPI (VSPI) shows the library’s buffer, each byte once, then the uptime', () => {
    const doc = circuit({ id: 'esp', type: 'esp32-devkit-v1' }, [{ id: 'oled', type: 'ssd1306-spi', props: {} }], [
      ['esp:D18', 'oled:D0'],
      ['esp:D23', 'oled:D1'],
      ['esp:RX2', 'oled:DC'],
      ['esp:D5', 'oled:CS'],
      ['esp:TX2', 'oled:RES'],
      ['esp:3V3', 'oled:VCC'],
      ['esp:GND.1', 'oled:GND'],
    ]);
    const { bench, latest, until } = load(doc, 'oled-spi');
    const fb = until((l) => l.startsWith('FB:'), 4000);
    const buffer = bufferOf(fb ?? '');
    expect(buffer).toHaveLength(1024);
    expect(unpack(latest.get('oled'), 64)).toEqual(buffer);
    expect(until((l) => l === 'tick 2', 6000)).toBe('tick 2');
    const now = unpack(latest.get('oled'), 64);
    expect(now.slice(0, 128 * 3)).toEqual(buffer.slice(0, 128 * 3)); // the title and frame stay
    expect(now).not.toEqual(buffer); // the uptime and the bar
    expect(bench.problems().filter((p) => p.code === 'spi-unattached')).toEqual([]);
  }, 60_000);
});
