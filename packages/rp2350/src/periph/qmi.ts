/**
 * QMI (BT65; RP2350 datasheet §12.14), the QSPI memory interface: XIP reads of the flash come
 * straight from the flash array (the read format in M0_RFMT/RCMD doesn't change what is read, so
 * M0/M1 and ATRANS only keep what is written), and the direct mode — DIRECT_CSR, DIRECT_TX,
 * DIRECT_RX — reaches the flash chip (flash-chip.ts) on chip select 0. Pushes queue in the TX
 * FIFO; while EN is set they shift out at once (BUSY never reads 1), each reply byte (or 16-bit
 * pair with DWIDTH, low byte first both ways) queued for DIRECT_RX unless NOPUSH — so software may push first and enable
 * after, as the bootrom does (it toggles EN and ASSERT_CS0N together through the XOR alias). CS0
 * is asserted while ASSERT_CS0N is set, or — AUTO_CS0N — for the run of pushes that follow until
 * DIRECT_CSR is next written. CS1 (PSRAM) has no device: bytes shifted with no chip selected
 * read back 0xff.
 */

import { applyAlias, Periph, type PeriphHost } from './block.ts';
import type { FlashChip } from './flash-chip.ts';

const CSR_EN = 1;
const CSR_ASSERT_CS0N = 1 << 2;
const CSR_AUTO_CS0N = 1 << 6;
const CSR_TXEMPTY = 1 << 11;
const CSR_RXEMPTY = 1 << 16;
const CSR_RXFULL = 1 << 17;
const RX_DEPTH = 4;

export class Qmi extends Periph {
  private readonly chip: FlashChip;
  private readonly rx: number[] = [];
  private readonly tx: number[] = [];
  /** An AUTO_CS0N burst is in progress. */
  private autoSelected = false;

  constructor(name: string, base: number, host: PeriphHost, chip: FlashChip) {
    super(name, base, host);
    this.quiet = true;
    this.chip = chip;
  }

  override reset(): void {
    super.reset();
    this.rx.length = 0;
    this.tx.length = 0;
    this.autoSelected = false;
    this.chip.reset();
  }

  override read(offset: number): number {
    if (offset === 0x00) {
      const csr = this.regs[0];
      const level = Math.min(RX_DEPTH, this.rx.length);
      const txLevel = Math.min(RX_DEPTH, this.tx.length);
      return (
        ((csr & ~(0x1c0000 | CSR_RXEMPTY | CSR_RXFULL | 0x7000 | CSR_TXEMPTY | 0x400 | 2)) |
          (this.tx.length === 0 ? CSR_TXEMPTY : 0) |
          (this.tx.length >= RX_DEPTH ? 0x400 : 0) |
          (txLevel << 12) |
          (this.rx.length === 0 ? CSR_RXEMPTY : 0) |
          (this.rx.length >= RX_DEPTH ? CSR_RXFULL : 0) |
          (level << 18)) >>>
        0
      );
    }
    if (offset === 0x08) return this.rx.shift() ?? 0;
    return this.regs[offset >>> 2];
  }

  override write(offset: number, value: number, alias: number): void {
    if (offset === 0x00) {
      const csr = this.store(0, value, alias);
      if (this.autoSelected) {
        this.autoSelected = false;
        if ((csr & CSR_ASSERT_CS0N) === 0) this.chip.deselect();
      }
      if ((csr & CSR_EN) !== 0 && (csr & CSR_ASSERT_CS0N) !== 0) this.chip.select();
      else this.chip.deselect();
      this.shift();
      return;
    }
    if (offset === 0x04) {
      this.tx.push(applyAlias(0, value, alias));
      this.shift();
      return;
    }
    if (offset === 0x08) return;
    this.store(offset, value, alias);
  }

  /** Shifts the queued TX entries out while direct mode is enabled. */
  private shift(): void {
    const csr = this.regs[0];
    if ((csr & CSR_EN) === 0) return;
    while (this.tx.length > 0) {
      const tx = this.tx.shift() as number;
      if ((csr & CSR_ASSERT_CS0N) === 0 && (csr & CSR_AUTO_CS0N) !== 0 && !this.autoSelected) {
        this.autoSelected = true;
        this.chip.select();
      }
      // A 16-bit entry (DWIDTH) shifts its low byte first: the bootrom pushes 0x3f20 for 20 3F.
      let reply = this.chip.exchange(tx & 0xff);
      if ((tx & (1 << 18)) !== 0) reply |= this.chip.exchange((tx >>> 8) & 0xff) << 8;
      if ((tx & (1 << 20)) === 0) this.rx.push(reply);
    }
  }
}
