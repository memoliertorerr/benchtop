/**
 * SENS (0x3FF48800, inside the RTC_CNTL block; sens_reg.h, adc_ll.h) — BT35: the RTC-controlled
 * SAR ADC1 conversion that IDF's adc1_get_raw (Arduino's analogRead) runs; BT162: ADC2's, which
 * adc2_get_raw runs, the same way on its own registers.
 *
 * adc_hal_convert selects one channel in SAR_MEAS_START1 SAR1_EN_PAD (bits 30:19, 1 << channel) —
 * ADC2: SAR_MEAS_START2 SAR2_EN_PAD —, pulses MEAS1_START_SAR (bit 17, 0 then 1), polls
 * MEAS1_DONE_SAR (bit 16) and reads MEAS1_DATA_SAR (15:0). The conversion samples the channel's pad
 * voltage (the pin's NetState volts) when it starts and is done (SAMPLE_CYCLE + bits + 2) · CLK_DIV
 * cycles of the 8 MHz RTC fast clock later (SAR_READ_CTRL / SAR_READ_CTRL2 15:8 and 7:0; reset
 * values 9 and 2 → 5.75 µs at 12 bits — a model choice, the TRM gives the fields but no formula).
 * The result is idealized and linear: raw = clamp(round(V / FS · (2^bits − 1))), FS = 1.1 / 1.5 /
 * 2.2 / 3.3 V for the channel's attenuation (SAR_ATTEN1 / SAR_ATTEN2, 2 bits per channel: 0 / 2.5 /
 * 6 / 11 dB), bits = SAMPLE_BIT (17:16) + 9. A pot across 3V3 therefore sweeps 0–4095; the real
 * 11 dB curve saturates near 3.1 V and is nonlinear (Later). The output is inverted unless the
 * unit's DATA_INV is set (SAR1_DATA_INV, SAR_READ_CTRL bit 28; SAR2_DATA_INV, SAR_READ_CTRL2 bit
 * 29) — IDF sets both (SOC_ADC1/2_DATA_INVERT_DEFAULT 1, adc_hal_conf.h), so 0 V reads 0.
 *
 * ADC1 channels → GPIOs (adc_channel.h): CH0 36, CH1 37, CH2 38, CH3 39, CH4 32, CH5 33, CH6 34,
 * CH7 35. ADC2: CH0 4, CH1 0, CH2 2, CH3 15, CH4 13, CH5 12, CH6 14, CH7 27, CH8 25, CH9 26. On a
 * board WiFi takes ADC2 (BT163: ESP-IDF's software lock, which the simulated WiFi driver takes too).
 * Everything else in SENS is storage.
 */

import type { SocContext } from './context.ts';
import { REF_HZ } from './context.ts';
import type { RegisterFile } from './periph.ts';

export const SENS_OFFSET = 0x800;
export const SENS_END = 0x100;
export const ADC1_GPIO = [36, 37, 38, 39, 32, 33, 34, 35] as const;
/** BT162: ADC2's channels' GPIOs. */
export const ADC2_GPIO = [4, 0, 2, 15, 13, 12, 14, 27, 25, 26] as const;
const START_SAR = 1 << 17;
const DONE_SAR = 1 << 16;
const RTC_FAST_HZ = 8_000_000;
const FULL_SCALE = [1.1, 1.5, 2.2, 3.3];

/** One ADC unit's registers (offsets in SENS), its channels' GPIOs and its DATA_INV bit. */
interface AdcUnit {
  readonly readCtrl: number;
  readonly atten: number;
  readonly measStart: number;
  readonly dataInv: number;
  readonly gpio: readonly number[];
}
const UNITS: readonly [AdcUnit, AdcUnit] = [
  { readCtrl: 0x00, atten: 0x34, measStart: 0x54, dataInv: 1 << 28, gpio: ADC1_GPIO },
  { readCtrl: 0x90, atten: 0x38, measStart: 0x94, dataInv: 1 << 29, gpio: ADC2_GPIO },
];

export class Sens {
  readonly regs = new Uint32Array(SENS_END >>> 2);
  /** The voltage on GPIO `gpio`'s pad (the Mcu adapter supplies the pins' NetState volts). */
  padVolts: (gpio: number) => number = () => 0;
  private readonly context: SocContext;
  private readonly file: RegisterFile;
  /** Per unit (0: ADC1, 1: ADC2): its conversion's event, and the code it will read. */
  private readonly slots: readonly [number, number];
  private readonly results = new Uint16Array(2);

  constructor(context: SocContext, file: RegisterFile) {
    this.context = context;
    this.file = file;
    this.slots = [context.events.add(() => this.done(0)), context.events.add(() => this.done(1))];
    this.reset();
  }

  reset(): void {
    for (let i = 0; i < this.regs.length; i++) this.regs[i] = this.file.regs[(SENS_OFFSET >>> 2) + i];
    this.context.events.cancel(this.slots[0]);
    this.context.events.cancel(this.slots[1]);
  }

  read32(offset: number): number {
    return this.regs[offset >>> 2];
  }

  write32(offset: number, value: number): void {
    for (let n = 0; n < 2; n++) {
      if (offset !== UNITS[n].measStart) continue;
      const before = this.regs[offset >>> 2];
      // DONE and DATA are the hardware's: writes keep them; START falling clears DONE.
      let v = (value & ~(DONE_SAR | 0xffff)) | (before & (DONE_SAR | 0xffff));
      if ((value & START_SAR) === 0) v &= ~DONE_SAR;
      this.regs[offset >>> 2] = v >>> 0;
      if ((value & START_SAR) !== 0 && (before & START_SAR) === 0) this.start(n);
      return;
    }
    this.regs[offset >>> 2] = value;
  }

  /** Unit `n` (0: ADC1, 1: ADC2) samples its selected channel's pad. */
  private start(n: number): void {
    const unit = UNITS[n];
    const readCtrl = this.regs[unit.readCtrl >>> 2];
    const bits = ((readCtrl >>> 16) & 3) + 9;
    const max = 2 ** bits - 1;
    const pads = (this.regs[unit.measStart >>> 2] >>> 19) & 0x7ff;
    let channel = 0;
    while (channel < unit.gpio.length && ((pads >>> channel) & 1) === 0) channel++;
    let raw = 0;
    if (channel < unit.gpio.length) {
      const atten = (this.regs[unit.atten >>> 2] >>> (channel * 2)) & 3;
      const volts = this.padVolts(unit.gpio[channel]);
      raw = Math.min(max, Math.max(0, Math.round((volts / FULL_SCALE[atten]) * max)));
    }
    if ((readCtrl & unit.dataInv) === 0) raw = max - raw;
    this.results[n] = raw;
    const clkDiv = (readCtrl & 0xff) || 1;
    const sampleCycles = (readCtrl >>> 8) & 0xff;
    const seconds = ((sampleCycles + bits + 2) * clkDiv) / RTC_FAST_HZ;
    this.context.events.schedule(this.slots[n], this.context.now() + seconds * REF_HZ);
  }

  private done(n: number): void {
    const i = UNITS[n].measStart >>> 2;
    if ((this.regs[i] & START_SAR) === 0) return; // restarted before it finished
    this.regs[i] = ((this.regs[i] & ~0xffff) | DONE_SAR | this.results[n]) >>> 0;
  }
}
