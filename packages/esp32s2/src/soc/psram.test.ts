import { XtensaBusError } from '@benchtop/esp32';
import type { BoardSpec, Problem } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { CODE_S2_MODULE, createEsp32s2Mcu, type Esp32s2Mcu, esp32s2McuFactory } from '../esp32s2-mcu.ts';
import { bootS2Fixture, s2FixtureImage } from '../test-support/boot.test-helper.ts';
import { loadCachedS2Rom } from '../test-support/rom.test-helper.ts';
import { CODE_S2_PSRAM } from './bus.ts';
import { IRAM_BASE } from './memory.ts';
import { REF_HZ } from './rtc-cntl.ts';
import { Esp32s2Soc, MMU_ACCESS_SPIRAM, MMU_TABLE_BASE, S2_PSRAM_BYTES, SPI1_BASE_S2 } from './soc.ts';
import { S2_IO_MUX_BASE } from './gpio.ts';

// BT154: the S2's PSRAM — the quad chip on SPI1's CS1, its 64 KB pages on the data bus through the
// MMU's ACCESS_SPIRAM entries, the build that uses it (fixtures/sketches/esp32s2/psram), the
// board's module, and GPIO26 (its chip select).

const MISC = 0x34;

function idleSoc(options: { psram?: boolean } = {}) {
  const soc = new Esp32s2Soc(options);
  soc.memory.sram.set([0x00, 0x7f, 0x00, 0x46, 0xff, 0xff], 0); // waiti 15; j .-3
  soc.core.pc = IRAM_BASE;
  const bus = soc.bus;
  return { soc, w: (a: number, v: number) => bus.write32(a, v), r: (a: number) => bus.read32(a) };
}

/** A user command on SPI1 to CS1 (MISC: CS0_DIS set, CS1_DIS clear), as psram_cmd_recv_start leaves it. */
function cs1(w: (a: number, v: number) => void, r: (a: number) => number, command: number, opts: { addr?: number; mosi?: number[]; miso?: number } = {}): number[] {
  let user = 1 << 31;
  w(SPI1_BASE_S2 + MISC, 1);
  w(SPI1_BASE_S2 + 0x20, (7 << 28) | command);
  if (opts.addr !== undefined) {
    user |= 1 << 30;
    w(SPI1_BASE_S2 + 0x1c, 23 << 26);
    w(SPI1_BASE_S2 + 0x04, opts.addr);
  }
  if (opts.mosi !== undefined) {
    user |= 1 << 27;
    w(SPI1_BASE_S2 + 0x24, opts.mosi.length * 8 - 1);
    for (let i = 0; i < opts.mosi.length; i += 4) w(SPI1_BASE_S2 + 0x58 + i, (opts.mosi[i] ?? 0) | ((opts.mosi[i + 1] ?? 0) << 8) | ((opts.mosi[i + 2] ?? 0) << 16) | ((opts.mosi[i + 3] ?? 0) << 24));
  }
  if (opts.miso !== undefined) {
    user |= 1 << 28;
    w(SPI1_BASE_S2 + 0x28, opts.miso * 8 - 1);
  }
  w(SPI1_BASE_S2 + 0x18, user);
  w(SPI1_BASE_S2 + 0x00, 1 << 18);
  w(SPI1_BASE_S2 + MISC, 2); // back to the flash
  const out: number[] = [];
  for (let i = 0; i < (opts.miso ?? 0); i++) out.push((r(SPI1_BASE_S2 + 0x58 + (i & ~3)) >>> ((i & 3) * 8)) & 0xff);
  return out;
}

describe('the S2 PSRAM chip on SPI1’s CS1 (BT154)', () => {
  it('its ID says 16 Mbit (MFID 0x0D, KGD 0x5D, EID 0): 2 MB; data written reads back; CS0 still reaches the flash', () => {
    const { soc, w, r } = idleSoc();
    expect(soc.psram.allocated).toBe(false); // nothing allocated until used
    expect(cs1(w, r, 0x9f, { addr: 0, miso: 3 })).toEqual([0x0d, 0x5d, 0x00]);
    expect(soc.psram.identified).toBe(true);
    expect(soc.psram.size).toBe(S2_PSRAM_BYTES);
    cs1(w, r, 0x35); // QPI
    expect(soc.psram.qpi).toBe(true);
    cs1(w, r, 0x38, { addr: 0x1234, mosi: [1, 2, 3, 4] });
    expect(cs1(w, r, 0xeb, { addr: 0x1234, miso: 4 })).toEqual([1, 2, 3, 4]);
    cs1(w, r, 0x66);
    cs1(w, r, 0x99);
    expect(soc.psram.qpi).toBe(false);
    // CS0: the flash's own ID, not the PSRAM's.
    w(SPI1_BASE_S2 + 0x20, (7 << 28) | 0x9f);
    w(SPI1_BASE_S2 + 0x28, 23);
    w(SPI1_BASE_S2 + 0x18, (1 << 31) | (1 << 28));
    w(SPI1_BASE_S2 + 0x00, 1 << 18);
    expect(r(SPI1_BASE_S2 + 0x58) & 0xff).not.toBe(0x0d);
  });

  it('a module without PSRAM leaves CS1 unanswered: the ID reads 0', () => {
    const { soc, w, r } = idleSoc({ psram: false });
    expect(cs1(w, r, 0x9f, { addr: 0, miso: 3 })).toEqual([0, 0, 0]);
    expect(soc.psram.identified).toBe(false);
    expect(soc.psram.size).toBe(0);
  });
});

describe('the S2 PSRAM through the MMU (BT154)', () => {
  it('an ACCESS_SPIRAM entry maps a 64 KB page of the chip into the data windows: any width, read and written, a remap at once', () => {
    const { soc, w } = idleSoc();
    const bus = soc.bus;
    w(MMU_TABLE_BASE + 216 * 4, MMU_ACCESS_SPIRAM | 0); // DBUS0 entry 216 → 0x3FD8_0000 (where IDF 4.4 maps it)
    w(MMU_TABLE_BASE + 256 * 4, MMU_ACCESS_SPIRAM | 31); // DBUS1 entry 256 → 0x3F80_0000, the chip's last page
    bus.write32(0x3fd80000, 0x11223344);
    bus.write16(0x3fd80006, 0xbeef);
    bus.write8(0x3fd80009, 0x5a);
    expect(bus.read32(0x3fd80000)).toBe(0x11223344);
    expect(bus.read16(0x3fd80006)).toBe(0xbeef);
    expect(bus.read8(0x3fd80009)).toBe(0x5a);
    expect(bus.read32(0x3fd80001)).toBe(0x00112233); // unaligned: the slow path, same bytes
    bus.write32(0x3f80fffc, 0xcafef00d);
    expect(soc.psram.data[31 * 0x10000 + 0xfffc]).toBe(0x0d);
    expect(bus.peek8(0x3f80fffd)).toBe(0xf0);
    expect(bus.poke8(0x3f80fffe, 0x77)).toBe(true);
    expect(bus.read32(0x3f80fffc)).toBe(0xca77f00d);
    w(MMU_TABLE_BASE + 216 * 4, MMU_ACCESS_SPIRAM | 31); // remap: the same page twice
    expect(bus.read32(0x3fd8fffc)).toBe(0xca77f00d);
    expect(soc.problems.problems.map((p) => p.code)).not.toContain(CODE_S2_PSRAM);
  });

  it('a page past the chip, or no chip, is unmapped with an esp32s2-psram Problem; fetching from PSRAM is refused', () => {
    const { soc, w } = idleSoc({ psram: false });
    w(MMU_TABLE_BASE + 216 * 4, MMU_ACCESS_SPIRAM | 0);
    expect(() => soc.bus.read32(0x3fd80000)).toThrow(XtensaBusError);
    expect(() => soc.bus.write32(0x3fd80000, 1)).toThrow(XtensaBusError);
    expect(soc.problems.problems.map((p) => p.code)).toContain(CODE_S2_PSRAM);
    const other = idleSoc();
    other.w(MMU_TABLE_BASE + 8 * 4, MMU_ACCESS_SPIRAM | 0); // IBUS0 entry 8 → 0x4008_0000
    expect(() => other.soc.bus.fetch(0x40080000)).toThrow(XtensaBusError);
  });
});

describe('a PSRAM build on the S2 (BT154)', () => {
  it('esp32s2/psram finds 2 MB, fills and checks a 1 MB ps_malloc buffer; a 256 KB malloc lands in PSRAM at the top of DBUS0', { timeout: 60_000 }, () => {
    const b = bootS2Fixture('psram');
    b.soc.runUntil(REF_HZ * 0.6);
    const out = b.uart[0];
    expect(out).toMatch(/psram found 1 size (\d+) free/);
    const size = Number(/size (\d+)/.exec(out)?.[1]);
    expect(size).toBeGreaterThan(2_000_000);
    expect(size).toBeLessThanOrEqual(S2_PSRAM_BYTES);
    expect(out).toContain('check ok sum 0c9e0000');
    expect(out).toContain('big 1');
    const at = Number.parseInt(/at ([0-9a-f]{8})/.exec(out)?.[1] ?? '0', 16);
    expect(at).toBeGreaterThanOrEqual(0x3fd80000);
    expect(at).toBeLessThan(0x3ff80000);
    expect(out).toContain('done');
    expect(b.soc.problems.problems.filter((p) => p.severity !== 'info').map((p) => p.code)).toEqual([]);
  });

  it('a build without PSRAM never touches the chip', { timeout: 60_000 }, () => {
    const b = bootS2Fixture('serial-hello');
    b.soc.runUntil(REF_HZ * 0.3);
    expect(b.soc.psram.identified).toBe(false);
    expect(b.soc.psram.allocated).toBe(false);
  });
});

const board: BoardSpec = { mcu: 'esp32s2', pinMap: {} };

function runPsram(mcu: Esp32s2Mcu, ms: number): string {
  let out = '';
  mcu.load({ format: 'esp32-bin', ...s2FixtureImage('psram') });
  mcu.uart(0)?.onTransmit((byte) => {
    out += String.fromCharCode(byte);
  });
  mcu.reset();
  mcu.runUntil((ms / 1000) * REF_HZ);
  return out;
}

describe('the S2 board’s module (BT154)', () => {
  it('N4 has no PSRAM: the build finds none; N4R2 finds 2 MB and holds GPIO26 from the start; auto once the build has read the ID', { timeout: 60_000 }, () => {
    const rom = loadCachedS2Rom();
    const n4 = createEsp32s2Mcu({ rom, module: 'N4' });
    expect(runPsram(n4, 600)).toContain('psram found 0');
    expect(n4.pinClaims()).toEqual([]);
    const r2 = createEsp32s2Mcu({ rom, module: 'N4R2' });
    expect(r2.pinClaims().map((c) => c.pin)).toEqual(['GPIO26']);
    expect(runPsram(r2, 600)).toContain('check ok');
    const auto = createEsp32s2Mcu({ rom });
    expect(auto.pinClaims()).toEqual([]);
    expect(runPsram(auto, 600)).toContain('psram found 1');
    expect(auto.pinClaims().map((c) => c.pin)).toEqual(['GPIO26']);
  });

  it('the factory reads the board’s module prop; an unknown one is a warning and runs as auto', () => {
    const rom = loadCachedS2Rom();
    const problems: Problem[] = [];
    const factory = esp32s2McuFactory(rom);
    const n4r2 = factory(board, 's2', (p) => problems.push(p), { module: 'N4R2' }) as Esp32s2Mcu;
    expect(n4r2.pinClaims().map((c) => c.pin)).toEqual(['GPIO26']);
    expect(problems).toEqual([]);
    const odd = factory(board, 's2', (p) => problems.push(p), { module: 'N16R8' }) as Esp32s2Mcu;
    expect(problems.map((p) => p.code)).toEqual([CODE_S2_MODULE]);
    expect(odd.pinClaims()).toEqual([]);
  });

  it('firmware taking GPIO26 from a running PSRAM is pin-reserved; without PSRAM GPIO26 is free', () => {
    const { soc, w, r } = idleSoc();
    w(S2_IO_MUX_BASE + 4 * (1 + 26), (1 << 12) | (1 << 9)); // GPIO function, no PSRAM yet: free
    expect(soc.problems.problems.map((p) => p.code)).not.toContain('pin-reserved');
    w(S2_IO_MUX_BASE + 4 * (1 + 26), 1 << 9); // back to SPICS1
    cs1(w, r, 0x9f, { addr: 0, miso: 3 }); // a driver has found the chip
    w(S2_IO_MUX_BASE + 4 * (1 + 26), (1 << 12) | (1 << 9));
    expect(soc.problems.problems.map((p) => p.code)).toContain('pin-reserved');
  });
});
