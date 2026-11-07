/**
 * The ESP32-C3's I2C controller, master mode (BT93; i2c_reg.h, IDF's C3 i2c_ll.h, TRM §28), at
 * 0x60013000 — transaction level, as on the ESP32 (@benchtop/esp32's i2c.ts, whose command engine
 * this follows): the attached devices (the bench's I2cDevices) see start/write/read/stop, never
 * SDA/SCL edges.
 *
 * What differs from the ESP32: eight command registers (COMD0–7, 0x58–0x74) whose op codes are
 * RESTART 6, WRITE 1, READ 3, STOP 2, END 4 (byte_num 7:0, ack_check_en 8, ack_exp 9, ack_value
 * 10, op_code 13:11, done 31); the bus clock comes from CLK_CONF (0x54: SCLK_DIV_NUM 7:0, SCLK_SEL
 * 20 — 0 the 40 MHz crystal, 1 RC_FAST), an SCL period being (SCL_LOW_PERIOD + 1) +
 * SCL_HIGH_PERIOD (8:0) + its WAIT_HIGH (15:9) sclk cycles (i2c_ll_get_scl_timing); CTR's
 * CONF_UPGATE (11) and FSM_RST (10) read back 0, and so does SCL_SP_CONF's SCL_RST_SLV_EN (0x80,
 * bit 0 — the bus-clear pulses IDF sends after a NACK's FSM reset take no time). FIFO_DATA (0x1C) pushes the 32-byte TX FIFO on a
 * write and pops the RX FIFO on a read — IDF writes it with a read-modify-write, harmless while
 * the RX FIFO is empty, as it is then. SR: RESP_REC 0, BUS_BUSY 4, RXFIFO_CNT 13:8, TXFIFO_CNT
 * 23:18. Interrupts (INT_RAW 0x20, CLR 0x24, ENA 0x28, STATUS 0x2C): END_DETECT 3, TRANS_COMPLETE
 * 7, NACK 10; source 29. Each command takes its time on the bus (RESTART and STOP one SCL period,
 * a byte nine); END waits for the next TRANS_START with the bus held. Single master: no
 * arbitration loss, no timeouts, no clock stretching, no slave mode.
 */

import type { I2cDevice } from '@benchtop/core';
import { type SocContext, XTAL_HZ } from './context.ts';
import { SRC } from './intmatrix.ts';
import { RegisterFile } from './periph.ts';

export const I2C_BASE = 0x60013000;
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
const CLK_CONF = 0x54;
const COMD0 = 0x58;
const SCL_SP_CONF = 0x80;
const COMMANDS = 8;
const TRANS_START = 1 << 5;
const FSM_RST = 1 << 10;
const CONF_UPGATE = 1 << 11;
const RX_FIFO_RST = 1 << 12;
const TX_FIFO_RST = 1 << 13;
const END_DETECT = 1 << 3;
const TRANS_COMPLETE = 1 << 7;
const NACK = 1 << 10;
const DONE = 1 << 31;
const OP_WRITE = 1;
const OP_STOP = 2;
const OP_READ = 3;
const OP_END = 4;
const OP_RESTART = 6;
const FIFO = 32;
const RC_FAST_HZ = 17_500_000;

export class I2c extends RegisterFile {
  /** The devices on the bus (the Mcu adapter keeps the list across resets). */
  devices: readonly I2cDevice[] = [];
  transactions = 0;
  /** Each transaction (START … STOP or NACK) as it ends: its start, end (reference cycles), bytes. */
  onTransaction: ((start: number, end: number, bytes: number) => void) | null = null;
  private transactionStart = 0;
  private transactionBytes = 0;
  private readonly ctx: SocContext;
  private readonly tx = new Uint8Array(FIFO);
  private txHead = 0;
  private txCount = 0;
  private readonly rx = new Uint8Array(FIFO);
  private rxHead = 0;
  private rxCount = 0;
  private readonly slot: number;
  private cmd = -1;
  private commandStart = 0;
  private addressNext = false;
  private device: I2cDevice | null = null;
  private busy = false;
  private lastAck = 0;
  private sourceHigh = false;

  /** BT124: the interrupt source (the S3 has two controllers). */
  private readonly source: number;

  constructor(ctx: SocContext, base: number = I2C_BASE, source: number = SRC.I2C0) {
    super(base, (address) => ctx.regDefault(address));
    this.ctx = ctx;
    this.source = source;
    this.slot = ctx.events.add(() => this.commandDone());
  }

  implements(offset: number): boolean {
    return offset <= 0x84 || offset === 0xf8;
  }

  override systemReset(_rtcDomain: boolean): void {
    this.reset();
    this.ctx.events.cancel(this.slot);
    this.txHead = this.txCount = this.rxHead = this.rxCount = 0;
    this.cmd = -1;
    if (this.device !== null) this.device.stop();
    this.device = null;
    this.busy = false;
    this.updateInterrupt();
  }

  /** Reference cycles per SCL period. */
  private sclPeriod(): number {
    const clk = this.regs[CLK_CONF >>> 2];
    const sclk = ((clk & (1 << 20)) !== 0 ? RC_FAST_HZ : XTAL_HZ) / ((clk & 0xff) + 1);
    const high = this.regs[SCL_HIGH >>> 2];
    const cycles = (this.regs[SCL_LOW >>> 2] & 0x1ff) + 1 + (high & 0x1ff) + ((high >>> 9) & 0x7f);
    return cycles <= 1 ? this.ctx.refHz / 100_000 : (cycles / sclk) * this.ctx.refHz;
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
        return (this.regs[INT_RAW >>> 2] & this.regs[INT_ENA >>> 2]) >>> 0;
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
      case SCL_SP_CONF:
        // SCL_RST_SLV_EN (bit 0): the SCL_RST_SLV_NUM recovery pulses go out at once, and it clears
        // (IDF's i2c_ll_master_clr_bus waits for that after every NACK's FSM reset).
        super.write32(offset, value & ~1);
        return;
      case CTR:
        super.write32(offset, value & ~(TRANS_START | FSM_RST | CONF_UPGATE));
        if ((value & FSM_RST) !== 0) this.abort();
        if ((value & TRANS_START) !== 0 && this.cmd < 0) this.startCommand(0);
        return;
      default:
        super.write32(offset, value);
    }
  }

  /** FSM_RST: the controller drops what it was doing (the bus is released). */
  private abort(): void {
    this.ctx.events.cancel(this.slot);
    this.cmd = -1;
    this.device?.stop();
    this.device = null;
    this.busy = false;
  }

  private command(i: number): number {
    return this.regs[(COMD0 >>> 2) + i];
  }

  private startCommand(i: number): void {
    if (i >= COMMANDS) {
      this.cmd = -1;
      return;
    }
    this.cmd = i;
    this.commandStart = this.ctx.now();
    const c = this.command(i);
    const op = (c >>> 11) & 7;
    const bytes = c & 0xff;
    let periods = 0;
    if (op === OP_RESTART || op === OP_STOP) periods = 1;
    else if (op === OP_WRITE || op === OP_READ) periods = 9 * bytes;
    const when = this.ctx.now() + periods * this.sclPeriod();
    this.ctx.events.schedule(this.slot, when);
    this.ctx.hurry(when);
  }

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
        this.onTransaction?.(this.transactionStart, this.ctx.now(), this.transactionBytes);
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

  private fail(): void {
    this.device?.stop();
    this.device = null;
    this.busy = false;
    this.cmd = -1;
    this.onTransaction?.(this.transactionStart, this.ctx.now(), this.transactionBytes);
    this.raise(NACK);
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
    this.ctx.matrix.setSource(this.source, high);
  }
}
