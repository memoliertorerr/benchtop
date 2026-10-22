import { avrMcuFactory } from '@benchtop/avr';
import { assembleBench, type Bench, type BenchEnv, BusDecoder, type BusTransaction, type FirmwareImage, NS_PER_MS, type ProjectDoc } from '@benchtop/core';
import { esp32McuFactory } from '@benchtop/esp32';
import { rp2040McuFactory } from '@benchtop/rp2040';
import { describe, expect, it } from 'vitest';
import { readFixture, readFixtureText } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { loadCachedRom } from '../../../esp32/src/test-support/rom.test-helper.ts';
import { analogSpecFor } from '../analog-specs.ts';
import { benchEnvParts } from '../catalog.ts';

// BT86: real firmware's bus traffic, as the bench logs it and the decoder groups it.

const ROM = loadCachedRom();
const esp32 = esp32McuFactory(ROM);
const env: BenchEnv = {
  part: benchEnvParts,
  createMcu: (board, id, report) => avrMcuFactory(board) ?? (board.mcu === 'esp32' ? esp32(board, id, report) : rp2040McuFactory(board, id, report)),
};

function run(project: string, board: string, image: FirmwareImage, ms: number): { bench: Bench; txs: BusTransaction[] } {
  const doc = JSON.parse(readFixtureText(`fixtures/projects/${project}.json`)) as ProjectDoc;
  const bench = assembleBench(doc, env, { [board]: image }, { analogSpecFor });
  const decoder = new BusDecoder();
  const txs: BusTransaction[] = [];
  let since = 0;
  for (let t = 10; t <= ms; t += 10) {
    bench.runUntil(t * NS_PER_MS);
    const log = bench.busLog();
    const records = log.read(since);
    since = log.written;
    txs.push(...decoder.feed(records, log.sources), ...decoder.flush(bench.now(), log.sources));
  }
  return { bench, txs };
}

const hex = (name: string): FirmwareImage => ({ format: 'hex', text: readFixtureText(`fixtures/firmware/uno/${name}.hex`) });
const label = (bench: Bench, tx: BusTransaction): string => bench.busLog().sources[tx.source].label;
const text = (tx: BusTransaction): string => (tx.bus === 'uart' ? String.fromCharCode(...tx.bytes) : '');

describe('bus traffic of real firmware (BT86)', () => {
  it('Uno + I2C LCD: one-byte writes to the PCF8574 at 0x27, and "nack=2" on Serial', () => {
    const { bench, txs } = run('lcd-i2c', 'uno', hex('lcd-i2c'), 300);
    const i2c = txs.filter((t) => t.bus === 'i2c');
    expect(i2c.length).toBeGreaterThan(50);
    expect(i2c.every((t) => t.bus === 'i2c' && t.address === 0x27 && !t.read && t.ack && t.count === 1)).toBe(true);
    expect(label(bench, i2c[0])).toBe('lcd1 (I2C 0x27)');
    // Backlight on (0x08) and E pulses (0x04) on every nibble.
    expect(i2c.some((t) => t.bus === 'i2c' && (t.bytes[0] & 0x0c) === 0x0c)).toBe(true);
    const serial = txs.filter((t) => t.bus === 'uart' && bench.busLog().sources[t.source].direction === 'tx').map(text).join('');
    expect(serial).toContain('nack=2\r\n'); // the probe of 0x3F itself isn't logged: no device answered
  }, 30_000);

  it('Uno + SSD1306 (Adafruit): the frame goes to 0x3C in Wire-sized chunks', () => {
    const { txs } = run('ssd1306-adafruit', 'uno', hex('ssd1306-adafruit'), 600);
    const oled = txs.filter((t): t is Extract<BusTransaction, { bus: 'i2c' }> => t.bus === 'i2c' && t.address === 0x3c);
    expect(oled.length).toBeGreaterThan(30);
    expect(Math.max(...oled.map((t) => t.count))).toBeLessThanOrEqual(32); // AVR Wire's buffer
    const data = oled.filter((t) => t.bytes[0] === 0x40).reduce((n, t) => n + t.count - 1, 0); // 0x40: a data run
    expect(data).toBeGreaterThanOrEqual(1024);
  }, 30_000);

  it('Uno + ILI9341: SPI frames by chip select carry the column/page/memory-write commands', () => {
    const { bench, txs } = run('tft-demo', 'uno', hex('tft-demo'), 400);
    const spi = txs.filter((t): t is Extract<BusTransaction, { bus: 'spi' }> => t.bus === 'spi');
    expect(spi.length).toBeGreaterThan(5);
    expect(spi.every((t) => t.framed)).toBe(true);
    const commands = new Set(spi.flatMap((t) => t.mosi));
    for (const command of [0x2a, 0x2b, 0x2c]) expect(commands.has(command), `0x${command.toString(16)}`).toBe(true);
    expect(label(bench, spi[0])).toBe('tft (SPI)');
  }, 30_000);

  it('ESP32 OLED clock: I2C writes to 0x3C from the DevKit', () => {
    const image: FirmwareImage = {
      format: 'esp32-bin',
      app: readFixture('fixtures/firmware/esp32/oled-clock.bin'),
      partitions: readFixture('fixtures/firmware/esp32/oled-clock.partitions.bin'),
    };
    const { bench, txs } = run('esp32-oled-clock', 'esp', image, 1500);
    const oled = txs.filter((t) => t.bus === 'i2c' && t.address === 0x3c);
    expect(oled.length).toBeGreaterThan(5);
    expect(bench.busLog().sources[oled[0].source].board).toBe('esp');
  }, 60_000);

  it('Pico + ILI9341: SPI0 frames with the TFT\'s commands', () => {
    const { txs } = run('pico-spi-tft', 'pico', { format: 'uf2', bytes: readFixture('fixtures/firmware/pico/spi-tft.uf2') }, 600);
    const spi = txs.filter((t): t is Extract<BusTransaction, { bus: 'spi' }> => t.bus === 'spi');
    expect(spi.length).toBeGreaterThan(5);
    const commands = new Set(spi.flatMap((t) => t.mosi));
    for (const command of [0x2a, 0x2b, 0x2c]) expect(commands.has(command), `0x${command.toString(16)}`).toBe(true);
  }, 60_000);
});
