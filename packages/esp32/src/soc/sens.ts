/**
 * SENS (0x3FF48800, inside the RTC_CNTL block; sens_reg.h, adc_ll.h) — BT35: the RTC-controlled
 * SAR ADC1 conversion that IDF's adc1_get_raw (Arduino's analogRead) runs.
 *
 * adc_hal_convert selects one channel in SAR_MEAS_START1 SAR1_EN_PAD (bits 30:19, 1 << channel),
 * pulses MEAS1_START_SAR (bit 17, 0 then 1), polls MEAS1_DONE_SAR (bit 16) and reads
 * MEAS1_DATA_SAR (15:0). The conversion samples the channel's pad voltage (the pin's NetState
 * volts) when it starts and is done (SAR1_SAMPLE_CYCLE + bits + 2) · SAR1_CLK_DIV cycles of the
 * 8 MHz RTC fast clock later (SAR_READ_CTRL 15:8 and 7:0; reset values 9 and 2 → 5.75 µs at 12
 * bits — a model choice, the TRM gives the fields but no formula). The result is idealized and
 * linear: raw = clamp(round(V / FS · (2^bits − 1))), FS = 1.1 / 1.5 / 2.2 / 3.3 V for the
 * channel's SAR_ATTEN1 (2 bits per channel: 0 / 2.5 / 6 / 11 dB), bits = SAR1_SAMPLE_BIT (17:16)
 * + 9. A pot across 3V3 therefore sweeps 0–4095; the real 11 dB curve saturates near 3.1 V and is
 * nonlinear (Later). The hardware's ADC1 output is inverted unless SAR1_DATA_INV (SAR_READ_CTRL
 * bit 28) is set — IDF sets it (SOC_ADC1_DATA_INVERT_DEFAULT 1, adc_hal_conf.h), so 0 V reads 0.
 *
 * ADC1 channels → GPIOs (adc_channel.h): CH0 36, CH1 37, CH2 38, CH3 39, CH4 32, CH5 33, CH6 34,
 * CH7 35. ADC2 (SAR_MEAS_START2) isn't modeled: a conversion reports `esp32-adc2-unsupported`,
 * finishes at once and reads 0. Everything else in SENS is storage.
 */

import type { SocContext } from './context.ts';
import { REF_HZ } from './context.ts';
import type { RegisterFile } from './periph.ts';

export const SENS_OFFSET = 0x800;
export const SENS_END = 0x100;
export const CODE_ADC2 = 'esp32-adc2-unsupported';
export const ADC1_GPIO = [36, 37, 38, 39, 32, 33, 34, 35] as const;
const SAR_READ_CTRL = 0x00;
const SAR_ATTEN1 = 0x34;
const SAR_MEAS_START1 = 0x54;
const SAR_MEAS_START2 = 0x94;
const START_SAR = 1 << 17;
const DONE_SAR = 1 << 16;
const DATA_INV = 1 << 28;
const RTC_FAST_HZ = 8_000_000;
const FULL_SCALE = [1.1, 1.5, 2.2, 3.3];

export class Sens {
  readonly regs = new Uint32Array(SENS_END >>> 2);
  /** The voltage on GPIO `gpio`'s pad (the Mcu adapter supplies the pins' NetState volts). */
  padVolts: (gpio: number) => number = () => 0;
  private readonly context: SocContext;
  private readonly file: RegisterFile;
  private readonly slot: number;
  private result = 0;

  constructor(context: SocContext, file: RegisterFile) {
    this.context = context;
    this.file = file;
    this.slot = context.events.add(() => this.done());
    this.reset();
  }

  reset(): void {
    for (let i = 0; i < this.regs.length; i++) this.regs[i] = this.file.regs[(SENS_OFFSET >>> 2) + i];
    this.context.events.cancel(this.slot);
  }

  read32(offset: number): number {
    return this.regs[offset >>> 2];
  }

  write32(offset: number, value: number): void {
    if (offset === SAR_MEAS_START1) {
      const before = this.regs[offset >>> 2];
      // DONE and DATA are the hardware's: writes keep them; START falling clears DONE.
      let v = (value & ~(DONE_SAR | 0xffff)) | (before & (DONE_SAR | 0xffff));
      if ((value & START_SAR) === 0) v &= ~DONE_SAR;
      this.regs[offset >>> 2] = v >>> 0;
      if ((value & START_SAR) !== 0 && (before & START_SAR) === 0) this.start();
      return;
    }
    if (offset === SAR_MEAS_START2) {
      const before = this.regs[offset >>> 2];
      this.regs[offset >>> 2] = ((value & ~(DONE_SAR | 0xffff)) | ((value & START_SAR) !== 0 ? DONE_SAR : 0)) >>> 0;
      if ((value & START_SAR) !== 0 && (before & START_SAR) === 0) {
        this.context.problems.report('warning', CODE_ADC2, 0x3ff48894, 'analogRead on an ADC2 pin (GPIO0, 2, 4, 12–15, 25–27) reads 0: ADC2 isn\'t emulated yet. Use an ADC1 pin (GPIO32–39).');
      }
      return;
    }
    this.regs[offset >>> 2] = value;
  }

  private start(): void {
    const readCtrl = this.regs[SAR_READ_CTRL >>> 2];
    const bits = ((readCtrl >>> 16) & 3) + 9;
    const max = 2 ** bits - 1;
    const pads = (this.regs[SAR_MEAS_START1 >>> 2] >>> 19) & 0xff;
    let channel = 0;
    while (channel < 8 && ((pads >>> channel) & 1) === 0) channel++;
    let raw = 0;
    if (channel < 8) {
      const atten = (this.regs[SAR_ATTEN1 >>> 2] >>> (channel * 2)) & 3;
      const volts = this.padVolts(ADC1_GPIO[channel]);
      raw = Math.min(max, Math.max(0, Math.round((volts / FULL_SCALE[atten]) * max)));
    }
    if ((readCtrl & DATA_INV) === 0) raw = max - raw;
    this.result = raw;
    const clkDiv = (readCtrl & 0xff) || 1;
    const sampleCycles = (readCtrl >>> 8) & 0xff;
    const seconds = ((sampleCycles + bits + 2) * clkDiv) / RTC_FAST_HZ;
    this.context.events.schedule(this.slot, this.context.now() + seconds * REF_HZ);
  }

  private done(): void {
    const i = SAR_MEAS_START1 >>> 2;
    if ((this.regs[i] & START_SAR) === 0) return; // restarted before it finished
    this.regs[i] = ((this.regs[i] & ~0xffff) | DONE_SAR | (this.result & 0xffff)) >>> 0;
  }
}
