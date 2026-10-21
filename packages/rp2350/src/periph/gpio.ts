/**
 * IO_BANK0 and PADS_BANK0 (BT65; RP2350 datasheet §9): what drives each GPIO and how its pad is set.
 *
 * IO_BANK0: GPIOn_CTRL (FUNCSEL, OUTOVER, OEOVER, INOVER) and GPIOn_STATUS for GPIO 0–47; INTR0–5
 * (four bits a GPIO: level low, level high, edge low, edge high — edges latch until written 1,
 * levels follow the input), PROCn_INTE/INTF/INTS and the dormant-wake set; core n's IO_IRQ_BANK0
 * (IRQ 21) is its INTS ≠ 0. PADS_BANK0: per GPIO ISO, OD, IE, DRIVE, PUE, PDE, SCHMITT, SLEWFAST
 * (reset 0x116: isolated, input disabled, pull-down).
 *
 * `drive(n)` resolves a pin: FUNCSEL 5 (SIO) takes the SIO's out/oe bits; a UART function (2,
 * or 11 for the aux pins) drives its TX pin idle high as a peripheral; PWM, PIO and SPI ask the
 * SoC's `peripheralDrive` (BT66); I2C pins are open drain — released here, the bus travels at
 * byte level —; NULL (31) drives nothing. OUTOVER/OEOVER apply on top, pad OD forces the output
 * off, ISO keeps the pad as it was isolated — here: not driven.
 */

import { applyAlias, Periph, type PeriphHost } from './block.ts';

export const GPIO_COUNT = 48;
export const FUNC_SPI = 1;
export const FUNC_UART = 2;
export const FUNC_I2C = 3;
export const FUNC_PWM = 4;
export const FUNC_SIO = 5;
export const FUNC_PIO0 = 6;
export const FUNC_UART_AUX = 11;
export const FUNC_NULL = 0x1f;

export const PAD_ISO = 0x100;
export const PAD_OD = 0x80;
export const PAD_IE = 0x40;
export const PAD_PUE = 0x8;
export const PAD_PDE = 0x4;

/** What drives a pin: `kind` 0 nothing, 1 SIO output, 2 a peripheral. */
export interface PinDrive {
  kind: number;
  level: number;
}

export class PadsBank0 extends Periph {
  /** A pad's register changed (pulls, input enable, isolation). */
  onChange: (() => void) | null = null;

  override read(offset: number): number {
    if (offset <= 4 * GPIO_COUNT + 8) return this.regs[offset >>> 2];
    return this.readStored(offset);
  }

  override write(offset: number, value: number, alias: number): void {
    if (offset <= 4 * GPIO_COUNT + 8) {
      this.store(offset, value, alias);
      this.onChange?.();
    } else this.writeStored(offset, value, alias);
  }

  pad(n: number): number {
    return this.regs[1 + n];
  }
}

/**
 * IO_QSPI (BT67; datasheet §9.11.2): the QSPI pins' STATUS registers. SS's reports what reaches
 * its pad — OUTTOPAD is the flash's chip select, high while QMI isn't talking to it (pico-sdk's
 * flash code waits for that before it changes QMI's timing) —, with CTRL's OUTOVER and OEOVER
 * applied; a released pad reads its pull-up. The other pins' STATUS reads 0; everything else
 * keeps what is written.
 */
export class IoQspi extends Periph {
  private readonly chipSelected: () => boolean;

  constructor(name: string, base: number, host: PeriphHost, chipSelected: () => boolean) {
    super(name, base, host);
    this.quiet = true;
    this.chipSelected = chipSelected;
  }

  override read(offset: number): number {
    if (offset === 0x18) {
      // GPIO_QSPI_SS_STATUS: OUTTOPAD 9, OETOPAD 13, INFROMPAD 17
      const ctrl = this.regs[0x1c >>> 2];
      let out = this.chipSelected() ? 0 : 1;
      let oe = 1;
      const outover = (ctrl >>> 12) & 3;
      const oeover = (ctrl >>> 14) & 3;
      if (outover === 1) out ^= 1;
      else if (outover >= 2) out = outover - 2;
      if (oeover === 1) oe ^= 1;
      else if (oeover >= 2) oe = oeover - 2;
      const input = oe !== 0 ? out : 1;
      return (out << 9) | (oe << 13) | (input << 17);
    }
    if (offset >= 0x10 && offset < 0x40 && (offset & 4) === 0) return 0;
    return super.read(offset);
  }
}

export class IoBank0 extends Periph {
  /** Input levels the bench drives (bits for GPIO 0–31, 32–47). */
  readonly inputs = new Uint32Array(2);
  /** Latched edge bits, INTR0–5 layout. */
  private readonly edges = new Uint32Array(6);
  /** A GPIO's function or overrides changed. */
  onChange: (() => void) | null = null;
  /** Core n's IO_IRQ_BANK0 line. */
  private readonly setCoreIrq: (hart: number, level: boolean) => void;

  constructor(name: string, base: number, host: PeriphHost, setCoreIrq: (hart: number, level: boolean) => void) {
    super(name, base, host);
    this.setCoreIrq = setCoreIrq;
  }

  override reset(): void {
    super.reset();
    this.edges.fill(0);
    this.updateIrqs();
  }

  ctrl(n: number): number {
    return this.regs[(8 * n + 4) >>> 2];
  }

  funcsel(n: number): number {
    return this.ctrl(n) & 0x1f;
  }

  input(n: number): number {
    return (this.inputs[n >>> 5] >>> (n & 31)) & 1;
  }

  /** The bench changed an input: latch edges, refresh levels. */
  setInput(n: number, level: number): void {
    const word = n >>> 5;
    const bit = 1 << (n & 31);
    const before = (this.inputs[word] & bit) !== 0 ? 1 : 0;
    this.inputs[word] = level !== 0 ? this.inputs[word] | bit : this.inputs[word] & ~bit;
    if (before !== level) {
      const shift = 4 * (n & 7);
      this.edges[n >>> 3] |= (level !== 0 ? 8 : 4) << shift; // EDGE_HIGH : EDGE_LOW
      this.updateIrqs();
    }
  }

  /** INTRn: latched edges plus the live levels. */
  private intr(i: number): number {
    let value = this.edges[i];
    for (let g = 0; g < 8; g++) {
      const n = 8 * i + g;
      if (n >= GPIO_COUNT) break;
      value |= (this.input(n) !== 0 ? 2 : 1) << (4 * g);
    }
    return value >>> 0;
  }

  private ints(proc: number, i: number): number {
    const inte = this.regs[(0x248 + 0x48 * proc + 4 * i) >>> 2];
    const intf = this.regs[(0x260 + 0x48 * proc + 4 * i) >>> 2];
    return ((this.intr(i) | intf) & inte) >>> 0;
  }

  updateIrqs(): void {
    for (let proc = 0; proc < 2; proc++) {
      let any = false;
      for (let i = 0; i < 6 && !any; i++) any = this.ints(proc, i) !== 0;
      this.setCoreIrq(proc, any);
    }
  }

  override read(offset: number): number {
    if (offset < 8 * GPIO_COUNT) {
      if ((offset & 4) === 0) {
        // GPIOn_STATUS: OUTTOPAD 9, OETOPAD 13, INFROMPAD 17, IRQTOPROC 26 (not computed)
        const n = offset >>> 3;
        return this.input(n) << 17;
      }
      return this.regs[offset >>> 2];
    }
    if (offset >= 0x230 && offset < 0x248) return this.intr((offset - 0x230) >>> 2);
    if (offset >= 0x278 && offset < 0x290) return this.ints(0, (offset - 0x278) >>> 2);
    if (offset >= 0x2c0 && offset < 0x2d8) return this.ints(1, (offset - 0x2c0) >>> 2);
    if (offset >= 0x248 && offset < 0x320) return this.regs[offset >>> 2];
    return this.readStored(offset);
  }

  override write(offset: number, value: number, alias: number): void {
    if (offset < 8 * GPIO_COUNT) {
      if ((offset & 4) !== 0) {
        this.store(offset, value, alias);
        this.onChange?.();
      }
      return;
    }
    if (offset >= 0x230 && offset < 0x248) {
      // INTR: write 1 clears an edge bit
      const i = (offset - 0x230) >>> 2;
      this.edges[i] &= ~(applyAlias(0, value, alias) & 0xcccccccc);
      this.updateIrqs();
      return;
    }
    if (offset >= 0x248 && offset < 0x320) {
      this.store(offset, value, alias);
      this.updateIrqs();
      return;
    }
    this.writeStored(offset, value, alias);
  }

  /** BT66: a peripheral function's output on GPIO `n` (PWM, PIO, SPI): fills `out.level` and returns its output enable. */
  peripheralDrive: ((n: number, funcsel: number, out: PinDrive) => number) | null = null;

  /** What drives GPIO `n`, given the SIO's out/oe bits for it. */
  drive(n: number, sioOut: number, sioOe: number, pad: number, out: PinDrive): void {
    const ctrl = this.ctrl(n);
    const f = ctrl & 0x1f;
    let level = 0;
    let oe = 0;
    let kind = 0;
    if (f === FUNC_SIO) {
      level = sioOut;
      oe = sioOe;
      kind = 1;
    } else if ((f === FUNC_UART && (n & 3) === 0) || (f === FUNC_UART_AUX && (n & 3) === 2)) {
      level = 1; // a UART TX pin idles high; bytes travel at byte level
      oe = 1;
      kind = 2;
    } else if (f !== FUNC_NULL && f !== FUNC_I2C && this.peripheralDrive !== null) {
      out.level = 0;
      oe = this.peripheralDrive(n, f, out);
      level = out.level;
      kind = 2;
    }
    const outover = (ctrl >>> 12) & 3;
    const oeover = (ctrl >>> 14) & 3;
    if (outover === 1) level ^= 1;
    else if (outover >= 2) level = outover - 2;
    if (oeover === 1) oe ^= 1;
    else if (oeover >= 2) oe = oeover - 2;
    if ((pad & (PAD_OD | PAD_ISO)) !== 0) oe = 0;
    out.kind = oe !== 0 ? kind || 2 : 0;
    out.level = level;
  }
}
