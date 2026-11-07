/**
 * The ESP32-S3's interrupt matrix (BT124; interrupt_core0_reg.h, interrupt_core1_reg.h): 99
 * peripheral sources (periph_defs.h), each routed per core to one of its 32 Xtensa interrupts by
 * a map register — core 0's at INTERRUPT_CORE0 + 4·source (0x600C_2000), core 1's at +0x800 —
 * reset value 16 (an internal interrupt: no effect), as the ESP32's DPORT maps. The routing is
 * @benchtop/esp32's InterruptMatrix over 99 sources; this block holds its registers. INTR_STATUS_0–3
 * (core 0 at 0x18C, core 1 at 0x98C) show the raw source lines; the rest reads back.
 */

import { InterruptMatrix, type Peripheral } from '@benchtop/esp32';
import { registerDefault } from './periph.ts';

export const INTERRUPT_BASE = 0x600c2000;
export const S3_SOURCE_COUNT = 99;
const CORE1 = 0x800;
const STATUS = 0x18c;

/** The sources the S3's models raise (periph_defs.h's ETS_*_SOURCE). */
export const S3_SRC = {
  GPIO: 16,
  GPIO_NMI: 17,
  GPIO2: 18,
  GPIO_NMI2: 19,
  SPI2: 21,
  SPI3: 22,
  UART0: 27,
  UART1: 28,
  UART2: 29,
  LEDC: 35,
  USB: 38,
  RMT: 40,
  I2C0: 42,
  I2C1: 43,
  TG0_T0: 50,
  TG0_T1: 51,
  TG0_WDT: 52,
  TG1_T0: 53,
  TG1_T1: 54,
  TG1_WDT: 55,
  CACHE_IA: 56,
  SYSTIMER_TARGET0: 57,
  SYSTIMER_TARGET1: 58,
  SYSTIMER_TARGET2: 59,
  APB_ADC: 65,
  FROM_CPU0: 79,
  USB_SERIAL_JTAG: 96,
} as const;

export class S3InterruptMatrix extends InterruptMatrix implements Peripheral {
  private readonly regs = new Uint32Array(1024);

  constructor() {
    super(S3_SOURCE_COUNT);
    this.systemReset();
  }

  systemReset(): void {
    for (let i = 0; i < this.regs.length; i++) this.regs[i] = registerDefault(INTERRUPT_BASE + i * 4);
    this.reset();
  }

  read32(offset: number): number {
    for (let cpu = 0; cpu < 2; cpu++) {
      const base = cpu * CORE1;
      if (offset >= base && offset < base + S3_SOURCE_COUNT * 4) return this.map[cpu][(offset - base) >>> 2];
      if (offset >= base + STATUS && offset < base + STATUS + 16) return this.status(cpu, (offset - base - STATUS) >>> 2);
    }
    return this.regs[offset >>> 2];
  }

  write32(offset: number, value: number): void {
    for (let cpu = 0; cpu < 2; cpu++) {
      const base = cpu * CORE1;
      if (offset >= base && offset < base + S3_SOURCE_COUNT * 4) {
        this.setMap(cpu, (offset - base) >>> 2, value & 31);
        return;
      }
      if (offset >= base + STATUS && offset < base + STATUS + 16) return; // read-only
    }
    this.regs[offset >>> 2] = value;
  }
}
