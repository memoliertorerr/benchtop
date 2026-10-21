/**
 * SPI0/SPI1 (BT66), Arm PL022 in master mode (RP2350 datasheet §12.3): SSPCR0 (DSS: 4–16-bit
 * frames), SSPCR1 (SSE), SSPDR, SSPSR, SSPCPSR, SSPIMSC/RIS/MIS/ICR, SSPDMACR and the ID
 * registers. A frame written to SSPDR goes to the bench at once (`onTransmit`, which the
 * SpiBridge answers synchronously through `completeTransmit`) and its reply waits in the 8-entry
 * RX FIFO; so TX is always empty and never busy (transfers take no simulated time here). RX
 * interrupts: RXIM at four or more entries, RTIM while anything waits; TXIM is always asserted
 * (the TX FIFO is empty); RORIM on an RX overrun.
 */

import type { SpiPeripheral } from '@benchtop/rp2040';
import { applyAlias, Periph, type PeriphHost } from './block.ts';

const RX_DEPTH = 8;
const RIS_ROR = 1;
const RIS_RT = 2;
const RIS_RX = 4;
const RIS_TX = 8;

export class Pl022 extends Periph implements SpiPeripheral {
  onTransmit: (value: number) => void = () => this.completeTransmit(0xffff);
  private readonly irq: number;
  private readonly rx: number[] = [];
  private overrun = false;

  constructor(name: string, base: number, host: PeriphHost, irq: number) {
    super(name, base, host);
    this.irq = irq;
  }

  override reset(): void {
    super.reset();
    this.rx.length = 0;
    this.overrun = false;
    this.update();
  }

  get dataBits(): number {
    return (this.regs[0] & 0xf) + 1;
  }

  private get enabled(): boolean {
    return (this.regs[1] & 2) !== 0;
  }

  completeTransmit(rx: number): void {
    if (this.rx.length >= RX_DEPTH) this.overrun = true;
    else this.rx.push(rx & ((1 << this.dataBits) - 1));
    this.update();
  }

  private ris(): number {
    return (this.overrun ? RIS_ROR : 0) | (this.rx.length > 0 ? RIS_RT : 0) | (this.rx.length >= 4 ? RIS_RX : 0) | RIS_TX;
  }

  private update(): void {
    this.host.setIrq(this.irq, (this.ris() & this.regs[0x14 >>> 2]) !== 0);
  }

  override read(offset: number): number {
    switch (offset) {
      case 0x08: {
        const value = this.rx.shift() ?? 0;
        this.update();
        return value;
      }
      case 0x0c: // SSPSR: TFE, TNF, RNE, RFF; never BSY
        return 0x3 | (this.rx.length > 0 ? 0x4 : 0) | (this.rx.length >= RX_DEPTH ? 0x8 : 0);
      case 0x18:
        return this.ris();
      case 0x1c:
        return this.ris() & this.regs[0x14 >>> 2];
      case 0x00:
      case 0x04:
      case 0x10:
      case 0x14:
      case 0x24:
        return this.regs[offset >>> 2];
      default:
        if (offset >= 0xfe0) return [0x22, 0x10, 0x34, 0x00, 0x0d, 0xf0, 0x05, 0xb1][(offset - 0xfe0) >>> 2] ?? 0;
        return this.readStored(offset);
    }
  }

  override write(offset: number, value: number, alias: number): void {
    switch (offset) {
      case 0x08:
        if (this.enabled) this.onTransmit(applyAlias(0, value, alias) & ((1 << this.dataBits) - 1));
        return;
      case 0x20: // SSPICR: clears ROR and RT
        if ((applyAlias(0, value, alias) & 1) !== 0) this.overrun = false;
        this.update();
        return;
      case 0x00:
      case 0x04:
      case 0x10:
      case 0x14:
      case 0x24:
        this.store(offset, value, alias);
        this.update();
        return;
      default:
        this.writeStored(offset, value, alias);
    }
  }
}
