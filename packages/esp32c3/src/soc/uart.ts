/**
 * The ESP32-C3's UARTs (BT92; TRM §26, uart_reg.h): UART0 at 0x60000000, UART1 at 0x60010000.
 *
 * TX: a 128-byte FIFO (FIFO register writes) drained one frame at a time at the configured baud;
 * each byte goes to `onTx` as its stop bit ends. RX: bytes handed to `receive` enter a queue and
 * reach the 128-byte FIFO one frame-time apart (a full FIFO drops them and raises RXFIFO_OVF);
 * reading FIFO pops one. Baud: sclk (CLK_CONF.SCLK_SEL: 1 APB, 2 RC_FAST 17.5 MHz, 3 XTAL) /
 * (SCLK_DIV_NUM + 1) / (CLKDIV + FRAG/16); a frame is 1 start + 5–8 data + parity + 1–2 stop bits
 * (CONF0). Interrupts (INT_RAW): RXFIFO_FULL while the RX count ≥ CONF1.RXFIFO_FULL_THRHD,
 * TXFIFO_EMPTY while the TX count ≤ CONF1.TXFIFO_EMPTY_THRHD, RXFIFO_TOUT when RX bytes wait and
 * the line has been idle for MEM_CONF.RX_TOUT_THRHD bit-times (CONF1.RX_TOUT_EN), TX_DONE when the
 * last queued frame ends; the source is high while INT_RAW & INT_ENA. ID.UPDATE (bit 31) is the
 * driver's "sync the configuration" bit: it reads back 0 at once. Nothing allocates per byte.
 */

import type { Peripheral } from '@benchtop/esp32';
import { type SocContext, XTAL_HZ } from './context.ts';

export const UART_BASES = [0x60000000, 0x60010000] as const;

const FIFO = 0x00;
const INT_RAW = 0x04;
const INT_ST = 0x08;
const INT_ENA = 0x0c;
const INT_CLR = 0x10;
const CLKDIV = 0x14;
const STATUS = 0x1c;
const CONF0 = 0x20;
const CONF1 = 0x24;
const MEM_CONF = 0x60;
const FSM_STATUS = 0x6c;
const CLK_CONF = 0x78;
const ID = 0x80;

/**
 * BT125: where CONF1 and MEM_CONF keep the fields that moved between the chips — the S3's FIFO
 * thresholds are 10 bits wide (RXFIFO_FULL 9:0, TXFIFO_EMPTY 19:10, RX_TOUT_EN 23, MEM_CONF's
 * RX_TOUT_THRHD 26:17) where the C3's are 9 (8:0, 17:9, 21, 25:16).
 */
export interface UartFields {
  thrBits: number;
  toutEn: number;
  toutThrShift: number;
}
export const C3_UART_FIELDS: UartFields = { thrBits: 9, toutEn: 21, toutThrShift: 16 };
export const S3_UART_FIELDS: UartFields = { thrBits: 10, toutEn: 23, toutThrShift: 17 };

export const UART_INT = { RXFIFO_FULL: 1 << 0, TXFIFO_EMPTY: 1 << 1, RXFIFO_OVF: 1 << 4, RXFIFO_TOUT: 1 << 8, TX_DONE: 1 << 14 } as const;

const FIFO_SIZE = 128;
const RX_QUEUE = 4096;

export class Uart implements Peripheral {
  readonly index: number;
  private readonly ctx: SocContext;
  private readonly source: number;
  private readonly regs = new Uint32Array(1024);
  private readonly tx = new Uint8Array(FIFO_SIZE);
  private txHead = 0;
  private txCount = 0;
  /** The frame on the wire (-1 none). */
  private sending = -1;
  private readonly rx = new Uint8Array(FIFO_SIZE);
  private rxHead = 0;
  private rxCount = 0;
  private readonly rxQueue = new Uint8Array(RX_QUEUE);
  private rxQueueHead = 0;
  private rxQueueCount = 0;
  private intRaw = 0;
  private lastRx = 0;
  private readonly txSlot: number;
  private readonly rxSlot: number;
  private readonly toutSlot: number;
  /** Each byte as its stop bit ends. */
  onTx: ((byte: number) => void) | null = null;

  /** BT124: its block (UART_BASES[index] by default; the S3's UART2 is elsewhere). */
  private readonly base: number;
  /** BT125: the chip's CONF1/MEM_CONF field positions. */
  private readonly fields: UartFields;
  private readonly thrMask: number;

  constructor(ctx: SocContext, index: number, source: number, base: number = UART_BASES[index], fields: UartFields = C3_UART_FIELDS) {
    this.ctx = ctx;
    this.index = index;
    this.source = source;
    this.base = base;
    this.fields = fields;
    this.thrMask = (1 << fields.thrBits) - 1;
    this.txSlot = ctx.events.add(() => this.frameSent());
    this.rxSlot = ctx.events.add(() => this.frameReceived());
    this.toutSlot = ctx.events.add(() => this.timeout());
    this.systemReset();
  }

  systemReset(): void {
    const base = this.base;
    for (let i = 0; i < this.regs.length; i++) this.regs[i] = this.ctx.regDefault(base + i * 4);
    this.txHead = this.txCount = this.rxHead = this.rxCount = this.rxQueueHead = this.rxQueueCount = 0;
    this.sending = -1;
    this.intRaw = 0;
    for (const slot of [this.txSlot, this.rxSlot, this.toutSlot]) this.ctx.events.cancel(slot);
    this.update();
  }

  /** The baud rate the registers configure (0 when they make no sense). */
  baud(): number {
    const clk = this.regs[CLK_CONF >>> 2];
    const sel = (clk >>> 20) & 3;
    const sclk = sel === 1 ? this.ctx.apbHz : sel === 2 ? 17_500_000 : XTAL_HZ;
    const sclkDiv = ((clk >>> 12) & 0xff) + 1;
    const div = this.regs[CLKDIV >>> 2];
    const divider = (div & 0xfff) + ((div >>> 20) & 0xf) / 16;
    return divider === 0 ? 0 : sclk / sclkDiv / divider;
  }

  /** Bits in a frame (start, data, parity, stop). */
  private frameBits(): number {
    const conf0 = this.regs[CONF0 >>> 2];
    const data = 5 + ((conf0 >>> 2) & 3);
    const parity = (conf0 & 2) !== 0 ? 1 : 0;
    const stopField = (conf0 >>> 4) & 3;
    const stop = stopField === 2 ? 1.5 : stopField === 3 ? 2 : 1;
    return 1 + data + parity + stop;
  }

  /** Reference cycles a frame takes (or a bit, with bits = 1). */
  private bitTime(bits: number): number {
    const baud = this.baud();
    return baud > 0 ? (bits * this.ctx.refHz) / baud : 1000;
  }

  /** Bytes from the outside world to this UART's RX pin. */
  receive(bytes: Uint8Array): void {
    for (let i = 0; i < bytes.length; i++) {
      if (this.rxQueueCount === RX_QUEUE) break;
      this.rxQueue[(this.rxQueueHead + this.rxQueueCount) % RX_QUEUE] = bytes[i];
      this.rxQueueCount++;
    }
    if (!this.ctx.events.pending(this.rxSlot) && this.rxQueueCount > 0) this.ctx.events.schedule(this.rxSlot, this.ctx.now() + this.bitTime(this.frameBits()));
  }

  private frameReceived(): void {
    if (this.rxQueueCount === 0) return;
    const byte = this.rxQueue[this.rxQueueHead];
    this.rxQueueHead = (this.rxQueueHead + 1) % RX_QUEUE;
    this.rxQueueCount--;
    if (this.rxCount === FIFO_SIZE) this.intRaw |= UART_INT.RXFIFO_OVF;
    else {
      this.rx[(this.rxHead + this.rxCount) % FIFO_SIZE] = byte;
      this.rxCount++;
    }
    this.lastRx = this.ctx.now();
    if (this.rxQueueCount > 0) this.ctx.events.schedule(this.rxSlot, this.ctx.now() + this.bitTime(this.frameBits()));
    this.armTimeout();
    this.update();
  }

  private armTimeout(): void {
    const conf1 = this.regs[CONF1 >>> 2];
    if ((conf1 & (1 << this.fields.toutEn)) === 0 || this.rxCount === 0) return;
    const bits = (this.regs[MEM_CONF >>> 2] >>> this.fields.toutThrShift) & 0x3ff;
    this.ctx.events.schedule(this.toutSlot, this.lastRx + this.bitTime(Math.max(bits, 1)));
  }

  private timeout(): void {
    if (this.rxCount > 0) this.intRaw |= UART_INT.RXFIFO_TOUT;
    this.update();
  }

  private startFrame(): void {
    if (this.sending >= 0 || this.txCount === 0) return;
    this.sending = this.tx[this.txHead];
    this.txHead = (this.txHead + 1) % FIFO_SIZE;
    this.txCount--;
    this.ctx.events.schedule(this.txSlot, this.ctx.now() + this.bitTime(this.frameBits()));
  }

  private frameSent(): void {
    const byte = this.sending;
    this.sending = -1;
    if (byte >= 0) this.onTx?.(byte);
    if (this.txCount > 0) this.startFrame();
    else this.intRaw |= UART_INT.TX_DONE;
    this.update();
  }

  /** Re-raises the level-like status bits and drives the source. */
  private update(): void {
    const conf1 = this.regs[CONF1 >>> 2];
    if (this.rxCount >= (conf1 & this.thrMask) && this.rxCount > 0) this.intRaw |= UART_INT.RXFIFO_FULL;
    if (this.txCount <= ((conf1 >>> this.fields.thrBits) & this.thrMask)) this.intRaw |= UART_INT.TXFIFO_EMPTY;
    this.ctx.matrix.setSource(this.source, (this.intRaw & this.regs[INT_ENA >>> 2]) !== 0);
  }

  read32(offset: number): number {
    switch (offset) {
      case FIFO: {
        if (this.rxCount === 0) return 0;
        const byte = this.rx[this.rxHead];
        this.rxHead = (this.rxHead + 1) % FIFO_SIZE;
        this.rxCount--;
        this.update();
        return byte;
      }
      case INT_RAW:
        return this.intRaw >>> 0;
      case INT_ST:
        return (this.intRaw & this.regs[INT_ENA >>> 2]) >>> 0;
      case STATUS:
        // RXD and TXD idle high (bits 15 and 31), the FIFO counts.
        return ((1 << 31) | (this.txCount << 16) | (1 << 15) | this.rxCount) >>> 0;
      case FSM_STATUS:
        return this.sending >= 0 ? 1 << 4 : 0;
      case ID:
        return this.regs[ID >>> 2] & 0x7fffffff;
    }
    return this.regs[offset >>> 2];
  }

  write32(offset: number, value: number): void {
    switch (offset) {
      case FIFO:
        if (this.txCount < FIFO_SIZE) {
          this.tx[(this.txHead + this.txCount) % FIFO_SIZE] = value & 0xff;
          this.txCount++;
        }
        this.intRaw &= ~UART_INT.TX_DONE;
        this.startFrame();
        this.update();
        return;
      case INT_RAW:
        return;
      case INT_CLR:
        this.intRaw &= ~value;
        this.update();
        return;
      case CONF0:
        this.regs[CONF0 >>> 2] = value;
        if ((value & (1 << 18)) !== 0) this.txHead = this.txCount = 0;
        if ((value & (1 << 17)) !== 0) this.rxHead = this.rxCount = 0;
        this.update();
        return;
    }
    this.regs[offset >>> 2] = value;
    if (offset === INT_ENA || offset === CONF1) this.update();
    if (offset === CONF1 || offset === MEM_CONF) this.armTimeout();
  }

  /** Bytes waiting to be sent (tests). */
  get pendingTx(): number {
    return this.txCount + (this.sending >= 0 ? 1 : 0);
  }
}
