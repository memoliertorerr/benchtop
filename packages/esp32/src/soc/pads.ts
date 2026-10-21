/**
 * The pad resolver (BT34): what each ESP32 pin is doing, from GPIO (latch, enables, the matrix's
 * FUNC_OUT_SEL, open drain), IO_MUX (function, pulls, input enable) and RTC IO (analog routing,
 * RTC-pad pulls). `update()` recomputes every pad after any of them changes and calls `onPin`
 * for each pin whose mode or level changed — preallocated arrays, no allocation.
 *
 * Rules, in order:
 *   1. An RTC pad routed to the RTC domain (RTC IO MUX_SEL) is `analog`; on GPIO25/26 with the
 *      DAC powered it also outputs the DAC's volts (`dacVolts`, NaN otherwise).
 *   2. A pad on the GPIO function (IO_MUX MCU_SEL 2, or 0 where function 0 is the GPIO) drives
 *      what FUNC_OUT_SEL selects: signal 256 = its GPIO_OUT bit with GPIO_ENABLE as the output
 *      enable (`output`); another signal = that peripheral (`peripheral`, at the level the SoC's
 *      `signalLevel` gives: LEDC outputs 71–86, UART TXD signals 14, 17, 198 idle high, other
 *      signals 0 until their peripherals exist), enabled by GPIO_ENABLE
 *      when OEN_SEL is set, else by the peripheral (assumed on). INV_SEL inverts the level.
 *   3. An IO_MUX function that drives the pad directly (DIRECT_OUT, from Table 6.10-1: U0TXD on
 *      GPIO1 function 0, U1TXD on GPIO10 and U2TXD on GPIO17 function 4 — IDF's uart_set_pin
 *      prefers these "IOMUX pins" over the matrix) is that peripheral (`peripheral`). Other
 *      non-GPIO functions (U0RXD, the flash SD_* pads, JTAG on MTDI/MTCK/MTMS/MTDO, …) leave the
 *      pad an input.
 *   4. Open drain (PINn PAD_DRIVER) drives only 0: a 1 releases the pad (an input with its pulls).
 *   5. GPIO34–39 are input-only: an enabled output there is refused with a one-time Problem.
 *   6. Otherwise the pad is an input: `input-pullup` / `input-pulldown` from RTC IO RUE/RDE on
 *      RTC pads (GPIO34–39 have no pulls) and from IO_MUX FUN_PU/FUN_PD on the others; a pad
 *      with both reads as pulled up.
 */

import type { Gpio } from './gpio.ts';
import { SIG_GPIO_OUT } from './gpio.ts';
import { GPIO_NUMBERS, IO_MUX_FIELD, type IoMux } from './iomux.ts';
import type { ProblemLog } from './periph.ts';
import { RTC_PADS, type RtcIo } from './rtcio.ts';

/** Pad modes (McuPin's PinMode, as small integers). */
export const PAD_MODE = { INPUT: 0, PULLUP: 1, PULLDOWN: 2, OUTPUT: 3, ANALOG: 4, PERIPHERAL: 5 } as const;
export const CODE_INPUT_ONLY = 'esp32-input-only-pin';
/** IO_MUX output functions as (gpio << 3 | MCU_SEL) → the matrix signal they carry (gpio_sig_map.h). */
const DIRECT_OUT: ReadonlyMap<number, number> = new Map([
  [(1 << 3) | 0, 14], // U0TXD
  [(10 << 3) | 4, 17], // U1TXD
  [(17 << 3) | 4, 198], // U2TXD
  [(14 << 3) | 1, 8], // HSPICLK
  [(13 << 3) | 1, 10], // HSPID (MOSI)
  [(15 << 3) | 1, 11], // HSPICS0
  [(18 << 3) | 1, 63], // VSPICLK
  [(23 << 3) | 1, 65], // VSPID (MOSI)
  [(5 << 3) | 1, 68], // VSPICS0
]);
/** IO_MUX input functions as (gpio << 3 | MCU_SEL) → the matrix signal they feed. */
const DIRECT_IN: ReadonlyMap<number, number> = new Map([
  [(3 << 3) | 0, 14], // U0RXD
  [(9 << 3) | 4, 17], // U1RXD
  [(16 << 3) | 4, 198], // U2RXD
  [(12 << 3) | 1, 9], // HSPIQ (MISO)
  [(19 << 3) | 1, 64], // VSPIQ (MISO)
]);
/**
 * Peripheral output signals that idle high (gpio_sig_map.h): UART TXD (U0TXD 14, U1TXD 17, U2TXD
 * 198) and the I2C lines (I2CEXT0 SCL/SDA 29/30, I2CEXT1 95/96 — open drain, so a released line).
 */
export const IDLE_HIGH_SIGNALS: ReadonlySet<number> = new Set([14, 17, 198, 29, 30, 95, 96]);

export class Pads {
  readonly mode = new Uint8Array(40);
  readonly level = new Uint8Array(40);
  /** The analog volts a pad outputs (the DAC on GPIO25/26), NaN when none. */
  readonly dacVolts = new Float64Array(40).fill(Number.NaN);
  /** Called with each GPIO whose mode or level changed. */
  onPin: ((gpio: number) => void) | null = null;
  private readonly gpio: Gpio;
  private readonly iomux: IoMux;
  private readonly rtcio: RtcIo;
  private readonly problems: ProblemLog;
  /** The level of a peripheral output signal (gpio_sig_map.h numbering). */
  private readonly signalLevel: (signal: number) => number;

  constructor(gpio: Gpio, iomux: IoMux, rtcio: RtcIo, problems: ProblemLog, signalLevel: (signal: number) => number = (s) => (IDLE_HIGH_SIGNALS.has(s) ? 1 : 0)) {
    this.signalLevel = signalLevel;
    this.gpio = gpio;
    this.iomux = iomux;
    this.rtcio = rtcio;
    this.problems = problems;
    for (const g of GPIO_NUMBERS) this.resolve(g);
  }

  /** The GPIO that drives peripheral output `signal` (matrix or IO_MUX), or −1. */
  pinOfOutSignal(signal: number): number {
    for (const g of GPIO_NUMBERS) {
      if (this.iomux.isGpio(g) ? (this.gpio.outConfig(g) & 0x1ff) === signal : DIRECT_OUT.get((g << 3) | this.iomux.func(g)) === signal) return g;
    }
    return -1;
  }

  /** The GPIO that feeds peripheral input `signal` (FUNC_IN_SEL through the matrix, or IO_MUX), or −1. */
  pinOfInSignal(signal: number): number {
    const routed = this.gpio.inRoute(signal);
    if (routed >= 0) return routed;
    for (const g of GPIO_NUMBERS) if (DIRECT_IN.get((g << 3) | this.iomux.func(g)) === signal) return g;
    return -1;
  }

  /** Recomputes every pad; reports the pins that changed. */
  update(): void {
    for (let i = 0; i < GPIO_NUMBERS.length; i++) {
      const g = GPIO_NUMBERS[i];
      const mode = this.mode[g];
      const level = this.level[g];
      const volts = this.dacVolts[g];
      this.resolve(g);
      const dac = this.dacVolts[g];
      if (this.mode[g] !== mode || this.level[g] !== level || (dac !== volts && !(Number.isNaN(dac) && Number.isNaN(volts)))) this.onPin?.(g);
    }
  }

  /** Does pad `g` have its pull-up / pull-down on (by the rules above)? */
  private pull(g: number): number {
    const rtc = RTC_PADS[g];
    let up: boolean;
    let down: boolean;
    if (rtc !== undefined) {
      up = this.rtcio.pullUp(g);
      down = this.rtcio.pullDown(g);
    } else {
      const pad = this.iomux.pad(g);
      up = (pad & IO_MUX_FIELD.FUN_PU) !== 0;
      down = (pad & IO_MUX_FIELD.FUN_PD) !== 0;
    }
    return up ? PAD_MODE.PULLUP : down ? PAD_MODE.PULLDOWN : PAD_MODE.INPUT;
  }

  private resolve(g: number): void {
    if (this.rtcio.analog(g)) {
      this.mode[g] = PAD_MODE.ANALOG;
      this.level[g] = 0;
      this.dacVolts[g] = this.rtcio.dacVolts(g);
      return;
    }
    this.dacVolts[g] = Number.NaN;
    let enabled = false;
    let level = 0;
    let gpioOut = false;
    if (this.iomux.isGpio(g)) {
      const cfg = this.gpio.outConfig(g);
      const signal = cfg & 0x1ff;
      if (signal === SIG_GPIO_OUT) {
        gpioOut = true;
        enabled = this.gpio.enabled(g);
        level = this.gpio.level(g);
      } else {
        enabled = (cfg & (1 << 10)) !== 0 ? this.gpio.enabled(g) : true;
        level = this.signalLevel(signal);
      }
      if ((cfg & (1 << 9)) !== 0) level ^= 1;
      if ((cfg & (1 << 11)) !== 0 && (cfg & (1 << 10)) !== 0) enabled = !enabled;
    } else {
      const signal = DIRECT_OUT.get((g << 3) | this.iomux.func(g));
      if (signal !== undefined) {
        enabled = true;
        level = this.signalLevel(signal);
      }
    }
    if (enabled && g >= 34) {
      if (this.problems.admit(CODE_INPUT_ONLY, g)) {
        this.problems.add('warning', CODE_INPUT_ONLY, g, `GPIO${g} is input-only (GPIO34–39 have no output driver): the firmware enabled its output; the pin stays an input.`);
      }
      enabled = false;
    }
    if (enabled && this.gpio.openDrain(g) && level === 1) enabled = false; // open drain releases a 1
    if (enabled) {
      this.mode[g] = gpioOut ? PAD_MODE.OUTPUT : PAD_MODE.PERIPHERAL;
      this.level[g] = level;
      return;
    }
    this.mode[g] = g >= 34 ? PAD_MODE.INPUT : this.pull(g);
    this.level[g] = 0;
  }
}
