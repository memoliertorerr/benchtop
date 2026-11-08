import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BoardSpec, Problem } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { CODE_ESP32_MODULE, createEsp32Mcu, type Esp32Mcu, esp32McuFactory } from '../esp32.ts';
import { REPO_ROOT } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { loadCachedRom } from '../test-support/rom.test-helper.ts';
import { REF_HZ } from './context.ts';
import { bootFixture, runUntil } from '../test-support/boot.test-helper.ts';
import { createTestSoc } from '../test-support/soc.test-helper.ts';
import { CODE, PAGE } from './bus.ts';
import { APP_TABLE, CACHE_ENABLE, CACHE_MASK, DPORT_REG, PRO_TABLE, PSRAM_FIRST_ENTRY } from './mmu.ts';
import { ESP32_PSRAM_BYTES } from './psram.ts';
import { SPI1_BASE } from './spi-flash.ts';

// BT133: the ESP32's PSRAM — the chip on SPI1's CS1, its 32 KB pages at 0x3F800000 through the
// MMU's external-RAM entries, and the build that uses it (fixtures/sketches/esp32/psram).

const DPORT = 0x3ff00000;
const PIN = 0x34;
const ALL_MASKS = 0x3f;

/** A user command on SPI1 with CS1 selected (CS0_DIS set, CS1_DIS clear), as psram_cmd_recv_start does. */
function cs1(soc: ReturnType<typeof createTestSoc>, command: number, opts: { addr?: number; mosi?: number[]; miso?: number; flash?: boolean } = {}): number[] {
  const bus = soc.buses[0];
  const w = (o: number, v: number) => bus.write32(SPI1_BASE + o, v);
  let user = 1 << 31;
  w(PIN, opts.flash === true ? 2 : 1);
  w(0x24, (7 << 28) | command);
  if (opts.addr !== undefined) {
    user |= 1 << 30;
    w(0x20, 23 << 26);
    w(0x04, opts.addr << 8);
  }
  if (opts.mosi !== undefined) {
    user |= 1 << 27;
    w(0x28, opts.mosi.length * 8 - 1);
    for (let i = 0; i < opts.mosi.length; i += 4) w(0x80 + i, (opts.mosi[i] ?? 0) | ((opts.mosi[i + 1] ?? 0) << 8) | ((opts.mosi[i + 2] ?? 0) << 16) | ((opts.mosi[i + 3] ?? 0) << 24));
  }
  if (opts.miso !== undefined) {
    user |= 1 << 28;
    w(0x2c, opts.miso * 8 - 1);
  }
  w(0x1c, user);
  w(0x00, 1 << 18);
  w(PIN, 2); // back to the flash
  const out: number[] = [];
  for (let i = 0; i < (opts.miso ?? 0); i++) out.push((bus.read32(SPI1_BASE + 0x80 + (i & ~3)) >>> ((i & 3) * 8)) & 0xff);
  return out;
}

/** Both caches on, external RAM unmasked, the first `pages` 32 KB entries mapped 1:1 on both CPUs. */
function mapPsram(soc: ReturnType<typeof createTestSoc>, pages: number) {
  const bus = soc.buses[0];
  bus.write32(DPORT + DPORT_REG.PRO_CACHE_CTRL, CACHE_ENABLE);
  bus.write32(DPORT + DPORT_REG.APP_CACHE_CTRL, CACHE_ENABLE);
  bus.write32(DPORT + DPORT_REG.PRO_CACHE_CTRL1, ALL_MASKS & ~CACHE_MASK.DRAM1);
  bus.write32(DPORT + DPORT_REG.APP_CACHE_CTRL1, ALL_MASKS & ~CACHE_MASK.DRAM1);
  for (let i = 0; i < pages; i++) setEntry(soc, i, i);
}

function setEntry(soc: ReturnType<typeof createTestSoc>, index: number, page: number, cpus: readonly number[] = [0, 1]) {
  for (const cpu of cpus) soc.buses[0].write32((cpu === 0 ? PRO_TABLE : APP_TABLE) + (PSRAM_FIRST_ENTRY + index) * 4, page);
}

describe('the ESP32 PSRAM chip on SPI1’s CS1 (BT133)', () => {
  it('reads its ID (MFID 0x0D, KGD 0x5D, EID density 2: 64 Mbit), resets, enters QPI, and its data reads back; CS0 still reaches the flash', () => {
    const soc = createTestSoc();
    expect(cs1(soc, 0x9f, { addr: 0, miso: 4 })).toEqual([0x0d, 0x5d, 0x40, 0x00]);
    expect(cs1(soc, 0x9f, { addr: 0, miso: 3, flash: true })).toEqual([0xef, 0x40, 0x16]);
    cs1(soc, 0x35);
    expect(soc.psram.qpi).toBe(true);
    cs1(soc, 0x66);
    cs1(soc, 0x99);
    expect(soc.psram.qpi).toBe(false);
    expect(soc.psram.allocated).toBe(false);
    cs1(soc, 0x38, { addr: 0x123456, mosi: [1, 2, 3, 4, 5] });
    expect(cs1(soc, 0xeb, { addr: 0x123456, miso: 5 })).toEqual([1, 2, 3, 4, 5]);
    expect(soc.psram.data[0x123456]).toBe(1);
    expect(soc.psram.size).toBe(ESP32_PSRAM_BYTES);
  });

  it('maps 32 KB pages at 0x3F800000 for both CPUs: written on one, read on the other; any width; remapping and split pages', () => {
    const soc = createTestSoc();
    mapPsram(soc, 128);
    const [pro, app] = soc.buses;
    pro.write32(0x3f800000, 0xdeadbeef);
    expect(app.read32(0x3f800000)).toBe(0xdeadbeef);
    pro.write8(0x3f9ffffd, 0x5a);
    pro.write16(0x3fbffffe, 0x1234);
    expect(app.read8(0x3f9ffffd)).toBe(0x5a);
    expect(app.read16(0x3fbffffe)).toBe(0x1234);
    expect(soc.psram.data[0x1ffffd]).toBe(0x5a);
    expect(soc.psram.dataWords[0x3ffffc >>> 2] >>> 16).toBe(0x1234);
    // Unaligned word on the data bus: byte by byte.
    pro.write32(0x3f800102, 0x11223344);
    expect(app.read32(0x3f800102)).toBe(0x11223344);
    // Contiguous halves arm the 64 KB page for the fast path.
    expect(pro.kind[0x3f80]).toBe(PAGE.PSRAM);
    // The ESP32 maps 4 MB; himem's banks reach the rest: entry 0 → chip page 200 (6.25 MB in).
    soc.psram.data[200 * 0x8000] = 0x77;
    setEntry(soc, 0, 200, [0]);
    expect(pro.kind[0x3f80]).toBe(PAGE.SLOW);
    expect(pro.read8(0x3f800000)).toBe(0x77);
    expect(app.read8(0x3f800000)).toBe(0xef);
    // Halves no longer contiguous: each access decides (the page stays slow) and still lands right.
    expect(pro.read8(0x3f808000)).toBe(soc.psram.data[0x8000]);
    expect(pro.kind[0x3f80]).toBe(PAGE.SLOW);
    // The debugger's view.
    expect(pro.peek8(0x3f800000)).toBe(0x77);
    expect(pro.poke8(0x3f800001, 0x66)).toBe(true);
    expect(soc.psram.data[200 * 0x8000 + 1]).toBe(0x66);
  });

  it('a build that never starts the PSRAM finds external RAM masked: esp32-psram and the core faults', () => {
    const soc = createTestSoc();
    expect(() => soc.buses[0].read32(0x3f800000)).toThrow(/cache disabled/);
    mapPsram(soc, 2);
    soc.buses[0].write32(DPORT + DPORT_REG.PRO_CACHE_CTRL1, ALL_MASKS);
    expect(() => soc.buses[0].read32(0x3f800000)).toThrow(/masked/);
    setEntry(soc, 4, 0x100);
    soc.buses[0].write32(DPORT + DPORT_REG.PRO_CACHE_CTRL1, ALL_MASKS & ~CACHE_MASK.DRAM1);
    expect(() => soc.buses[0].write8(0x3f820000, 1)).toThrow(/invalid/);
    expect(soc.problems.count(CODE.PSRAM)).toBeGreaterThan(0);
    expect(soc.buses[0].peek8(0x3f820000)).toBe(0);
  });
});

describe('PSRAM builds on the ESP32 (BT133)', () => {
  it('psram (the board menu’s PSRAM "Enabled"): found, 4 MB mapped into the heap, a 1 MB ps_malloc buffer checks out, a large malloc lands in PSRAM', () => {
    const { soc, uart } = bootFixture('psram');
    runUntil(soc, 2, () => uart[0].includes('done'));
    expect(uart[0]).toContain('psram found 1 size 4192123 free 4192123\n');
    expect(uart[0]).toContain('check ok sum 0c9e0000\n');
    expect(uart[0]).toContain('big 1\n');
    expect(soc.psram.allocated).toBe(true);
    expect(soc.problems.count(CODE.PSRAM)).toBe(0);
    expect(soc.stopped).toBe(false);
  });

  it('a build without PSRAM never touches the chip', () => {
    const { soc, uart } = bootFixture('serial-hello');
    runUntil(soc, 0.5);
    expect(uart[0].length).toBeGreaterThan(10);
    expect(soc.psram.allocated).toBe(false);
  });

  it('PSRAM is volatile: a deep sleep (VDD_SDIO off) loses it, a light sleep keeps it', () => {
    const deep = bootFixture('deep-sleep-timer');
    deep.soc.psram.data[123] = 0x5a;
    runUntil(deep.soc, 3, () => /boot 2 .*\n/.test(deep.uart[0]));
    expect(deep.uart[0]).toContain('boot 2 cause 4 reset 8');
    expect(deep.soc.psram.allocated).toBe(false);
    const light = bootFixture('light-sleep');
    light.soc.psram.data[123] = 0x5a;
    runUntil(light.soc, 1, () => /wake 2 .*\n/.test(light.uart[0]));
    expect(light.uart[0]).toContain('wake 2 cause 4');
    expect(light.soc.psram.data[123]).toBe(0x5a);
  });
});

describe('the board\u2019s module (BT135)', () => {
  const rom = loadCachedRom();

  function runPsramBuild(mcu: Esp32Mcu): string {
    let out = '';
    mcu.uart(0)!.onTransmit((b) => (out += String.fromCharCode(b)));
    mcu.load({ format: 'esp32-bin', ...fixtureImage('psram') });
    const end = mcu.cycles + REF_HZ * 2;
    while (mcu.cycles < end && !out.includes('done')) mcu.runUntil(Math.min(end, mcu.cycles + REF_HZ / 1000));
    return out;
  }

  it('a WROOM-32 has no PSRAM: nothing answers on CS1, and the PSRAM build finds none, as on that board', () => {
    const out = runPsramBuild(createEsp32Mcu({ rom, psram: false }));
    expect(out).toContain('psram found 0 size 0 free 0\n');
    expect(out).toContain('check bad sum 0');
  });

  it('the factory reads the board\u2019s module prop: WROOM-32 none, WROVER-E and auto PSRAM; an unknown one runs as auto with a warning', () => {
    const factory = esp32McuFactory(rom);
    const board = { mcu: 'esp32', pinMap: {} } as BoardSpec;
    const problems: Problem[] = [];
    const make = (module: string | undefined) => factory(board, 'esp', (p) => problems.push(p), module === undefined ? undefined : { module }) as Esp32Mcu;
    expect(make('WROOM-32').soc.psram.present).toBe(false);
    expect(make('WROVER-E').soc.psram.present).toBe(true);
    expect(make('auto').soc.psram.present).toBe(true);
    expect(make(undefined).soc.psram.present).toBe(true);
    expect(problems).toEqual([]);
    expect(make('WROVER-B').soc.psram.present).toBe(true);
    expect(problems.map((p) => p.code)).toEqual([CODE_ESP32_MODULE]);
    expect(problems[0].message).toContain('WROVER-B');
  });
});

function fixtureImage(name: string): { app: Uint8Array; partitions: Uint8Array } {
  const dir = join(REPO_ROOT, 'fixtures', 'firmware', 'esp32');
  return { app: new Uint8Array(readFileSync(join(dir, `${name}.bin`))), partitions: new Uint8Array(readFileSync(join(dir, `${name}.partitions.bin`))) };
}
