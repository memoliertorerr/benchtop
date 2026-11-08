import { SPI1_BASE } from '@benchtop/esp32c3';
import { describe, expect, it } from 'vitest';
import type { BoardSpec, Problem } from '@benchtop/core';
import { CODE_S3_MODULE, createEsp32s3Mcu, type Esp32s3Mcu, esp32s3McuFactory } from '../esp32s3-mcu.ts';
import { bootS3Fixture, s3FixtureImage } from '../test-support/boot.test-helper.ts';
import { loadCachedS3Rom } from '../test-support/rom.test-helper.ts';
import { CODE_S3_PSRAM } from './bus.ts';
import { DROM_FLASH_BASE, IRAM_BASE } from './memory.ts';
import { S3_PSRAM_QUAD_BYTES } from './psram.ts';
import { REF_HZ } from './rtc-cntl.ts';
import { Esp32s3Soc, MMU_TABLE_BASE } from './soc.ts';
import { CODE_S3_PIN_RESERVED } from './gpio.ts';

// BT130: the S3's PSRAM — the chip on SPI1's CS1 (quad and octal protocols), its pages on the data
// bus through the MMU's SPIRAM entries, and the builds that use it (fixtures/sketches/esp32s3/psram-*).

const MISC = 0x34;
const MMU_SPIRAM = 1 << 15;

function idleSoc() {
  const soc = new Esp32s3Soc();
  soc.memory.sram.set([0x00, 0x7f, 0x00, 0x46, 0xff, 0xff], 0); // waiti 15; j .-3
  soc.cores[0].pc = IRAM_BASE;
  const bus = soc.buses[0];
  return { soc, w: (a: number, v: number) => bus.write32(a, v), r: (a: number) => bus.read32(a) };
}

/** A user command on SPI1 to CS1 (MISC: CS0 off, CS1 on), as esp_rom_spi_cmd_start leaves it. */
function cs1(w: (a: number, v: number) => void, r: (a: number) => number, command: number, bits: number, opts: { addr?: number; mosi?: number[]; miso?: number } = {}): number[] {
  let user = 1 << 31;
  w(SPI1_BASE + MISC, 1);
  w(SPI1_BASE + 0x20, ((bits - 1) << 28) | command);
  if (opts.addr !== undefined) {
    user |= 1 << 30;
    w(SPI1_BASE + 0x1c, 31 << 26);
    w(SPI1_BASE + 0x04, opts.addr);
  }
  if (opts.mosi !== undefined) {
    user |= 1 << 27;
    w(SPI1_BASE + 0x24, opts.mosi.length * 8 - 1);
    for (let i = 0; i < opts.mosi.length; i += 4) w(SPI1_BASE + 0x58 + i, (opts.mosi[i] ?? 0) | ((opts.mosi[i + 1] ?? 0) << 8) | ((opts.mosi[i + 2] ?? 0) << 16) | ((opts.mosi[i + 3] ?? 0) << 24));
  }
  if (opts.miso !== undefined) {
    user |= 1 << 28;
    w(SPI1_BASE + 0x28, opts.miso * 8 - 1);
  }
  w(SPI1_BASE + 0x18, user);
  w(SPI1_BASE + 0x00, 1 << 18);
  w(SPI1_BASE + MISC, 2); // back to the flash
  const out: number[] = [];
  for (let i = 0; i < (opts.miso ?? 0); i++) out.push((r(SPI1_BASE + 0x58 + (i & ~3)) >>> ((i & 3) * 8)) & 0xff);
  return out;
}

describe('the S3 PSRAM chip on SPI1’s CS1 (BT130)', () => {
  it('quad: the ID says 2 MB (MFID 0x0D, KGD 0x5D, EID density 0); data written reads back; CS0 still reaches the flash', () => {
    const { soc, w, r } = idleSoc();
    expect(cs1(w, r, 0x9f, 8, { addr: 0, miso: 3 })).toEqual([0x0d, 0x5d, 0x00]);
    expect(soc.psram.mode).toBe('quad');
    expect(soc.psram.size).toBe(S3_PSRAM_QUAD_BYTES);
    cs1(w, r, 0x66, 8);
    cs1(w, r, 0x99, 8);
    cs1(w, r, 0x35, 8);
    expect(soc.psram.qpi).toBe(true);
    cs1(w, r, 0x38, 8, { addr: 0x1234, mosi: [1, 2, 3, 4] });
    expect(cs1(w, r, 0xeb, 8, { addr: 0x1234, miso: 4 })).toEqual([1, 2, 3, 4]);
    // The same command with CS0 selected is the flash's RDID.
    w(SPI1_BASE + MISC, 2);
    w(SPI1_BASE + 0x20, (7 << 28) | 0x9f);
    w(SPI1_BASE + 0x28, 23);
    w(SPI1_BASE + 0x18, (1 << 31) | (1 << 28));
    w(SPI1_BASE + 0x00, 1 << 18);
    expect(r(SPI1_BASE + 0x58) & 0xffffff).toBe(0x1640c8);
  });

  it('octal: mode registers say AP Memory, 64 Mbit, Good-Die; latency writes stick, the ids don’t', () => {
    const { soc, w, r } = idleSoc();
    expect(cs1(w, r, 0x4040, 16, { addr: 0, miso: 2 })[1]).toBe(0x0d); // MR1 vendor
    const mr2 = cs1(w, r, 0x4040, 16, { addr: 2, miso: 2 })[0];
    expect(mr2 & 7).toBe(3); // density: 64 Mbit
    expect(mr2 >>> 7).toBe(1); // Good-Die
    expect(soc.psram.mode).toBe('octal');
    expect(soc.psram.size).toBe(8 * 1024 * 1024);
    cs1(w, r, 0xc0c0, 16, { addr: 0, mosi: [0x15, 0x99] });
    expect(cs1(w, r, 0x4040, 16, { addr: 0, miso: 2 })).toEqual([0x15, 0x0d]);
  });
});

describe('the S3 PSRAM through the MMU (BT130)', () => {
  it('an entry with SPIRAM set maps a PSRAM page on the data bus, read and written by both cores; an unmapped one still reports esp32s3-psram', () => {
    const { soc, w } = idleSoc();
    expect(soc.psram.allocated).toBe(false);
    w(MMU_TABLE_BASE + 0x1f0 * 4, MMU_SPIRAM | 3); // DBUS 0x3DF0_0000 → PSRAM 0x30000
    const at = DROM_FLASH_BASE + 0x1f0 * 0x10000;
    soc.buses[0].write32(at + 8, 0xdeadbeef);
    soc.buses[0].write8(at + 13, 0x5a);
    soc.buses[0].write16(at + 14, 0xa55a);
    expect(soc.psram.data[0x30008]).toBe(0xef);
    expect(soc.buses[1].read32(at + 8)).toBe(0xdeadbeef);
    expect(soc.buses[1].read8(at + 13)).toBe(0x5a);
    expect(soc.buses[1].read16(at + 14)).toBe(0xa55a);
    expect(soc.buses[0].peek8(at + 9)).toBe(0xbe);
    expect(soc.buses[0].poke8(at + 9, 0x11)).toBe(true);
    expect(soc.buses[1].read32(at + 8)).toBe(0xdead11ef);
    // Remapped: the bus sees the new page at once.
    w(MMU_TABLE_BASE + 0x1f0 * 4, MMU_SPIRAM | 4);
    expect(soc.buses[1].read32(at + 8)).toBe(0);
    expect(() => soc.buses[0].read32(DROM_FLASH_BASE + 0x1f1 * 0x10000)).toThrow();
    expect(soc.problems.count(CODE_S3_PSRAM)).toBe(1);
  });

  it('a quad chip maps only its 2 MB; a light sleep keeps the bytes', () => {
    const { soc, w, r } = idleSoc();
    cs1(w, r, 0x9f, 8, { addr: 0, miso: 3 });
    w(MMU_TABLE_BASE + 0x1f0 * 4, MMU_SPIRAM | 0x1f); // page 31: the 2 MB's last
    w(MMU_TABLE_BASE + 0x1f1 * 4, MMU_SPIRAM | 0x20); // page 32: past it
    soc.buses[0].write32(DROM_FLASH_BASE + 0x1f0 * 0x10000, 0x12345678);
    expect(() => soc.buses[0].read32(DROM_FLASH_BASE + 0x1f1 * 0x10000)).toThrow();
    // A light sleep: a timer wake 10 ms on.
    const RTC = 0x60008000;
    w(RTC + 0x3c, (1 << 3) << 15); // WAKEUP_STATE: TIMER
    w(RTC + 0x0c, 1 << 31);
    const now = soc.rtc.rtcTime();
    w(RTC + 0x04, now + 1500);
    w(RTC + 0x08, 0);
    w(RTC + 0x18, 1 << 31); // SLEEP_EN, light (DIG_PWC.DG_WRAP_PD_EN clear)
    expect(soc.sleeping).toEqual({ deep: false });
    soc.runUntil(soc.now() + 0.05 * REF_HZ);
    expect(soc.sleeping).toBeNull();
    expect(soc.buses[1].read32(DROM_FLASH_BASE + 0x1f0 * 0x10000)).toBe(0x12345678);
  });
});

describe('builds with PSRAM (BT130)', () => {
  const lines = (uart: string) => uart.split('\n').map((l) => l.replace(/\r$/, ''));

  it('psram-quad (QSPI PSRAM): 2 MB found by psramInit, a 1 MB ps_malloc buffer checks, a 256 KB malloc lands in PSRAM', () => {
    const { soc, uart } = bootS3Fixture('psram-quad');
    for (let i = 0; i < 800 && !uart[0].includes('done'); i++) soc.runUntil(soc.now() + REF_HZ / 1000);
    const [found, check, big] = lines(uart[0]);
    const size = Number(/size (\d+)/.exec(found)?.[1]);
    expect(found).toMatch(/^psram found 1 size \d+ free \d+$/);
    expect(size).toBeGreaterThan(2_000_000);
    expect(size).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(check).toBe('check ok sum 0c9e0000');
    expect(big).toBe('big 1');
    expect(soc.psram.mode).toBe('quad');
    expect(soc.problems.problems.filter((p) => p.severity !== 'info')).toEqual([]);
  });

  it('psram-octal (OPI PSRAM): 8 MB found at boot by ESP-IDF, the same checks', () => {
    const { soc, uart } = bootS3Fixture('psram-octal');
    for (let i = 0; i < 1200 && !uart[0].includes('done'); i++) soc.runUntil(soc.now() + REF_HZ / 1000);
    const [found, check, big] = lines(uart[0]);
    const size = Number(/size (\d+)/.exec(found)?.[1]);
    expect(size).toBeGreaterThan(8_300_000);
    expect(size).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(check).toBe('check ok sum 0c9e0000');
    expect(big).toBe('big 1');
    expect(soc.psram.mode).toBe('octal');
    expect(soc.problems.problems.filter((p) => p.severity !== 'info')).toEqual([]);
  });

  it('a build without PSRAM never touches it; PSRAM is volatile: a reset starts it empty', () => {
    const plain = bootS3Fixture('serial-hello');
    plain.soc.runUntil(0.6 * REF_HZ);
    expect(plain.soc.psram.mode).toBeNull();
    expect(plain.soc.psram.allocated).toBe(false);
    const mcu = createEsp32s3Mcu({ rom: loadCachedS3Rom() });
    mcu.load({ format: 'esp32-bin', ...s3FixtureImage('psram-quad') });
    mcu.runUntil(0.5 * REF_HZ);
    expect(mcu.soc.psram.data.some((b) => b !== 0)).toBe(true);
    mcu.reset();
    expect(mcu.soc.psram.allocated).toBe(false);
  });
});

describe('the board\u2019s module (BT135)', () => {
  const rom = loadCachedS3Rom();

  function run(psram: 'none' | 'quad' | 'octal', fixture: string): string {
    const mcu = createEsp32s3Mcu({ rom, psram });
    let out = '';
    mcu.uart(0)!.onTransmit((b) => (out += String.fromCharCode(b)));
    mcu.load({ format: 'esp32-bin', ...s3FixtureImage(fixture) });
    const end = mcu.cycles + REF_HZ * 1.5;
    while (mcu.cycles < end && !out.includes('done')) mcu.runUntil(Math.min(end, mcu.cycles + REF_HZ / 1000));
    return out;
  }

  it('N8 (no PSRAM), N8R2 (quad only), N8R8 (octal only): each build finds what that board gives it', () => {
    expect(run('none', 'psram-quad')).toContain('psram found 0 size 0 free 0');
    expect(run('quad', 'psram-quad')).toContain('check ok sum 0c9e0000');
    // Arduino's OPI build says "found" once its boot-time init ran, PSRAM or not: 0 bytes.
    expect(run('quad', 'psram-octal')).toContain('psram found 1 size 0 free 0');
    expect(run('octal', 'psram-octal')).toContain('check ok sum 0c9e0000');
    expect(run('octal', 'psram-quad')).toContain('psram found 0 size 0 free 0');
  });

  it('the factory reads the board\u2019s module prop; an unknown one runs as auto with a warning', () => {
    const factory = esp32s3McuFactory(rom);
    const board = { mcu: 'esp32s3', pinMap: {} } as BoardSpec;
    const problems: Problem[] = [];
    const make = (module: string | undefined) => factory(board, 's3', (p) => problems.push(p), module === undefined ? undefined : { module }) as Esp32s3Mcu;
    expect(make('N8').soc.psram.present).toBe(false);
    expect(make('N8R2').soc.psram.protocols).toBe('quad');
    expect(make('N8R8').soc.psram.protocols).toBe('octal');
    expect(make('auto').soc.psram.protocols).toBe('both');
    expect(make(undefined).soc.psram.protocols).toBe('both');
    expect(problems).toEqual([]);
    expect(make('N16R8').soc.psram.protocols).toBe('both');
    expect(problems.map((p) => p.code)).toEqual([CODE_S3_MODULE]);
  });
});

describe('the pins the octal PSRAM holds (BT136)', () => {
  const rom = loadCachedS3Rom();
  const IO_MUX_PAD = (g: number) => 0x60009000 + 4 + 4 * g;
  const reserved = (soc: Esp32s3Soc) => soc.problems.problems.filter((p) => p.code === CODE_S3_PIN_RESERVED);
  const boot = (name: string) => {
    const booted = bootS3Fixture(name);
    for (let i = 0; i < 1200 && !booted.uart[0].includes('done'); i++) booted.soc.runUntil(booted.soc.now() + REF_HZ / 1000);
    return booted.soc;
  };

  it('an octal build puts GPIO33–37 on their SPI functions; firmware making one a GPIO afterwards is reported once per pad', () => {
    const soc = boot('psram-octal');
    expect([33, 34, 35, 36, 37].map((g) => soc.iomux.isGpio(g))).toEqual([false, false, false, false, false]);
    expect(reserved(soc)).toEqual([]);
    const bus = soc.buses[0];
    const pinMode = (g: number) => bus.write32(IO_MUX_PAD(g), (bus.read32(IO_MUX_PAD(g)) & ~(7 << 12)) | (1 << 12)); // PIN_FUNC_GPIO
    pinMode(35);
    pinMode(35);
    bus.write32(IO_MUX_PAD(35), bus.read32(IO_MUX_PAD(35)) | (1 << 8)); // a pull-up on the taken pad: nothing new
    const found = reserved(soc);
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain("The firmware made GPIO35 a GPIO, but it carries the octal PSRAM's SPIIO6: on a board the PSRAM stops answering");
    pinMode(37);
    expect(reserved(soc).map((p) => /GPIO\d+/.exec(p.message)?.[0])).toEqual(['GPIO35', 'GPIO37']);
  });

  it('a quad build leaves GPIO33–37 free', () => {
    const soc = boot('psram-quad');
    const bus = soc.buses[0];
    bus.write32(IO_MUX_PAD(35), (bus.read32(IO_MUX_PAD(35)) & ~(7 << 12)) | (1 << 12));
    expect(reserved(soc)).toEqual([]);
  });

  it('the Mcu’s claims: an N8R8 holds GPIO33–37 from the start; auto once an octal build’s PSRAM runs; N8R2 and a quad build none', () => {
    expect(createEsp32s3Mcu({ rom, psram: 'octal' }).pinClaims().map((c) => c.pin)).toEqual(['GPIO33', 'GPIO34', 'GPIO35', 'GPIO36', 'GPIO37']);
    expect(createEsp32s3Mcu({ rom, psram: 'quad' }).pinClaims()).toEqual([]);
    const run = (fixture: string) => {
      const mcu = createEsp32s3Mcu({ rom });
      mcu.load({ format: 'esp32-bin', ...s3FixtureImage(fixture) });
      expect(mcu.pinClaims()).toEqual([]);
      mcu.runUntil(REF_HZ / 2);
      return mcu.pinClaims();
    };
    expect(run('psram-octal').map((c) => `${c.pin} ${c.by}`)[2]).toBe("GPIO35 the octal PSRAM's SPIIO6 (this build uses it, as on an N8R8)");
    expect(run('psram-quad')).toEqual([]);
  });
});
