import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { REF_HZ } from '../soc/context.ts';
import { Esp32c3Soc } from '../soc/soc.ts';
import { bootC3Fixture, fixtureImage } from '../test-support/boot.test-helper.ts';
import { cachedC3Rom } from '../test-support/rom.test-helper.ts';
import { directBoot, mmuEntryOf } from './direct-boot.ts';

describe('ESP32-C3 direct boot of an Arduino image (BT92)', () => {
  it('serial-hello prints its greeting on UART0, then a tick once a second', () => {
    const { soc, uart, sent } = bootC3Fixture('serial-hello');
    soc.runUntil(2.3 * REF_HZ);
    expect(soc.stopReason).toBe('');
    expect(uart[0]).toBe('hello from esp32c3\r\ntick 1\ntick 2\n');
    // delay(1000) on a 1 kHz FreeRTOS tick: the ticks land 1 s apart, within a tick.
    const lineEnds = sent.filter(([byte]) => byte === 0x0a).map(([, t]) => t / REF_HZ);
    expect(lineEnds).toHaveLength(3);
    expect(Math.abs(lineEnds[2] - lineEnds[1] - 1)).toBeLessThan(0.001);
    expect(lineEnds[0]).toBeLessThan(0.5);
    // 115200 baud, 8N1: the greeting's bytes leave back to back, 86.8 µs apart.
    const spacing = (sent[19][1] - sent[0][1]) / 19 / REF_HZ;
    expect(spacing * 1e6).toBeCloseTo(1e6 / 11520, 1);
    // The CPU runs at 160 MHz from esp_clk_init on, and nothing went wrong on the way.
    expect(soc.cpuHz).toBe(160_000_000);
    expect(soc.problems.problems.filter((p) => p.severity !== 'info')).toEqual([]);
  });

  it('sleeps in WFI between ticks, so a second of idle costs few instructions', () => {
    const { soc } = bootC3Fixture('serial-hello');
    soc.runUntil(1.2 * REF_HZ);
    const before = soc.core.instructions;
    soc.runUntil(2.2 * REF_HZ);
    // 1000 tick interrupts and a print: far fewer than the 160 M a busy second would take.
    expect(soc.core.instructions - before).toBeLessThan(2_000_000);
  });

  it('refuses an image built for another chip', () => {
    const dir = join(REPO_ROOT, 'fixtures', 'firmware', 'esp32');
    const app = new Uint8Array(readFileSync(join(dir, 'serial-hello.bin')));
    const result = directBoot(new Esp32c3Soc(), { app, rom: cachedC3Rom() });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/chip id 0 is not an ESP32-C3/);
  });

  it('maps every flash segment through the MMU and leaves the rest invalid', () => {
    const soc = new Esp32c3Soc();
    const result = directBoot(soc, { ...fixtureImage('serial-hello'), rom: cachedC3Rom() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const flashSegments = result.layout.image.segments.filter((s) => s.region === 'IROM' || s.region === 'DROM');
    expect(flashSegments.length).toBeGreaterThanOrEqual(2);
    for (const segment of flashSegments) {
      const entry = mmuEntryOf(segment.loadAddress);
      const flashPage = (result.layout.app.offset + segment.fileOffset) >>> 16;
      expect(soc.mmu[entry]).toBe(flashPage);
      // Through the cache, the segment's first word.
      if ((segment.loadAddress & 3) === 0) expect(soc.bus.read32(segment.loadAddress)).toBe(new DataView(segment.data.buffer, segment.data.byteOffset).getUint32(0, true));
    }
    expect([...soc.mmu].filter((e) => e === 0x100).length).toBeGreaterThan(100);
  });
});
