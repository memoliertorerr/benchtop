import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readFixture, REPO_ROOT } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { parseEspImage } from './image.ts';

const BINS = readdirSync(resolve(REPO_ROOT, 'fixtures/firmware/esp32')).filter((f) => f.endsWith('.bin') && !f.endsWith('.partitions.bin'));
const load = (name: string): Uint8Array => readFixture(`fixtures/firmware/esp32/${name}`);

describe('parseEspImage', () => {
  it('accepts every committed ESP32 app image: magic, chip 0, entry in IRAM, checksum, appended SHA-256', () => {
    expect(BINS.sort()).toEqual(['adc-read.bin', 'blink.bin', 'crc-bench.bin', 'dac-sine.bin', 'debug-demo.bin', 'gpio-input.bin', 'gpio-interrupt.bin', 'i2c-ds1307.bin', 'i2c-remap.bin', 'i2c-scan.bin', 'ledc-fade.bin', 'mic-level.bin', 'neopixel.bin', 'oled-clock.bin', 'pwm-fader.bin', 'rainbow-ring.bin', 'restart-loop.bin', 'rmt-long.bin', 'serial-echo.bin', 'serial-hello.bin', 'spi-loopback.bin', 'tft-demo.bin', 'timekeeping.bin', 'uart-chat.bin', 'uart-relay.bin', 'wdt-trip.bin']);
    for (const name of BINS) {
      const bytes = load(name);
      const parsed = parseEspImage(bytes);
      if (!parsed.ok) throw new Error(`${name}: ${parsed.error.code} — ${parsed.error.message}`);
      const image = parsed.image;
      expect(bytes[0]).toBe(0xe9);
      expect(image.chipId).toBe(0);
      expect(image.entry).toBeGreaterThanOrEqual(0x40070000);
      expect(image.entry).toBeLessThanOrEqual(0x400bffff);
      expect(image.hashAppended).toBe(true);
      expect(image.length).toBe(bytes.length);
      expect([image.spiSize, image.spiSpeed]).toEqual([2, 0xf]); // 4 MB, 80 MHz: header byte 0x2f
      expect(bytes[3]).toBe(0x2f);
    }
  });

  it('segment regions: serial-hello DROM, DRAM, IROM, DRAM, IRAM; blink DROM, DRAM, IRAM, IROM, IRAM', () => {
    const regions = (name: string) => {
      const parsed = parseEspImage(load(name));
      if (!parsed.ok) throw new Error(parsed.error.message);
      return parsed.image.segments.map((s) => s.region);
    };
    // The layout esptool produced for Blink while planning (it fills the gap before the
    // 64 KB-aligned IROM segment with a RAM chunk, so the order follows section sizes).
    expect(regions('serial-hello.bin')).toEqual(['DROM', 'DRAM', 'IROM', 'DRAM', 'IRAM']);
    // This blink is smaller (no Serial): an IRAM chunk fills that gap instead.
    expect(regions('blink.bin')).toEqual(['DROM', 'DRAM', 'IRAM', 'IROM', 'IRAM']);
  });

  it('a flipped segment byte is a checksum error; truncation is a truncated error — never an exception', () => {
    const bytes = load('blink.bin');
    const parsed = parseEspImage(bytes);
    if (!parsed.ok) throw new Error(parsed.error.message);
    const flipped = bytes.slice();
    flipped[parsed.image.segments[2].fileOffset + 10] ^= 0x40;
    expect(parseEspImage(flipped)).toMatchObject({ ok: false, error: { code: 'checksum' } });
    for (const length of [0, 10, 24, 30, 5000, bytes.length - 40, bytes.length - 1]) {
      expect(parseEspImage(bytes.subarray(0, length)), `length ${length}`).toMatchObject({ ok: false, error: { code: 'truncated' } });
    }
    const hash = bytes.slice();
    hash[hash.length - 1] ^= 1;
    expect(parseEspImage(hash)).toMatchObject({ ok: false, error: { code: 'hash' } });
    const magic = bytes.slice();
    magic[0] = 0xe8;
    expect(parseEspImage(magic)).toMatchObject({ ok: false, error: { code: 'magic' } });
    const chip = bytes.slice();
    chip[12] = 2; // ESP32-S2
    expect(parseEspImage(chip)).toMatchObject({ ok: false, error: { code: 'chip' } });
    const address = bytes.slice();
    new DataView(address.buffer).setUint32(24, 0x60000000, true); // first segment's load address
    expect(parseEspImage(address)).toMatchObject({ ok: false, error: { code: 'address' } });
    const huge = bytes.slice();
    new DataView(huge.buffer).setUint32(28, 0xfffffff0, true); // first segment's length
    expect(parseEspImage(huge)).toMatchObject({ ok: false, error: { code: 'truncated' } });
  });
});
