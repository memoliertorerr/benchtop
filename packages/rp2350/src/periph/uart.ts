/**
 * UART0/UART1 (BT65), Arm PL011 (RP2350 datasheet §12.1): DR, RSR, FR, IBRD/FBRD, LCR_H, CR,
 * IFLS, IMSC/RIS/MIS/ICR, DMACR and the ID registers. Bytes move at the programmed rate:
 * baud = clk_peri / (16 × (IBRD + FBRD/64)), a frame being 1 + data + parity + stop bits. TX
 * empties a 32-entry FIFO (1 entry with LCR_H.FEN clear) through a shifter — each byte reaches
 * `listeners` when its frame ends; RX takes the bench's bytes one frame apart into the RX FIFO
 * (overflow drops and sets OE). Interrupts: RX at the IFLS level (or any byte without FIFOs),
 * TX at or below its level, the receive timeout after 32 bit periods of RX FIFO idle; errors
 * aren't generated.
 */

import type { Alarm, SocClock } from '../clock.ts';
import { applyAlias, Periph, type PeriphHost } from './block.ts';

const FIFO = 32;
const LEVELS = [4, 8, 16, 24, 28];
const RIS_RX = 1 << 4;
const RIS_TX = 1 << 5;
const RIS_RT = 1 << 6;
const RIS_OE = 1 << 10;

export class Uart extends Periph {
  readonly listeners: ((byte: number) => void)[] = [];
  private readonly irq: number;
  private readonly periHz: () => number;
  private readonly tx: number[] = [];
  private readonly rx: number[] = [];
  private readonly pending: number[] = [];
  private shifting = -1;
  private ris = 0;
  private readonly txDone: Alarm;
  private readonly rxNext: Alarm;
  private readonly timeout: Alarm;

  constructor(name: string, base: number, host: PeriphHost, clock: SocClock, irq: number, periHz: () => number) {
    super(name, base, host);
    this.irq = irq;
    this.periHz = periHz;
    this.txDone = clock.alarm(() => this.frameSent());
    this.rxNext = clock.alarm(() => this.frameReceived());
    this.timeout = clock.alarm(() => {
      if (this.rx.length > 0) {
        this.ris |= RIS_RT;
        this.updateIrq();
      }
    });
  }

  override reset(): void {
    super.reset();
    this.tx.length = this.rx.length = this.pending.length = 0;
    this.shifting = -1;
    this.ris = 0;
    this.txDone.cancel();
    this.rxNext.cancel();
    this.timeout.cancel();
    this.updateIrq();
  }

  private get enabled(): boolean {
    return (this.regs[0x30 >>> 2] & 1) !== 0;
  }

  private get depth(): number {
    return (this.regs[0x2c >>> 2] & 0x10) !== 0 ? FIFO : 1;
  }

  /** The configured rate, or undefined before IBRD is set or without clk_peri. */
  baud(): number | undefined {
    const divisor = this.regs[0x24 >>> 2] + (this.regs[0x28 >>> 2] & 0x3f) / 64;
    const hz = this.periHz();
    return divisor === 0 || hz === 0 ? undefined : hz / (16 * divisor);
  }

  /** One frame, ns. */
  private frameNanos(): number {
    const lcr = this.regs[0x2c >>> 2];
    const bits = 1 + 5 + ((lcr >>> 5) & 3) + ((lcr & 2) !== 0 ? 1 : 0) + ((lcr & 8) !== 0 ? 2 : 1);
    return (bits * 1e9) / (this.baud() ?? 115_200);
  }

  /** Bytes from the bench, received one frame apart. */
  receive(bytes: Uint8Array): void {
    for (const b of bytes) this.pending.push(b);
    if (!this.rxNext.scheduled && this.pending.length > 0) this.rxNext.scheduleAt(this.host.now() + this.frameNanos());
  }

  override read(offset: number): number {
    switch (offset) {
      case 0x000: {
        const byte = this.rx.shift();
        if (this.rx.length > 0) this.timeout.scheduleAt(this.host.now() + (32 * this.frameNanos()) / 10);
        else this.ris &= ~RIS_RT;
        this.updateIrq();
        return byte ?? 0;
      }
      case 0x018: {
        const busy = this.shifting >= 0 || this.tx.length > 0;
        return (
          (this.tx.length === 0 && this.shifting < 0 ? 0x80 : 0) |
          (this.rx.length >= this.depth ? 0x40 : 0) |
          (this.tx.length >= this.depth ? 0x20 : 0) |
          (this.rx.length === 0 ? 0x10 : 0) |
          (busy ? 0x08 : 0)
        );
      }
      case 0x03c:
        return this.ris;
      case 0x040:
        return this.ris & this.regs[0x38 >>> 2];
      case 0x004:
      case 0x020:
      case 0x024:
      case 0x028:
      case 0x02c:
      case 0x030:
      case 0x034:
      case 0x038:
      case 0x048:
        return this.regs[offset >>> 2];
      default:
        if (offset >= 0xfe0) return [0x11, 0x10, 0x34, 0x00, 0x0d, 0xf0, 0x05, 0xb1][(offset - 0xfe0) >>> 2] ?? 0;
        return this.readStored(offset);
    }
  }

  override write(offset: number, value: number, alias: number): void {
    switch (offset) {
      case 0x000:
        if (this.tx.length < this.depth) this.tx.push(value & 0xff);
        this.startTx();
        this.updateIrq();
        break;
      case 0x044:
        this.ris &= ~(applyAlias(0, value, alias) & ~(RIS_RX | RIS_TX));
        this.updateIrq();
        break;
      case 0x004:
        this.regs[1] = 0; // RSR: any write clears the errors
        this.ris &= ~RIS_OE;
        break;
      case 0x030:
        this.store(offset, value, alias);
        this.startTx();
        this.updateIrq();
        break;
      case 0x020:
      case 0x024:
      case 0x028:
      case 0x02c:
      case 0x034:
      case 0x038:
      case 0x048:
        this.store(offset, value, alias);
        this.updateIrq();
        break;
      default:
        this.writeStored(offset, value, alias);
    }
  }

  private startTx(): void {
    const cr = this.regs[0x30 >>> 2];
    if (this.shifting >= 0 || this.tx.length === 0 || !this.enabled || (cr & 0x100) === 0) return;
    this.shifting = this.tx.shift() as number;
    this.txDone.scheduleAt(this.host.now() + this.frameNanos());
  }

  private frameSent(): void {
    const byte = this.shifting;
    this.shifting = -1;
    if (byte >= 0) for (const listener of this.listeners) listener(byte);
    this.startTx();
    this.updateIrq();
  }

  private frameReceived(): void {
    const byte = this.pending.shift();
    if (byte !== undefined && this.enabled && (this.regs[0x30 >>> 2] & 0x200) !== 0) {
      if (this.rx.length < this.depth) this.rx.push(byte);
      else this.ris |= RIS_OE;
      this.timeout.scheduleAt(this.host.now() + (32 * this.frameNanos()) / 10);
      this.updateIrq();
    }
    if (this.pending.length > 0) this.rxNext.scheduleAt(this.host.now() + this.frameNanos());
  }

  private updateIrq(): void {
    const fifo = this.depth === FIFO;
    const ifls = this.regs[0x34 >>> 2];
    const rxLevel = fifo ? LEVELS[Math.min(4, (ifls >>> 3) & 7)] : 1;
    const txLevel = fifo ? LEVELS[Math.min(4, ifls & 7)] : 0;
    let ris = this.ris & ~(RIS_RX | RIS_TX);
    if (this.rx.length >= rxLevel) ris |= RIS_RX;
    if (this.tx.length <= txLevel && this.enabled) ris |= RIS_TX;
    this.ris = ris;
    this.host.setIrq(this.irq, (ris & this.regs[0x38 >>> 2]) !== 0);
  }
}
