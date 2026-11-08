/**
 * The ESP32-S3's GPIO, GPIO matrix, IO_MUX and pad resolver (BT125; gpio_reg.h, io_mux_reg.h,
 * gpio_sig_map.h, gpio_pins.h). The C3's model (@benchtop/esp32c3 gpio.ts) over the S3's 49 pads —
 * GPIO0–21 and 26–48 (22–25 don't exist; 26–32 are the module's flash, 33–37 its octal PSRAM on
 * the N8R8 modules) — so every 32-bit word has a second one: the S3 copy keeps per-pad state.
 *
 * GPIO (0x6000_4000): OUT 0x04 / OUT1 0x10 and ENABLE 0x20 / ENABLE1 0x2C, each with W1TS/W1TC
 * (+4/+8); IN 0x3C / IN1 0x40 show a pad's level while its IO_MUX FUN_IE is set. PINn (0x74 + 4n):
 * PAD_DRIVER (2) open drain, INT_TYPE (9:7: 1 rising, 2 falling, 3 any, 4 low, 5 high), INT_ENA
 * (17:13: 13 the CPU interrupt, 14 its NMI — gpio_ll.h's GPIO_LL_INTR_ENA; the S3's one interrupt
 * reaches either core through the matrix), WAKEUP_ENABLE (10). An edge (or a held level) sets
 * STATUS 0x44 / STATUS1 0x50 (W1TS/W1TC +4/+8); PCPU_INT 0x5C / PCPU_INT1 0x68 (and the NMIs 0x60 /
 * 0x6C) are STATUS masked by INT_ENA and drive sources 16 (GPIO) and 17 (GPIO_NMI).
 * FUNC_IN_SEL_CFG (0x154 + 4·signal, 256 signals): IN_SEL (5:0) the GPIO — 0x38 constant 1, 0x3C
 * constant 0 —, IN_INV_SEL (6), SIG_IN_SEL (7) through the matrix. FUNC_OUT_SEL_CFG (0x554 +
 * 4·gpio): OUT_SEL (8:0), 256 = the GPIO_OUT bit; OUT_INV_SEL (9); OEN_SEL (10) 1 = output enable
 * from GPIO_ENABLE; OEN_INV_SEL (11).
 *
 * IO_MUX (0x6000_9000): pad n at 0x04 + 4n — MCU_SEL (14:12) the function (1 is GPIO on every pad;
 * 0 is GPIO too on 0–21, 33–38, 45, 46, U0TXD/U0RXD on 43/44, the flash on 26–32, JTAG on 39–42;
 * 4 is FSPI on 10–13; 2 is U1TXD/U1RXD on 17/18 and FSPI on 34–37), FUN_IE (9), FUN_WPU (8), FUN_WPD (7). Reset: function 0, inputs enabled but
 * on the USB pads (19, 20), pull-ups on GPIO0 (BOOT), the flash pads and U0RXD, pull-downs on the
 * GPIO45/46 straps — the TRM's IO MUX table, approximated.
 *
 * The module's flash pads (GPIO26–32: SPICS1, SPIHD, SPIWP, SPICS0, SPICLK, SPIQ, SPID on every
 * WROOM-1/-2) are refused: the bench can't drive them (`setPadInput` ignores them), and firmware
 * that turns one into a GPIO (MCU_SEL 1) gets a warning, `esp32s3-flash-pin` — on a board that cuts
 * the flash off; here the flash model doesn't notice. GPIO33–37 carry PSRAM only on octal-PSRAM
 * modules (N8R8): free pads here, but BT136's `octalPsram` watch reports (`pin-reserved`, once per
 * pad) firmware that makes one a GPIO while the octal PSRAM runs — on a board the PSRAM stops
 * answering; the simulated one keeps working.
 *
 * Pads resolve as the C3's do (its file says how): a matrix output, an IO_MUX function that drives
 * the pad directly (U0TXD on 43, U1TXD on 17, FSPICLK/FSPID/FSPICS0 on 12/11/10 or 36/35/34), open
 * drain, else an input with
 * its pulls — or `analog`, an ADC pad (GPIO1–10 ADC1, GPIO11–20 ADC2) with its input and pulls off
 * after a conversion used it.
 */

import type { Peripheral, ProblemLog } from '@benchtop/esp32';
import type { SocContext } from '@benchtop/esp32c3';
import { S3_SRC } from './intmatrix.ts';

export const S3_GPIO_BASE = 0x60004000;
export const S3_IO_MUX_BASE = 0x60009000;
/** GPIO0–48 (indexes 22–25 are no pads). */
export const S3_PADS = 49;
/** OUT_SEL meaning "the GPIO_OUT bit" (SIG_GPIO_OUT_IDX). */
export const S3_SIG_GPIO_OUT = 256;
/** Pad modes (McuPin's PinMode, as small integers — the ESP32's numbering). */
export const S3_PAD_MODE = { INPUT: 0, PULLUP: 1, PULLDOWN: 2, OUTPUT: 3, ANALOG: 4, PERIPHERAL: 5 } as const;
/** gpio_sig_map.h signals the models use. */
export const S3_SIG = {
  U0TXD: 12,
  U0RXD: 12,
  U1TXD: 15,
  U1RXD: 15,
  U2TXD: 18,
  U2RXD: 18,
  LEDC0: 73,
  RMT0: 81,
  I2C0_SCL: 89,
  I2C0_SDA: 90,
  I2C1_SCL: 91,
  I2C1_SDA: 92,
  FSPICLK: 101,
  FSPIQ: 102,
  FSPID: 103,
  FSPICS0: 110,
} as const;
/** Peripheral outputs that idle high: UART TXD and the I2C lines (open drain, released). */
export const S3_IDLE_HIGH_SIGNALS: ReadonlySet<number> = new Set([S3_SIG.U0TXD, S3_SIG.U1TXD, S3_SIG.U2TXD, S3_SIG.I2C0_SCL, S3_SIG.I2C0_SDA, S3_SIG.I2C1_SCL, S3_SIG.I2C1_SDA]);

/** Is `g` a pad (GPIO0–21, 26–48)? */
export const isS3Pad = (g: number): boolean => g >= 0 && g < S3_PADS && (g < 22 || g > 25);
/** Is `g` one of the module's flash pads (GPIO26–32)? */
export const isS3FlashPad = (g: number): boolean => g >= 26 && g <= 32;
export const CODE_S3_FLASH_PIN = 'esp32s3-flash-pin';
const FLASH_PAD_NAMES = ['SPICS1', 'SPIHD', 'SPIWP', 'SPICS0', 'SPICLK', 'SPIQ', 'SPID'] as const;
/** The ADC channel of pad `g` as adc << 4 | channel (ADC1: GPIO1–10, ADC2: GPIO11–20), or −1. */
export function adcChannelOf(g: number): number {
  if (g >= 1 && g <= 10) return (1 << 4) | (g - 1);
  if (g >= 11 && g <= 20) return (2 << 4) | (g - 11);
  return -1;
}

const REG = {
  OUT: 0x04,
  OUT1: 0x10,
  ENABLE: 0x20,
  ENABLE1: 0x2c,
  STRAP: 0x38,
  IN: 0x3c,
  IN1: 0x40,
  STATUS: 0x44,
  STATUS1: 0x50,
  PCPU_INT: 0x5c,
  PCPU_NMI_INT: 0x60,
  CPUSDIO_INT: 0x64,
  PCPU_INT1: 0x68,
  PCPU_NMI_INT1: 0x6c,
  CPUSDIO_INT1: 0x70,
  PIN0: 0x74,
  STATUS_NEXT: 0x14c,
  STATUS_NEXT1: 0x150,
  FUNC_IN_SEL: 0x154,
  FUNC_OUT_SEL: 0x554,
  DATE: 0x6fc,
} as const;
const PIN_REGS = 54;
const SIGNALS = 256;
const IN_CONST_ONE = 0x38;
const ENA_CPU = 1 << 13;
const ENA_CPU_NMI = 1 << 14;
/** GPIO_STRAP: GPIO0 high (SPI boot), GPIO46 low. */
const STRAP_SPI_BOOT = 0x08;

const MUX = { FUN_WPD: 1 << 7, FUN_WPU: 1 << 8, FUN_IE: 1 << 9, DRV2: 2 << 10, MCU_SEL: 7 << 12 } as const;
/** BT136: a pad the module's PSRAM holds, taken by the firmware (the bench's code, as the ESP32's). */
export const CODE_S3_PIN_RESERVED = 'pin-reserved';
/** BT136: what GPIO33–37 carry for an octal PSRAM (the datasheet's pin list). */
export const OCTAL_PSRAM_PADS = ['SPIIO4', 'SPIIO5', 'SPIIO6', 'SPIIO7', 'SPIDQS'] as const;
/** IO_MUX's sleep-mode fields (MCU_OE, SLP_SEL, MCU_WPD, MCU_WPU, MCU_IE and reserved, 6:0). */
const MUX_SLEEP_FIELDS = 0x7f;
/** IO_MUX output functions as (gpio << 3 | MCU_SEL) → the signal they carry. */
const DIRECT_OUT: ReadonlyMap<number, number> = new Map([
  [(43 << 3) | 0, S3_SIG.U0TXD],
  [(17 << 3) | 2, S3_SIG.U1TXD],
  [(12 << 3) | 4, S3_SIG.FSPICLK],
  [(11 << 3) | 4, S3_SIG.FSPID],
  [(10 << 3) | 4, S3_SIG.FSPICS0],
  [(36 << 3) | 2, S3_SIG.FSPICLK],
  [(35 << 3) | 2, S3_SIG.FSPID],
  [(34 << 3) | 2, S3_SIG.FSPICS0],
]);
/** IO_MUX input functions as (gpio << 3 | MCU_SEL) → the signal they feed. */
const DIRECT_IN: ReadonlyMap<number, number> = new Map([
  [(44 << 3) | 0, S3_SIG.U0RXD],
  [(18 << 3) | 2, S3_SIG.U1RXD],
  [(13 << 3) | 4, S3_SIG.FSPIQ],
  [(37 << 3) | 2, S3_SIG.FSPIQ],
]);
/** Pads whose function 0 is the GPIO. */
const gpioAt0 = (g: number): boolean => g <= 21 || (g >= 33 && g <= 38) || g === 45 || g === 46;

export class S3IoMux implements Peripheral {
  readonly regs = new Uint32Array(1024);
  /** Pads the firmware configured (a write that changed more than the sleep fields; as the C3's). */
  readonly configured = new Uint8Array(S3_PADS);
  /** Something that decides a pad's mode changed. */
  onConfig: (() => void) | null = null;
  /** BT136: whether the octal PSRAM runs (it holds GPIO33–37); null: no watch. */
  octalPsram: (() => boolean) | null = null;
  private readonly problems: ProblemLog | null;

  constructor(problems: ProblemLog | null = null) {
    this.problems = problems;
    this.systemReset();
  }

  systemReset(): void {
    this.regs.fill(0);
    this.configured.fill(0);
    for (let g = 0; g < S3_PADS; g++) {
      if (!isS3Pad(g)) continue;
      let v = MUX.DRV2;
      if (g !== 19 && g !== 20) v |= MUX.FUN_IE;
      if (g === 0 || g === 44 || (g >= 26 && g <= 32)) v |= MUX.FUN_WPU;
      if (g === 45 || g === 46) v |= MUX.FUN_WPD;
      this.regs[1 + g] = v;
    }
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
    return f === 1 || (f === 0 && gpioAt0(g));
  }

  inputEnabled(g: number): boolean {
    return (this.regs[1 + g] & MUX.FUN_IE) !== 0;
  }

  read32(offset: number): number {
    return this.regs[offset >>> 2];
  }

  write32(offset: number, value: number): void {
    const before = this.regs[offset >>> 2];
    this.regs[offset >>> 2] = value;
    if (offset >= 4 && offset < 4 + S3_PADS * 4) {
      const g = (offset - 4) >>> 2;
      if (((before ^ value) & ~MUX_SLEEP_FIELDS) !== 0) this.configured[g] = 1;
      if (isS3FlashPad(g) && this.isGpio(g) && this.problems !== null) {
        this.problems.report('warning', CODE_S3_FLASH_PIN, S3_IO_MUX_BASE + offset, `GPIO${g} is the module's SPI flash (${FLASH_PAD_NAMES[g - 26]}): using it as a GPIO cuts the flash off on a board (the simulator's flash keeps working). Pick another pin.`);
      }
      if (g >= 33 && g <= 37 && ((before ^ value) & MUX.MCU_SEL) !== 0 && this.isGpio(g) && this.problems !== null && this.octalPsram !== null && this.octalPsram()) {
        this.problems.report('warning', CODE_S3_PIN_RESERVED, S3_IO_MUX_BASE + offset, `The firmware made GPIO${g} a GPIO, but it carries the octal PSRAM's ${OCTAL_PSRAM_PADS[g - 33]}: on a board the PSRAM stops answering (the simulator's keeps working). On an N8R8 module IO35–37 aren't free: pick another pin.`);
      }
      this.onConfig?.();
    }
  }
}

export class S3Gpio implements Peripheral {
  readonly regs = new Uint32Array(1024);
  /** Every change of OUT, OUT1, ENABLE or ENABLE1 (words 0–3, the ESP32's numbering) with the store's time. */
  onOutput: ((word: number, value: number, time: number) => void) | null = null;
  /** Something that decides a pad's mode or output level changed. */
  onConfig: (() => void) | null = null;
  /** The firmware read IN/IN1 while GPIO `g` floated with its input enabled. */
  onFloatingRead: ((g: number) => void) | null = null;
  /** After a pad's input changed. */
  onInputs: (() => void) | null = null;
  private readonly floating = new Uint8Array(S3_PADS);
  private readonly padIn = new Uint8Array(S3_PADS);
  private readonly seenIn = new Uint8Array(S3_PADS);
  private readonly ctx: SocContext;
  private readonly iomux: S3IoMux;
  private readonly sources = new Uint8Array(2);

  constructor(ctx: SocContext, iomux: S3IoMux) {
    this.ctx = ctx;
    this.iomux = iomux;
    this.systemReset();
  }

  systemReset(): void {
    const outs = [this.regs[REG.OUT >>> 2], this.regs[REG.OUT1 >>> 2], this.regs[REG.ENABLE >>> 2], this.regs[REG.ENABLE1 >>> 2]];
    this.regs.fill(0);
    for (let g = 0; g < PIN_REGS; g++) this.regs[(REG.FUNC_OUT_SEL >>> 2) + g] = S3_SIG_GPIO_OUT;
    this.regs[REG.STRAP >>> 2] = STRAP_SPI_BOOT;
    this.regs[REG.DATE >>> 2] = 0x1907040;
    outs.forEach((v, word) => {
      if (v !== 0) this.onOutput?.(word, 0, this.ctx.now());
    });
    for (let g = 0; g < S3_PADS; g++) this.seenIn[g] = this.inBit(g);
    this.updateInterrupts();
    this.onConfig?.();
  }

  level(g: number): number {
    return g < 32 ? (this.regs[REG.OUT >>> 2] >>> g) & 1 : (this.regs[REG.OUT1 >>> 2] >>> (g - 32)) & 1;
  }

  enabled(g: number): boolean {
    return (g < 32 ? (this.regs[REG.ENABLE >>> 2] >>> g) & 1 : (this.regs[REG.ENABLE1 >>> 2] >>> (g - 32)) & 1) !== 0;
  }

  outConfig(g: number): number {
    return this.regs[(REG.FUNC_OUT_SEL >>> 2) + g];
  }

  openDrain(g: number): boolean {
    return (this.regs[(REG.PIN0 >>> 2) + g] & 4) !== 0;
  }

  /** A pad's input level as the bench drives it (0/1). */
  padInput(g: number): number {
    return this.padIn[g];
  }

  setPadInput(g: number, level: number): void {
    if (isS3FlashPad(g)) return; // the module's flash drives these
    const v = level !== 0 ? 1 : 0;
    if (this.padIn[g] === v) return;
    this.padIn[g] = v;
    this.inputsChanged();
    this.onInputs?.();
  }

  /** Whether a pad's net floats (no driver). */
  setPadFloating(g: number, floating: boolean): void {
    this.floating[g] = floating ? 1 : 0;
  }

  /** The GPIO that FUNC_IN_SEL routes to `signal` through the matrix, or −1. */
  inRoute(signal: number): number {
    const cfg = this.regs[(REG.FUNC_IN_SEL >>> 2) + signal];
    if ((cfg & 0x80) === 0) return -1;
    const sel = cfg & 0x3f;
    return isS3Pad(sel) ? sel : -1;
  }

  /** The level a peripheral input signal sees (`direct` when it isn't routed through the matrix). */
  inputSignal(signal: number, direct: number): number {
    const cfg = this.regs[(REG.FUNC_IN_SEL >>> 2) + signal];
    let v: number;
    if ((cfg & 0x80) === 0) v = direct;
    else {
      const sel = cfg & 0x3f;
      v = sel === IN_CONST_ONE ? 1 : isS3Pad(sel) ? this.inBit(sel) : 0;
    }
    return (cfg & 0x40) !== 0 ? v ^ 1 : v;
  }

  /** A pad's input level as IN shows it (0 while FUN_IE is off). */
  padLevel(g: number): number {
    return this.inBit(g);
  }

  private inBit(g: number): number {
    return this.padIn[g] !== 0 && this.iomux.inputEnabled(g) ? 1 : 0;
  }

  /** IN (word 0: GPIO0–31) or IN1 (word 1: GPIO32–53). */
  private inWord(word: number): number {
    let v = 0;
    const first = word * 32;
    const last = Math.min(S3_PADS, first + 32);
    for (let g = first; g < last; g++) if (this.inBit(g) !== 0) v |= 1 << (g - first);
    return v >>> 0;
  }

  /** BT128: the pins armed for a light sleep's GPIO wake, as "GPIO4 low". */
  wakePins(): string[] {
    const pins: string[] = [];
    for (let g = 0; g < S3_PADS; g++) {
      const pin = this.regs[(REG.PIN0 >>> 2) + g];
      const type = (pin >>> 7) & 7;
      if ((pin & (1 << 10)) !== 0 && (type === 4 || type === 5)) pins.push(`GPIO${g} ${type === 4 ? 'low' : 'high'}`);
    }
    return pins;
  }

  /** Inputs or input enables changed: edges and levels for interrupts. */
  inputsChanged(): void {
    let set0 = 0;
    let set1 = 0;
    for (let g = 0; g < S3_PADS; g++) {
      const cur = this.inBit(g);
      const old = this.seenIn[g];
      this.seenIn[g] = cur;
      const type = (this.regs[(REG.PIN0 >>> 2) + g] >>> 7) & 7;
      if (type === 0) continue;
      const hit = type === 1 ? old === 0 && cur === 1 : type === 2 ? old === 1 && cur === 0 : type === 3 ? old !== cur : type === 4 ? cur === 0 : type === 5 ? cur === 1 : false;
      if (!hit) continue;
      if (g < 32) set0 |= 1 << g;
      else set1 |= 1 << (g - 32);
    }
    if (set0 !== 0 || set1 !== 0) {
      this.regs[REG.STATUS >>> 2] |= set0;
      this.regs[REG.STATUS1 >>> 2] |= set1;
      this.updateInterrupts();
    }
  }

  private reassertLevels(): void {
    for (let g = 0; g < S3_PADS; g++) {
      const type = (this.regs[(REG.PIN0 >>> 2) + g] >>> 7) & 7;
      const level = this.seenIn[g];
      if ((type === 4 && level === 0) || (type === 5 && level === 1)) {
        if (g < 32) this.regs[REG.STATUS >>> 2] |= 1 << g;
        else this.regs[REG.STATUS1 >>> 2] |= 1 << (g - 32);
      }
    }
  }

  /** STATUS word `word` masked by the pins' INT_ENA bit `ena`. */
  private masked(word: number, ena: number): number {
    const status = this.regs[(word === 0 ? REG.STATUS : REG.STATUS1) >>> 2];
    let v = 0;
    for (let i = 0; i < 32; i++) {
      const g = word * 32 + i;
      if (g >= PIN_REGS) break;
      if (((status >>> i) & 1) !== 0 && (this.regs[(REG.PIN0 >>> 2) + g] & ena) !== 0) v |= 1 << i;
    }
    return v >>> 0;
  }

  private updateInterrupts(): void {
    const cpu = this.masked(0, ENA_CPU) !== 0 || this.masked(1, ENA_CPU) !== 0 ? 1 : 0;
    const nmi = this.masked(0, ENA_CPU_NMI) !== 0 || this.masked(1, ENA_CPU_NMI) !== 0 ? 1 : 0;
    if (cpu !== this.sources[0]) {
      this.sources[0] = cpu;
      this.ctx.matrix.setSource(S3_SRC.GPIO, cpu === 1);
    }
    if (nmi !== this.sources[1]) {
      this.sources[1] = nmi;
      this.ctx.matrix.setSource(S3_SRC.GPIO_NMI, nmi === 1);
    }
  }

  /** BT128: a light sleep's GPIO wake — a pin with WAKEUP_ENABLE (PINn bit 10) at its level type (INT_TYPE 4 low, 5 high). */
  wakeLevel(): boolean {
    for (let g = 0; g < S3_PADS; g++) {
      const pin = this.regs[(REG.PIN0 >>> 2) + g];
      if ((pin & (1 << 10)) === 0) continue;
      const type = (pin >>> 7) & 7;
      if ((type === 4 && this.padIn[g] === 0) || (type === 5 && this.padIn[g] === 1)) return true;
    }
    return false;
  }

  implements(offset: number): boolean {
    if (offset >= REG.OUT && offset <= REG.STATUS1 + 8) return offset !== 0x1c; // SDIO_SELECT
    if (offset >= REG.PCPU_INT && offset <= REG.CPUSDIO_INT1) return true;
    if (offset >= REG.PIN0 && offset < REG.PIN0 + PIN_REGS * 4) return true;
    if (offset === REG.STATUS_NEXT || offset === REG.STATUS_NEXT1) return true;
    if (offset >= REG.FUNC_IN_SEL && offset < REG.FUNC_IN_SEL + SIGNALS * 4) return true;
    return (offset >= REG.FUNC_OUT_SEL && offset < REG.FUNC_OUT_SEL + PIN_REGS * 4) || offset === REG.DATE;
  }

  read32(offset: number): number {
    switch (offset) {
      case REG.IN:
      case REG.IN1: {
        const word = offset === REG.IN ? 0 : 1;
        if (this.onFloatingRead !== null) {
          for (let g = word * 32; g < Math.min(S3_PADS, word * 32 + 32); g++) if (this.floating[g] !== 0 && this.iomux.inputEnabled(g)) this.onFloatingRead(g);
        }
        return this.inWord(word);
      }
      case REG.PCPU_INT:
        return this.masked(0, ENA_CPU);
      case REG.PCPU_NMI_INT:
        return this.masked(0, ENA_CPU_NMI);
      case REG.PCPU_INT1:
        return this.masked(1, ENA_CPU);
      case REG.PCPU_NMI_INT1:
        return this.masked(1, ENA_CPU_NMI);
      case REG.STATUS_NEXT:
        return this.regs[REG.STATUS >>> 2];
      case REG.STATUS_NEXT1:
        return this.regs[REG.STATUS1 >>> 2];
      default:
        return this.regs[offset >>> 2];
    }
  }

  write32(offset: number, value: number): void {
    // OUT/OUT1/ENABLE/ENABLE1 and their W1TS/W1TC aliases.
    for (const [base, word, mask] of WORDS) {
      if (offset < base || offset > base + 8) continue;
      const current = this.regs[base >>> 2];
      const next = offset === base ? value : offset === base + 4 ? current | value : current & ~value;
      this.set(word, base, (next & mask) >>> 0);
      return;
    }
    switch (offset) {
      case REG.STATUS:
      case REG.STATUS1:
        this.regs[offset >>> 2] = value >>> 0;
        break;
      case REG.STATUS + 4:
      case REG.STATUS1 + 4:
        this.regs[(offset - 4) >>> 2] |= value;
        break;
      case REG.STATUS + 8:
      case REG.STATUS1 + 8:
        this.regs[(offset - 8) >>> 2] &= ~value;
        this.reassertLevels();
        break;
      case REG.IN:
      case REG.IN1:
      case REG.PCPU_INT:
      case REG.PCPU_NMI_INT:
      case REG.CPUSDIO_INT:
      case REG.PCPU_INT1:
      case REG.PCPU_NMI_INT1:
      case REG.CPUSDIO_INT1:
      case REG.STATUS_NEXT:
      case REG.STATUS_NEXT1:
      case REG.DATE:
        return;
      default:
        this.regs[offset >>> 2] = value;
        if (offset >= REG.PIN0 && offset < REG.PIN0 + PIN_REGS * 4) {
          this.reassertLevels();
          this.updateInterrupts();
          this.onConfig?.();
        } else if (offset >= REG.FUNC_OUT_SEL && offset < REG.FUNC_OUT_SEL + PIN_REGS * 4) this.onConfig?.();
        return;
    }
    this.updateInterrupts();
  }

  private set(word: number, offset: number, value: number): void {
    if (this.regs[offset >>> 2] === value) return;
    this.regs[offset >>> 2] = value;
    this.onOutput?.(word, value, this.ctx.now());
    this.onConfig?.();
  }
}

/** [register, word number, the pads it holds]. */
const WORDS: readonly [number, number, number][] = [
  [REG.OUT, 0, 0xffffffff],
  [REG.OUT1, 1, 0x1ffff], // GPIO32–48
  [REG.ENABLE, 2, 0xffffffff],
  [REG.ENABLE1, 3, 0x1ffff],
];

export class S3Pads {
  readonly mode = new Uint8Array(S3_PADS);
  readonly level = new Uint8Array(S3_PADS);
  /** ADC pads a conversion used (by GPIO): with input and pulls off they read as analog. */
  readonly adcUsed = new Uint8Array(S3_PADS);
  onPin: ((gpio: number) => void) | null = null;
  private readonly gpio: S3Gpio;
  private readonly iomux: S3IoMux;
  /** The level of a peripheral output signal. */
  signalLevel: (signal: number) => number = (s) => (S3_IDLE_HIGH_SIGNALS.has(s) ? 1 : 0);
  /** BT128: −1 when a pad isn't routed to the RTC (RTC_IO's MUX_SEL), else its RTC pulls (0 none, 1 up, 2 down). */
  rtcPad: (g: number) => number = () => -1;

  constructor(gpio: S3Gpio, iomux: S3IoMux) {
    this.gpio = gpio;
    this.iomux = iomux;
    for (let g = 0; g < S3_PADS; g++) this.resolve(g);
  }

  /** The GPIO that drives peripheral output `signal` (matrix or IO_MUX), or −1. */
  pinOfOutSignal(signal: number): number {
    for (let g = 0; g < S3_PADS; g++) {
      if (!isS3Pad(g)) continue;
      if (this.iomux.isGpio(g) ? (this.gpio.outConfig(g) & 0x1ff) === signal : DIRECT_OUT.get((g << 3) | this.iomux.func(g)) === signal) return g;
    }
    return -1;
  }

  /** The GPIO that feeds peripheral input `signal` (matrix or IO_MUX), or −1. */
  pinOfInSignal(signal: number): number {
    const routed = this.gpio.inRoute(signal);
    if (routed >= 0) return routed;
    for (let g = 0; g < S3_PADS; g++) if (isS3Pad(g) && DIRECT_IN.get((g << 3) | this.iomux.func(g)) === signal) return g;
    return -1;
  }

  /** The level peripheral input `signal` sees: through the matrix, or an IO_MUX pad, else idle. */
  inputSignal(signal: number, idle: number): number {
    let direct = idle;
    for (let g = 0; g < S3_PADS; g++) {
      if (isS3Pad(g) && DIRECT_IN.get((g << 3) | this.iomux.func(g)) === signal) {
        direct = this.gpio.padLevel(g);
        break;
      }
    }
    return this.gpio.inputSignal(signal, direct);
  }

  /** Recomputes every pad; reports the pins that changed. */
  update(): void {
    for (let g = 0; g < S3_PADS; g++) {
      if (!isS3Pad(g)) continue;
      const mode = this.mode[g];
      const level = this.level[g];
      this.resolve(g);
      if (this.mode[g] !== mode || this.level[g] !== level) this.onPin?.(g);
    }
  }

  private resolve(g: number): void {
    const rtc = this.rtcPad(g);
    if (rtc >= 0) {
      // BT128: an RTC pad (rtc_gpio_init — a deep sleep's ext0/ext1 pin, or an ADC pad, which IDF's
      // adc_gpio_init routes there with no pulls): an input with the RTC's pulls, or analog.
      this.level[g] = 0;
      this.mode[g] = rtc === 1 ? S3_PAD_MODE.PULLUP : rtc === 2 ? S3_PAD_MODE.PULLDOWN : this.adcUsed[g] !== 0 ? S3_PAD_MODE.ANALOG : S3_PAD_MODE.INPUT;
      return;
    }
    let enabled = false;
    let level = 0;
    let gpioOut = false;
    if (this.iomux.isGpio(g)) {
      const cfg = this.gpio.outConfig(g);
      const signal = cfg & 0x1ff;
      if (signal === S3_SIG_GPIO_OUT) {
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
    if (enabled && this.gpio.openDrain(g) && level === 1) enabled = false;
    if (enabled) {
      this.mode[g] = gpioOut ? S3_PAD_MODE.OUTPUT : S3_PAD_MODE.PERIPHERAL;
      this.level[g] = level;
      return;
    }
    this.level[g] = 0;
    const pad = this.iomux.pad(g);
    if ((pad & MUX.FUN_WPU) !== 0) this.mode[g] = S3_PAD_MODE.PULLUP;
    else if ((pad & MUX.FUN_WPD) !== 0) this.mode[g] = S3_PAD_MODE.PULLDOWN;
    else if (this.adcUsed[g] !== 0 && (pad & MUX.FUN_IE) === 0) this.mode[g] = S3_PAD_MODE.ANALOG;
    else this.mode[g] = S3_PAD_MODE.INPUT;
  }
}
