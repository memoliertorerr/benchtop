/**
 * I2C controllers I2C0 (0x3FF53000) and I2C1 (0x3FF67000), master mode (i2c_reg.h, i2c_ll.h,
 * TRM v5.8 "I2C Controller") — BT36. Transaction level: the attached devices (the bench's
 * I2cDevices) see start/write/read/stop, never SDA/SCL edges.
 *
 * Registers: SCL_LOW_PERIOD (0x00) and SCL_HIGH_PERIOD (0x38) in APB cycles — an SCL period is
 * their sum (IDF's i2c_ll_cal_bus_clk splits APB / f_scl in two); CTR (0x04: MS_MODE 4,
 * TRANS_START 5); SR (0x08: ACK_REC 0, BUS_BUSY 4, RXFIFO_CNT 13:8, TXFIFO_CNT 23:18); FIFO_CONF
 * (0x18: RX_FIFO_RST 12, TX_FIFO_RST 13); DATA (0x1C: a write pushes the 32-byte TX FIFO — IDF
 * writes it through the AHB alias 0x6001301C / 0x6002701C — a read pops the 32-byte RX FIFO);
 * INT_RAW/CLR/ENA/STATUS (0x20–0x2C: END_DETECT 3, TRANS_COMPLETE 7, ACK_ERR 10); COMD0–15
 * (0x58–0x94: byte_num 7:0, ack_check_en 8, ack_exp 9, ack_value 10, op_code 13:11 — 0 RESTART,
 * 1 WRITE, 2 READ, 3 STOP, 4 END — done 31). The rest is storage.
 *
 * TRANS_START runs the command list from COMD0, one command per timed event: RESTART takes one
 * SCL period, each WRITE/READ byte nine (eight bits and the ACK), STOP one. A WRITE's first byte
 * after RESTART is the address: the device with that address gets start(read) and ACKs; nobody
 * answering is a NACK. With ack_check_en, a received ACK other than ack_exp raises ACK_ERR and
 * ends the transaction (the device gets stop()). READ bytes go to the RX FIFO (`ack` = the
 * command's ack_value is 0). END raises END_DETECT and waits for the next TRANS_START, which runs
 * COMD0 again with the bus still held — IDF's i2c_master_cmd_begin refills the list that way;
 * STOP raises TRANS_COMPLETE. Interrupts (INT_RAW & INT_ENA) drive matrix source 49 / 50.
 * TIME_OUT and ARBITRATION_LOST never happen (devices answer at once, single master); clock
 * stretching and slave mode aren't modeled.
 */

import type { I2cDevice } from '@benchtop/core';
import type { SocContext } from './context.ts';
import { REF_HZ } from './context.ts';
import { RegisterFile } from './periph.ts';

export const I2C_BASES = [0x3ff53000, 0x3ff67000] as const;
const SCL_LOW = 0x00;
const CTR = 0x04;
const SR = 0x08;
const FIFO_CONF = 0x18;
const DATA = 0x1c;
const INT_RAW = 0x20;
const INT_CLR = 0x24;
const INT_ENA = 0x28;
const INT_STATUS = 0x2c;
const SCL_HIGH = 0x38;
const COMD0 = 0x58;
const TRANS_START = 1 << 5;
const RX_FIFO_RST = 1 << 12;
const TX_FIFO_RST = 1 << 13;
const END_DETECT = 1 << 3;
const TRANS_COMPLETE = 1 << 7;
const ACK_ERR = 1 << 10;
const DONE = 1 << 31;
const OP_RESTART = 0;
const OP_WRITE = 1;
const OP_READ = 2;
const OP_STOP = 3;
const OP_END = 4;
const FIFO = 32;
const SOURCES = [49, 50] as const;

export class I2c extends RegisterFile {
  readonly index: number;
  /** The devices on this controller's bus (the Mcu adapter keeps the list across resets). */
  devices: readonly I2cDevice[] = [];
  /** Transactions run (reports, tests). */
  transactions = 0;
  /** Each transaction (START … STOP or NACK) as it ends: its start, end (reference cycles), bytes. */
  onTransaction: ((start: number, end: number, bytes: number) => void) | null = null;
  private transactionStart = 0;
  private transactionBytes = 0;
  private readonly context: SocContext;
  private readonly tx = new Uint8Array(FIFO);
  private txHead = 0;
  private txCount = 0;
  private readonly rx = new Uint8Array(FIFO);
  private rxHead = 0;
  private rxCount = 0;
  private readonly slot: number;
  /** The command now running (−1: idle), and when it started. */
  private cmd = -1;
  private commandStart = 0;
  /** A RESTART was just issued: the next written byte is an address. */
  private addressNext = false;
  private device: I2cDevice | null = null;
  private busy = false;
  private lastAck = 0;
  private sourceHigh = false;

  constructor(context: SocContext, index: number) {
    super(I2C_BASES[index]);
    this.index = index;
    this.context = context;
    this.slot = context.events.add(() => this.commandDone());
  }

  implements(offset: number): boolean {
    return offset <= COMD0 + 15 * 4 || offset === 0xf8;
  }

  override systemReset(_rtcDomain: boolean): void {
    this.reset();
    this.context.events.cancel(this.slot);
    this.txHead = this.txCount = this.rxHead = this.rxCount = 0;
    this.cmd = -1;
    if (this.device !== null) this.device.stop();
    this.device = null;
    this.busy = false;
    this.updateInterrupt();
  }

  /** Reference cycles per SCL period. */
  private sclPeriod(): number {
    const cycles = (this.regs[SCL_LOW >>> 2] & 0x3fff) + (this.regs[SCL_HIGH >>> 2] & 0x3fff) || 800;
    return (cycles / this.context.apbHz) * REF_HZ;
  }

  override read32(offset: number): number {
    switch (offset) {
      case DATA: {
        if (this.rxCount === 0) return 0;
        const byte = this.rx[this.rxHead];
        this.rxHead = (this.rxHead + 1) % FIFO;
        this.rxCount--;
        return byte;
      }
      case SR:
        return ((this.regs[SR >>> 2] & ~((1 << 0) | (1 << 4) | (0x3f << 8) | (0x3f << 18))) | this.lastAck | (this.busy ? 1 << 4 : 0) | (this.rxCount << 8) | (this.txCount << 18)) >>> 0;
      case INT_STATUS:
        return this.regs[INT_RAW >>> 2] & this.regs[INT_ENA >>> 2];
      default:
        return super.read32(offset);
    }
  }

  override write32(offset: number, value: number): void {
    switch (offset) {
      case DATA:
        if (this.txCount < FIFO) {
          this.tx[(this.txHead + this.txCount) % FIFO] = value & 0xff;
          this.txCount++;
        }
        return;
      case SR:
      case INT_RAW:
      case INT_STATUS:
        return;
      case INT_CLR:
        this.regs[INT_RAW >>> 2] &= ~value;
        this.updateInterrupt();
        return;
      case INT_ENA:
        super.write32(offset, value);
        this.updateInterrupt();
        return;
      case FIFO_CONF:
        super.write32(offset, value);
        if ((value & TX_FIFO_RST) !== 0) this.txHead = this.txCount = 0;
        if ((value & RX_FIFO_RST) !== 0) this.rxHead = this.rxCount = 0;
        return;
      case CTR:
        super.write32(offset, value & ~TRANS_START);
        if ((value & TRANS_START) !== 0 && this.cmd < 0) this.startCommand(0);
        return;
      default:
        super.write32(offset, value);
    }
  }

  private command(i: number): number {
    return this.regs[(COMD0 >>> 2) + i];
  }

  /** Starts command `i`: schedules its completion. */
  private startCommand(i: number): void {
    if (i >= 16) {
      this.cmd = -1;
      return;
    }
    this.cmd = i;
    this.commandStart = this.context.now();
    const c = this.command(i);
    const op = (c >>> 11) & 7;
    const bytes = c & 0xff;
    let periods = 0;
    if (op === OP_RESTART || op === OP_STOP) periods = 1;
    else if (op === OP_WRITE || op === OP_READ) periods = 9 * bytes;
    this.context.events.schedule(this.slot, this.context.now() + periods * this.sclPeriod());
  }

  /** Command `cmd` finished: do what it did on the bus, mark it done, go on. */
  private commandDone(): void {
    const i = this.cmd;
    if (i < 0) return;
    const c = this.command(i);
    const op = (c >>> 11) & 7;
    const bytes = c & 0xff;
    const ackCheck = (c & (1 << 8)) !== 0;
    const ackExp = (c >>> 9) & 1;
    const ackValue = (c >>> 10) & 1;
    this.regs[(COMD0 >>> 2) + i] = (c | DONE) >>> 0;
    switch (op) {
      case OP_RESTART:
        if (!this.busy) {
          this.transactionStart = this.commandStart;
          this.transactionBytes = 0;
        }
        this.busy = true;
        this.addressNext = true;
        break;
      case OP_WRITE:
        for (let b = 0; b < bytes; b++) {
          const byte = this.popTx();
          this.transactionBytes++;
          let ack: boolean;
          if (this.addressNext) {
            this.addressNext = false;
            this.transactions++;
            const address = byte >>> 1;
            this.device = null;
            for (let d = 0; d < this.devices.length; d++) {
              if (this.devices[d].address === address) {
                this.device = this.devices[d];
                break;
              }
            }
            ack = this.device !== null && this.device.start((byte & 1) === 1);
            if (!ack) this.device = null;
          } else ack = this.device !== null && this.device.write(byte);
          this.lastAck = ack ? 0 : 1;
          if (ackCheck && this.lastAck !== ackExp) {
            this.fail();
            return;
          }
        }
        break;
      case OP_READ:
        for (let b = 0; b < bytes; b++) {
          const byte = this.device === null ? 0xff : this.device.read(ackValue === 0) & 0xff;
          this.transactionBytes++;
          if (this.rxCount < FIFO) {
            this.rx[(this.rxHead + this.rxCount) % FIFO] = byte;
            this.rxCount++;
          }
        }
        break;
      case OP_STOP:
        this.device?.stop();
        this.device = null;
        this.busy = false;
        this.cmd = -1;
        this.onTransaction?.(this.transactionStart, this.context.now(), this.transactionBytes);
        this.raise(TRANS_COMPLETE);
        return;
      case OP_END:
        this.cmd = -1;
        this.raise(END_DETECT);
        return;
      default:
        break;
    }
    this.startCommand(i + 1);
  }

  /** A NACK where the command expected an ACK: the transaction ends. */
  private fail(): void {
    this.device?.stop();
    this.device = null;
    this.busy = false;
    this.cmd = -1;
    this.onTransaction?.(this.transactionStart, this.context.now(), this.transactionBytes);
    this.raise(ACK_ERR);
  }

  private popTx(): number {
    if (this.txCount === 0) return 0xff;
    const byte = this.tx[this.txHead];
    this.txHead = (this.txHead + 1) % FIFO;
    this.txCount--;
    return byte;
  }

  private raise(bits: number): void {
    this.regs[INT_RAW >>> 2] |= bits;
    this.updateInterrupt();
  }

  private updateInterrupt(): void {
    const high = (this.regs[INT_RAW >>> 2] & this.regs[INT_ENA >>> 2]) !== 0;
    if (high === this.sourceHigh) return;
    this.sourceHigh = high;
    this.context.interrupts.setSource(SOURCES[this.index], high);
  }
}
