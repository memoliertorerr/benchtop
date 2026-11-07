/**
 * The ESP32-C3's general-purpose SPI2 (FSPI) as a master (BT93; spi_reg.h, core 2.0.17's
 * esp32-hal-spi.c, TRM §27), at 0x60024000 — transaction level, as the ESP32's SPI2/3
 * (@benchtop/esp32's spi.ts): attached devices (the bench's SpiDevices) get one transfer(mosi) →
 * miso call per byte while selected, never SCK/MOSI edges.
 *
 * What differs from the ESP32: CMD.USR is bit 24 and CMD.UPDATE (23) — "apply the configuration",
 * which esp32-hal-spi sets and polls before every USR — reads back 0 at once; one data length,
 * MS_DLEN (0x1C, bits 17:0, + 1 bits), serves the MOSI and the MISO phase; W0–W15 sit at 0x98
 * (USER's MOSI_HIGHPART 25 / MISO_HIGHPART 24 use W8–W15); USER1's ADDR_BITLEN is 31:27; CLOCK
 * (0x0C) divides APB by (CLKDIV_PRE 21:18 + 1)(CLKCNT_N 17:12 + 1) unless CLK_EQU_SYSCLK (31).
 * The phases (command, address, dummy, data) add their bits to the transaction's time — bits /
 * f_sck, USR reading 1 until then; the data phase is full duplex with DOUTDIN (USER bit 0), else
 * MOSI bytes then MISO bytes. CTRL's WR_BIT_ORDER (26) / RD_BIT_ORDER (25) send / receive LSB
 * first: the device sees the byte as it travels (bit-reversed). The CS0 signal (FSPICS0, 68) is
 * low during a transaction unless MISC.CS0_DIS (0). Slave mode (SLAVE.MODE, bit 26) and DMA
 * (DMA_CONF's TX/RX enables, 28/27) report `esp32c3-spi-unsupported-mode` and do nothing.
 */

import type { SpiDevice } from '@benchtop/core';
import type { SocContext } from './context.ts';
import { RegisterFile } from './periph.ts';

export const SPI2_BASE = 0x60024000;
export const CODE_SPI_UNSUPPORTED = 'esp32c3-spi-unsupported-mode';
const CMD = 0x00;
const CTRL = 0x08;
const CLOCK = 0x0c;
const USER = 0x10;
const USER1 = 0x14;
const USER2 = 0x18;
const MS_DLEN = 0x1c;
const MISC = 0x20;
const DMA_CONF = 0x30;
const W0 = 0x98;
const SLAVE = 0xe0;
const USR = 1 << 24;
const UPDATE = 1 << 23;

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
  devices: readonly SpiAttachment[] = [];
  /** CS0 output level: low during a transaction. */
  cs0 = 1;
  onCs: (() => void) | null = null;
  bytes = 0;
  /** Each transaction as USR clears: its start, end (reference cycles) and bits. */
  onTransaction: ((start: number, end: number, bits: number) => void) | null = null;
  private start = 0;
  private bits = 0;
  private readonly ctx: SocContext;
  private readonly slot: number;
  private readonly buffer = new Uint8Array(64);

  constructor(ctx: SocContext) {
    super(SPI2_BASE, (address) => ctx.regDefault(address));
    this.ctx = ctx;
    this.slot = ctx.events.add(() => this.finish());
  }

  implements(offset: number): boolean {
    return offset <= 0x40 || (offset >= W0 && offset < W0 + 64) || (offset >= SLAVE && offset <= 0xf0);
  }

  override systemReset(_rtcDomain: boolean): void {
    this.reset();
    this.ctx.events.cancel(this.slot);
    this.setCs(1);
  }

  sckHz(): number {
    const clock = this.regs[CLOCK >>> 2];
    if ((clock >>> 31) !== 0) return this.ctx.apbHz;
    const pre = (clock >>> 18) & 0xf;
    const n = (clock >>> 12) & 0x3f;
    return this.ctx.apbHz / ((pre + 1) * (n + 1));
  }

  override write32(offset: number, value: number): void {
    if (offset !== CMD) {
      super.write32(offset, value);
      return;
    }
    const v = value & ~UPDATE;
    if ((v & USR) === 0 || (this.regs[CMD >>> 2] & USR) !== 0) {
      super.write32(offset, (v & ~USR) | (this.regs[CMD >>> 2] & USR));
      return;
    }
    if ((this.regs[SLAVE >>> 2] & (1 << 26)) !== 0 || (this.regs[DMA_CONF >>> 2] & ((1 << 28) | (1 << 27))) !== 0) {
      this.ctx.problems.report('warning', CODE_SPI_UNSUPPORTED, SPI2_BASE, 'SPI2: slave mode and DMA aren\'t emulated; the transaction did nothing.');
      return;
    }
    super.write32(offset, v);
    this.transfer();
  }

  private transfer(): void {
    const user = this.regs[USER >>> 2];
    const mosiOn = (user & (1 << 27)) !== 0;
    const misoOn = (user & (1 << 28)) !== 0;
    const doutdin = (user & 1) !== 0;
    const dataBits = (this.regs[MS_DLEN >>> 2] & 0x3ffff) + 1;
    const mosiBits = mosiOn ? dataBits : 0;
    const misoBits = misoOn ? dataBits : 0;
    let bits = doutdin ? Math.max(mosiBits, misoBits) : mosiBits + misoBits;
    if ((user >>> 31) !== 0) bits += ((this.regs[USER2 >>> 2] >>> 28) & 0xf) + 1;
    if ((user & (1 << 30)) !== 0) bits += ((this.regs[USER1 >>> 2] >>> 27) & 0x1f) + 1;
    if ((user & (1 << 29)) !== 0) bits += (this.regs[USER1 >>> 2] & 0xff) + 1;
    const ctrl = this.regs[CTRL >>> 2];
    const lsbOut = (ctrl & (1 << 26)) !== 0;
    const lsbIn = (ctrl & (1 << 25)) !== 0;
    const outBase = (user & (1 << 25)) !== 0 ? 32 : 0;
    const inBase = (user & (1 << 24)) !== 0 ? 32 : 0;
    const outBytes = Math.min(64 - outBase, Math.ceil(mosiBits / 8));
    const inBytes = Math.min(64 - inBase, Math.ceil(misoBits / 8));
    const count = doutdin ? Math.max(outBytes, inBytes) : outBytes + inBytes;
    for (let i = 0; i < 64; i++) this.buffer[i] = (this.regs[(W0 >>> 2) + (i >>> 2)] >>> ((i & 3) * 8)) & 0xff;
    if ((this.regs[MISC >>> 2] & 1) === 0) this.setCs(0);
    for (let i = 0; i < count; i++) {
      const sending = mosiOn && i < outBytes;
      const out = sending ? this.buffer[outBase + i] : 0xff;
      const wire = lsbOut ? reverse8(out) : out;
      let miso = 0xff;
      for (let d = 0; d < this.devices.length; d++) if (this.devices[d].selected()) miso = this.devices[d].device.transfer(wire) & 0xff;
      this.bytes++;
      const received = lsbIn ? reverse8(miso) : miso;
      if (misoOn) {
        const at = doutdin ? i : i - outBytes;
        if (at >= 0 && at < inBytes) this.buffer[inBase + at] = received;
      }
    }
    if (misoOn) {
      for (let w = 0; w < 16; w++) {
        this.regs[(W0 >>> 2) + w] = (this.buffer[w * 4] | (this.buffer[w * 4 + 1] << 8) | (this.buffer[w * 4 + 2] << 16) | (this.buffer[w * 4 + 3] << 24)) >>> 0;
      }
    }
    this.start = this.ctx.now();
    this.bits = bits;
    const when = this.start + (bits / this.sckHz()) * this.ctx.refHz;
    this.ctx.events.schedule(this.slot, when);
    this.ctx.hurry(when);
  }

  private finish(): void {
    this.regs[CMD >>> 2] &= ~USR;
    this.setCs(1);
    this.onTransaction?.(this.start, this.ctx.now(), this.bits);
  }

  private setCs(level: number): void {
    if (this.cs0 === level) return;
    this.cs0 = level;
    this.onCs?.();
  }
}
