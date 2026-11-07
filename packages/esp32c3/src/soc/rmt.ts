/**
 * The ESP32-C3's Remote Control peripheral, transmit side (BT93; rmt_reg.h, IDF 4.4's C3
 * rmt_ll.h, TRM §32), at 0x60016000 with its RAM at +0x400: TX channels 0 and 1 (2 and 3 receive —
 * not modeled), each with 48 items of RAM from block n (MEM_SIZE blocks). BT125: the S3's layout
 * (`S3_RMT_LAYOUT`): 4 TX of 8 channels, its RAM at +0x800.
 *
 * TX_CONF0 (0x10 + 4n): TX_START 0, MEM_RD_RST 1, TX_CONTI_MODE 3, MEM_TX_WRAP_EN 4, IDLE_OUT_LV
 * 5, IDLE_OUT_EN 6, TX_STOP 7, DIV_CNT 15:8 (0 meaning 256), MEM_SIZE 18:16, CARRIER_EN 21,
 * CONF_UPDATE 24 (reads 0). The channel clock is SYS_CONF's (0x68: SCLK_SEL 25:24 — 1 APB,
 * 2 RC_FAST, 3 XTAL —, SCLK_DIV_NUM 11:4 + 1 with the A/B fraction 17:12 / 23:18) divided by
 * DIV_CNT. An item is {duration0 14:0, level0 15, duration1 30:16, level1 31}, as on the ESP32: a
 * zero duration ends the transmission (TX_END, INT_RAW bit n, and the idle level), TX_CONTI_MODE
 * starts over, every TX_LIM (0x58 + 4n, 8:0) items raise TX_THR (bit 8 + n), the end of the
 * channel's memory wraps with MEM_TX_WRAP_EN or ends with TX_ERR (bit 4 + n). INT_RAW 0x38, ST
 * 0x3C, ENA 0x40, CLR 0x44 drive source 28. Each half item is an event at its exact time (whole
 * reference cycles), so a WS2812 part decodes from the edge timestamps — the ESP32's scheduling
 * (@benchtop/esp32's rmt.ts). Outputs are RMT_SIG_OUT0/1 (signals 51/52). Receive, the carrier
 * and the APB FIFO (SYS_CONF.APB_FIFO_MASK = 0, CHnDATA) report `esp32c3-rmt-unsupported` once.
 */

import { type SocContext, XTAL_HZ } from './context.ts';
import { SRC } from './intmatrix.ts';
import { RegisterFile } from './periph.ts';

export const RMT_BASE = 0x60016000;
export const RMT_SIGNAL_BASE = 51;
export const RMT_TX_CHANNELS = 2;
export const CODE_RMT_UNSUPPORTED = 'esp32c3-rmt-unsupported';
const WORDS_PER_CHANNEL = 48;

/**
 * BT125: where a chip's RMT keeps its registers — the C3's (2 TX of 4 channels), or the S3's (4 TX
 * of 8: TX_CONF0 0x20, RX 0x30, TX_STATUS 0x50, INT 0x70, TX_LIM 0xA0, SYS_CONF 0xC0). The fields
 * and interrupt bits (TX_END n, ERR 4 + n, TX_THR 8 + n) are the same.
 */
export interface RmtLayout {
  txChannels: number;
  channels: number;
  txConf0: number;
  rxConf0: number;
  txStatus: number;
  intRaw: number;
  txLim: number;
  sysConf: number;
  /** The last register offset the model answers (below the RAM). */
  last: number;
  /** The channels' RAM (RMTMEM): +0x400 on the C3, +0x800 on the S3. */
  ram: number;
}

export const C3_RMT_LAYOUT: RmtLayout = { txChannels: 2, channels: 4, txConf0: 0x10, rxConf0: 0x18, txStatus: 0x28, intRaw: 0x38, txLim: 0x58, sysConf: 0x68, last: 0x70, ram: 0x400 };
export const S3_RMT_LAYOUT: RmtLayout = { txChannels: 4, channels: 8, txConf0: 0x20, rxConf0: 0x30, txStatus: 0x50, intRaw: 0x70, txLim: 0xa0, sysConf: 0xc0, last: 0xc8, ram: 0x800 };
const TX_START = 1 << 0;
const MEM_RD_RST = 1 << 1;
const TX_CONTI = 1 << 3;
const WRAP_EN = 1 << 4;
const IDLE_OUT_LV = 1 << 5;
const IDLE_OUT_EN = 1 << 6;
const TX_STOP = 1 << 7;
const CARRIER_EN = 1 << 21;
const CONF_UPDATE = 1 << 24;
const RC_FAST_HZ = 17_500_000;

export class Rmt extends RegisterFile {
  readonly level: Uint8Array;
  onOutput: (() => void) | null = null;
  items = 0;
  private readonly ctx: SocContext;
  private readonly slots: number[] = [];
  private readonly active: Uint8Array;
  private readonly pointer: Uint16Array;
  private readonly half: Uint8Array;
  private readonly sent: Uint32Array;
  private readonly halfEnd: Float64Array;
  private sourceHigh = false;

  /** BT124: the interrupt source (the S3's differs). */
  private readonly source: number;
  /** BT125: the chip's register layout. */
  private readonly layout: RmtLayout;
  private readonly tx: number;
  private readonly ramWords: number;

  constructor(ctx: SocContext, source: number = SRC.RMT, layout: RmtLayout = C3_RMT_LAYOUT) {
    super(RMT_BASE, (address) => ctx.regDefault(address));
    this.ctx = ctx;
    this.source = source;
    this.layout = layout;
    this.tx = layout.txChannels;
    this.ramWords = layout.channels * WORDS_PER_CHANNEL;
    this.level = new Uint8Array(this.tx);
    this.active = new Uint8Array(this.tx);
    this.pointer = new Uint16Array(this.tx);
    this.half = new Uint8Array(this.tx);
    this.sent = new Uint32Array(this.tx);
    this.halfEnd = new Float64Array(this.tx);
    for (let c = 0; c < this.tx; c++) this.slots.push(ctx.events.add(() => this.halfDone(c)));
    this.systemReset(true);
  }

  implements(offset: number): boolean {
    const ram = this.layout.ram;
    return (offset >= this.layout.txConf0 && offset <= this.layout.last) || offset === 0xcc || (offset >= ram && offset < ram + this.ramWords * 4);
  }

  override systemReset(_rtcDomain: boolean): void {
    this.reset();
    if (this.layout === undefined) return; // RegisterFile's constructor, before ours ran
    for (let c = 0; c < this.tx; c++) this.ctx.events.cancel(this.slots[c]);
    this.active.fill(0);
    this.pointer.fill(0);
    this.half.fill(0);
    this.sent.fill(0);
    let changed = false;
    for (let c = 0; c < this.tx; c++) {
      const v = this.idleLevel(c);
      if (v !== this.level[c]) changed = true;
      this.level[c] = v;
    }
    if (changed) this.onOutput?.();
    this.updateInterrupt();
  }

  private conf(c: number): number {
    return this.regs[(this.layout.txConf0 >>> 2) + c];
  }

  private idleLevel(c: number): number {
    const conf = this.conf(c);
    return (conf & IDLE_OUT_EN) !== 0 && (conf & IDLE_OUT_LV) !== 0 ? 1 : 0;
  }

  /** Reference cycles per tick of channel c. */
  private tick(c: number): number {
    const sys = this.regs[this.layout.sysConf >>> 2];
    const sel = (sys >>> 24) & 3;
    const source = sel === 1 ? this.ctx.apbHz : sel === 2 ? RC_FAST_HZ : XTAL_HZ;
    const b = (sys >>> 18) & 0x3f;
    const divider = ((sys >>> 4) & 0xff) + 1 + (b === 0 ? 0 : ((sys >>> 12) & 0x3f) / b);
    const div = (this.conf(c) >>> 8) & 0xff || 256;
    return (div * divider * this.ctx.refHz) / source;
  }

  private memItems(c: number): number {
    return Math.max(1, (this.conf(c) >>> 16) & 7) * WORDS_PER_CHANNEL;
  }

  override read32(offset: number): number {
    const L = this.layout;
    if (offset >= L.txStatus && offset < L.txStatus + this.tx * 4) {
      const c = (offset - L.txStatus) >>> 2;
      return ((this.active[c] << 9) | ((c * WORDS_PER_CHANNEL + this.pointer[c]) & 0x1ff)) >>> 0;
    }
    if (offset === L.intRaw + 4) return (this.regs[L.intRaw >>> 2] & this.regs[(L.intRaw + 8) >>> 2]) >>> 0; // INT_ST
    return super.read32(offset);
  }

  override write32(offset: number, value: number): void {
    const L = this.layout;
    if (offset >= L.ram) {
      super.write32(offset, value);
      return;
    }
    if (offset < L.txConf0) {
      this.unsupported('the APB FIFO access through CHnDATA is not emulated; use direct RAM access');
      return;
    }
    if (offset < L.rxConf0) {
      const c = (offset - L.txConf0) >>> 2;
      super.write32(offset, value & ~(CONF_UPDATE | TX_STOP | MEM_RD_RST));
      if ((value & MEM_RD_RST) !== 0) {
        this.pointer[c] = 0;
        this.half[c] = 0;
      }
      if ((value & TX_STOP) !== 0 && this.active[c] !== 0) this.stop(c);
      else if ((value & TX_START) !== 0 && this.active[c] === 0) this.start(c);
      else if (this.active[c] === 0) this.setLevel(c, this.idleLevel(c));
      return;
    }
    if (offset < L.txStatus) {
      super.write32(offset, value);
      if ((offset - L.rxConf0) % 8 === 4 && (value & 1) !== 0) this.unsupported('RMT receive is not emulated');
      return;
    }
    if (offset < L.intRaw) return; // the channels' STATUS registers
    if (offset === L.intRaw || offset === L.intRaw + 4) return; // INT_RAW, INT_ST
    if (offset === L.intRaw + 12) {
      // INT_CLR
      this.regs[L.intRaw >>> 2] &= ~value;
      this.updateInterrupt();
      return;
    }
    super.write32(offset, value);
    if (offset === L.intRaw + 8) this.updateInterrupt(); // INT_ENA
  }

  private start(c: number): void {
    if ((this.conf(c) & CARRIER_EN) !== 0) this.unsupported(`channel ${c}: carrier modulation is not emulated; the levels go out unmodulated`);
    if ((this.regs[this.layout.sysConf >>> 2] & 1) === 0) this.unsupported('the APB FIFO access mode (SYS_CONF APB_FIFO_MASK = 0) is not emulated; the channel sends its RAM as written directly');
    this.active[c] = 1;
    this.sent[c] = 0;
    this.half[c] = 2;
    const t = Math.ceil(this.ctx.now());
    this.halfEnd[c] = t;
    this.ctx.events.schedule(this.slots[c], t);
    this.ctx.hurry(t);
  }

  private send(c: number, t: number): void {
    const word = this.regs[(this.layout.ram >>> 2) + ((c * WORDS_PER_CHANNEL + this.pointer[c]) % this.ramWords)];
    const h = this.half[c];
    const duration = h === 0 ? word & 0x7fff : (word >>> 16) & 0x7fff;
    if (duration === 0) {
      this.raise(1 << c);
      if ((this.conf(c) & TX_CONTI) !== 0 && (this.pointer[c] !== 0 || h !== 0)) {
        this.pointer[c] = 0;
        this.half[c] = 0;
        this.send(c, t);
        return;
      }
      this.stop(c);
      return;
    }
    this.setLevel(c, h === 0 ? (word >>> 15) & 1 : word >>> 31);
    const end = Math.ceil(t + duration * this.tick(c));
    this.halfEnd[c] = end;
    this.ctx.events.schedule(this.slots[c], end);
  }

  private halfDone(c: number): void {
    if (this.active[c] === 0) return;
    const t = this.halfEnd[c];
    if (this.half[c] !== 1) {
      this.half[c] = this.half[c] === 0 ? 1 : 0;
      this.send(c, t);
      return;
    }
    this.half[c] = 0;
    this.items++;
    this.sent[c]++;
    const lim = this.regs[(this.layout.txLim >>> 2) + c] & 0x1ff;
    if (lim !== 0 && this.sent[c] % lim === 0) this.raise(1 << (8 + c));
    if (++this.pointer[c] >= this.memItems(c)) {
      if ((this.conf(c) & WRAP_EN) === 0) {
        this.raise(1 << (4 + c));
        this.stop(c);
        return;
      }
      this.pointer[c] = 0;
    }
    this.send(c, t);
  }

  private stop(c: number): void {
    this.active[c] = 0;
    this.regs[(this.layout.txConf0 >>> 2) + c] &= ~TX_START;
    this.ctx.events.cancel(this.slots[c]);
    this.setLevel(c, this.idleLevel(c));
  }

  private setLevel(c: number, v: number): void {
    if (this.level[c] === v) return;
    this.level[c] = v;
    this.onOutput?.();
  }

  private raise(bits: number): void {
    this.regs[this.layout.intRaw >>> 2] |= bits;
    this.updateInterrupt();
  }

  private updateInterrupt(): void {
    const high = (this.regs[this.layout.intRaw >>> 2] & this.regs[(this.layout.intRaw + 8) >>> 2]) !== 0;
    if (high === this.sourceHigh) return;
    this.sourceHigh = high;
    this.ctx.matrix.setSource(this.source, high);
  }

  private unsupported(what: string): void {
    this.ctx.problems.report('warning', CODE_RMT_UNSUPPORTED, RMT_BASE, `RMT: ${what}.`);
  }
}
