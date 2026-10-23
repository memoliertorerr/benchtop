import { RiscvBusError } from '@benchtop/riscv';
import { describe, expect, it } from 'vitest';
import { REF_HZ } from './context.ts';
import { INTMATRIX_BASE, SRC } from './intmatrix.ts';
import { IRAM_BASE, IROM_BASE } from './memory.ts';
import { SARADC_BASE } from './saradc.ts';
import { Esp32c3Soc, MMU_TABLE_BASE } from './soc.ts';
import { SPI1_BASE } from './spi-mem.ts';
import { SYSTIMER_BASE } from './systimer.ts';
import { UART_BASES } from './uart.ts';

/** A SoC idling in a WFI loop in IRAM (interrupts off), with exact peripheral access helpers. */
function idleSoc(): { soc: Esp32c3Soc; r: (a: number) => number; w: (a: number, v: number) => void } {
  const soc = new Esp32c3Soc();
  soc.bus.write32(IRAM_BASE, 0x10500073); // wfi
  soc.bus.write32(IRAM_BASE + 4, 0xffdff06f); // j -4
  soc.core.pc = IRAM_BASE;
  const exact = <T>(f: () => T): T => {
    soc.bus.exact = true;
    try {
      return f();
    } finally {
      soc.bus.exact = false;
    }
  };
  return { soc, r: (a) => exact(() => soc.bus.read32(a)) >>> 0, w: (a, v) => exact(() => soc.bus.write32(a, v)) };
}

describe('the C3 interrupt matrix (BT92)', () => {
  const route = (w: (a: number, v: number) => void, source: number, line: number, priority: number): void => {
    w(INTMATRIX_BASE + source * 4, line);
    w(INTMATRIX_BASE + 0x114 + line * 4, priority);
  };

  it('presents a line at or above the threshold, and masks one below it', () => {
    const { soc, w } = idleSoc();
    route(w, SRC.UART0, 9, 1);
    w(INTMATRIX_BASE + 0x104, 1 << 9);
    w(INTMATRIX_BASE + 0x194, 1); // IDF's base threshold: priority 1 still interrupts
    soc.matrix.setSource(SRC.UART0, true);
    expect(soc.matrix.current).toBe(9);
    w(INTMATRIX_BASE + 0x194, 2); // a critical section's threshold masks it
    expect(soc.matrix.current).toBe(0);
    w(INTMATRIX_BASE + 0x194, 1);
    w(INTMATRIX_BASE + 0x114 + 9 * 4, 0); // priority 0 never interrupts
    expect(soc.matrix.current).toBe(0);
  });

  it('picks the highest priority, the lowest line on a tie', () => {
    const { soc, w } = idleSoc();
    route(w, SRC.UART0, 9, 2);
    route(w, SRC.UART1, 5, 2);
    route(w, SRC.TG0_T0, 12, 3);
    w(INTMATRIX_BASE + 0x104, (1 << 9) | (1 << 5) | (1 << 12));
    soc.matrix.setSource(SRC.UART0, true);
    soc.matrix.setSource(SRC.UART1, true);
    expect(soc.matrix.current).toBe(5);
    soc.matrix.setSource(SRC.TG0_T0, true);
    expect(soc.matrix.current).toBe(12);
  });

  it('latches an edge line until it is cleared', () => {
    const { soc, w, r } = idleSoc();
    route(w, SRC.FROM_CPU0, 3, 1);
    w(INTMATRIX_BASE + 0x108, 1 << 3); // edge
    w(INTMATRIX_BASE + 0x104, 1 << 3);
    soc.matrix.setSource(SRC.FROM_CPU0, true);
    soc.matrix.setSource(SRC.FROM_CPU0, false);
    expect(soc.matrix.current).toBe(3);
    expect(r(INTMATRIX_BASE + 0x110) & (1 << 3)).not.toBe(0);
    w(INTMATRIX_BASE + 0x10c, 1 << 3);
    expect(soc.matrix.current).toBe(0);
  });
});

describe('the C3 SYSTIMER (BT92)', () => {
  it('alarms every period once PERIOD_MODE is set after the load, as IDF does', () => {
    const { soc, w } = idleSoc();
    const alarms: number[] = [];
    soc.matrix.onCause = (cause) => {
      if (cause === 0) return;
      alarms.push(soc.now());
      soc.systimer.write32(0x6c, 1); // INT_CLR, as the tick ISR does
    };
    w(INTMATRIX_BASE + SRC.SYSTIMER_TARGET0 * 4, 4);
    w(INTMATRIX_BASE + 0x114 + 16, 1);
    w(INTMATRIX_BASE + 0x104, 1 << 4);
    // vPortSetupTimer: unit 1 from 0, comparator 0 on unit 1, period 1 ms (16,000 ticks).
    w(SYSTIMER_BASE + 0x00, (1 << 31) | (1 << 30) | (1 << 29)); // CLK_EN, both units
    w(SYSTIMER_BASE + 0x14, 0);
    w(SYSTIMER_BASE + 0x18, 0);
    w(SYSTIMER_BASE + 0x60, 1); // UNIT1_LOAD
    const loadedAt = soc.now();
    w(SYSTIMER_BASE + 0x34, (1 << 31) | 16_000); // TARGET0_CONF: UNIT_SEL, period
    w(SYSTIMER_BASE + 0x50, 1); // COMP0_LOAD
    w(SYSTIMER_BASE + 0x00, (1 << 31) | (1 << 30) | (1 << 29) | (1 << 24)); // TARGET0_WORK_EN
    w(SYSTIMER_BASE + 0x34, (1 << 31) | (1 << 30) | 16_000); // then PERIOD_MODE
    w(SYSTIMER_BASE + 0x64, 1); // INT_ENA
    soc.runUntil(loadedAt + 0.0055 * REF_HZ);
    expect(alarms.length).toBe(5);
    for (let i = 1; i < alarms.length; i++) expect(alarms[i] - alarms[i - 1]).toBe(REF_HZ / 1000);
  });

  it('reads a unit through UPDATE: the count at the write, 16 MHz', () => {
    const { soc, w, r } = idleSoc();
    soc.runUntil(0.001 * REF_HZ);
    w(SYSTIMER_BASE + 0x04, 1 << 30); // UNIT0_OP: UPDATE
    expect(r(SYSTIMER_BASE + 0x04) & (1 << 29)).not.toBe(0); // VALUE_VALID
    const ticks = r(SYSTIMER_BASE + 0x44);
    expect(Math.abs(ticks - 16_000)).toBeLessThanOrEqual(2);
  });
});

describe('the C3 SAR ADC one-shot conversion (BT92)', () => {
  it('converts on ONETIME_START: the sample, the done bit, the interrupt', () => {
    const { soc, w, r } = idleSoc();
    soc.adc.sample = (adc, channel, attenuation) => adc * 1000 + channel * 10 + attenuation;
    w(INTMATRIX_BASE + SRC.APB_ADC * 4, 7);
    w(INTMATRIX_BASE + 0x114 + 28, 1);
    w(INTMATRIX_BASE + 0x104, 1 << 7);
    w(SARADC_BASE + 0x40, 1 << 31); // INT_ENA: ADC1 done
    const conf = (1 << 31) | (4 << 25) | (3 << 23); // ADC1, channel 4, 11 dB
    w(SARADC_BASE + 0x20, conf);
    expect(r(SARADC_BASE + 0x44)).toBe(0);
    w(SARADC_BASE + 0x20, conf | (1 << 29));
    expect(r(SARADC_BASE + 0x44) >>> 0).toBe((1 << 31) >>> 0);
    expect(r(SARADC_BASE + 0x2c)).toBe(1043);
    expect(soc.matrix.current).toBe(7);
    w(SARADC_BASE + 0x4c, 1 << 31); // INT_CLR
    expect(r(SARADC_BASE + 0x44)).toBe(0);
    expect(soc.matrix.current).toBe(0);
  });
});

describe('the C3 flash and its MMU (BT92)', () => {
  const user = (w: (a: number, v: number) => void, command: number, opts: { addr?: number; mosi?: number[]; misoBits?: number } = {}): void => {
    let userReg = 1 << 31; // USR_COMMAND
    w(SPI1_BASE + 0x20, (7 << 28) | command); // USER2: 8-bit command
    if (opts.addr !== undefined) {
      userReg |= 1 << 30;
      w(SPI1_BASE + 0x1c, 23 << 26); // 24 address bits
      w(SPI1_BASE + 0x04, opts.addr);
    }
    if (opts.mosi !== undefined) {
      userReg |= 1 << 27;
      w(SPI1_BASE + 0x24, opts.mosi.length * 8 - 1);
      for (let i = 0; i < opts.mosi.length; i += 4) w(SPI1_BASE + 0x58 + i, (opts.mosi[i] ?? 0) | ((opts.mosi[i + 1] ?? 0) << 8) | ((opts.mosi[i + 2] ?? 0) << 16) | ((opts.mosi[i + 3] ?? 0) << 24));
    }
    if (opts.misoBits !== undefined) {
      userReg |= 1 << 28;
      w(SPI1_BASE + 0x28, opts.misoBits - 1);
    }
    w(SPI1_BASE + 0x18, userReg);
    w(SPI1_BASE + 0x00, 1 << 18); // CMD.USR
  };

  it('keeps QE once written with WRSR2 and reads it back with RDSR2', () => {
    const { w, r } = idleSoc();
    user(w, 0x31, { mosi: [0x02] }); // without a write enable: ignored
    user(w, 0x35, { misoBits: 8 });
    expect(r(SPI1_BASE + 0x58) & 0xff).toBe(0);
    user(w, 0x06);
    user(w, 0x31, { mosi: [0x02] });
    user(w, 0x35, { misoBits: 8 });
    expect(r(SPI1_BASE + 0x58) & 0xff).toBe(0x02);
    user(w, 0x9f, { misoBits: 24 });
    expect(r(SPI1_BASE + 0x58) & 0xffffff).toBe(0x1640c8);
  });

  it('programs by AND and erases a sector to 0xFF, and the cache sees it', () => {
    const { soc, w, r } = idleSoc();
    soc.flash.data.fill(0xff);
    w(MMU_TABLE_BASE + 0, 1); // IROM page 0 → flash 0x10000
    user(w, 0x06);
    user(w, 0x02, { addr: 0x10000, mosi: [0x0f, 0xf0, 0x3c, 0xc3] });
    expect(soc.bus.read32(IROM_BASE)).toBe(0xc33cf00f);
    user(w, 0x06);
    user(w, 0x02, { addr: 0x10000, mosi: [0xf0, 0xff, 0xff, 0xff] });
    expect(soc.bus.read32(IROM_BASE) & 0xff).toBe(0x00);
    user(w, 0x06);
    user(w, 0x20, { addr: 0x10000 });
    expect(soc.bus.read32(IROM_BASE)).toBe(0xffffffff);
    expect(r(MMU_TABLE_BASE)).toBe(1);
  });

  it('refuses a read through an invalid MMU entry', () => {
    const { soc } = idleSoc();
    expect(() => soc.bus.read32(IROM_BASE + 0x20000)).toThrow(RiscvBusError);
  });
});

describe('the C3 UART (BT92)', () => {
  it('sends FIFO bytes one frame apart at the baud rate', () => {
    const { soc, w } = idleSoc();
    const sent: [number, number][] = [];
    soc.uarts[0].onTx = (byte) => sent.push([byte, soc.now()]);
    const frame = (10 / soc.uarts[0].baud()) * REF_HZ; // 8N1 at the reset divider
    const start = soc.now();
    for (const byte of [0x41, 0x42, 0x43]) w(UART_BASES[0], byte);
    soc.runUntil(start + 2.5 * frame);
    expect(sent.map(([b]) => b)).toEqual([0x41, 0x42]);
    soc.runUntil(start + 3.5 * frame);
    expect(sent.map(([b]) => b)).toEqual([0x41, 0x42, 0x43]);
    expect(Math.abs(sent[0][1] - start - frame)).toBeLessThan(2);
    expect(Math.abs(sent[2][1] - sent[1][1] - frame)).toBeLessThan(2);
  });
});
