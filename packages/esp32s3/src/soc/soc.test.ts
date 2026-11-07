import { XtensaBusError } from '@benchtop/esp32';
import { SPI1_BASE, SYSTIMER_BASE } from '@benchtop/esp32c3';
import { describe, expect, it } from 'vitest';
import { CODE_S3_FLASH_PIN, S3_GPIO_BASE, S3_IO_MUX_BASE, S3_PAD_MODE } from './gpio.ts';
import { INTERRUPT_BASE, S3_SRC } from './intmatrix.ts';
import { DROM_FLASH_BASE, IRAM_BASE, IROM_BASE } from './memory.ts';
import { REF_HZ } from './rtc-cntl.ts';
import { Esp32s3Soc, MMU_TABLE_BASE, UART_BASES_S3 } from './soc.ts';
import { EXTMEM_BASE, SYSTEM_BASE } from './system.ts';

// BT124: the S3 SoC's pieces on their own — the PRO_CPU parked in `waiti 15` (nothing wakes it),
// registers written through its bus as firmware would.

function idleSoc() {
  const soc = new Esp32s3Soc();
  soc.memory.sram.set([0x00, 0x7f, 0x00, 0x46, 0xff, 0xff], 0); // waiti 15; j .-3
  soc.cores[0].pc = IRAM_BASE;
  const bus = soc.buses[0];
  return { soc, w: (a: number, v: number) => bus.write32(a, v), r: (a: number) => bus.read32(a) };
}

describe('the S3 interrupt matrix (BT124)', () => {
  it('routes a source to each core\'s own CPU interrupt; INTR_STATUS shows the raw line', () => {
    const { soc, w, r } = idleSoc();
    w(INTERRUPT_BASE + S3_SRC.UART0 * 4, 13); // core 0: CPU interrupt 13 (level 1)
    w(INTERRUPT_BASE + 0x800 + S3_SRC.UART0 * 4, 17); // core 1: 17
    expect(r(INTERRUPT_BASE + S3_SRC.UART0 * 4)).toBe(13);
    soc.matrix.setSource(S3_SRC.UART0, true);
    expect((soc.cores[0].lines >>> 13) & 1).toBe(1);
    expect((soc.cores[1].lines >>> 17) & 1).toBe(1);
    expect((r(INTERRUPT_BASE + 0x18c) >>> S3_SRC.UART0) & 1).toBe(1);
    expect((r(INTERRUPT_BASE + 0x800 + 0x18c) >>> S3_SRC.UART0) & 1).toBe(1);
    w(INTERRUPT_BASE + 0x800 + S3_SRC.UART0 * 4, 16); // core 1: back to an internal interrupt (off)
    expect((soc.cores[1].lines >>> 17) & 1).toBe(0);
    soc.matrix.setSource(S3_SRC.UART0, false);
    expect((soc.cores[0].lines >>> 13) & 1).toBe(0);
    // Source 96 (USB-Serial-JTAG) is in the fourth status word.
    soc.matrix.setSource(S3_SRC.USB_SERIAL_JTAG, true);
    expect((r(INTERRUPT_BASE + 0x18c + 12) >>> (96 - 96)) & 1).toBe(1);
  });
});

describe('the S3 SYSTIMER on the 240 MHz base (BT124)', () => {
  it('reads a unit through UPDATE: the count at the write, 16 MHz', () => {
    const { soc, w, r } = idleSoc();
    soc.runUntil(0.001 * REF_HZ);
    w(SYSTIMER_BASE + 0x04, 1 << 30); // UNIT0_OP: UPDATE
    expect(r(SYSTIMER_BASE + 0x04) & (1 << 29)).not.toBe(0); // VALUE_VALID
    expect(Math.abs(r(SYSTIMER_BASE + 0x44) - 16_000)).toBeLessThanOrEqual(2);
  });

  it('alarms every period once PERIOD_MODE is set after the load, as IDF does', () => {
    const { soc, w } = idleSoc();
    const alarms: number[] = [];
    const raise = soc.matrix.setSource.bind(soc.matrix);
    soc.matrix.setSource = (source, high) => {
      raise(source, high);
      if (source === S3_SRC.SYSTIMER_TARGET0 && high) {
        alarms.push(soc.now());
        soc.systimer.write32(0x6c, 1); // INT_CLR, as the tick ISR does
      }
    };
    w(SYSTIMER_BASE + 0x00, (1 << 31) | (1 << 30) | (1 << 29));
    w(SYSTIMER_BASE + 0x14, 0);
    w(SYSTIMER_BASE + 0x18, 0);
    w(SYSTIMER_BASE + 0x60, 1); // UNIT1_LOAD
    const loadedAt = soc.now();
    w(SYSTIMER_BASE + 0x34, (1 << 31) | 16_000); // TARGET0_CONF: UNIT_SEL, period 1 ms
    w(SYSTIMER_BASE + 0x50, 1); // COMP0_LOAD
    w(SYSTIMER_BASE + 0x00, (1 << 31) | (1 << 30) | (1 << 29) | (1 << 24));
    w(SYSTIMER_BASE + 0x34, (1 << 31) | (1 << 30) | 16_000); // PERIOD_MODE
    w(SYSTIMER_BASE + 0x64, 1); // INT_ENA
    soc.runUntil(loadedAt + 0.0055 * REF_HZ);
    expect(alarms.length).toBe(5);
    for (let i = 1; i < alarms.length; i++) expect(alarms[i] - alarms[i - 1]).toBe(REF_HZ / 1000);
  });
});

describe('the S3 flash, its MMU and SPI1 (BT124)', () => {
  const user = (w: (a: number, v: number) => void, command: number, opts: { addr?: number; mosi?: number[] } = {}): void => {
    let userReg = 1 << 31;
    w(SPI1_BASE + 0x20, (7 << 28) | command);
    if (opts.addr !== undefined) {
      userReg |= 1 << 30;
      w(SPI1_BASE + 0x1c, 23 << 26);
      w(SPI1_BASE + 0x04, opts.addr);
    }
    if (opts.mosi !== undefined) {
      userReg |= 1 << 27;
      w(SPI1_BASE + 0x24, opts.mosi.length * 8 - 1);
      for (let i = 0; i < opts.mosi.length; i += 4) w(SPI1_BASE + 0x58 + i, (opts.mosi[i] ?? 0) | ((opts.mosi[i + 1] ?? 0) << 8) | ((opts.mosi[i + 2] ?? 0) << 16) | ((opts.mosi[i + 3] ?? 0) << 24));
    }
    w(SPI1_BASE + 0x18, userReg);
    w(SPI1_BASE + 0x00, 1 << 18);
  };

  it('maps a 64 KB page into both windows; programs and erases through SPI1 show through them', () => {
    const { soc, w, r } = idleSoc();
    w(MMU_TABLE_BASE + 5 * 4, 1); // entry 5 → flash 0x10000: IBUS 0x4205_0000 and DBUS 0x3C05_0000
    expect(r(MMU_TABLE_BASE + 5 * 4)).toBe(1);
    const bus = soc.buses[0];
    user(w, 0x06);
    user(w, 0x02, { addr: 0x10000, mosi: [0x0f, 0xf0, 0x3c, 0xc3] });
    expect(bus.read32(IROM_BASE + 5 * 0x10000)).toBe(0xc33cf00f);
    expect(bus.read32(DROM_FLASH_BASE + 5 * 0x10000)).toBe(0xc33cf00f);
    expect(bus.read8(DROM_FLASH_BASE + 5 * 0x10000 + 2)).toBe(0x3c);
    user(w, 0x06);
    user(w, 0x20, { addr: 0x10000 });
    expect(bus.read32(IROM_BASE + 5 * 0x10000)).toBe(0xffffffff);
  });

  it('refuses a read through an invalid MMU entry; a remap shows the new page at once', () => {
    const { soc, w } = idleSoc();
    const bus = soc.buses[0];
    expect(() => bus.read32(DROM_FLASH_BASE + 7 * 0x10000)).toThrow(XtensaBusError);
    soc.flash.data[0x20000] = 0xaa;
    soc.flash.data[0x30000] = 0xbb;
    w(MMU_TABLE_BASE + 7 * 4, 2);
    expect(bus.read8(DROM_FLASH_BASE + 7 * 0x10000)).toBe(0xaa);
    w(MMU_TABLE_BASE + 7 * 4, 3);
    expect(bus.read8(DROM_FLASH_BASE + 7 * 0x10000)).toBe(0xbb);
    w(MMU_TABLE_BASE + 7 * 4, 0x4000);
    expect(() => bus.read8(DROM_FLASH_BASE + 7 * 0x10000)).toThrow(XtensaBusError);
  });
});

describe('the S3 SYSTEM, EXTMEM and UART (BT124)', () => {
  it('starts the APP_CPU at the ROM reset vector when CORE_1_CONTROL_0 ungates it, and stalls it again', () => {
    const { soc, w } = idleSoc();
    expect(soc.appRunning).toBe(false);
    w(SYSTEM_BASE + 0x00, 1 << 1); // CLKGATE_EN, RUNSTALL and RESETING clear
    expect(soc.appRunning).toBe(true);
    expect(soc.cores[1].pc).toBe(0x40000400);
    w(SYSTEM_BASE + 0x00, (1 << 1) | 1); // RUNSTALL
    expect(soc.appRunning).toBe(false);
  });

  it('switches the CPU to 240 MHz on the PLL: SOC_CLK_SEL 1, CPUPERIOD_SEL 2', () => {
    const { soc, w, r } = idleSoc();
    w(SYSTEM_BASE + 0x10, (r(SYSTEM_BASE + 0x10) & ~3) | 2);
    w(SYSTEM_BASE + 0x60, (r(SYSTEM_BASE + 0x60) & ~(3 << 10)) | (1 << 10));
    expect(soc.cpuHz).toBe(240_000_000);
    expect(soc.apbHz).toBe(80_000_000);
  });

  it('completes cache operations at once; a freeze\'s DONE follows its enable', () => {
    const { w, r } = idleSoc();
    w(EXTMEM_BASE + 0x88, 1); // ICACHE_SYNC_CTRL: INVALIDATE_ENA
    expect(r(EXTMEM_BASE + 0x88) & 3).toBe(2); // SYNC_DONE, ENA clear
    w(EXTMEM_BASE + 0x154, 1); // ICACHE_FREEZE: ENA
    expect(r(EXTMEM_BASE + 0x154) & 4).toBe(4);
    w(EXTMEM_BASE + 0x154, 0);
    expect(r(EXTMEM_BASE + 0x154) & 4).toBe(0); // what Cache_Freeze_ICache_Disable waits for
  });

  it('sends UART FIFO bytes one frame apart at the baud rate (UART2 at its own address)', () => {
    const { soc, w } = idleSoc();
    const sent: [number, number][] = [];
    soc.uarts[2].onTx = (byte) => sent.push([byte, soc.now()]);
    const frame = (10 / soc.uarts[2].baud()) * REF_HZ;
    const start = soc.now();
    for (const byte of [0x41, 0x42, 0x43]) w(UART_BASES_S3[2], byte);
    soc.runUntil(start + 3.5 * frame);
    expect(sent.map(([b]) => b)).toEqual([0x41, 0x42, 0x43]);
    expect(Math.abs(sent[2][1] - sent[1][1] - frame)).toBeLessThan(2);
  });
});

describe('the S3 GPIO on its own (BT125)', () => {
  it('a low-level interrupt on GPIO5 holds STATUS while the pad stays low and reaches the core each map names', () => {
    const { soc, w, r } = idleSoc();
    w(INTERRUPT_BASE + S3_SRC.GPIO * 4, 13); // core 0: CPU interrupt 13
    w(INTERRUPT_BASE + 0x800 + S3_SRC.GPIO * 4, 17); // core 1: 17
    soc.gpio.setPadInput(5, 1);
    w(S3_GPIO_BASE + 0x74 + 5 * 4, (4 << 7) | (1 << 13)); // PIN5: INT_TYPE low level, INT_ENA CPU
    expect(r(S3_GPIO_BASE + 0x44) & (1 << 5)).toBe(0);
    soc.gpio.setPadInput(5, 0);
    expect(r(S3_GPIO_BASE + 0x44) & (1 << 5)).not.toBe(0);
    expect(r(S3_GPIO_BASE + 0x5c) & (1 << 5)).not.toBe(0); // PCPU_INT
    expect((soc.cores[0].lines >>> 13) & 1).toBe(1);
    expect((soc.cores[1].lines >>> 17) & 1).toBe(1);
    w(S3_GPIO_BASE + 0x4c, 1 << 5); // STATUS_W1TC while still low: set again
    expect(r(S3_GPIO_BASE + 0x44) & (1 << 5)).not.toBe(0);
    soc.gpio.setPadInput(5, 1);
    w(S3_GPIO_BASE + 0x4c, 1 << 5);
    expect(r(S3_GPIO_BASE + 0x44) & (1 << 5)).toBe(0);
    expect((soc.cores[0].lines >>> 13) & 1).toBe(0);
    // GPIO40 is in the second word: STATUS1, PCPU_INT1.
    w(S3_GPIO_BASE + 0x74 + 40 * 4, (2 << 7) | (1 << 13)); // falling edge
    soc.gpio.setPadInput(40, 1);
    soc.gpio.setPadInput(40, 0);
    expect(r(S3_GPIO_BASE + 0x50) & (1 << 8)).not.toBe(0);
    expect(r(S3_GPIO_BASE + 0x68) & (1 << 8)).not.toBe(0);
  });

  it('refuses the module\'s flash pads: the bench can\'t drive them; firmware making one a GPIO gets a warning', () => {
    const { soc, w, r } = idleSoc();
    const before = soc.gpio.padInput(27);
    soc.gpio.setPadInput(27, before ^ 1);
    expect(soc.gpio.padInput(27)).toBe(before); // ignored
    const pad = r(S3_IO_MUX_BASE + 4 + 27 * 4);
    w(S3_IO_MUX_BASE + 4 + 27 * 4, pad | (3 << 10)); // drive strength only: still SPIHD
    expect(soc.problems.count(CODE_S3_FLASH_PIN)).toBe(0);
    w(S3_IO_MUX_BASE + 4 + 27 * 4, (pad & ~(7 << 12)) | (1 << 12)); // MCU_SEL 1: GPIO
    expect(soc.problems.problems.find((p) => p.code === CODE_S3_FLASH_PIN)?.message).toMatch(/GPIO27 is the module's SPI flash \(SPIHD\)/);
    // GPIO35 (PSRAM only on octal modules) is a free pad.
    w(S3_GPIO_BASE + 0x2c, 1 << 3); // ENABLE1: GPIO35
    w(S3_GPIO_BASE + 0x554 + 35 * 4, 256); // OUT_SEL: the GPIO_OUT bit
    w(S3_GPIO_BASE + 0x10, 1 << 3); // OUT1
    expect(soc.pads.mode[35]).toBe(S3_PAD_MODE.OUTPUT);
    expect(soc.pads.level[35]).toBe(1);
    expect(soc.problems.count(CODE_S3_FLASH_PIN)).toBe(1);
  });
});
