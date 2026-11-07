/**
 * The ESP32-S3's analog I2C master (BT124; 0x6000_E000): the ROM's rom_i2c_* functions reach the
 * analog blocks (BBPLL, BIAS, …) through it, and IDF's rtc_clk_bbpll_configure waits on it for the
 * PLL's calibration — ANA_CONF0 (0x40) bit 24, BBPLL_CAL_DONE, which reads 1 here: the PLL
 * calibrates at once. The rest reads back as written (the analog registers aren't modeled).
 */

import type { Peripheral } from '@benchtop/esp32';
import { registerDefault } from './periph.ts';

export const ANA_I2C_BASE = 0x6000e000;
const ANA_CONF0 = 0x40;
const BBPLL_CAL_DONE = 1 << 24;

export class S3AnalogI2c implements Peripheral {
  private readonly regs = new Uint32Array(1024);

  constructor() {
    this.systemReset();
  }

  systemReset(): void {
    for (let i = 0; i < this.regs.length; i++) this.regs[i] = registerDefault(ANA_I2C_BASE + i * 4);
  }

  read32(offset: number): number {
    if (offset === ANA_CONF0) return (this.regs[offset >>> 2] | BBPLL_CAL_DONE) >>> 0;
    return this.regs[offset >>> 2];
  }

  write32(offset: number, value: number): void {
    this.regs[offset >>> 2] = value;
  }
}
