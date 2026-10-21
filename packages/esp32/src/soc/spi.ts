/**
 * SPI2 (HSPI, 0x3FF64000) and SPI3 (VSPI, 0x3FF65000) as masters (spi_reg.h, esp32-hal-spi.c,
 * TRM v5.8 "SPI") — BT36. Transaction level: attached devices (the bench's SpiDevices) get one
 * transfer(mosi) → miso call per byte while selected, never SCK/MOSI edges.
 *
 * Setting CMD USR (bit 18) runs a user transaction: optional command (USER bit 31, USER2
 * COMMAND_BITLEN 31:28 + 1 bits), address (bit 30, USER1 ADDR_BITLEN 31:26 + 1) and dummy (bit
 * 29, USER1 DUMMY_CYCLELEN 7:0 + 1) phases add their bits to the time but carry no data for the
 * devices; the data phase is MOSI_DLEN + 1 bits out of W0… (USER bit 27) and MISO_DLEN + 1 bits
 * into W0… (bit 28) — full duplex (DOUTDIN, bit 0) uses one length for both, as Arduino's
 * spiTransferByte does. Each byte (W0 byte 0 first) goes to every attached device whose
 * `selected()` is true, in attach order; the MISO byte of the last one wins, 0xFF with none.
 * CTRL WR_BIT_ORDER (26) / RD_BIT_ORDER (25) send / receive LSB first: the device sees the byte as
 * it travels on the wire (bit-reversed). Clock modes (PIN CK_IDLE_EDGE 29, USER CK_OUT_EDGE 7)
 * only decide edges, which aren't modeled. The bits take bits / f_sck of simulated time, f_sck =
 * APB / ((CLKDIV_PRE + 1)(CLKCNT_N + 1)) or APB with CLK_EQU_SYSCLK (CLOCK bit 31); USR reads 1
 * until then (esp32-hal-spi busy-waits on it). The CS0 signal (HSPICS0 11 / VSPICS0 68) is low
 * during the transaction, else high.
 *
 * Slave mode (SLAVE bit 30), DMA (DMA_CONF / OUTLINK) and the flash-style native commands on
 * SPI2/3 report `esp32-spi-unsupported-mode` and do nothing.
 */

import type { SpiDevice } from '@benchtop/core';
import type { SocContext } from './context.ts';
import { REF_HZ } from './context.ts';
import { RegisterFile } from './periph.ts';

export const SPI_BASES = { 2: 0x3ff64000, 3: 0x3ff65000 } as const;
export const CODE_SPI_UNSUPPORTED = 'esp32-spi-unsupported-mode';
const CMD = 0x00;
const CTRL = 0x08;
const CLOCK = 0x18;
const USER = 0x1c;
const USER1 = 0x20;
const USER2 = 0x24;
const MOSI_DLEN = 0x28;
const MISO_DLEN = 0x2c;
const SLAVE = 0x38;
const W0 = 0x80;
const USR = 1 << 18;
/** Native (flash) command bits SPI1 has: on SPI2/3 they mean misuse. */
const NATIVE = 0xffc00000 >>> 0;

/** An attached device and how to tell whether its CS is asserted. */
export interface SpiAttachment {
  device: SpiDevice;
  selected: () => boolean;
}

const reverse8 = (b: number): number => {
  let r = 0;
  for (let i = 0; i < 8; i++) r |= ((b >>> i) & 1) << (7 - i);
  return r;
};

export class Spi extends RegisterFile {
  readonly host: 2 | 3;
  /** The bus's devices (the Mcu adapter keeps the list across resets). */
  devices: readonly SpiAttachment[] = [];
  /** CS0 output level: low during a transaction. */
  cs0 = 1;
  /** CS0 changed (the pad resolver recomputes). */
  onCs: (() => void) | null = null;
  /** Bytes moved (reports, tests). */
  bytes = 0;
  /** Each transaction as USR clears: its start, end (reference cycles) and bits. */
  onTransaction: ((start: number, end: number, bits: number) => void) | null = null;
  private start = 0;
  private bits = 0;
  private readonly context: SocContext;
  private readonly slot: number;
  private readonly buffer = new Uint8Array(64);

  constructor(context: SocContext, host: 2 | 3) {
    super(SPI_BASES[host]);
    this.host = host;
    this.context = context;
    this.slot = context.events.add(() => this.finish());
  }

  implements(offset: number): boolean {
    return offset <= 0x3c || (offset >= W0 && offset < W0 + 64) || offset === 0xfc || offset === 0x100;
  }

  override systemReset(_rtcDomain: boolean): void {
    this.reset();
    this.context.events.cancel(this.slot);
    this.setCs(1);
  }

  /** Data-phase SCK frequency in Hz. */
  sckHz(): number {
    const clock = this.regs[CLOCK >>> 2];
    if ((clock >>> 31) !== 0) return this.context.apbHz;
    const pre = (clock >>> 18) & 0x1fff;
    const n = (clock >>> 12) & 0x3f;
    return this.context.apbHz / ((pre + 1) * (n + 1));
  }

  override write32(offset: number, value: number): void {
    if (offset !== CMD) {
      super.write32(offset, value);
      return;
    }
    if ((value & NATIVE) !== 0 || (this.regs[SLAVE >>> 2] & (1 << 30)) !== 0) {
      this.context.problems.report('warning', CODE_SPI_UNSUPPORTED, SPI_BASES[this.host], `SPI${this.host}: slave mode, DMA and flash commands aren't emulated; the transaction did nothing.`);
      return;
    }
    if ((value & USR) === 0 || (this.regs[CMD >>> 2] & USR) !== 0) {
      super.write32(offset, value & ~USR);
      return;
    }
    super.write32(offset, value);
    this.transfer();
  }

  private transfer(): void {
    const user = this.regs[USER >>> 2];
    const mosiOn = (user & (1 << 27)) !== 0;
    const misoOn = (user & (1 << 28)) !== 0;
    const doutdin = (user & 1) !== 0;
    const mosiBits = mosiOn ? (this.regs[MOSI_DLEN >>> 2] & 0xffffff) + 1 : 0;
    const misoBits = misoOn ? (this.regs[MISO_DLEN >>> 2] & 0xffffff) + 1 : 0;
    const dataBits = doutdin ? Math.max(mosiBits, misoBits) : mosiBits + misoBits;
    let bits = dataBits;
    if ((user >>> 31) !== 0) bits += ((this.regs[USER2 >>> 2] >>> 28) & 0xf) + 1;
    if ((user & (1 << 30)) !== 0) bits += ((this.regs[USER1 >>> 2] >>> 26) & 0x3f) + 1;
    if ((user & (1 << 29)) !== 0) bits += (this.regs[USER1 >>> 2] & 0xff) + 1;
    const ctrl = this.regs[CTRL >>> 2];
    const lsbOut = (ctrl & (1 << 26)) !== 0;
    const lsbIn = (ctrl & (1 << 25)) !== 0;
    // The data phase, byte by byte, to the selected devices.
    const outBytes = Math.min(64, Math.ceil(mosiBits / 8));
    const inBytes = Math.min(64, Math.ceil(misoBits / 8));
    const count = doutdin ? Math.max(outBytes, inBytes) : outBytes + inBytes;
    for (let i = 0; i < 64; i++) this.buffer[i] = (this.regs[(W0 >>> 2) + (i >>> 2)] >>> ((i & 3) * 8)) & 0xff;
    this.setCs(0);
    for (let i = 0; i < count && i < 64; i++) {
      const out = mosiOn && (doutdin || i < outBytes) ? this.buffer[i] : 0xff;
      const wire = lsbOut ? reverse8(out) : out;
      let miso = 0xff;
      for (let d = 0; d < this.devices.length; d++) if (this.devices[d].selected()) miso = this.devices[d].device.transfer(wire) & 0xff;
      this.bytes++;
      const received = lsbIn ? reverse8(miso) : miso;
      // MISO lands where the MISO phase writes: from W0 in full duplex, after the MOSI bytes otherwise.
      if (misoOn) {
        const at = doutdin ? i : i - outBytes;
        if (at >= 0 && at < 64) this.buffer[at] = received;
      }
    }
    if (misoOn) {
      for (let w = 0; w < 16; w++) {
        this.regs[(W0 >>> 2) + w] = (this.buffer[w * 4] | (this.buffer[w * 4 + 1] << 8) | (this.buffer[w * 4 + 2] << 16) | (this.buffer[w * 4 + 3] << 24)) >>> 0;
      }
    }
    this.start = this.context.now();
    this.bits = bits;
    this.context.events.schedule(this.slot, this.start + (bits / this.sckHz()) * REF_HZ);
  }

  private finish(): void {
    this.regs[CMD >>> 2] &= ~USR;
    this.setCs(1);
    this.onTransaction?.(this.start, this.context.now(), this.bits);
  }

  private setCs(level: number): void {
    if (this.cs0 === level) return;
    this.cs0 = level;
    this.onCs?.();
  }
}
