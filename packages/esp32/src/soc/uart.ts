/**
 * UART0/1/2 (0x3FF40000 / 0x3FF50000 / 0x3FF6E000, FIFOs also reached through the AHB alias
 * 0x60000000 / 0x60010000 / 0x6002E000 — uart_reg.h; IDF's uart_ll writes TX through the AHB
 * address and reads RX through the DPORT one, the ROM uses DPORT for both).
 *
 * Baud: CLKDIV (bits 19:0) + CLKDIV_FRAG/16 (bits 23:20) divides the APB clock (CONF0
 * TICK_REF_ALWAYS_ON, bit 27, = 1) or the 1 MHz REF_TICK; a frame is a start bit, 5–8 data bits
 * (CONF0 BIT_NUM), parity (PARITY_EN) and 1/1.5/2 stop bits (STOP_BIT_NUM).
 *
 * TX: a 128-byte FIFO drains at that rate; a byte reaches the listeners when its stop bit ends,
 * and the next starts where it ended (no drift). STATUS shows TXFIFO_CNT (23:16) and the
 * transmitter state.
 *
 * RX (BT35): `receive` queues bytes on the RX line; each enters the 128-byte RX FIFO when its stop
 * bit ends, frames back to back from when the line was free. Reading FIFO pops it. STATUS
 * RXFIFO_CNT (7:0) and MEM_RX_STATUS (0x60: RD_ADDR 12:2, WR_ADDR 23:13 — uart_ll_get_rxfifo_len
 * takes their difference mod 128) report the fill level. RXFIFO_FULL (bit 0) is raised while the
 * FIFO holds at least CONF1 RXFIFO_FULL_THRHD (6:0) bytes; RXFIFO_TOUT (bit 8) when CONF1
 * RX_TOUT_EN (31) is set, the FIFO isn't empty and RX_TOUT_THRHD (30:24) units pass after the
 * last byte — a unit is 8 bit times on the APB clock, 1/8 bit time on REF_TICK (uart_ll_set_rx_tout
 * converts with those factors); RXFIFO_OVF (bit 4) when a byte arrives at a full FIFO — the byte
 * is lost, as on hardware, and a Problem says so. A write with CONF0 RXFIFO_RST (17) set empties
 * it (TXFIFO_RST, 18, the TX FIFO); both bits read back as written. FRM_ERR and
 * BRK_DET never happen (the line is byte-level, never a waveform).
 *
 * Interrupts: TXFIFO_EMPTY (bit 1) is raised whenever the TX FIFO holds fewer bytes than CONF1
 * TXFIFO_EMPTY_THRHD (14:8) (it comes straight back after INT_CLR while that holds), TX_DONE
 * (bit 14) when the last byte has left; INT_ST = INT_RAW & INT_ENA drives matrix source 34/35/36.
 */

import type { SocContext } from './context.ts';
import { REF_HZ } from './context.ts';
import { RegisterFile } from './periph.ts';

export const UART_BASES = [0x3ff40000, 0x3ff50000, 0x3ff6e000] as const;
export const CODE_UART_OVERFLOW = 'esp32-uart-rx-overflow';
const FIFO = 0x00;
const INT_RAW = 0x04;
const INT_ST = 0x08;
const INT_ENA = 0x0c;
const INT_CLR = 0x10;
const CLKDIV = 0x14;
const STATUS = 0x1c;
const CONF0 = 0x20;
const CONF1 = 0x24;
const MEM_TX_STATUS = 0x5c;
const MEM_RX_STATUS = 0x60;
const RXFIFO_FULL = 1 << 0;
const TXFIFO_EMPTY = 1 << 1;
const RXFIFO_OVF = 1 << 4;
const RXFIFO_TOUT = 1 << 8;
const TX_DONE = 1 << 14;
const RXFIFO_RST = 1 << 17;
const TXFIFO_RST = 1 << 18;
const TICK_REF_ALWAYS_ON = 1 << 27;
const FIFO_SIZE = 128;
const SOURCE = 34;
/** Most bytes `receive` keeps waiting for the line (beyond them, the sender is told nothing: dropped). */
const RX_QUEUE = 4096;

export class Uart extends RegisterFile {
  readonly index: number;
  /** Each byte as its stop bit ends. */
  onByte: ((uart: number, byte: number) => void) | null = null;
  private readonly context: SocContext;
  private readonly fifo = new Uint8Array(FIFO_SIZE);
  private head = 0;
  private count = 0;
  /** A byte is on the line (the FIFO's head byte). */
  private sending = false;
  private readonly slot: number;
  private sourceHigh = false;
  /** When the byte on the line ends (reference cycles): the next one starts there, not late. */
  private lineFreeAt = 0;
  // RX: the FIFO, the bytes still to come over the line, and its timing.
  private readonly rxFifo = new Uint8Array(FIFO_SIZE);
  private rxHead = 0;
  private rxCount = 0;
  private readonly rxQueue = new Uint8Array(RX_QUEUE);
  private rxQueueHead = 0;
  private rxQueueCount = 0;
  private rxLineFreeAt = 0;
  private lastRxAt = 0;
  private readonly rxSlot: number;
  private readonly toutSlot: number;
  /** Bytes lost to a full RX FIFO. */
  overflows = 0;

  constructor(context: SocContext, index: number) {
    super(UART_BASES[index]);
    this.index = index;
    this.context = context;
    this.slot = context.events.add(() => this.byteDone());
    this.rxSlot = context.events.add(() => this.rxByteDone());
    this.toutSlot = context.events.add(() => this.rxTimeout());
    this.updateInterrupts();
  }

  implements(offset: number): boolean {
    return offset <= CONF1 || offset === MEM_TX_STATUS || offset === MEM_RX_STATUS || offset === 0x78 || offset === 0x7c;
  }

  /** Bytes waiting in the TX FIFO (including the one on the line). */
  pending(): number {
    return this.count;
  }

  /** Bytes in the RX FIFO. */
  rxPending(): number {
    return this.rxCount;
  }

  /** A chip reset: registers to reset values, the FIFOs emptied (a byte on the line is cut off). */
  override systemReset(_rtcDomain: boolean): void {
    this.reset();
    for (const slot of [this.slot, this.rxSlot, this.toutSlot]) this.context.events.cancel(slot);
    this.head = 0;
    this.count = 0;
    this.sending = false;
    this.lineFreeAt = this.context.now();
    this.rxHead = 0;
    this.rxCount = 0;
    this.rxQueueHead = 0;
    this.rxQueueCount = 0;
    this.rxLineFreeAt = this.context.now();
    this.updateInterrupts();
  }

  /** Bytes for the receiver: they arrive one frame after another from when the line is free. */
  receive(bytes: Uint8Array): void {
    for (let i = 0; i < bytes.length && this.rxQueueCount < RX_QUEUE; i++) {
      this.rxQueue[(this.rxQueueHead + this.rxQueueCount) % RX_QUEUE] = bytes[i];
      this.rxQueueCount++;
    }
    if (!this.context.events.pending(this.rxSlot) && this.rxQueueCount > 0) this.startRxByte();
  }

  override read32(offset: number): number {
    switch (offset) {
      case FIFO:
        return this.popRx();
      case INT_ST:
        return this.regs[INT_RAW >>> 2] & this.regs[INT_ENA >>> 2];
      case STATUS:
        // RXFIFO_CNT 7:0, TXFIFO_CNT 23:16, ST_UTX_OUT (27:24) busy while sending; TXD idles high.
        return ((this.regs[STATUS >>> 2] & 0x0000ff00) | (this.rxCount & 0xff) | (this.count << 16) | (this.sending ? 1 << 24 : 0) | (1 << 31)) >>> 0;
      case MEM_RX_STATUS: {
        const rd = this.rxHead;
        const wr = (this.rxHead + this.rxCount) % FIFO_SIZE;
        return ((rd << 2) | (wr << 13)) >>> 0;
      }
      default:
        return super.read32(offset);
    }
  }

  override write32(offset: number, value: number): void {
    switch (offset) {
      case FIFO:
        this.push(value & 0xff);
        return;
      case INT_RAW:
      case INT_ST:
      case STATUS:
      case MEM_RX_STATUS:
        return;
      case INT_CLR:
        this.regs[INT_RAW >>> 2] &= ~value;
        this.updateInterrupts();
        return;
      case CONF0:
        super.write32(offset, value); // the reset bits read back; IDF sets and clears them
        if ((value & TXFIFO_RST) !== 0) this.count = this.sending ? 1 : 0; // the byte on the line finishes
        if ((value & RXFIFO_RST) !== 0) {
          this.rxCount = 0;
          this.context.events.cancel(this.toutSlot);
        }
        this.updateInterrupts();
        return;
      default:
        super.write32(offset, value);
        if (offset === INT_ENA || offset === CONF1) {
          if (offset === CONF1) this.armTimeout();
          this.updateInterrupts();
        }
    }
  }

  private push(byte: number): void {
    if (this.count >= FIFO_SIZE) return; // overflow: dropped, as the hardware does
    this.fifo[(this.head + this.count) % FIFO_SIZE] = byte;
    this.count++;
    this.regs[INT_RAW >>> 2] &= ~TX_DONE;
    if (!this.sending) this.startByte();
    this.updateInterrupts();
  }

  /** Reference cycles one frame takes at the current settings, and its bit count. */
  private frameTime(): number {
    return this.bitTime() * this.frameBits();
  }

  private frameBits(): number {
    const conf0 = this.regs[CONF0 >>> 2];
    const dataBits = 5 + ((conf0 >>> 2) & 3);
    const parity = (conf0 & 2) !== 0 ? 1 : 0;
    const stop = [1, 1, 1.5, 2][(conf0 >>> 4) & 3];
    return 1 + dataBits + parity + stop;
  }

  private bitTime(): number {
    return (this.divider() / this.clock()) * REF_HZ;
  }

  /** Bits per second: the clock over the divider (BT39 reports it). */
  baud(): number {
    return this.clock() / this.divider();
  }

  /** APB, or the 1 MHz REF_TICK. */
  private clock(): number {
    return (this.regs[CONF0 >>> 2] & TICK_REF_ALWAYS_ON) !== 0 ? this.context.apbHz : 1_000_000;
  }

  /** CLKDIV + CLKDIV_FRAG/16. */
  private divider(): number {
    const div = this.regs[CLKDIV >>> 2];
    return (div & 0xfffff) + ((div >>> 20) & 0xf) / 16 || 1;
  }

  private startByte(): void {
    this.sending = true;
    this.lineFreeAt = Math.max(this.context.now(), this.lineFreeAt) + this.frameTime();
    this.context.events.schedule(this.slot, this.lineFreeAt);
  }

  private byteDone(): void {
    const byte = this.fifo[this.head];
    this.head = (this.head + 1) % FIFO_SIZE;
    this.count--;
    this.sending = false;
    this.onByte?.(this.index, byte);
    if (this.count > 0) this.startByte();
    else this.regs[INT_RAW >>> 2] |= TX_DONE;
    this.updateInterrupts();
  }

  // ── RX ──────────────────────────────────────────────────────────────────────────────────

  private startRxByte(): void {
    this.rxLineFreeAt = Math.max(this.context.now(), this.rxLineFreeAt) + this.frameTime();
    this.context.events.schedule(this.rxSlot, this.rxLineFreeAt);
  }

  private rxByteDone(): void {
    const byte = this.rxQueue[this.rxQueueHead];
    this.rxQueueHead = (this.rxQueueHead + 1) % RX_QUEUE;
    this.rxQueueCount--;
    this.lastRxAt = this.rxLineFreeAt;
    if (this.rxCount >= FIFO_SIZE) {
      this.overflows++;
      this.regs[INT_RAW >>> 2] |= RXFIFO_OVF;
      this.context.problems.report('warning', CODE_UART_OVERFLOW, UART_BASES[this.index], `UART${this.index} RX FIFO overflowed: received bytes were lost (the firmware didn't read them in time).`);
    } else {
      this.rxFifo[(this.rxHead + this.rxCount) % FIFO_SIZE] = byte;
      this.rxCount++;
    }
    if (this.rxQueueCount > 0) this.startRxByte();
    this.armTimeout();
    this.updateInterrupts();
  }

  private popRx(): number {
    if (this.rxCount === 0) return 0;
    const byte = this.rxFifo[this.rxHead];
    this.rxHead = (this.rxHead + 1) % FIFO_SIZE;
    this.rxCount--;
    if (this.rxCount === 0) this.context.events.cancel(this.toutSlot);
    this.updateInterrupts();
    return byte;
  }

  /** RX_TOUT units of the current clock, in reference cycles. */
  private timeoutTime(): number {
    const conf1 = this.regs[CONF1 >>> 2];
    const units = (conf1 >>> 24) & 0x7f;
    const bits = (this.regs[CONF0 >>> 2] & TICK_REF_ALWAYS_ON) !== 0 ? units * 8 : units / 8;
    return Math.max(bits, 1) * this.bitTime();
  }

  /** (Re)arms the RX timeout from the last received byte. */
  private armTimeout(): void {
    const conf1 = this.regs[CONF1 >>> 2];
    if ((conf1 & (1 << 31)) === 0 || this.rxCount === 0) {
      this.context.events.cancel(this.toutSlot);
      return;
    }
    this.context.events.schedule(this.toutSlot, Math.max(this.lastRxAt + this.timeoutTime(), this.context.now()));
  }

  private rxTimeout(): void {
    if (this.rxCount === 0 || this.context.events.pending(this.rxSlot)) {
      // More bytes are still coming in: the timeout restarts from the next one.
      return;
    }
    this.regs[INT_RAW >>> 2] |= RXFIFO_TOUT;
    this.updateInterrupts();
  }

  private updateInterrupts(): void {
    const conf1 = this.regs[CONF1 >>> 2];
    const threshold = (conf1 >>> 8) & 0x7f;
    if (this.count < threshold) this.regs[INT_RAW >>> 2] |= TXFIFO_EMPTY;
    const full = conf1 & 0x7f;
    if (this.rxCount >= full && this.rxCount > 0) this.regs[INT_RAW >>> 2] |= RXFIFO_FULL;
    const high = (this.regs[INT_RAW >>> 2] & this.regs[INT_ENA >>> 2]) !== 0;
    if (high !== this.sourceHigh) {
      this.sourceHigh = high;
      this.context.interrupts.setSource(SOURCE + this.index, high);
    }
  }
}
