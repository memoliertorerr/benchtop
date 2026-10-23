/**
 * The ESP32-C3's SAR ADC controller, one-shot mode (BT92; apb_saradc_reg.h, 0x60040000). Startup's
 * self-calibration and analogRead use it the same way: ONETIME_SAMPLE (+0x20) picks the ADC
 * (SARADC1_ONETIME_SAMPLE bit 31, SARADC2 bit 30), the channel (bits 28:25) and the attenuation
 * (24:23); a 0 → 1 of ONETIME_START (bit 29) converts. The conversion completes at once: the
 * 12-bit result lands in 1_DATA_STATUS (+0x2C) or 2_DATA_STATUS (+0x30) and INT_RAW (+0x44) sets
 * ADC1_ONETIME_DONE (bit 31) or ADC2 (bit 30). INT_ENA (+0x40), INT_ST (+0x48) and INT_CLR (+0x4C)
 * as usual; source 43 (APB_ADC) follows INT_ST. `sample(adc, channel, attenuation)` gives the
 * result — 0 until a board feeds it pin voltages. DMA (continuous) mode isn't modeled.
 */

import type { Peripheral } from '@benchtop/esp32';
import type { SocContext } from './context.ts';
import { SRC } from './intmatrix.ts';
import { registerDefault } from './periph.ts';

export const SARADC_BASE = 0x60040000;

const ONETIME_SAMPLE = 0x020;
const DATA_STATUS1 = 0x02c;
const DATA_STATUS2 = 0x030;
const INT_ENA = 0x040;
const INT_RAW = 0x044;
const INT_ST = 0x048;
const INT_CLR = 0x04c;

const ADC1_SELECT = 1 << 31;
const ADC2_SELECT = 1 << 30;
const ONETIME_START = 1 << 29;
const ADC1_DONE = 1 << 31;
const ADC2_DONE = 1 << 30;

export class SarAdc implements Peripheral {
  private readonly ctx: SocContext;
  private readonly regs = new Uint32Array(1024);
  /** The 12-bit result of a conversion: `adc` 1 or 2. */
  sample: (adc: number, channel: number, attenuation: number) => number = () => 0;

  constructor(ctx: SocContext) {
    this.ctx = ctx;
    this.systemReset();
  }

  systemReset(): void {
    for (let i = 0; i < this.regs.length; i++) this.regs[i] = registerDefault(SARADC_BASE + i * 4);
    this.update();
  }

  private update(): void {
    this.ctx.matrix.setSource(SRC.APB_ADC, (this.regs[INT_RAW >>> 2] & this.regs[INT_ENA >>> 2]) !== 0);
  }

  read32(offset: number): number {
    if (offset === INT_ST) return (this.regs[INT_RAW >>> 2] & this.regs[INT_ENA >>> 2]) >>> 0;
    return this.regs[offset >>> 2];
  }

  write32(offset: number, value: number): void {
    switch (offset) {
      case ONETIME_SAMPLE: {
        const old = this.regs[ONETIME_SAMPLE >>> 2];
        this.regs[ONETIME_SAMPLE >>> 2] = value;
        if ((value & ONETIME_START) !== 0 && (old & ONETIME_START) === 0) this.convert(value);
        return;
      }
      case INT_RAW:
      case INT_ST:
        return;
      case INT_CLR:
        this.regs[INT_RAW >>> 2] &= ~value;
        this.update();
        return;
      case INT_ENA:
        this.regs[INT_ENA >>> 2] = value;
        this.update();
        return;
      default:
        this.regs[offset >>> 2] = value;
    }
  }

  private convert(conf: number): void {
    const channel = (conf >>> 25) & 0xf;
    const attenuation = (conf >>> 23) & 3;
    if ((conf & ADC1_SELECT) !== 0) {
      this.regs[DATA_STATUS1 >>> 2] = this.sample(1, channel, attenuation) & 0xfff;
      this.regs[INT_RAW >>> 2] |= ADC1_DONE;
    }
    if ((conf & ADC2_SELECT) !== 0) {
      this.regs[DATA_STATUS2 >>> 2] = this.sample(2, channel, attenuation) & 0xfff;
      this.regs[INT_RAW >>> 2] |= ADC2_DONE;
    }
    this.update();
  }
}
