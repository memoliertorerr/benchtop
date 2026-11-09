import { XtensaBusError } from '@benchtop/esp32';
import { describe, expect, it } from 'vitest';
import { INTERRUPT_BASE, S2_SRC } from './intmatrix.ts';
import { IRAM_BASE } from './memory.ts';
import { REF_HZ } from './rtc-cntl.ts';
import { Esp32s2Soc, MMU_ACCESS_FLASH, MMU_ACCESS_SPIRAM, MMU_TABLE_BASE, SPI1_BASE_S2, UART_BASES_S2 } from './soc.ts';
import { EXTMEM_BASE, SYSTEM_BASE } from './system.ts';
import { SYSTIMER_BASE } from './systimer.ts';

// BT148: the S2 SoC's pieces on their own — the core parked in `waiti 15` (nothing wakes it),
// registers written through its bus as firmware would (on PeriBus1, and PeriBus2 where it says).

function idleSoc() {
  const soc = new Esp32s2Soc();
  soc.memory.sram.set([0x00, 0x7f, 0x00, 0x46, 0xff, 0xff], 0); // waiti 15; j .-3
  soc.core.pc = IRAM_BASE;
  const bus = soc.bus;
  return { soc, w: (a: number, v: number) => bus.write32(a, v), r: (a: number) => bus.read32(a) };
}

describe('the S2 interrupt matrix (BT148)', () => {
  it('routes a source to the CPU interrupt its map names; PRO_INTR_STATUS shows the raw line; PeriBus2 is the same block', () => {
    const { soc, w, r } = idleSoc();
    w(INTERRUPT_BASE + S2_SRC.UART0 * 4, 9);
    expect(r(INTERRUPT_BASE + S2_SRC.UART0 * 4)).toBe(9);
    expect(r(0x600c2000 + S2_SRC.UART0 * 4)).toBe(9); // the same register on PeriBus2
    soc.matrix.setSource(S2_SRC.UART0, true);
    expect(soc.core.lines & (1 << 9)).not.toBe(0);
    expect(r(INTERRUPT_BASE + 0x180)).toBe(1 << (S2_SRC.UART0 - 32)); // PRO_INTR_STATUS_1
    soc.matrix.setSource(S2_SRC.UART0, false);
    expect(soc.core.lines & (1 << 9)).toBe(0);
  });
});

describe('the S2 SYSTIMER (BT148)', () => {
  it('counts 80 ticks a µs on the crystal (XTAL_STEP 2, as IDF sets it) and under the PLL (PLL_STEP 1)', () => {
    const { soc, w, r } = idleSoc();
    w(SYSTIMER_BASE + 0x10, (1 << 10) | 2); // STEP
    w(SYSTIMER_BASE + 0x00, 1 << 31); // CLK_EN
    soc.runUntil(soc.time + REF_HZ / 1000); // 1 ms on the 40 MHz crystal
    w(SYSTIMER_BASE + 0x38, 1 << 31); // UPDATE
    expect(r(SYSTIMER_BASE + 0x38) >>> 30).toBe(1); // VALUE_VALID
    expect(r(SYSTIMER_BASE + 0x40)).toBe(80_000);
    w(SYSTEM_BASE + 0x18, 2); // CPUPERIOD_SEL 240 MHz
    w(SYSTEM_BASE + 0x8c, 1 << 10); // SOC_CLK_SEL: PLL (APB 80 MHz)
    soc.runUntil(soc.time + REF_HZ / 1000);
    w(SYSTIMER_BASE + 0x38, 1 << 31);
    expect(r(SYSTIMER_BASE + 0x40)).toBe(160_000);
  });

  it('alarms once at its target (one-shot), raising its source while INT_ENA has it; INT_CLR clears it', () => {
    const { soc, w, r } = idleSoc();
    w(SYSTIMER_BASE + 0x10, (1 << 10) | 2);
    w(SYSTIMER_BASE + 0x00, 1 << 31);
    w(SYSTIMER_BASE + 0x44, 1); // INT_ENA: comparator 0
    w(SYSTIMER_BASE + 0x14, 0);
    w(SYSTIMER_BASE + 0x18, 8000); // 100 µs
    w(SYSTIMER_BASE + 0x2c, 1 << 31); // WORK_EN, one-shot
    soc.runUntil(soc.time + (99 * REF_HZ) / 1_000_000);
    expect(r(SYSTIMER_BASE + 0x48)).toBe(0);
    soc.runUntil(soc.time + (2 * REF_HZ) / 1_000_000);
    expect(r(SYSTIMER_BASE + 0x48)).toBe(1);
    expect(soc.matrix.lines[S2_SRC.SYSTIMER_TARGET0]).toBe(1);
    w(SYSTIMER_BASE + 0x4c, 1);
    soc.runUntil(soc.time + REF_HZ / 1000);
    expect(r(SYSTIMER_BASE + 0x48)).toBe(0); // once
    expect(soc.matrix.lines[S2_SRC.SYSTIMER_TARGET0]).toBe(0);
  });

  it('in period mode alarms every PERIOD ticks', () => {
    const { soc, w } = idleSoc();
    let alarms = 0;
    w(SYSTIMER_BASE + 0x10, (1 << 10) | 2);
    w(SYSTIMER_BASE + 0x00, 1 << 31);
    w(SYSTIMER_BASE + 0x30, (1 << 31) | (1 << 30) | 80_000); // comparator 1: every 1 ms
    for (let i = 0; i < 5; i++) {
      soc.runUntil(soc.time + REF_HZ / 1000);
      if ((soc.systimer.intRaw & 2) !== 0) alarms++;
      w(SYSTIMER_BASE + 0x4c, 2);
    }
    expect(alarms).toBe(5);
  });
});

describe('the S2 flash through its MMU windows (BT148)', () => {
  const user = (w: (a: number, v: number) => void, command: number, opts: { addr?: number; mosi?: number[] } = {}): void => {
    let userReg = 1 << 31;
    w(SPI1_BASE_S2 + 0x20, (7 << 28) | command);
    if (opts.addr !== undefined) {
      userReg |= 1 << 30;
      w(SPI1_BASE_S2 + 0x1c, 23 << 26);
      w(SPI1_BASE_S2 + 0x04, opts.addr);
    }
    if (opts.mosi !== undefined) {
      userReg |= 1 << 27;
      w(SPI1_BASE_S2 + 0x24, opts.mosi.length * 8 - 1);
      for (let i = 0; i < opts.mosi.length; i += 4) w(SPI1_BASE_S2 + 0x58 + i, (opts.mosi[i] ?? 0) | ((opts.mosi[i + 1] ?? 0) << 8) | ((opts.mosi[i + 2] ?? 0) << 16) | ((opts.mosi[i + 3] ?? 0) << 24));
    }
    w(SPI1_BASE_S2 + 0x18, userReg);
    w(SPI1_BASE_S2 + 0x00, 1 << 18);
  };

  it('maps IROM (IBUS0 entry 8 → 0x4008_0000) and DROM (IBUS2 entry 128 → 0x3F00_0000); SPI1 programs show through them', () => {
    const { soc, w, r } = idleSoc();
    w(MMU_TABLE_BASE + 8 * 4, MMU_ACCESS_FLASH | 1);
    w(MMU_TABLE_BASE + 128 * 4, MMU_ACCESS_FLASH | 1);
    expect(r(MMU_TABLE_BASE + 8 * 4)).toBe(MMU_ACCESS_FLASH | 1);
    user(w, 0x06);
    user(w, 0x02, { addr: 0x10000, mosi: [0x0f, 0xf0, 0x3c, 0xc3] });
    expect(soc.bus.read32(0x40080000)).toBe(0xc33cf00f);
    expect(soc.bus.read32(0x3f000000)).toBe(0xc33cf00f);
    expect(soc.bus.fetch(0x40080000) & 0xffffff).toBe(0x3cf00f);
  });

  it('refuses a read through an invalid entry; a remap shows the new page at once; a PSRAM entry past the chip is a Problem', () => {
    const { soc, w } = idleSoc();
    const bus = soc.bus;
    expect(() => bus.read32(0x3f070000)).toThrow(XtensaBusError);
    soc.flash.data[0x20000] = 0xaa;
    soc.flash.data[0x30000] = 0xbb;
    w(MMU_TABLE_BASE + 135 * 4, MMU_ACCESS_FLASH | 2);
    expect(bus.read8(0x3f070000)).toBe(0xaa);
    w(MMU_TABLE_BASE + 135 * 4, MMU_ACCESS_FLASH | 3);
    expect(bus.read8(0x3f070000)).toBe(0xbb);
    w(MMU_TABLE_BASE + 135 * 4, 0x4000);
    expect(() => bus.read8(0x3f070000)).toThrow(XtensaBusError);
    w(MMU_TABLE_BASE + 256 * 4, MMU_ACCESS_SPIRAM | 40); // BT154: 2.5 MB into a 2 MB chip
    expect(() => bus.read8(0x3f800000)).toThrow(XtensaBusError);
    expect(soc.problems.problems.map((p) => p.code)).toContain('esp32s2-psram');
    // SRAM next to the DRAM0 window is never a window page (its last entry is below 0x3FF8_0000).
    w(MMU_TABLE_BASE + 255 * 4, MMU_ACCESS_FLASH | 2);
    bus.write32(0x3ffffd3c, 0x12345678);
    expect(bus.read32(0x3ffffd3c)).toBe(0x12345678);
  });
});

describe('the S2 bus (BT157)', () => {
  it('does unaligned loads and stores on SRAM and ROM in hardware (XCHAL_UNALIGNED_*_HW), as the ESP32 and S3', () => {
    const { soc } = idleSoc();
    const bus = soc.bus;
    bus.write32(0x3ffc9b40, 0x44332211);
    bus.write32(0x3ffc9b44, 0x88776655);
    expect(bus.read32(0x3ffc9b43)).toBe(0x77665544);
    expect(bus.read16(0x3ffc9b45)).toBe(0x7766);
    bus.write32(0x3ffc9b41, 0xddccbbaa);
    expect(bus.read32(0x3ffc9b40)).toBe(0xccbbaa11);
    expect(bus.read8(0x3ffc9b44)).toBe(0xdd);
    bus.write16(0x3ffc9b47, 0xeeff);
    expect(bus.read32(0x3ffc9b44)).toBe(0xff7766dd);
    expect(bus.read8(0x3ffc9b48)).toBe(0xee);
    const romWord = bus.read32(0x40000000);
    expect(bus.read32(0x40000001)).toBe(((romWord >>> 8) | (bus.read8(0x40000004) << 24)) >>> 0);
  });
});

describe('the S2 SYSTEM, EXTMEM and UART (BT148)', () => {
  it('switches the CPU to 240 MHz on the PLL: SOC_CLK_SEL 1, CPUPERIOD_SEL 2; back to the crystal', () => {
    const { soc, w, r } = idleSoc();
    expect(soc.cpuHz).toBe(40_000_000);
    w(SYSTEM_BASE + 0x18, (r(SYSTEM_BASE + 0x18) & ~3) | 2);
    w(SYSTEM_BASE + 0x8c, (r(SYSTEM_BASE + 0x8c) & ~(3 << 10)) | (1 << 10));
    expect([soc.cpuHz, soc.apbHz]).toEqual([240_000_000, 80_000_000]);
    w(SYSTEM_BASE + 0x8c, 0);
    expect([soc.cpuHz, soc.apbHz]).toEqual([40_000_000, 40_000_000]);
  });

  it('completes cache operations at once and reports the caches idle', () => {
    const { r, w } = idleSoc();
    w(EXTMEM_BASE + 0x40, 1 << 8); // PRO_ICACHE_CTRL: INVALIDATE_ENA
    expect(r(EXTMEM_BASE + 0x40) & (1 << 9)).not.toBe(0); // INVALIDATE_DONE
    expect(r(EXTMEM_BASE + 0x00) & (1 << 25)).not.toBe(0); // PRO_DCACHE_CTRL: LOCK_DONE
    expect(r(EXTMEM_BASE + 0x11c)).toBe(0x1001); // PRO_CACHE_STATE: both idle
  });

  it('sends UART FIFO bytes one frame apart at the baud rate: APB with TICK_REF_ALWAYS_ON, else the 1 MHz REF_TICK', () => {
    const { soc, w, r } = idleSoc();
    const sent: [number, number][] = [];
    soc.uarts[1].onTx = (byte) => sent.push([byte, soc.now()]);
    w(UART_BASES_S2[1] + 0x20, r(UART_BASES_S2[1] + 0x20) | (1 << 27)); // CONF0: TICK_REF_ALWAYS_ON (APB, 40 MHz here)
    w(UART_BASES_S2[1] + 0x14, 347); // CLKDIV: 40 MHz / 347 ≈ 115 kbaud
    expect(soc.uarts[1].baud()).toBeCloseTo(40_000_000 / 347, 3);
    const frame = (10 / soc.uarts[1].baud()) * REF_HZ;
    const start = soc.now();
    for (const byte of [0x41, 0x42, 0x43]) w(UART_BASES_S2[1], byte);
    soc.runUntil(start + 3.5 * frame);
    expect(sent.map(([b]) => b)).toEqual([0x41, 0x42, 0x43]);
    expect(Math.abs(sent[2][1] - sent[1][1] - frame)).toBeLessThan(2);
    w(UART_BASES_S2[1] + 0x20, r(UART_BASES_S2[1] + 0x20) & ~(1 << 27));
    w(UART_BASES_S2[1] + 0x14, 104);
    expect(soc.uarts[1].baud()).toBeCloseTo(1_000_000 / 104, 3);
  });
});
