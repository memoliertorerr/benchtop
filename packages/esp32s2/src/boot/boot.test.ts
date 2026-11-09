import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { REF_HZ } from '../soc/rtc-cntl.ts';
import { Esp32s2Soc } from '../soc/soc.ts';
import { bootS2Fixture } from '../test-support/boot.test-helper.ts';
import { cachedS2Rom } from '../test-support/rom.test-helper.ts';
import { directBootS2 } from './direct-boot.ts';

// BT148: Arduino-ESP32 2.0.17 firmware on the S2, booted directly (direct-boot.ts) on the cached ROM.

describe('the S2 ROM (BT148)', () => {
  it('parses: code at 0x4000_0000 and its data view, RAM data near DRAM\'s top, the symbols direct boot uses', () => {
    const rom = cachedS2Rom();
    expect(rom.code.some((s) => s.name === '.text' && s.address >= 0x40000000)).toBe(true);
    expect(rom.code.some((s) => s.name === '.rodata' && s.address === 0x3ffac600)).toBe(true);
    expect(rom.ram.length).toBeGreaterThan(0);
    for (const name of ['g_ticks_per_us', 'SPI_flashchip_data', 'Cache_Suspend_ICache', 'ets_printf']) expect(rom.symbols.has(name), name).toBe(true);
  });
});

describe('Arduino on the S2 (BT148)', () => {
  it('serial-hello: "hello from esp32s2", then a tick each second to within 1 ms, idling in WAITI between them', () => {
    const { soc, uart, sent } = bootS2Fixture('serial-hello');
    soc.runUntil(3.2 * REF_HZ);
    expect(soc.stopped).toBe(false);
    expect(uart[0]).toMatch(/^hello from esp32s2\r\ntick 1\ntick 2\ntick 3\n$/);
    // When each tick line's newline went out.
    const text = sent.map(([b]) => String.fromCharCode(b)).join('');
    const ends = [...text.matchAll(/tick \d\n/g)].map((m) => sent[(m.index ?? 0) + m[0].length - 1][1]);
    expect(ends).toHaveLength(3);
    expect(Math.abs(ends[1] - ends[0] - REF_HZ)).toBeLessThan(REF_HZ / 1000);
    expect(Math.abs(ends[2] - ends[1] - REF_HZ)).toBeLessThan(REF_HZ / 1000);
    expect(soc.cpuHz).toBe(240_000_000);
    expect(soc.skipped).toBeGreaterThan(2 * REF_HZ); // most of the time asleep in WAITI, skipped ahead
    expect(soc.problems.problems.filter((p) => p.severity !== 'info')).toEqual([]);
  }, 60_000);

  it('blink runs a second without a fault, a reset or a warning', () => {
    const { soc } = bootS2Fixture('blink');
    soc.runUntil(1.2 * REF_HZ);
    expect(soc.stopped).toBe(false);
    expect(soc.resetRequested).toBe(false);
    expect(soc.problems.problems.filter((p) => p.severity !== 'info')).toEqual([]);
  }, 60_000);

  it('refuses the ESP32\'s, the C3\'s and the S3\'s images by their chip id', () => {
    for (const [board, id] of [['esp32', 0], ['esp32c3', 5], ['esp32s3', 9]] as const) {
      const dir = join(REPO_ROOT, 'fixtures', 'firmware', board);
      const boot = directBootS2(new Esp32s2Soc(), { app: new Uint8Array(readFileSync(join(dir, 'serial-hello.bin'))), partitions: new Uint8Array(readFileSync(join(dir, 'serial-hello.partitions.bin'))), rom: cachedS2Rom() });
      expect(boot.ok, board).toBe(false);
      if (!boot.ok) expect(boot.error).toContain(`chip id ${id} is not an ESP32-S2 (2)`);
    }
  });
});
