import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { REF_HZ } from '../soc/rtc-cntl.ts';
import { Esp32s3Soc, MMU_INVALID } from '../soc/soc.ts';
import { bootS3Fixture, s3FixtureImage } from '../test-support/boot.test-helper.ts';
import { cachedS3Rom } from '../test-support/rom.test-helper.ts';
import { directBootS3, s3MmuEntryOf } from './direct-boot.ts';

describe('ESP32-S3 direct boot of an Arduino image (BT124)', () => {
  it('serial-hello prints its greeting on UART0, then a tick once a second, from the APP_CPU', () => {
    const { soc, uart, sent } = bootS3Fixture('serial-hello');
    soc.runUntil(2.3 * REF_HZ);
    expect(soc.stopReason).toBe('');
    expect(soc.resetRequested).toBe(false);
    expect(uart[0]).toBe('hello from esp32s3\r\ntick 1\ntick 2\n');
    // delay(1000) on a 1 kHz FreeRTOS tick: the ticks land 1 s apart, within a tick.
    const lineEnds = sent.filter(([byte]) => byte === 0x0a).map(([, t]) => t / REF_HZ);
    expect(lineEnds).toHaveLength(3);
    expect(Math.abs(lineEnds[2] - lineEnds[1] - 1)).toBeLessThan(0.001);
    expect(lineEnds[0]).toBeLessThan(0.5);
    // 115200 baud, 8N1: the greeting's bytes leave back to back, 86.8 µs apart.
    const spacing = (sent[19][1] - sent[0][1]) / 19 / REF_HZ;
    expect(spacing * 1e6).toBeCloseTo(1e6 / 11520, 1);
    // 240 MHz from esp_clk_init on; the app started the APP_CPU, where Arduino's loopTask runs.
    expect(soc.cpuHz).toBe(240_000_000);
    expect(soc.appRunning).toBe(true);
    expect(soc.cores[1].instructions).toBeGreaterThan(100_000);
    expect(soc.problems.problems.filter((p) => p.severity !== 'info')).toEqual([]);
  });

  it('both cores sleep in WAITI between ticks, so a second of idle costs few instructions', () => {
    const { soc } = bootS3Fixture('serial-hello');
    soc.runUntil(1.2 * REF_HZ);
    const before = soc.cores[0].instructions + soc.cores[1].instructions;
    const skippedBefore = soc.skipped;
    soc.runUntil(2.2 * REF_HZ);
    // Two cores × 1000 tick interrupts and a print: far fewer than the 480 M two busy cores would run.
    expect(soc.cores[0].instructions + soc.cores[1].instructions - before).toBeLessThan(4_000_000);
    expect(soc.skipped - skippedBefore).toBeGreaterThan(0.5 * REF_HZ);
  });

  it('blink boots too', () => {
    const { soc } = bootS3Fixture('blink');
    soc.runUntil(0.6 * REF_HZ);
    expect(soc.stopReason).toBe('');
    expect(soc.appRunning).toBe(true);
  });

  it('refuses an image built for another chip', () => {
    for (const [board, id] of [['esp32', 0], ['esp32c3', 5]] as const) {
      const app = new Uint8Array(readFileSync(join(REPO_ROOT, 'fixtures', 'firmware', board, 'serial-hello.bin')));
      const result = directBootS3(new Esp32s3Soc(), { app, rom: cachedS3Rom() });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(new RegExp(`chip id ${id} is not an ESP32-S3`));
    }
  });

  it('maps every flash segment through the MMU and leaves the rest invalid; the ROM knows the flash size', () => {
    const soc = new Esp32s3Soc();
    const rom = cachedS3Rom();
    const result = directBootS3(soc, { ...s3FixtureImage('serial-hello'), rom });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const flashSegments = result.layout.image.segments.filter((s) => s.region === 'IROM' || s.region === 'DROM');
    expect(flashSegments.length).toBeGreaterThanOrEqual(2);
    for (const segment of flashSegments) {
      const entry = s3MmuEntryOf(segment.loadAddress);
      const flashPage = (result.layout.app.offset + segment.fileOffset) >>> 16;
      expect(soc.mmu.table[entry]).toBe(flashPage);
      if ((segment.loadAddress & 3) === 0) expect(soc.buses[0].read32(segment.loadAddress)).toBe(new DataView(segment.data.buffer, segment.data.byteOffset).getUint32(0, true));
    }
    expect([...soc.mmu.table].filter((e) => e === MMU_INVALID).length).toBeGreaterThan(400);
    // rom_spiflash_legacy_data's chip: the image's 4 MB, not the ROM default's 2 MB.
    const legacy = rom.symbols.get('rom_default_spiflash_legacy_data') ?? 0;
    expect(soc.buses[0].read32(legacy + 4)).toBe(4 * 1024 * 1024);
  });
});
