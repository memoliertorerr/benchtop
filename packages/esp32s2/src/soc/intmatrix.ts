/**
 * The ESP32-S2's interrupt matrix (BT148; interrupt_reg.h at 0x3F4C_2000): 95 peripheral sources
 * (periph_defs.h), each routed to one of the core's 32 Xtensa interrupts by a map register at
 * INTERRUPT + 4·source (reset value 16: an internal interrupt — no effect), as the ESP32's PRO_CPU
 * maps. The routing is @benchtop/esp32's InterruptMatrix over 95 sources and one core;
 * PRO_INTR_STATUS_0–2 (0x17C–0x184) show the raw source lines; the rest reads back.
 */

import { InterruptMatrix, type Peripheral } from '@benchtop/esp32';
import { registerDefault } from './periph.ts';

export const INTERRUPT_BASE = 0x3f4c2000;
export const S2_SOURCE_COUNT = 95;
const STATUS = 0x17c;

/** The sources the S2's models raise (periph_defs.h's ETS_*_SOURCE). */
export const S2_SRC = {
  TG0_T0: 15,
  TG0_WDT: 17,
  TG1_T0: 19,
  TG1_WDT: 21,
  GPIO: 23,
  GPIO_NMI: 24,
  FROM_CPU0: 28,
  SPI1: 32,
  SPI2: 33,
  SPI3: 34,
  UART0: 37,
  UART1: 38,
  LEDC: 45,
  USB: 48,
  RTC_CORE: 49,
  RMT: 50,
  I2C0: 52,
  I2C1: 53,
  TG0_T0_EDGE: 62,
  TG1_T0_EDGE: 66,
  SYSTIMER_TARGET0: 71,
  SYSTIMER_TARGET1: 72,
  SYSTIMER_TARGET2: 73,
  APB_ADC: 89,
} as const;

export class S2InterruptMatrix extends InterruptMatrix implements Peripheral {
  private readonly regs = new Uint32Array(1024);

  constructor() {
    super(S2_SOURCE_COUNT);
    this.systemReset();
  }

  systemReset(): void {
    for (let i = 0; i < this.regs.length; i++) this.regs[i] = registerDefault(INTERRUPT_BASE + i * 4);
    this.reset();
  }

  read32(offset: number): number {
    if (offset < S2_SOURCE_COUNT * 4) return this.map[0][offset >>> 2];
    if (offset >= STATUS && offset < STATUS + 12) return this.status(0, (offset - STATUS) >>> 2);
    return this.regs[offset >>> 2];
  }

  write32(offset: number, value: number): void {
    if (offset < S2_SOURCE_COUNT * 4) {
      this.setMap(0, offset >>> 2, value & 31);
      return;
    }
    if (offset >= STATUS && offset < STATUS + 12) return; // read-only
    this.regs[offset >>> 2] = value;
  }
}
