/**
 * The ESP32-C3's Remote Control peripheral, transmit side (BT93; rmt_reg.h, IDF 4.4's C3
 * rmt_ll.h, TRM §32), at 0x60016000 with its RAM at +0x400: TX channels 0 and 1 (2 and 3 receive —
 * not modeled), each with 48 items of RAM from block n (MEM_SIZE blocks).
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

import { REF_HZ, type SocContext, XTAL_HZ } from './context.ts';
import { SRC } from './intmatrix.ts';
import { RegisterFile } from './periph.ts';

export const RMT_BASE = 0x60016000;
export const RMT_SIGNAL_BASE = 51;
export const RMT_TX_CHANNELS = 2;
export const CODE_RMT_UNSUPPORTED = 'esp32c3-rmt-unsupported';
const TX_CONF0 = 0x10;
const RX_CONF0 = 0x18;
const TX_STATUS = 0x28;
const INT_RAW = 0x38;
const INT_ST = 0x3c;
const INT_ENA = 0x40;
const INT_CLR = 0x44;
const TX_LIM = 0x58;
const SYS_CONF = 0x68;
const RAM = 0x400;
const RAM_WORD = RAM >>> 2;
const WORDS_PER_CHANNEL = 48;
const RAM_WORDS = 4 * WORDS_PER_CHANNEL;
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
  readonly level = new Uint8Array(RMT_TX_CHANNELS);
  onOutput: (() => void) | null = null;
  items = 0;
  private readonly ctx: SocContext;
  private readonly slots: number[] = [];
  private readonly active = new Uint8Array(RMT_TX_CHANNELS);
  private readonly pointer = new Uint16Array(RMT_TX_CHANNELS);
  private readonly half = new Uint8Array(RMT_TX_CHANNELS);
  private readonly sent = new Uint32Array(RMT_TX_CHANNELS);
  private readonly halfEnd = new Float64Array(RMT_TX_CHANNELS);
  private sourceHigh = false;

  constructor(ctx: SocContext) {
    super(RMT_BASE);
    this.ctx = ctx;
    for (let c = 0; c < RMT_TX_CHANNELS; c++) this.slots.push(ctx.events.add(() => this.halfDone(c)));
  }

  implements(offset: number): boolean {
    return (offset >= TX_CONF0 && offset <= 0x70) || offset === 0xcc || (offset >= RAM && offset < RAM + RAM_WORDS * 4);
  }

  override systemReset(_rtcDomain: boolean): void {
    this.reset();
    for (let c = 0; c < RMT_TX_CHANNELS; c++) this.ctx.events.cancel(this.slots[c]);
    this.active.fill(0);
    this.pointer.fill(0);
    this.half.fill(0);
    this.sent.fill(0);
    let changed = false;
    for (let c = 0; c < RMT_TX_CHANNELS; c++) {
      const v = this.idleLevel(c);
      if (v !== this.level[c]) changed = true;
      this.level[c] = v;
    }
    if (changed) this.onOutput?.();
    this.updateInterrupt();
  }

  private conf(c: number): number {
    return this.regs[(TX_CONF0 >>> 2) + c];
  }

  private idleLevel(c: number): number {
    const conf = this.conf(c);
    return (conf & IDLE_OUT_EN) !== 0 && (conf & IDLE_OUT_LV) !== 0 ? 1 : 0;
  }

  /** Reference cycles per tick of channel c. */
  private tick(c: number): number {
    const sys = this.regs[SYS_CONF >>> 2];
    const sel = (sys >>> 24) & 3;
    const source = sel === 1 ? this.ctx.apbHz : sel === 2 ? RC_FAST_HZ : XTAL_HZ;
    const b = (sys >>> 18) & 0x3f;
    const divider = ((sys >>> 4) & 0xff) + 1 + (b === 0 ? 0 : ((sys >>> 12) & 0x3f) / b);
    const div = (this.conf(c) >>> 8) & 0xff || 256;
    return (div * divider * REF_HZ) / source;
  }

  private memItems(c: number): number {
    return Math.max(1, (this.conf(c) >>> 16) & 7) * WORDS_PER_CHANNEL;
  }

  override read32(offset: number): number {
    if (offset === TX_STATUS || offset === TX_STATUS + 4) {
      const c = (offset - TX_STATUS) >>> 2;
      return ((this.active[c] << 9) | ((c * WORDS_PER_CHANNEL + this.pointer[c]) & 0x1ff)) >>> 0;
    }
    if (offset === INT_ST) return (this.regs[INT_RAW >>> 2] & this.regs[INT_ENA >>> 2]) >>> 0;
    return super.read32(offset);
  }

  override write32(offset: number, value: number): void {
    if (offset >= RAM) {
      super.write32(offset, value);
      return;
    }
    if (offset < TX_CONF0) {
      this.unsupported('the APB FIFO access through CHnDATA is not emulated; use direct RAM access');
      return;
    }
    if (offset < RX_CONF0) {
      const c = (offset - TX_CONF0) >>> 2;
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
    if (offset < TX_STATUS) {
      super.write32(offset, value);
      if ((offset === RX_CONF0 + 4 || offset === RX_CONF0 + 12) && (value & 1) !== 0) this.unsupported('RMT receive is not emulated');
      return;
    }
    switch (offset) {
      case TX_STATUS:
      case TX_STATUS + 4:
      case TX_STATUS + 8:
      case TX_STATUS + 12:
      case INT_RAW:
      case INT_ST:
        return;
      case INT_CLR:
        this.regs[INT_RAW >>> 2] &= ~value;
        this.updateInterrupt();
        return;
      case INT_ENA:
        super.write32(offset, value);
        this.updateInterrupt();
        return;
      default:
        super.write32(offset, value);
    }
  }

  private start(c: number): void {
    if ((this.conf(c) & CARRIER_EN) !== 0) this.unsupported(`channel ${c}: carrier modulation is not emulated; the levels go out unmodulated`);
    if ((this.regs[SYS_CONF >>> 2] & 1) === 0) this.unsupported('the APB FIFO access mode (SYS_CONF APB_FIFO_MASK = 0) is not emulated; the channel sends its RAM as written directly');
    this.active[c] = 1;
    this.sent[c] = 0;
    this.half[c] = 2;
    const t = Math.ceil(this.ctx.now());
    this.halfEnd[c] = t;
    this.ctx.events.schedule(this.slots[c], t);
    this.ctx.hurry(t);
  }

  private send(c: number, t: number): void {
    const word = this.regs[RAM_WORD + ((c * WORDS_PER_CHANNEL + this.pointer[c]) % RAM_WORDS)];
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
    const lim = this.regs[(TX_LIM >>> 2) + c] & 0x1ff;
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
    this.regs[(TX_CONF0 >>> 2) + c] &= ~TX_START;
    this.ctx.events.cancel(this.slots[c]);
    this.setLevel(c, this.idleLevel(c));
  }

  private setLevel(c: number, v: number): void {
    if (this.level[c] === v) return;
    this.level[c] = v;
    this.onOutput?.();
  }

  private raise(bits: number): void {
    this.regs[INT_RAW >>> 2] |= bits;
    this.updateInterrupt();
  }

  private updateInterrupt(): void {
    const high = (this.regs[INT_RAW >>> 2] & this.regs[INT_ENA >>> 2]) !== 0;
    if (high === this.sourceHigh) return;
    this.sourceHigh = high;
    this.ctx.matrix.setSource(SRC.RMT, high);
  }

  private unsupported(what: string): void {
    this.ctx.problems.report('warning', CODE_RMT_UNSUPPORTED, RMT_BASE, `RMT: ${what}.`);
  }
}
