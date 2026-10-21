/**
 * IO_MUX (0x3FF49000; io_mux_reg.h, TRM v5.8 §6.10) — one register per pad, NOT in GPIO order
 * (GPIO2 at +0x40, GPIO1/U0TXD at +0x88, GPIO36 at +0x04: the PERIPHS_IO_MUX_*_U addresses).
 * Fields: MCU_SEL (14:12) the pad function (2 = GPIO through the matrix on every pad), FUN_DRV
 * (11:10), FUN_IE (9) input enable, FUN_PU (8) / FUN_PD (7) pulls, plus the sleep-mode bits.
 * The header has no reset values; they come from Table 6.10-1's Reset column: 0 = input
 * disabled, 1 = input enabled, 2 = input + pull-down, 3 = input + pull-up (FUN_DRV 2, MCU_SEL 0).
 * On the RTC pads (Table 6.11-1) the pulls that work are RTC_IO's RUE/RDE (rtcio.ts) — IDF's
 * gpio_pullup_en calls rtc_gpio_pullup_en there — so this file's FUN_PU/FUN_PD matter only on the
 * other pads.
 */

import { RegisterFile } from './periph.ts';

export const IO_MUX_BASE = 0x3ff49000;
/** The GPIOs the ESP32-D0WD has (20, 24 and 28–31 don't exist). */
export const GPIO_NUMBERS: readonly number[] = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33, 34, 35, 36, 37, 38, 39,
];
/** gpio → IO_MUX register offset (PERIPHS_IO_MUX_*_U − DR_REG_IO_MUX_BASE), −1 where there is no pad. */
export const IO_MUX_OFFSET: Int16Array = (() => {
  const t = new Int16Array(40).fill(-1);
  const pairs = [
    [0, 0x44], [1, 0x88], [2, 0x40], [3, 0x84], [4, 0x48], [5, 0x6c], [6, 0x60], [7, 0x64], [8, 0x68], [9, 0x54], [10, 0x58],
    [11, 0x5c], [12, 0x34], [13, 0x38], [14, 0x30], [15, 0x3c], [16, 0x4c], [17, 0x50], [18, 0x70], [19, 0x74], [21, 0x7c],
    [22, 0x80], [23, 0x8c], [25, 0x24], [26, 0x28], [27, 0x2c], [32, 0x1c], [33, 0x20], [34, 0x14], [35, 0x18], [36, 0x04],
    [37, 0x08], [38, 0x0c], [39, 0x10],
  ];
  for (const [gpio, offset] of pairs) t[gpio] = offset;
  return t;
})();
/** Table 6.10-1 Reset column per GPIO (0 IE off, 1 IE, 2 IE + pull-down, 3 IE + pull-up). */
export const PAD_RESET: Uint8Array = (() => {
  const t = new Uint8Array(40);
  const values: [number, number][] = [
    [0, 3], [1, 3], [2, 2], [3, 3], [4, 2], [5, 3], [6, 3], [7, 3], [8, 3], [9, 3], [10, 3], [11, 3], [12, 2], [13, 2], [14, 3], [15, 3],
    [16, 1], [17, 1], [18, 1], [19, 1], [21, 1], [22, 1], [23, 1], [25, 0], [26, 0], [27, 0], [32, 0], [33, 0], [34, 0], [35, 0],
    [36, 0], [37, 0], [38, 0], [39, 0],
  ];
  for (const [gpio, v] of values) t[gpio] = v;
  return t;
})();
/**
 * Pads whose function 0 is the GPIO itself (Table 6.10-1: GPIO0, 2, 4, 5, 16–39 — "GPIOn" in both
 * function 0 and function 2), so MCU_SEL 0 routes them through the GPIO matrix too.
 */
const FUNC0_IS_GPIO: Uint8Array = (() => {
  const t = new Uint8Array(40);
  for (const g of [0, 2, 4, 5, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33, 34, 35, 36, 37, 38, 39]) t[g] = 1;
  return t;
})();

export const IO_MUX_FIELD = { MCU_SEL_SHIFT: 12, FUN_IE: 1 << 9, FUN_PU: 1 << 8, FUN_PD: 1 << 7, DRV_SHIFT: 10 } as const;
/** MCU_SEL value of the GPIO function on every pad (PIN_FUNC_GPIO). */
export const FUNC_GPIO = 2;

export class IoMux extends RegisterFile {
  /** Called after any pad register write (the pad resolver recomputes). */
  onChange: (() => void) | null = null;

  constructor() {
    super(IO_MUX_BASE);
    this.resetPads();
  }

  implements(offset: number): boolean {
    return offset === 0 || (offset <= 0x90 && IO_MUX_OFFSET.includes(offset));
  }

  override systemReset(_rtcDomain: boolean): void {
    this.reset();
    this.resetPads();
    this.onChange?.();
  }

  private resetPads(): void {
    for (const gpio of GPIO_NUMBERS) {
      const r = PAD_RESET[gpio];
      let v = 2 << IO_MUX_FIELD.DRV_SHIFT;
      if (r !== 0) v |= IO_MUX_FIELD.FUN_IE;
      if (r === 2) v |= IO_MUX_FIELD.FUN_PD;
      if (r === 3) v |= IO_MUX_FIELD.FUN_PU;
      this.regs[IO_MUX_OFFSET[gpio] >>> 2] = v;
    }
  }

  /** Does GPIO `gpio` exist (has a pad)? */
  padExists(gpio: number): boolean {
    return gpio < 40 && IO_MUX_OFFSET[gpio] >= 0;
  }

  /** The pad register of GPIO `gpio`. */
  pad(gpio: number): number {
    return this.regs[IO_MUX_OFFSET[gpio] >>> 2];
  }

  /** MCU_SEL of GPIO `gpio`'s pad. */
  func(gpio: number): number {
    return (this.pad(gpio) >>> IO_MUX_FIELD.MCU_SEL_SHIFT) & 7;
  }

  /** Is the pad routed through the GPIO matrix (MCU_SEL 2, or 0 on a pad whose function 0 is GPIO)? */
  isGpio(gpio: number): boolean {
    const f = this.func(gpio);
    return f === FUNC_GPIO || (f === 0 && FUNC0_IS_GPIO[gpio] === 1);
  }

  inputEnabled(gpio: number): boolean {
    return (this.pad(gpio) & IO_MUX_FIELD.FUN_IE) !== 0;
  }

  override write32(offset: number, value: number): void {
    super.write32(offset, value);
    this.onChange?.();
  }
}
