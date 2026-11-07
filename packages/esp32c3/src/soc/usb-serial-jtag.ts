/**
 * The ESP32-C3's USB-Serial-JTAG controller, its CDC-ACM serial side (BT93;
 * usb_serial_jtag_reg.h, TRM §30, IDF's usb_serial_jtag_ll.h), at 0x60043000, with a host on the
 * other end of the cable that is always there and always reading — the serial monitor.
 *
 * Device → host: EP1 (0x00) writes push a byte into the 64-byte IN FIFO while
 * EP1_CONF.SERIAL_IN_EP_DATA_FREE (bit 1) reads 1; EP1_CONF.WR_DONE (bit 0) — or a full FIFO —
 * sends it as one packet. While a packet waits for the host, DATA_FREE reads 0. The host takes it
 * HOST_LATENCY plus the bytes' time on a 12 Mbit/s bus later: the bytes go to `onTx`, the FIFO
 * empties and INT_RAW.SERIAL_IN_EMPTY (bit 3, set at reset) rises — Arduino's HWCDC sends its
 * next 64 bytes from that interrupt.
 *
 * Host → device: `receive` queues bytes; they arrive in packets of up to 64 bytes, each after
 * HOST_LATENCY, once the OUT FIFO is empty: EP1_CONF.SERIAL_OUT_EP_DATA_AVAIL (bit 2) reads 1
 * while bytes wait, EP1 reads pop them, and each packet raises SERIAL_OUT_RECV_PKT (bit 2).
 *
 * SOF: a host sends a start-of-frame every millisecond; HWCDC's tick hook calls the port unplugged
 * when INT_RAW.SOF (bit 1) stays clear for 5 ms. Frames start at the firmware's first access to
 * the block (a sketch that never touches it costs no events) and count FRAM_NUM (11 bits).
 * INT_ST = INT_RAW & INT_ENA drives source 26; INT_CLR clears. JTAG isn't modeled.
 */

import type { Peripheral } from '@benchtop/esp32';
import type { SocContext } from './context.ts';
import { SRC } from './intmatrix.ts';

export const USB_SERIAL_JTAG_BASE = 0x60043000;
/** The host's turnaround for a packet (reference cycles: 50 µs). */
const HOST_LATENCY_S = 1 / 20_000;
/** A byte on the bus at 12 Mbit/s (with stuffing and framing, ≈ 0.75 µs). */
const BYTE_TIME_S = 0.75 / 1e6;
const FRAME_S = 1 / 1000;
const PACKET = 64;

const EP1 = 0x00;
const EP1_CONF = 0x04;
const INT_RAW = 0x08;
const INT_ST = 0x0c;
const INT_ENA = 0x10;
const INT_CLR = 0x14;
const JFIFO_ST = 0x20;
const FRAM_NUM = 0x24;
const OUT_EP1_ST = 0x3c;

const WR_DONE = 1 << 0;
const DATA_FREE = 1 << 1;
const DATA_AVAIL = 1 << 2;
export const USJ_INT = { SOF: 1 << 1, SERIAL_OUT_RECV_PKT: 1 << 2, SERIAL_IN_EMPTY: 1 << 3, BUS_RESET: 1 << 9 } as const;

export class UsbSerialJtag implements Peripheral {
  /** Every byte the host receives, as it receives it. */
  onTx: ((byte: number) => void) | null = null;
  private readonly ctx: SocContext;
  private readonly regs = new Uint32Array(1024);
  private readonly inFifo = new Uint8Array(PACKET);
  private inCount = 0;
  private inFlight = false;
  private readonly outFifo = new Uint8Array(PACKET);
  private outCount = 0;
  private outAt = 0;
  /** Bytes from the host not yet in the OUT FIFO (a ring). */
  private queue = new Uint8Array(4096);
  private qHead = 0;
  private qCount = 0;
  private outPending = false;
  private frames = false;
  private frame = 0;
  private intRaw = USJ_INT.SERIAL_IN_EMPTY;
  private intEna = 0;
  private readonly hostSlot: number;
  private readonly outSlot: number;
  private readonly sofSlot: number;

  /** BT124: its block and interrupt source (the S3's differ), and the host's times in reference cycles. */
  private readonly base: number;
  private readonly source: number;
  private readonly hostLatency: number;
  private readonly byteTime: number;
  private readonly framePeriod: number;

  constructor(ctx: SocContext, base: number = USB_SERIAL_JTAG_BASE, source: number = SRC.USB_SERIAL_JTAG) {
    this.ctx = ctx;
    this.base = base;
    this.source = source;
    this.hostLatency = ctx.refHz * HOST_LATENCY_S;
    this.byteTime = ctx.refHz * BYTE_TIME_S;
    this.framePeriod = ctx.refHz * FRAME_S;
    this.hostSlot = ctx.events.add(() => this.hostRead());
    this.outSlot = ctx.events.add(() => this.deliverPacket());
    this.sofSlot = ctx.events.add(() => this.sof());
    this.systemReset();
  }

  systemReset(): void {
    for (let i = 0; i < this.regs.length; i++) this.regs[i] = this.ctx.regDefault(this.base + i * 4);
    this.ctx.events.cancel(this.hostSlot);
    this.ctx.events.cancel(this.outSlot);
    this.ctx.events.cancel(this.sofSlot);
    this.inCount = this.outCount = this.outAt = this.qHead = this.qCount = this.frame = 0;
    this.inFlight = this.outPending = this.frames = false;
    this.intRaw = USJ_INT.SERIAL_IN_EMPTY;
    this.intEna = 0;
    this.update();
  }

  /** Bytes from the host (the serial monitor) to the firmware. */
  receive(bytes: Uint8Array): void {
    for (let i = 0; i < bytes.length; i++) {
      if (this.qCount === this.queue.length) {
        const grown = new Uint8Array(this.queue.length * 2);
        for (let j = 0; j < this.qCount; j++) grown[j] = this.queue[(this.qHead + j) % this.queue.length];
        this.queue = grown;
        this.qHead = 0;
      }
      this.queue[(this.qHead + this.qCount) % this.queue.length] = bytes[i];
      this.qCount++;
    }
    this.scheduleOut();
  }

  /** Bytes the firmware hasn't sent to the host yet (the IN FIFO). */
  get pendingTx(): number {
    return this.inCount;
  }

  private start(): void {
    if (this.frames) return;
    this.frames = true;
    this.ctx.events.schedule(this.sofSlot, this.ctx.now() + this.framePeriod);
  }

  private sof(): void {
    this.frame = (this.frame + 1) & 0x7ff;
    this.intRaw |= USJ_INT.SOF;
    this.update();
    this.ctx.events.schedule(this.sofSlot, this.ctx.events.firing + this.framePeriod);
  }

  private update(): void {
    this.ctx.matrix.setSource(this.source, (this.intRaw & this.intEna) !== 0);
  }

  private flush(): void {
    if (this.inFlight) return;
    this.inFlight = true;
    const when = this.ctx.now() + this.hostLatency + this.inCount * this.byteTime;
    this.ctx.events.schedule(this.hostSlot, when);
    this.ctx.hurry(when);
  }

  private hostRead(): void {
    const count = this.inCount;
    this.inCount = 0;
    this.inFlight = false;
    for (let i = 0; i < count; i++) this.onTx?.(this.inFifo[i]);
    this.intRaw |= USJ_INT.SERIAL_IN_EMPTY;
    this.update();
  }

  private scheduleOut(): void {
    if (this.outPending || this.outCount > 0 || this.qCount === 0) return;
    this.outPending = true;
    const when = this.ctx.now() + this.hostLatency;
    this.ctx.events.schedule(this.outSlot, when);
    this.ctx.hurry(when);
  }

  private deliverPacket(): void {
    this.outPending = false;
    const n = Math.min(PACKET, this.qCount);
    for (let i = 0; i < n; i++) {
      this.outFifo[i] = this.queue[this.qHead];
      this.qHead = (this.qHead + 1) % this.queue.length;
    }
    this.qCount -= n;
    this.outCount = n;
    this.outAt = 0;
    if (n > 0) this.intRaw |= USJ_INT.SERIAL_OUT_RECV_PKT;
    this.update();
  }

  read32(offset: number): number {
    this.start();
    switch (offset) {
      case EP1: {
        if (this.outAt >= this.outCount) return 0;
        const byte = this.outFifo[this.outAt++];
        if (this.outAt >= this.outCount) {
          this.outCount = this.outAt = 0;
          this.scheduleOut();
        }
        return byte;
      }
      case EP1_CONF:
        return (!this.inFlight && this.inCount < PACKET ? DATA_FREE : 0) | (this.outAt < this.outCount ? DATA_AVAIL : 0);
      case INT_RAW:
        return this.intRaw;
      case INT_ST:
        return (this.intRaw & this.intEna) >>> 0;
      case INT_ENA:
        return this.intEna;
      case JFIFO_ST:
        return this.regs[JFIFO_ST >>> 2];
      case FRAM_NUM:
        return this.frame;
      case OUT_EP1_ST:
        return ((this.outCount - this.outAt) & 0x7f) << 16;
      default:
        return this.regs[offset >>> 2];
    }
  }

  write32(offset: number, value: number): void {
    this.start();
    switch (offset) {
      case EP1:
        if (this.inFlight || this.inCount >= PACKET) return;
        this.inFifo[this.inCount++] = value & 0xff;
        if (this.inCount === PACKET) this.flush();
        return;
      case EP1_CONF:
        if ((value & WR_DONE) !== 0) this.flush();
        return;
      case INT_ENA:
        this.intEna = value >>> 0;
        this.update();
        return;
      case INT_CLR:
        this.intRaw &= ~value;
        this.update();
        return;
      case INT_RAW:
      case INT_ST:
      case FRAM_NUM:
      case OUT_EP1_ST:
        return;
      default:
        this.regs[offset >>> 2] = value;
    }
  }
}
