/**
 * GPIO and the GPIO matrix (0x3FF44000; gpio_reg.h, TRM v5.8 ch. 6).
 *
 * Outputs: OUT (0x04, GPIO0–31) / OUT1 (0x10, GPIO32–39 in bits 7:0) and ENABLE (0x20) / ENABLE1
 * (0x2C), each with write-1-to-set/clear aliases (+4 / +8). Arduino's digitalWrite ends in an
 * OUT_W1TS/OUT_W1TC store. FUNC_OUT_SEL_CFG (0x530 + 4·gpio) picks what drives a pad on the
 * matrix: OUT_SEL (8:0) a peripheral signal, 256 = the GPIO_OUT bit; INV_SEL (9); OEN_SEL (10) 1 =
 * output enable from GPIO_ENABLE, 0 = from the peripheral; OEN_INV_SEL (11). PINn (0x88 + 4·gpio):
 * PAD_DRIVER (2) open drain, INT_TYPE (9:7: 1 rising, 2 falling, 3 any edge, 4 low level, 5 high
 * level), INT_ENA (17:13: APP int, APP NMI, PRO int, PRO NMI, SDIO).
 *
 * Inputs: IN (0x3C) / IN1 (0x40) show each pad's level while its IO_MUX FUN_IE is set (0
 * otherwise). FUNC_IN_SEL_CFG (0x130 + 4·signal): IN_SEL (5:0) the GPIO, 0x30 constant 0, 0x38
 * constant 1 (gpio_pins.h); IN_INV_SEL (6); SIG_IN_SEL (7) 1 = through the matrix. `inputSignal`
 * reads a peripheral's input signal (BT35's UART RX uses it).
 *
 * Interrupts: an edge of an enabled pad's input (or a held level) sets its STATUS / STATUS1 bit
 * (0x44 / 0x50, with W1TS/W1TC aliases) per INT_TYPE. PCPU_INT/PCPU_NMI_INT (0x68/0x6C, 0x7C/0x80
 * for GPIO32–39) and ACPU_INT/ACPU_NMI_INT (0x60/0x64, 0x74/0x78) are STATUS masked by each pin's
 * INT_ENA bits; they drive the CPU-specific matrix sources 22 (GPIO_INTERRUPT_PRO/APP) and 23
 * (…_NMI). A level type stays pending while the level holds, even after a W1TC.
 *
 * `onConfig` tells the pad resolver (pads.ts) that something affecting a pad's mode or level
 * changed; `onOutput` hears every change of a latch or enable word with the store's time (BT33's
 * tests watch it).
 */

import type { SocContext } from './context.ts';
import type { InterruptMatrix } from './intmatrix.ts';
import type { IoMux } from './iomux.ts';
import { RegisterFile } from './periph.ts';

export const GPIO_BASE = 0x3ff44000;
export const GPIO = {
  OUT: 0x04,
  OUT_W1TS: 0x08,
  OUT_W1TC: 0x0c,
  OUT1: 0x10,
  OUT1_W1TS: 0x14,
  OUT1_W1TC: 0x18,
  ENABLE: 0x20,
  ENABLE_W1TS: 0x24,
  ENABLE_W1TC: 0x28,
  ENABLE1: 0x2c,
  ENABLE1_W1TS: 0x30,
  ENABLE1_W1TC: 0x34,
  STRAP: 0x38,
  IN: 0x3c,
  IN1: 0x40,
  STATUS: 0x44,
  STATUS_W1TS: 0x48,
  STATUS_W1TC: 0x4c,
  STATUS1: 0x50,
  STATUS1_W1TS: 0x54,
  STATUS1_W1TC: 0x58,
  ACPU_INT: 0x60,
  ACPU_NMI_INT: 0x64,
  PCPU_INT: 0x68,
  PCPU_NMI_INT: 0x6c,
  ACPU_INT1: 0x74,
  ACPU_NMI_INT1: 0x78,
  PCPU_INT1: 0x7c,
  PCPU_NMI_INT1: 0x80,
  PIN0: 0x88,
  FUNC_IN_SEL: 0x130,
  FUNC_OUT_SEL: 0x530,
} as const;
/** OUT1/ENABLE1/STATUS1 hold GPIO32–39. */
const HIGH_MASK = 0xff;
const PIN_END = GPIO.PIN0 + 40 * 4;
const FUNC_OUT_END = GPIO.FUNC_OUT_SEL + 40 * 4;
/** FUNC_OUT_SEL OUT_SEL value meaning "the GPIO_OUT bit" (SIG_GPIO_OUT_IDX). */
export const SIG_GPIO_OUT = 256;
/** GPIO_STRAP: GPIO0 high (SPI boot), MTDI low — the strapping a DevKit boots with. */
const STRAP_SPI_BOOT = 0x13;
const SOURCE_GPIO = 22;
const SOURCE_GPIO_NMI = 23;
/** INT_ENA bits (PINn 17:13). */
const ENA_APP = 1 << 13;
const ENA_APP_NMI = 1 << 14;
const ENA_PRO = 1 << 15;
const ENA_PRO_NMI = 1 << 16;
/** The four CPU-specific sources in `sources` order: PRO int, PRO NMI, APP int, APP NMI. */
const SOURCE_ENA = [ENA_PRO, ENA_PRO_NMI, ENA_APP, ENA_APP_NMI] as const;

/** Which word changed: 0 OUT, 1 OUT1, 2 ENABLE, 3 ENABLE1. */
export type GpioWord = 0 | 1 | 2 | 3;

export class Gpio extends RegisterFile {
  /** Called on every change of OUT/OUT1/ENABLE/ENABLE1 with the new word and the store's time. */
  onOutput: ((word: GpioWord, value: number, time: number) => void) | null = null;
  /** Something that decides a pad's mode or output level changed. */
  onConfig: (() => void) | null = null;
  /** The firmware read IN/IN1 while GPIO `g` floated with its input enabled (BT34's Problem). */
  onFloatingRead: ((g: number) => void) | null = null;
  /** Pads whose net nothing drives (bit n = GPIO n), as the pins report them. */
  private floating = 0;
  private floating1 = 0;
  /** Pad input levels (bit n = GPIO n), as the pins report them; IN masks them by FUN_IE. */
  private padIn = 0;
  private padIn1 = 0;
  /** The inputs the interrupt logic saw last (masked), for edge detection. */
  private seenIn = 0;
  private seenIn1 = 0;
  private readonly context: SocContext;
  private readonly matrix: InterruptMatrix;
  private readonly iomux: IoMux;
  private readonly sources = new Uint8Array(4); // PRO int, PRO NMI, APP int, APP NMI as driven

  constructor(context: SocContext, matrix: InterruptMatrix, iomux: IoMux) {
    super(GPIO_BASE);
    this.context = context;
    this.matrix = matrix;
    this.iomux = iomux;
    this.resetMatrix();
  }

  implements(offset: number): boolean {
    if (offset >= GPIO.OUT && offset <= GPIO.STATUS1_W1TC) return offset !== 0x1c;
    if (offset >= GPIO.ACPU_INT && offset <= GPIO.PCPU_NMI_INT1) return true;
    return (offset >= GPIO.PIN0 && offset < PIN_END) || (offset >= GPIO.FUNC_IN_SEL && offset < FUNC_OUT_END);
  }

  /** FUNC_OUT_SEL = 256 (the GPIO_OUT bit) for every pad, FUNC_IN_SEL = constant 0 (headers say "x"). */
  private resetMatrix(): void {
    for (let g = 0; g < 40; g++) this.regs[(GPIO.FUNC_OUT_SEL >>> 2) + g] = SIG_GPIO_OUT | (1 << 10);
    for (let s = 0; s < 256; s++) this.regs[(GPIO.FUNC_IN_SEL >>> 2) + s] = 0x30;
    this.regs[GPIO.STRAP >>> 2] = STRAP_SPI_BOOT;
  }

  override systemReset(_rtcDomain: boolean): void {
    const before = [this.regs[GPIO.OUT >>> 2], this.regs[GPIO.OUT1 >>> 2], this.regs[GPIO.ENABLE >>> 2], this.regs[GPIO.ENABLE1 >>> 2]];
    this.reset();
    this.resetMatrix();
    const offsets = [GPIO.OUT, GPIO.OUT1, GPIO.ENABLE, GPIO.ENABLE1];
    for (let w = 0; w < 4; w++) {
      const v = this.regs[offsets[w] >>> 2];
      if (v !== before[w]) this.onOutput?.(w as GpioWord, v, this.context.now());
    }
    this.seenIn = this.inWord(0);
    this.seenIn1 = this.inWord(1);
    this.updateInterrupts();
    this.onConfig?.();
  }

  /** The output latch level of GPIO `n` (0–39). */
  level(n: number): number {
    return n < 32 ? (this.regs[GPIO.OUT >>> 2] >>> n) & 1 : (this.regs[GPIO.OUT1 >>> 2] >>> (n - 32)) & 1;
  }

  /** Is GPIO `n`'s GPIO_ENABLE bit set? */
  enabled(n: number): boolean {
    return (n < 32 ? (this.regs[GPIO.ENABLE >>> 2] >>> n) & 1 : (this.regs[GPIO.ENABLE1 >>> 2] >>> (n - 32)) & 1) !== 0;
  }

  /** FUNC_OUT_SEL_CFG of GPIO `n`. */
  outConfig(n: number): number {
    return this.regs[(GPIO.FUNC_OUT_SEL >>> 2) + n];
  }

  /** PAD_DRIVER (open drain) of GPIO `n`. */
  openDrain(n: number): boolean {
    return (this.regs[(GPIO.PIN0 >>> 2) + n] & 4) !== 0;
  }

  /** The pins report a pad's input level (0/1). */
  setPadInput(n: number, level: number): void {
    if (n < 32) {
      const v = level !== 0 ? (this.padIn | (1 << n)) >>> 0 : (this.padIn & ~(1 << n)) >>> 0;
      if (v === this.padIn) return;
      this.padIn = v;
    } else {
      const v = level !== 0 ? this.padIn1 | (1 << (n - 32)) : this.padIn1 & ~(1 << (n - 32));
      if (v === this.padIn1) return;
      this.padIn1 = v;
    }
    this.inputsChanged();
  }

  /** The pins report whether a pad's net is floating (no driver). */
  setPadFloating(n: number, floating: boolean): void {
    if (n < 32) this.floating = floating ? (this.floating | (1 << n)) >>> 0 : (this.floating & ~(1 << n)) >>> 0;
    else this.floating1 = floating ? this.floating1 | (1 << (n - 32)) : this.floating1 & ~(1 << (n - 32));
  }

  /** IN/IN1 was read: tell about floating pads with their input enabled. */
  private readFloating(word: number): void {
    const f = word === 0 ? this.floating : this.floating1;
    if (f === 0 || this.onFloatingRead === null) return;
    for (let i = 0; i < (word === 0 ? 32 : 8); i++) {
      const g = word * 32 + i;
      if (((f >>> i) & 1) !== 0 && this.iomux.padExists(g) && this.iomux.inputEnabled(g)) this.onFloatingRead(g);
    }
  }

  /** The GPIO FUNC_IN_SEL routes to input `signal` through the matrix (SIG_IN_SEL set), or −1. */
  inRoute(signal: number): number {
    const cfg = this.regs[(GPIO.FUNC_IN_SEL >>> 2) + signal];
    if ((cfg & 0x80) === 0) return -1;
    const sel = cfg & 0x3f;
    return sel < 40 && this.iomux.padExists(sel) ? sel : -1;
  }

  /** The level a peripheral input signal sees (FUNC_IN_SEL routing; `direct` when SIG_IN_SEL = 0). */
  inputSignal(signal: number, direct: number): number {
    const cfg = this.regs[(GPIO.FUNC_IN_SEL >>> 2) + signal];
    let v: number;
    if ((cfg & 0x80) === 0) v = direct;
    else {
      const sel = cfg & 0x3f;
      v = sel === 0x38 ? 1 : sel >= 40 ? 0 : (this.inWord(sel < 32 ? 0 : 1) >>> (sel & 31)) & 1;
    }
    return (cfg & 0x40) !== 0 ? v ^ 1 : v;
  }

  /** IN (word 0) or IN1 (word 1): pad levels where FUN_IE is set. */
  private inWord(word: number): number {
    let mask = 0;
    const base = word * 32;
    const raw = word === 0 ? this.padIn : this.padIn1;
    for (let i = 0; i < (word === 0 ? 32 : 8); i++) {
      const g = base + i;
      if (((raw >>> i) & 1) !== 0 && this.iomux.padExists(g) && this.iomux.inputEnabled(g)) mask |= 1 << i;
    }
    return mask >>> 0;
  }

  /** Inputs (or input enables) changed: detect edges and levels for interrupts. */
  inputsChanged(): void {
    const now0 = this.inWord(0);
    const now1 = this.inWord(1);
    const prev0 = this.seenIn;
    const prev1 = this.seenIn1;
    this.seenIn = now0;
    this.seenIn1 = now1;
    let set0 = 0;
    let set1 = 0;
    for (let g = 0; g < 40; g++) {
      const type = (this.regs[(GPIO.PIN0 >>> 2) + g] >>> 7) & 7;
      if (type === 0) continue;
      const cur = g < 32 ? (now0 >>> g) & 1 : (now1 >>> (g - 32)) & 1;
      const old = g < 32 ? (prev0 >>> g) & 1 : (prev1 >>> (g - 32)) & 1;
      const hit = type === 1 ? old === 0 && cur === 1 : type === 2 ? old === 1 && cur === 0 : type === 3 ? old !== cur : type === 4 ? cur === 0 : type === 5 ? cur === 1 : false;
      if (!hit) continue;
      if (g < 32) set0 |= 1 << g;
      else set1 |= 1 << (g - 32);
    }
    if ((set0 | set1) !== 0) {
      this.regs[GPIO.STATUS >>> 2] |= set0;
      this.regs[GPIO.STATUS1 >>> 2] |= set1;
      this.updateInterrupts();
    }
  }

  /** Level-type pins whose level still holds stay pending. */
  private reassertLevels(): void {
    const in0 = this.seenIn;
    const in1 = this.seenIn1;
    for (let g = 0; g < 40; g++) {
      const type = (this.regs[(GPIO.PIN0 >>> 2) + g] >>> 7) & 7;
      if (type !== 4 && type !== 5) continue;
      const cur = g < 32 ? (in0 >>> g) & 1 : (in1 >>> (g - 32)) & 1;
      if ((type === 4 && cur === 0) || (type === 5 && cur === 1)) {
        if (g < 32) this.regs[GPIO.STATUS >>> 2] |= 1 << g;
        else this.regs[GPIO.STATUS1 >>> 2] |= 1 << (g - 32);
      }
    }
  }

  /** STATUS masked by INT_ENA bit `ena` (word 0: GPIO0–31, 1: GPIO32–39). */
  private masked(word: number, ena: number): number {
    const status = this.regs[(word === 0 ? GPIO.STATUS : GPIO.STATUS1) >>> 2];
    let v = 0;
    const count = word === 0 ? 32 : 8;
    for (let i = 0; i < count; i++) {
      if (((status >>> i) & 1) !== 0 && (this.regs[(GPIO.PIN0 >>> 2) + word * 32 + i] & ena) !== 0) v |= 1 << i;
    }
    return v >>> 0;
  }

  private updateInterrupts(): void {
    for (let i = 0; i < 4; i++) {
      const ena = SOURCE_ENA[i];
      const v = (this.masked(0, ena) | this.masked(1, ena)) !== 0 ? 1 : 0;
      if (v === this.sources[i]) continue;
      this.sources[i] = v;
      this.matrix.setCpuSource(i < 2 ? 0 : 1, (i & 1) === 0 ? SOURCE_GPIO : SOURCE_GPIO_NMI, v === 1);
    }
  }

  override read32(offset: number): number {
    switch (offset) {
      case GPIO.IN:
        this.readFloating(0);
        return this.inWord(0);
      case GPIO.IN1:
        this.readFloating(1);
        return this.inWord(1);
      case GPIO.ACPU_INT:
        return this.masked(0, ENA_APP);
      case GPIO.ACPU_NMI_INT:
        return this.masked(0, ENA_APP_NMI);
      case GPIO.PCPU_INT:
        return this.masked(0, ENA_PRO);
      case GPIO.PCPU_NMI_INT:
        return this.masked(0, ENA_PRO_NMI);
      case GPIO.ACPU_INT1:
        return this.masked(1, ENA_APP);
      case GPIO.ACPU_NMI_INT1:
        return this.masked(1, ENA_APP_NMI);
      case GPIO.PCPU_INT1:
        return this.masked(1, ENA_PRO);
      case GPIO.PCPU_NMI_INT1:
        return this.masked(1, ENA_PRO_NMI);
      default:
        return super.read32(offset);
    }
  }

  override write32(offset: number, value: number): void {
    switch (offset) {
      case GPIO.OUT:
        this.set(0, GPIO.OUT, value);
        return;
      case GPIO.OUT_W1TS:
        this.set(0, GPIO.OUT, this.regs[GPIO.OUT >>> 2] | value);
        return;
      case GPIO.OUT_W1TC:
        this.set(0, GPIO.OUT, this.regs[GPIO.OUT >>> 2] & ~value);
        return;
      case GPIO.OUT1:
        this.set(1, GPIO.OUT1, value & HIGH_MASK);
        return;
      case GPIO.OUT1_W1TS:
        this.set(1, GPIO.OUT1, (this.regs[GPIO.OUT1 >>> 2] | value) & HIGH_MASK);
        return;
      case GPIO.OUT1_W1TC:
        this.set(1, GPIO.OUT1, this.regs[GPIO.OUT1 >>> 2] & ~value & HIGH_MASK);
        return;
      case GPIO.ENABLE:
        this.set(2, GPIO.ENABLE, value);
        return;
      case GPIO.ENABLE_W1TS:
        this.set(2, GPIO.ENABLE, this.regs[GPIO.ENABLE >>> 2] | value);
        return;
      case GPIO.ENABLE_W1TC:
        this.set(2, GPIO.ENABLE, this.regs[GPIO.ENABLE >>> 2] & ~value);
        return;
      case GPIO.ENABLE1:
        this.set(3, GPIO.ENABLE1, value & HIGH_MASK);
        return;
      case GPIO.ENABLE1_W1TS:
        this.set(3, GPIO.ENABLE1, (this.regs[GPIO.ENABLE1 >>> 2] | value) & HIGH_MASK);
        return;
      case GPIO.ENABLE1_W1TC:
        this.set(3, GPIO.ENABLE1, this.regs[GPIO.ENABLE1 >>> 2] & ~value & HIGH_MASK);
        return;
      case GPIO.STATUS:
        this.regs[offset >>> 2] = value;
        break;
      case GPIO.STATUS_W1TS:
        this.regs[GPIO.STATUS >>> 2] |= value;
        break;
      case GPIO.STATUS_W1TC:
        this.regs[GPIO.STATUS >>> 2] &= ~value;
        this.reassertLevels();
        break;
      case GPIO.STATUS1:
        this.regs[offset >>> 2] = value & HIGH_MASK;
        break;
      case GPIO.STATUS1_W1TS:
        this.regs[GPIO.STATUS1 >>> 2] |= value & HIGH_MASK;
        break;
      case GPIO.STATUS1_W1TC:
        this.regs[GPIO.STATUS1 >>> 2] &= ~value;
        this.reassertLevels();
        break;
      case GPIO.IN:
      case GPIO.IN1:
      case GPIO.ACPU_INT:
      case GPIO.ACPU_NMI_INT:
      case GPIO.PCPU_INT:
      case GPIO.PCPU_NMI_INT:
      case GPIO.ACPU_INT1:
      case GPIO.ACPU_NMI_INT1:
      case GPIO.PCPU_INT1:
      case GPIO.PCPU_NMI_INT1:
        return; // read-only
      default:
        super.write32(offset, value);
        if (offset >= GPIO.PIN0 && offset < PIN_END) {
          this.reassertLevels();
          this.updateInterrupts();
          this.onConfig?.();
        } else if (offset >= GPIO.FUNC_OUT_SEL && offset < FUNC_OUT_END) this.onConfig?.();
        return;
    }
    this.updateInterrupts();
  }

  private set(word: GpioWord, offset: number, value: number): void {
    const v = value >>> 0;
    if (this.regs[offset >>> 2] === v) return;
    this.regs[offset >>> 2] = v;
    this.onOutput?.(word, v, this.context.now());
    this.onConfig?.();
  }
}

