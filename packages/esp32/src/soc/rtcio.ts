/**
 * RTC IO (0x3FF48400, inside the RTC_CNTL block; rtc_io_reg.h, TRM v5.8 §6.11) — the 18 RTC pads'
 * analog/RTC routing and their pulls. Per pad (Table 6.11-1 and the rtc_io_reg.h fields): MUX_SEL
 * routes the pad to the RTC domain (ADC, DAC, touch, RTC GPIO) instead of the digital IO_MUX —
 * Benchtop reports such a pin as `analog`; RUE/RDE are the pull-up/pull-down that work on these
 * pads in digital mode too (IDF's gpio_pullup_en uses rtc_gpio_pullup_en on them). GPIO34–39
 * have no pull resistors. RTC GPIO output (RTC_GPIO_OUT) isn't modeled. Reset pulls follow IO_MUX
 * Table 6.10-1's Reset column (GPIO0, 14, 15 pull-up; 2, 4, 12, 13 pull-down). The registers sit
 * in the RTC domain: a digital (non-RTC) chip reset keeps them.
 *
 * DAC (BT41): GPIO25/26 (DAC channels 1/2) output RTC_IO_PDACn_DAC (bits 26:19) as
 * code / 255 · 3.3 V while the pad is routed to RTC (MUX_SEL) and RTC_IO_PDACn_XPD_DAC (bit 18)
 * powers the DAC — what IDF 4.4's dac_output_enable + dac_output_voltage (Arduino's dacWrite)
 * leave. The cosine generator (SENS_SAR_DAC_CTRL1/2) and DAC DMA through I2S0 aren't modeled.
 */

import { RegisterFile } from './periph.ts';
import { PAD_RESET } from './iomux.ts';

/** RTC IO's offset inside the RTC_CNTL block. */
export const RTC_IO_OFFSET = 0x400;
/** RTC IO register space size (RTC_IO_DATE_REG is at +0xC8). */
export const RTC_IO_END = 0xcc;

/** Per GPIO: register offset (within RTC IO), MUX_SEL bit, RUE bit, RDE bit (−1: none). */
interface RtcPad {
  reg: number;
  mux: number;
  rue: number;
  rde: number;
}

const SENSOR_PADS = 0x7c;
const ADC_PAD = 0x80;
const PAD_DAC1 = 0x84;
const PAD_DAC2 = 0x88;
const XTAL_32K_PAD = 0x8c;
/** The DAC's full scale (VDD3P3_RTC on a DevKit), volts. */
export const DAC_VDD = 3.3;
const TOUCH_PAD0 = 0x94;
/** Touch pad i's GPIO (Table 6.11-1: T0 = GPIO4, T1 = 0, T2 = 2, T3 = 15, T4 = 13, T5 = 12, T6 = 14, T7 = 27). */
const TOUCH_GPIO = [4, 0, 2, 15, 13, 12, 14, 27];

export const RTC_PADS: readonly (RtcPad | undefined)[] = (() => {
  const t: (RtcPad | undefined)[] = new Array<RtcPad | undefined>(40).fill(undefined);
  t[36] = { reg: SENSOR_PADS, mux: 27, rue: -1, rde: -1 };
  t[37] = { reg: SENSOR_PADS, mux: 26, rue: -1, rde: -1 };
  t[38] = { reg: SENSOR_PADS, mux: 25, rue: -1, rde: -1 };
  t[39] = { reg: SENSOR_PADS, mux: 24, rue: -1, rde: -1 };
  t[34] = { reg: ADC_PAD, mux: 29, rue: -1, rde: -1 };
  t[35] = { reg: ADC_PAD, mux: 28, rue: -1, rde: -1 };
  t[25] = { reg: PAD_DAC1, mux: 17, rue: 27, rde: 28 };
  t[26] = { reg: PAD_DAC2, mux: 17, rue: 27, rde: 28 };
  t[32] = { reg: XTAL_32K_PAD, mux: 17, rue: 22, rde: 23 };
  t[33] = { reg: XTAL_32K_PAD, mux: 18, rue: 27, rde: 28 };
  TOUCH_GPIO.forEach((gpio, i) => {
    t[gpio] = { reg: TOUCH_PAD0 + 4 * i, mux: 19, rue: 27, rde: 28 };
  });
  return t;
})();

export class RtcIo {
  /** Registers 0x000–0x0C8 of RTC IO (word index = offset / 4). */
  readonly regs = new Uint32Array(RTC_IO_END >>> 2);
  /** Called after any write (the pad resolver recomputes). */
  onChange: (() => void) | null = null;
  private readonly file: RegisterFile;

  /** `file` is the RTC_CNTL block's register file: reset values come from its defaults. */
  constructor(file: RegisterFile) {
    this.file = file;
    this.reset();
  }

  reset(): void {
    for (let i = 0; i < this.regs.length; i++) this.regs[i] = this.file.regs[(RTC_IO_OFFSET >>> 2) + i];
    for (let gpio = 0; gpio < 40; gpio++) {
      const pad = RTC_PADS[gpio];
      if (pad === undefined || pad.rue < 0) continue;
      const i = pad.reg >>> 2;
      this.regs[i] &= ~((1 << pad.rue) | (1 << pad.rde) | (1 << pad.mux));
      if (PAD_RESET[gpio] === 3) this.regs[i] |= 1 << pad.rue;
      if (PAD_RESET[gpio] === 2) this.regs[i] |= 1 << pad.rde;
    }
  }

  read32(offset: number): number {
    return this.regs[offset >>> 2];
  }

  write32(offset: number, value: number): void {
    this.regs[offset >>> 2] = value;
    this.onChange?.();
  }

  /** Is RTC pad `gpio` routed to the RTC domain (analog)? */
  analog(gpio: number): boolean {
    const pad = RTC_PADS[gpio];
    return pad !== undefined && ((this.regs[pad.reg >>> 2] >>> pad.mux) & 1) !== 0;
  }

  /** The DAC's output volts on GPIO25/26, or NaN when that DAC isn't driving the pad. */
  dacVolts(gpio: number): number {
    if (gpio !== 25 && gpio !== 26) return Number.NaN;
    const reg = this.regs[(gpio === 25 ? PAD_DAC1 : PAD_DAC2) >>> 2];
    if (((reg >>> 17) & 1) === 0 || ((reg >>> 18) & 1) === 0) return Number.NaN;
    return (((reg >>> 19) & 0xff) / 255) * DAC_VDD;
  }

  pullUp(gpio: number): boolean {
    const pad = RTC_PADS[gpio];
    return pad !== undefined && pad.rue >= 0 && ((this.regs[pad.reg >>> 2] >>> pad.rue) & 1) !== 0;
  }

  pullDown(gpio: number): boolean {
    const pad = RTC_PADS[gpio];
    return pad !== undefined && pad.rde >= 0 && ((this.regs[pad.reg >>> 2] >>> pad.rde) & 1) !== 0;
  }
}
