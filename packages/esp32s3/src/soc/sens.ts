/**
 * The ESP32-S3's SENS block (BT125; sens_reg.h, 0x60008800 — inside RTC_CNTL's page, which hands
 * it offsets 0x800–0x8FF): the RTC-controlled SAR ADC conversions IDF 4.4's adc1_get_raw and
 * adc2_get_raw (Arduino's analogRead) and its startup self-calibration (read_cal_channel) run.
 *
 * ADC1: SAR_MEAS1_CTRL2 (+0x0C) selects one channel in SAR1_EN_PAD (bits 30:19, 1 << channel); a
 * 0 → 1 of MEAS1_START_SAR (bit 17) samples the channel's pad and, a conversion time later, sets
 * MEAS1_DONE_SAR (bit 16) with the code in MEAS1_DATA_SAR (15:0); START falling clears DONE.
 * SAR_ATTEN1 (+0x14) holds 2 bits per channel. ADC2 is the same at SAR_MEAS2_CTRL2 (+0x30) and
 * SAR_ATTEN2 (+0x38); its data's flag bits (15:14, "the arbiter gave the RTC controller the ADC")
 * read 0 — nothing else asks for ADC2 here. The result is idealized and linear over the S3
 * datasheet's ranges (`sample` gives it); SAR1_DATA_INV (READER1_CTRL bit 28) and SAR2_DATA_INV
 * (READER2_CTRL bit 29) invert it — IDF leaves them clear on the S3 (SOC_ADC1_DATA_INVERT_DEFAULT
 * 0). A conversion takes (9 + 12 + 2) · SAR_CLK_DIV (7:0, at least 1) cycles of an 8 MHz clock — a
 * model choice like the ESP32's (the TRM gives no formula). Everything else is storage.
 */

import type { Peripheral } from '@benchtop/esp32';
import type { SocContext } from '@benchtop/esp32c3';
import { registerDefault } from './periph.ts';

export const SENS_BASE = 0x60008800;
/** SENS's offset inside RTC_CNTL's page, and its length. */
export const SENS_OFFSET = 0x800;
export const SENS_SIZE = 0x100;
/** The S3 datasheet's input ranges per attenuation (0, 2.5, 6, 11 dB), in volts. */
export const S3_ADC_FULL_SCALE = [0.95, 1.25, 1.75, 3.1] as const;

const READER1_CTRL = 0x00;
const MEAS1_CTRL2 = 0x0c;
const ATTEN1 = 0x14;
const READER2_CTRL = 0x24;
const MEAS2_CTRL2 = 0x30;
const ATTEN2 = 0x38;
const START_SAR = 1 << 17;
const DONE_SAR = 1 << 16;
const ADC_CLOCK_HZ = 8_000_000;
const CONVERSION_CYCLES = 9 + 12 + 2;

/** BT149: where a chip's SENS is, its reset values and its codes' width (the ESP32-S2's are 13 bits). */
export interface SensChip {
  base: number;
  defaults: (address: number) => number;
  bits: number;
}
export const S3_SENS_CHIP: SensChip = { base: SENS_BASE, defaults: registerDefault, bits: 12 };

export class S3Sens implements Peripheral {
  readonly regs = new Uint32Array(SENS_SIZE >>> 2);
  /** A conversion's code (12 bits, 13 on the S2): `adc` 1 or 2, its channel and attenuation (0–3). */
  sample: (adc: number, channel: number, attenuation: number) => number = () => 0;
  private readonly ctx: SocContext;
  private readonly slots: [number, number];
  private readonly result = new Uint16Array(2);
  private readonly chip: SensChip;
  private readonly max: number;

  constructor(ctx: SocContext, chip: SensChip = S3_SENS_CHIP) {
    this.ctx = ctx;
    this.chip = chip;
    this.max = (1 << chip.bits) - 1;
    this.slots = [ctx.events.add(() => this.done(0)), ctx.events.add(() => this.done(1))];
    this.systemReset();
  }

  systemReset(): void {
    for (let i = 0; i < this.regs.length; i++) this.regs[i] = this.chip.defaults(this.chip.base + i * 4);
    this.ctx.events.cancel(this.slots[0]);
    this.ctx.events.cancel(this.slots[1]);
  }

  read32(offset: number): number {
    return this.regs[offset >>> 2];
  }

  write32(offset: number, value: number): void {
    if (offset !== MEAS1_CTRL2 && offset !== MEAS2_CTRL2) {
      this.regs[offset >>> 2] = value;
      return;
    }
    const before = this.regs[offset >>> 2];
    // DONE and DATA are the hardware's: writes keep them; START falling clears DONE.
    let v = (value & ~(DONE_SAR | 0xffff)) | (before & (DONE_SAR | 0xffff));
    if ((value & START_SAR) === 0) v &= ~DONE_SAR;
    this.regs[offset >>> 2] = v >>> 0;
    if ((value & START_SAR) !== 0 && (before & START_SAR) === 0) this.start(offset === MEAS1_CTRL2 ? 0 : 1);
  }

  private start(n: number): void {
    const ctrl = this.regs[(n === 0 ? MEAS1_CTRL2 : MEAS2_CTRL2) >>> 2];
    const reader = this.regs[(n === 0 ? READER1_CTRL : READER2_CTRL) >>> 2];
    const pads = (ctrl >>> 19) & 0x3ff;
    let channel = 0;
    while (channel < 10 && ((pads >>> channel) & 1) === 0) channel++;
    let code = 0;
    if (channel < 10) {
      const attenuation = (this.regs[(n === 0 ? ATTEN1 : ATTEN2) >>> 2] >>> (channel * 2)) & 3;
      code = this.sample(n + 1, channel, attenuation) & this.max;
    }
    if ((reader & (n === 0 ? 1 << 28 : 1 << 29)) !== 0) code = this.max - code;
    this.result[n] = code;
    const seconds = (CONVERSION_CYCLES * ((reader & 0xff) || 1)) / ADC_CLOCK_HZ;
    this.ctx.events.schedule(this.slots[n], this.ctx.now() + seconds * this.ctx.refHz);
  }

  private done(n: number): void {
    const i = (n === 0 ? MEAS1_CTRL2 : MEAS2_CTRL2) >>> 2;
    if ((this.regs[i] & START_SAR) === 0) return; // stopped before it finished
    this.regs[i] = ((this.regs[i] & ~0xffff) | DONE_SAR | this.result[n]) >>> 0;
  }
}
