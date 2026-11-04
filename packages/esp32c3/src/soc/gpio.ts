/**
 * The ESP32-C3's GPIO, GPIO matrix, IO_MUX and pad resolver (BT93; gpio_reg.h, io_mux_reg.h,
 * gpio_sig_map.h, TRM §5). 22 pads, GPIO0–21 (12–17 are the module's flash on the DevKitM-1).
 *
 * GPIO (0x60004000): OUT 0x04 and ENABLE 0x20, each with W1TS/W1TC aliases (+4/+8); IN 0x3C shows
 * a pad's level while its IO_MUX FUN_IE is set. PINn (0x74 + 4n): PAD_DRIVER (2) open drain,
 * INT_TYPE (9:7: 1 rising, 2 falling, 3 any edge, 4 low level, 5 high level), INT_ENA (17:13; bit
 * 13 the CPU interrupt, 14 its NMI). An edge (or a held level) sets STATUS (0x44, W1TS/W1TC 0x48/
 * 0x4C); PCPU_INT (0x5C) / PCPU_NMI_INT (0x60) are STATUS masked by INT_ENA and drive interrupt
 * sources 16 (GPIO) and 17 (GPIO_NMI). A level type stays pending while the level holds.
 * FUNC_IN_SEL_CFG (0x154 + 4·signal, 128 signals): IN_SEL (4:0) the GPIO — 0x1E constant 1, 0x1F
 * constant 0 (gpio_pins.h) —, IN_INV_SEL (5), SIG_IN_SEL (6) through the matrix.
 * FUNC_OUT_SEL_CFG (0x554 + 4·gpio): OUT_SEL (7:0) the signal, 128 = the GPIO_OUT bit; OUT_INV_SEL
 * (8); OEN_SEL (9) 1 = output enable from GPIO_ENABLE, 0 = from the peripheral; OEN_INV_SEL (10).
 *
 * IO_MUX (0x60009000): GPIOn at 0x04 + 4n — MCU_SEL (14:12) the function (1 is GPIO on every pad;
 * 0 is GPIO too on 0–3, 8–11, 18, 19, U0RXD/U0TXD on 20/21, JTAG on 4–7, the flash on 12–17; 2 is
 * FSPI on 2, 4–7, 10), FUN_IE (9), FUN_WPU (8), FUN_WPD (7). Reset: function 0; inputs enabled
 * except GPIO0/1 (the 32 kHz crystal pads) and 18/19 (USB); pull-ups on GPIO9 (BOOT), the flash
 * pads and U0RXD — the TRM's IO MUX table, approximated.
 *
 * Pads, in order: a pad on a GPIO function drives what OUT_SEL picks (the GPIO_OUT bit with
 * GPIO_ENABLE → `output`; a peripheral signal → `peripheral` at the level `signalLevel` gives —
 * UART TXD and the I2C lines idle high —, enabled by GPIO_ENABLE when OEN_SEL is set, else by the
 * peripheral, assumed on); an IO_MUX function that drives the pad directly (U0TXD on GPIO21,
 * FSPICLK/FSPID/FSPICS0 on 6/7/10) is that peripheral; open drain drives only 0. Otherwise the pad
 * is an input with its pulls — or `analog` when it's an ADC pad (GPIO0–5) with its input and
 * pulls off after a conversion used it (Arduino's analogRead leaves it so). `onPin` hears every
 * pad whose mode or level changed; nothing allocates.
 */

import type { Peripheral } from '@benchtop/esp32';
import type { SocContext } from './context.ts';
import { SRC } from './intmatrix.ts';

export const GPIO_BASE = 0x60004000;
export const IO_MUX_BASE = 0x60009000;
export const PIN_COUNT = 22;
/** OUT_SEL meaning "the GPIO_OUT bit" (SIG_GPIO_OUT_IDX). */
export const SIG_GPIO_OUT = 128;
/** Pad modes (McuPin's PinMode, as small integers — the ESP32's numbering). */
export const PAD_MODE = { INPUT: 0, PULLUP: 1, PULLDOWN: 2, OUTPUT: 3, ANALOG: 4, PERIPHERAL: 5 } as const;
/** gpio_sig_map.h signals the models use. */
export const SIG = {
  U0TXD: 6,
  U0RXD: 6,
  U1TXD: 9,
  U1RXD: 9,
  LEDC0: 45,
  RMT0: 51,
  I2C_SCL: 53,
  I2C_SDA: 54,
  FSPICLK: 63,
  FSPIQ: 64,
  FSPID: 65,
  FSPICS0: 68,
} as const;
/** Peripheral outputs that idle high: UART TXD and the I2C lines (open drain, released). */
export const IDLE_HIGH_SIGNALS: ReadonlySet<number> = new Set([SIG.U0TXD, SIG.U1TXD, SIG.I2C_SCL, SIG.I2C_SDA]);
/** The ADC pads: GPIO0–4 are ADC1 channels 0–4, GPIO5 ADC2 channel 0. */
export const ADC_PADS = 6;

const GPIO_REG = {
  OUT: 0x04,
  OUT_W1TS: 0x08,
  OUT_W1TC: 0x0c,
  ENABLE: 0x20,
  ENABLE_W1TS: 0x24,
  ENABLE_W1TC: 0x28,
  STRAP: 0x38,
  IN: 0x3c,
  STATUS: 0x44,
  STATUS_W1TS: 0x48,
  STATUS_W1TC: 0x4c,
  PCPU_INT: 0x5c,
  PCPU_NMI_INT: 0x60,
  CPUSDIO_INT: 0x64,
  PIN0: 0x74,
  STATUS_NEXT: 0x14c,
  FUNC_IN_SEL: 0x154,
  FUNC_OUT_SEL: 0x554,
  CLOCK_GATE: 0x62c,
  DATE: 0x6fc,
} as const;
const PIN_MASK = (1 << PIN_COUNT) - 1;
const SIGNALS = 128;
const IN_CONST_ONE = 0x1e;
const ENA_CPU = 1 << 13;
const ENA_CPU_NMI = 1 << 14;
/** GPIO_STRAP: GPIO8 and GPIO9 high — SPI boot. */
const STRAP_SPI_BOOT = 0x0c;

const MUX = { FUN_WPD: 1 << 7, FUN_WPU: 1 << 8, FUN_IE: 1 << 9, DRV2: 2 << 10 } as const;
/** IO_MUX's sleep-mode fields (MCU_OE, SLP_SEL, MCU_WPD, MCU_WPU, MCU_IE, bits 4:0 and the reserved 6:5). */
const MUX_SLEEP_FIELDS = 0x7f;
/** IO_MUX output functions as (gpio << 2 | MCU_SEL) → the signal they carry. */
const DIRECT_OUT: ReadonlyMap<number, number> = new Map([
  [(21 << 2) | 0, SIG.U0TXD],
  [(6 << 2) | 2, SIG.FSPICLK],
  [(7 << 2) | 2, SIG.FSPID],
  [(10 << 2) | 2, SIG.FSPICS0],
]);
/** IO_MUX input functions as (gpio << 2 | MCU_SEL) → the signal they feed. */
const DIRECT_IN: ReadonlyMap<number, number> = new Map([
  [(20 << 2) | 0, SIG.U0RXD],
  [(2 << 2) | 2, SIG.FSPIQ],
]);
/** Pads whose function 0 is the GPIO. */
const GPIO_AT_0 = (1 << 0) | (1 << 1) | (1 << 2) | (1 << 3) | (1 << 8) | (1 << 9) | (1 << 10) | (1 << 11) | (1 << 18) | (1 << 19);

export class IoMux implements Peripheral {
  readonly regs = new Uint32Array(1024);
  /**
   * BT94: pads whose register the firmware wrote (as on the ESP32, BT96: only they count as read
   * while floating). BT122: a write that changes nothing outside the sleep-mode fields doesn't count
   * — IDF isolates every pad for sleep at startup (gpio_sleep_set_direction, gpio_sleep_sel_en …),
   * which configures none of them for use.
   */
  readonly configured = new Uint8Array(PIN_COUNT);
  /** Something that decides a pad's mode changed. */
  onConfig: (() => void) | null = null;

  constructor() {
    this.systemReset();
  }

  systemReset(): void {
    this.regs.fill(0);
    this.configured.fill(0);
    for (let g = 0; g < PIN_COUNT; g++) {
      let v = MUX.DRV2;
      if (g !== 0 && g !== 1 && g !== 18 && g !== 19) v |= MUX.FUN_IE;
      if (g === 9 || (g >= 12 && g <= 17) || g === 20) v |= MUX.FUN_WPU;
      this.regs[1 + g] = v;
    }
    this.regs[0xfc >>> 2] = 0x2006050;
    this.onConfig?.();
  }

  pad(g: number): number {
    return this.regs[1 + g];
  }

  func(g: number): number {
    return (this.regs[1 + g] >>> 12) & 7;
  }

  isGpio(g: number): boolean {
    const f = this.func(g);
    return f === 1 || (f === 0 && ((GPIO_AT_0 >>> g) & 1) !== 0);
  }

  inputEnabled(g: number): boolean {
    return (this.regs[1 + g] & MUX.FUN_IE) !== 0;
  }

  read32(offset: number): number {
    return this.regs[offset >>> 2];
  }

  write32(offset: number, value: number): void {
    if (offset === 0xfc) return;
    const before = this.regs[offset >>> 2];
    this.regs[offset >>> 2] = value;
    if (offset >= 4 && offset < 4 + PIN_COUNT * 4) {
      if (((before ^ value) & ~MUX_SLEEP_FIELDS) !== 0) this.configured[(offset - 4) >>> 2] = 1;
      this.onConfig?.();
    }
  }
}

export class Gpio implements Peripheral {
  readonly regs = new Uint32Array(1024);
  /** Every change of OUT or ENABLE (0 OUT, 2 ENABLE — the ESP32's word numbering) with the store's time. */
  onOutput: ((word: number, value: number, time: number) => void) | null = null;
  /** Something that decides a pad's mode or output level changed. */
  onConfig: (() => void) | null = null;
  /** The firmware read IN while GPIO `g` floated with its input enabled. */
  onFloatingRead: ((g: number) => void) | null = null;
  private floating = 0;
  private padIn = 0;
  private seenIn = 0;
  private readonly ctx: SocContext;
  private readonly iomux: IoMux;
  private readonly sources = new Uint8Array(2);

  constructor(ctx: SocContext, iomux: IoMux) {
    this.ctx = ctx;
    this.iomux = iomux;
    this.systemReset();
  }

  systemReset(): void {
    const out = this.regs[GPIO_REG.OUT >>> 2];
    const enable = this.regs[GPIO_REG.ENABLE >>> 2];
    this.regs.fill(0);
    for (let g = 0; g < 26; g++) this.regs[(GPIO_REG.FUNC_OUT_SEL >>> 2) + g] = SIG_GPIO_OUT;
    this.regs[GPIO_REG.STRAP >>> 2] = STRAP_SPI_BOOT;
    this.regs[GPIO_REG.DATE >>> 2] = 0x2006130;
    if (out !== 0) this.onOutput?.(0, 0, this.ctx.now());
    if (enable !== 0) this.onOutput?.(2, 0, this.ctx.now());
    this.seenIn = this.inWord();
    this.updateInterrupts();
    this.onConfig?.();
  }

  level(g: number): number {
    return (this.regs[GPIO_REG.OUT >>> 2] >>> g) & 1;
  }

  enabled(g: number): boolean {
    return ((this.regs[GPIO_REG.ENABLE >>> 2] >>> g) & 1) !== 0;
  }

  outConfig(g: number): number {
    return this.regs[(GPIO_REG.FUNC_OUT_SEL >>> 2) + g];
  }

  openDrain(g: number): boolean {
    return (this.regs[(GPIO_REG.PIN0 >>> 2) + g] & 4) !== 0;
  }

  /** The pins report a pad's input level (0/1). */
  /** BT122: a pad's input level as the bench drives it (0/1). */
  padInput(g: number): number {
    return (this.padIn >>> g) & 1;
  }

  /** BT122: a light sleep's GPIO wake: a pin with PINn WAKEUP_ENABLE (bit 10) at its level type (4 low, 5 high). */
  wakeLevel(): boolean {
    for (let g = 0; g < PIN_COUNT; g++) {
      const pin = this.regs[(GPIO_REG.PIN0 >>> 2) + g];
      if ((pin & (1 << 10)) === 0) continue;
      const type = (pin >>> 7) & 7;
      const level = this.padInput(g);
      if ((type === 4 && level === 0) || (type === 5 && level === 1)) return true;
    }
    return false;
  }

  /** BT123: the pins armed for a light sleep's GPIO wake, as "GPIO4 low". */
  wakePins(): string[] {
    const pins: string[] = [];
    for (let g = 0; g < PIN_COUNT; g++) {
      const pin = this.regs[(GPIO_REG.PIN0 >>> 2) + g];
      const type = (pin >>> 7) & 7;
      if ((pin & (1 << 10)) !== 0 && (type === 4 || type === 5)) pins.push(`GPIO${g} ${type === 4 ? 'low' : 'high'}`);
    }
    return pins;
  }

  /** BT122: after a pad's input changed (a sleeping chip checks its wake pins). */
  onInputs: (() => void) | null = null;

  setPadInput(g: number, level: number): void {
    const v = level !== 0 ? (this.padIn | (1 << g)) >>> 0 : (this.padIn & ~(1 << g)) >>> 0;
    if (v === this.padIn) return;
    this.padIn = v;
    this.inputsChanged();
    this.onInputs?.();
  }

  /** The pins report whether a pad's net floats (no driver). */
  setPadFloating(g: number, floating: boolean): void {
    this.floating = floating ? (this.floating | (1 << g)) >>> 0 : (this.floating & ~(1 << g)) >>> 0;
  }

  /** The GPIO that FUNC_IN_SEL routes to `signal` through the matrix, or −1. */
  inRoute(signal: number): number {
    const cfg = this.regs[(GPIO_REG.FUNC_IN_SEL >>> 2) + signal];
    if ((cfg & 0x40) === 0) return -1;
    const sel = cfg & 0x1f;
    return sel < PIN_COUNT ? sel : -1;
  }

  /** The level a peripheral input signal sees (`direct` when it isn't routed through the matrix). */
  inputSignal(signal: number, direct: number): number {
    const cfg = this.regs[(GPIO_REG.FUNC_IN_SEL >>> 2) + signal];
    let v: number;
    if ((cfg & 0x40) === 0) v = direct;
    else {
      const sel = cfg & 0x1f;
      v = sel === IN_CONST_ONE ? 1 : sel >= PIN_COUNT ? 0 : (this.inWord() >>> sel) & 1;
    }
    return (cfg & 0x20) !== 0 ? v ^ 1 : v;
  }

  /** A pad's input level as IN shows it (0 while FUN_IE is off). */
  padLevel(g: number): number {
    return (this.inWord() >>> g) & 1;
  }

  private inWord(): number {
    let v = 0;
    const raw = this.padIn;
    for (let g = 0; g < PIN_COUNT; g++) if (((raw >>> g) & 1) !== 0 && this.iomux.inputEnabled(g)) v |= 1 << g;
    return v >>> 0;
  }

  /** Inputs or input enables changed: edges and levels for interrupts. */
  inputsChanged(): void {
    const now = this.inWord();
    const prev = this.seenIn;
    this.seenIn = now;
    let set = 0;
    for (let g = 0; g < PIN_COUNT; g++) {
      const type = (this.regs[(GPIO_REG.PIN0 >>> 2) + g] >>> 7) & 7;
      if (type === 0) continue;
      const cur = (now >>> g) & 1;
      const old = (prev >>> g) & 1;
      const hit = type === 1 ? old === 0 && cur === 1 : type === 2 ? old === 1 && cur === 0 : type === 3 ? old !== cur : type === 4 ? cur === 0 : type === 5 ? cur === 1 : false;
      if (hit) set |= 1 << g;
    }
    if (set !== 0) {
      this.regs[GPIO_REG.STATUS >>> 2] |= set;
      this.updateInterrupts();
    }
  }

  private reassertLevels(): void {
    const cur = this.seenIn;
    for (let g = 0; g < PIN_COUNT; g++) {
      const type = (this.regs[(GPIO_REG.PIN0 >>> 2) + g] >>> 7) & 7;
      const level = (cur >>> g) & 1;
      if ((type === 4 && level === 0) || (type === 5 && level === 1)) this.regs[GPIO_REG.STATUS >>> 2] |= 1 << g;
    }
  }

  private masked(ena: number): number {
    const status = this.regs[GPIO_REG.STATUS >>> 2];
    let v = 0;
    for (let g = 0; g < PIN_COUNT; g++) if (((status >>> g) & 1) !== 0 && (this.regs[(GPIO_REG.PIN0 >>> 2) + g] & ena) !== 0) v |= 1 << g;
    return v >>> 0;
  }

  private updateInterrupts(): void {
    const cpu = this.masked(ENA_CPU) !== 0 ? 1 : 0;
    const nmi = this.masked(ENA_CPU_NMI) !== 0 ? 1 : 0;
    if (cpu !== this.sources[0]) {
      this.sources[0] = cpu;
      this.ctx.matrix.setSource(SRC.GPIO, cpu === 1);
    }
    if (nmi !== this.sources[1]) {
      this.sources[1] = nmi;
      this.ctx.matrix.setSource(SRC.GPIO + 1, nmi === 1);
    }
  }

  implements(offset: number): boolean {
    if (offset >= GPIO_REG.OUT && offset <= GPIO_REG.ENABLE_W1TC) return offset !== 0x10 && offset !== 0x14 && offset !== 0x18 && offset !== 0x1c;
    if (offset === GPIO_REG.STRAP || offset === GPIO_REG.IN || (offset >= GPIO_REG.STATUS && offset <= GPIO_REG.STATUS_W1TC)) return true;
    if (offset >= GPIO_REG.PCPU_INT && offset <= GPIO_REG.CPUSDIO_INT) return true;
    if (offset >= GPIO_REG.PIN0 && offset < GPIO_REG.PIN0 + 26 * 4) return true;
    if (offset >= GPIO_REG.FUNC_IN_SEL && offset < GPIO_REG.FUNC_IN_SEL + SIGNALS * 4) return true;
    return (offset >= GPIO_REG.FUNC_OUT_SEL && offset < GPIO_REG.FUNC_OUT_SEL + 26 * 4) || offset === GPIO_REG.CLOCK_GATE || offset === GPIO_REG.DATE || offset === GPIO_REG.STATUS_NEXT;
  }

  read32(offset: number): number {
    switch (offset) {
      case GPIO_REG.IN:
        if (this.floating !== 0 && this.onFloatingRead !== null) {
          for (let g = 0; g < PIN_COUNT; g++) if (((this.floating >>> g) & 1) !== 0 && this.iomux.inputEnabled(g)) this.onFloatingRead(g);
        }
        return this.inWord();
      case GPIO_REG.PCPU_INT:
        return this.masked(ENA_CPU);
      case GPIO_REG.PCPU_NMI_INT:
        return this.masked(ENA_CPU_NMI);
      case GPIO_REG.STATUS_NEXT:
        return this.regs[GPIO_REG.STATUS >>> 2];
      default:
        return this.regs[offset >>> 2];
    }
  }

  write32(offset: number, value: number): void {
    const out = this.regs[GPIO_REG.OUT >>> 2];
    const enable = this.regs[GPIO_REG.ENABLE >>> 2];
    switch (offset) {
      case GPIO_REG.OUT:
        this.set(0, GPIO_REG.OUT, value);
        return;
      case GPIO_REG.OUT_W1TS:
        this.set(0, GPIO_REG.OUT, out | value);
        return;
      case GPIO_REG.OUT_W1TC:
        this.set(0, GPIO_REG.OUT, out & ~value);
        return;
      case GPIO_REG.ENABLE:
        this.set(2, GPIO_REG.ENABLE, value);
        return;
      case GPIO_REG.ENABLE_W1TS:
        this.set(2, GPIO_REG.ENABLE, enable | value);
        return;
      case GPIO_REG.ENABLE_W1TC:
        this.set(2, GPIO_REG.ENABLE, enable & ~value);
        return;
      case GPIO_REG.STATUS:
        this.regs[GPIO_REG.STATUS >>> 2] = value & PIN_MASK;
        break;
      case GPIO_REG.STATUS_W1TS:
        this.regs[GPIO_REG.STATUS >>> 2] |= value & PIN_MASK;
        break;
      case GPIO_REG.STATUS_W1TC:
        this.regs[GPIO_REG.STATUS >>> 2] &= ~value;
        this.reassertLevels();
        break;
      case GPIO_REG.IN:
      case GPIO_REG.PCPU_INT:
      case GPIO_REG.PCPU_NMI_INT:
      case GPIO_REG.CPUSDIO_INT:
      case GPIO_REG.STATUS_NEXT:
      case GPIO_REG.DATE:
        return;
      default:
        this.regs[offset >>> 2] = value;
        if (offset >= GPIO_REG.PIN0 && offset < GPIO_REG.PIN0 + 26 * 4) {
          this.reassertLevels();
          this.updateInterrupts();
          this.onConfig?.();
        } else if (offset >= GPIO_REG.FUNC_OUT_SEL && offset < GPIO_REG.FUNC_OUT_SEL + 26 * 4) this.onConfig?.();
        return;
    }
    this.updateInterrupts();
  }

  private set(word: number, offset: number, value: number): void {
    const v = (value & PIN_MASK) >>> 0;
    if (this.regs[offset >>> 2] === v) return;
    this.regs[offset >>> 2] = v;
    this.onOutput?.(word, v, this.ctx.now());
    this.onConfig?.();
  }
}

export class Pads {
  readonly mode = new Uint8Array(PIN_COUNT);
  readonly level = new Uint8Array(PIN_COUNT);
  /** ADC pads a conversion used (bit n = GPIO n): with input and pulls off they read as analog. */
  adcUsed = 0;
  onPin: ((gpio: number) => void) | null = null;
  private readonly gpio: Gpio;
  private readonly iomux: IoMux;
  /** The level of a peripheral output signal. */
  signalLevel: (signal: number) => number = (s) => (IDLE_HIGH_SIGNALS.has(s) ? 1 : 0);

  constructor(gpio: Gpio, iomux: IoMux) {
    this.gpio = gpio;
    this.iomux = iomux;
    for (let g = 0; g < PIN_COUNT; g++) this.resolve(g);
  }

  /** The GPIO that drives peripheral output `signal` (matrix or IO_MUX), or −1. */
  pinOfOutSignal(signal: number): number {
    for (let g = 0; g < PIN_COUNT; g++) {
      if (this.iomux.isGpio(g) ? (this.gpio.outConfig(g) & 0xff) === signal : DIRECT_OUT.get((g << 2) | this.iomux.func(g)) === signal) return g;
    }
    return -1;
  }

  /** The GPIO that feeds peripheral input `signal` (matrix or IO_MUX), or −1. */
  pinOfInSignal(signal: number): number {
    const routed = this.gpio.inRoute(signal);
    if (routed >= 0) return routed;
    for (let g = 0; g < PIN_COUNT; g++) if (DIRECT_IN.get((g << 2) | this.iomux.func(g)) === signal) return g;
    return -1;
  }

  /** The level peripheral input `signal` sees: through the matrix, or an IO_MUX pad, else idle. */
  inputSignal(signal: number, idle: number): number {
    let direct = idle;
    for (let g = 0; g < PIN_COUNT; g++) {
      if (DIRECT_IN.get((g << 2) | this.iomux.func(g)) === signal) {
        direct = this.gpio.padLevel(g);
        break;
      }
    }
    return this.gpio.inputSignal(signal, direct);
  }

  /** Recomputes every pad; reports the pins that changed. */
  update(): void {
    for (let g = 0; g < PIN_COUNT; g++) {
      const mode = this.mode[g];
      const level = this.level[g];
      this.resolve(g);
      if (this.mode[g] !== mode || this.level[g] !== level) this.onPin?.(g);
    }
  }

  private resolve(g: number): void {
    let enabled = false;
    let level = 0;
    let gpioOut = false;
    if (this.iomux.isGpio(g)) {
      const cfg = this.gpio.outConfig(g);
      const signal = cfg & 0xff;
      if (signal === SIG_GPIO_OUT) {
        gpioOut = true;
        enabled = this.gpio.enabled(g);
        level = this.gpio.level(g);
      } else {
        enabled = (cfg & (1 << 9)) !== 0 ? this.gpio.enabled(g) : true;
        level = this.signalLevel(signal);
      }
      if ((cfg & (1 << 8)) !== 0) level ^= 1;
      if ((cfg & (1 << 10)) !== 0 && (cfg & (1 << 9)) !== 0) enabled = !enabled;
    } else {
      const signal = DIRECT_OUT.get((g << 2) | this.iomux.func(g));
      if (signal !== undefined) {
        enabled = true;
        level = this.signalLevel(signal);
      }
    }
    if (enabled && this.gpio.openDrain(g) && level === 1) enabled = false;
    if (enabled) {
      this.mode[g] = gpioOut ? PAD_MODE.OUTPUT : PAD_MODE.PERIPHERAL;
      this.level[g] = level;
      return;
    }
    this.level[g] = 0;
    const pad = this.iomux.pad(g);
    if ((pad & MUX.FUN_WPU) !== 0) this.mode[g] = PAD_MODE.PULLUP;
    else if ((pad & MUX.FUN_WPD) !== 0) this.mode[g] = PAD_MODE.PULLDOWN;
    else if (g < ADC_PADS && ((this.adcUsed >>> g) & 1) !== 0 && (pad & MUX.FUN_IE) === 0) this.mode[g] = PAD_MODE.ANALOG;
    else this.mode[g] = PAD_MODE.INPUT;
  }
}
