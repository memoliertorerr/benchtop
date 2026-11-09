/**
 * The Remote Control peripheral (RMT, 0x3FF56000, its RAM RMTMEM at 0x3FF56800; rmt_reg.h,
 * rmt_struct.h, rmt_ll.h, TRM v5.8 "Remote Control Peripheral") — BT37, transmit only.
 *
 * 8 channels — CONF0 (0x20 + 8n: DIV_CNT 7:0, 0 meaning 256; MEM_SIZE 27:24; CARRIER_EN 28) and
 * CONF1 (0x24 + 8n: TX_START 0, RX_EN 1, MEM_RD_RST 3, TX_CONTI_MODE 6, REF_ALWAYS_ON 17 — 1 the
 * APB clock, 0 the 1 MHz REF_TICK — IDLE_OUT_LV 18, IDLE_OUT_EN 19) — share 512 words of RAM:
 * channel n's memory is MEM_SIZE blocks of 64 items from block n. An item is {duration0 14:0,
 * level0 15, duration1 30:16, level1 31}: level0 for duration0 ticks, then level1 for duration1.
 * A zero duration ends the transmission: TX_END (INT_RAW bit 3n) and the idle level (IDLE_OUT_LV
 * with IDLE_OUT_EN, else low); TX_CONTI_MODE starts over from the first item instead. Every
 * TX_LIM (0xD0 + 4n, bits 8:0) items sent raise TX_THR (bit 24 + n). At the end of the channel's
 * memory the read pointer wraps to its first item with APB_CONF MEM_TX_WRAP_EN (0xF0 bit 1) —
 * IDF's driver refills one half from the TX_THR interrupt while the other half goes out — and
 * without it the transmission ends with ERR (bit 3n + 2). A CONF1 write with TX_START set while
 * idle starts at the read pointer (on the next whole reference cycle); MEM_RD_RST puts the
 * pointer back on the first item. The transmission's end clears TX_START (inferred: IDF's TX_END
 * handler rewrites CONF1 with a read-modify-write and the channel doesn't start again, while
 * repeated rmt_write_items calls without a stop do start).
 * Interrupts (INT_RAW & INT_ENA = INT_ST; INT_CLR; 0xA0–0xAC) drive matrix source 47. STATUS
 * (0x60 + 4n) reads the state (26:24: 1 while sending) and the read address (21:12).
 *
 * Each half item is a timed event at its exact time — whole reference cycles for APB ticks (3 per
 * APB cycle at 80 MHz) — so a WS2812 part decodes from the edge timestamps. The outputs reach the
 * pads through the GPIO matrix as RMT_SIG_OUT0_IDX 87–94; `level` holds them and `onOutput` tells
 * the pad resolver. Receive, the carrier and the APB FIFO access through CHnDATA report
 * `esp32-rmt-unsupported` once and do nothing (the carrier: the levels go out unmodulated).
 */

import type { SocContext } from './context.ts';
import { REF_HZ } from './context.ts';
import { RegisterFile } from './periph.ts';

export const RMT_BASE = 0x3ff56000;
export const RMT_SIGNAL_BASE = 87;
export const CODE_RMT_UNSUPPORTED = 'esp32-rmt-unsupported';

/**
 * BT149: where a chip keeps this RMT's registers. The ESP32-S2's is the same peripheral — the same
 * CONF0/CONF1 fields, items and interrupts — with 4 channels at tighter offsets (CONF0 0x10 + 8n,
 * STATUS 0x30, INT_RAW 0x50, TX_LIM 0x70, APB_CONF 0x80, its RAM at +0x400 — RMTMEM 0x3F41_6400),
 * TX_THR at bit 12 + n, its own interrupt source and register defaults.
 */
export interface RmtLayout32 {
  readonly base: number;
  readonly channels: number;
  readonly conf0: number;
  readonly status: number;
  readonly intRaw: number;
  readonly txLim: number;
  readonly apbConf: number;
  readonly ram: number;
  /** TX_THR's first INT_RAW bit. */
  readonly thrBit: number;
  readonly source: number;
  readonly defaults?: (address: number) => number;
  readonly unsupportedCode: string;
}

export const ESP32_RMT_LAYOUT: RmtLayout32 = { base: RMT_BASE, channels: 8, conf0: 0x20, status: 0x60, intRaw: 0xa0, txLim: 0xd0, apbConf: 0xf0, ram: 0x800, thrBit: 24, source: 47, unsupportedCode: CODE_RMT_UNSUPPORTED };
const TX_START = 1 << 0;
const RX_EN = 1 << 1;
const MEM_RD_RST = 1 << 3;
const TX_CONTI = 1 << 6;
const REF_ALWAYS_ON = 1 << 17;
const IDLE_OUT_LV = 1 << 18;
const IDLE_OUT_EN = 1 << 19;
const CARRIER_EN = 1 << 28;
const FIFO_MASK = 1 << 0;
const WRAP_EN = 1 << 1;
const REF_TICK_HZ = 1_000_000;

export class Rmt extends RegisterFile {
  /** Output signal per channel. */
  readonly level: Uint8Array;
  /** An output level changed. */
  onOutput: (() => void) | null = null;
  /** Items sent (reports, tests). */
  items = 0;
  private readonly context: SocContext;
  private readonly L: RmtLayout32;
  private readonly slots: number[] = [];
  private readonly active: Uint8Array;
  /** The read pointer (an item of the channel's memory) and the half of it going out (2: starting). */
  private readonly pointer: Uint16Array;
  private readonly half: Uint8Array;
  /** Items sent since TX_START (TX_THR counts them). */
  private readonly sent: Uint32Array;
  /** When the half going out ends (reference cycles). */
  private readonly halfEnd: Float64Array;
  private sourceHigh = false;

  constructor(context: SocContext, layout: RmtLayout32 = ESP32_RMT_LAYOUT) {
    super(layout.base, layout.defaults);
    this.context = context;
    this.L = layout;
    const n = layout.channels;
    this.level = new Uint8Array(n);
    this.active = new Uint8Array(n);
    this.pointer = new Uint16Array(n);
    this.half = new Uint8Array(n);
    this.sent = new Uint32Array(n);
    this.halfEnd = new Float64Array(n);
    for (let c = 0; c < n; c++) this.slots.push(context.events.add(() => this.halfDone(c)));
  }

  implements(offset: number): boolean {
    return offset <= 0xfc || offset >= this.L.ram;
  }

  override systemReset(_rtcDomain: boolean): void {
    this.reset();
    for (let c = 0; c < this.L.channels; c++) this.context.events.cancel(this.slots[c]);
    this.active.fill(0);
    this.pointer.fill(0);
    this.half.fill(0);
    this.sent.fill(0);
    let changed = false;
    for (let c = 0; c < this.L.channels; c++) {
      const v = this.idleLevel(c);
      if (v !== this.level[c]) changed = true;
      this.level[c] = v;
    }
    if (changed) this.onOutput?.();
    this.updateInterrupt();
  }

  private conf0(c: number): number {
    return this.regs[(this.L.conf0 >>> 2) + 2 * c];
  }

  private conf1(c: number): number {
    return this.regs[(this.L.conf0 >>> 2) + 2 * c + 1];
  }

  private idleLevel(c: number): number {
    const conf1 = this.conf1(c);
    return (conf1 & IDLE_OUT_EN) !== 0 && (conf1 & IDLE_OUT_LV) !== 0 ? 1 : 0;
  }

  /** Reference cycles per tick of channel c. */
  private tick(c: number): number {
    const div = this.conf0(c) & 0xff || 256;
    const clock = (this.conf1(c) & REF_ALWAYS_ON) !== 0 ? this.context.apbHz : REF_TICK_HZ;
    return (div / clock) * REF_HZ;
  }

  /** Items in channel c's memory. */
  private memItems(c: number): number {
    return Math.max(1, (this.conf0(c) >>> 24) & 0xf) * 64;
  }

  override read32(offset: number): number {
    if (offset >= this.L.status && offset < this.L.status + 4 * this.L.channels) {
      const c = (offset - this.L.status) >>> 2;
      return ((this.active[c] << 24) | (((c * 64 + this.pointer[c]) & 0x3ff) << 12)) >>> 0;
    }
    if (offset === this.L.intRaw + 4) return (this.regs[this.L.intRaw >>> 2] & this.regs[(this.L.intRaw + 8) >>> 2]) >>> 0;
    return super.read32(offset);
  }

  override write32(offset: number, value: number): void {
    if (offset >= this.L.ram) {
      super.write32(offset, value);
      return;
    }
    if (offset < this.L.conf0) {
      this.unsupported('the APB FIFO access through CHnDATA (APB_CONF FIFO_MASK = 0) is not emulated; use direct RAM access');
      return;
    }
    if (offset < this.L.status) {
      const c = (offset - this.L.conf0) >>> 3;
      super.write32(offset, value);
      if ((offset & 4) === 0) return; // CONF0
      if ((value & MEM_RD_RST) !== 0) {
        this.pointer[c] = 0;
        this.half[c] = 0;
      }
      if ((value & RX_EN) !== 0) this.unsupported(`channel ${c}: RMT receive is not emulated`);
      if ((value & TX_START) !== 0 && this.active[c] === 0) this.start(c);
      else if (this.active[c] === 0) this.setLevel(c, this.idleLevel(c));
      return;
    }
    const intRaw = this.L.intRaw;
    if (offset === intRaw || offset === intRaw + 4) return; // INT_RAW, INT_ST
    if (offset === intRaw + 12) {
      this.regs[intRaw >>> 2] &= ~value; // INT_CLR
      this.updateInterrupt();
      return;
    }
    if (offset === intRaw + 8) {
      super.write32(offset, value); // INT_ENA
      this.updateInterrupt();
      return;
    }
    if (offset >= this.L.status && offset < this.L.status + 8 * this.L.channels) return; // STATUS, ADDR: read-only
    super.write32(offset, value);
  }

  private start(c: number): void {
    if ((this.conf0(c) & CARRIER_EN) !== 0) this.unsupported(`channel ${c}: carrier modulation is not emulated; the levels go out unmodulated`);
    if ((this.regs[this.L.apbConf >>> 2] & FIFO_MASK) === 0) this.unsupported('the APB FIFO access mode (APB_CONF FIFO_MASK = 0) is not emulated; the channel sends its RAM as written directly');
    this.active[c] = 1;
    this.sent[c] = 0;
    this.half[c] = 2;
    const t = Math.ceil(this.context.now());
    this.halfEnd[c] = t;
    this.context.events.schedule(this.slots[c], t);
  }

  /** Puts out the half item at the read pointer from time `t`, or ends at an end marker. */
  private send(c: number, t: number): void {
    const word = this.regs[(this.L.ram >>> 2) + ((c * 64 + this.pointer[c]) & (this.L.channels * 64 - 1))];
    const h = this.half[c];
    const duration = h === 0 ? word & 0x7fff : (word >>> 16) & 0x7fff;
    if (duration === 0) {
      this.raise(1 << (3 * c));
      if ((this.conf1(c) & TX_CONTI) !== 0 && (this.pointer[c] !== 0 || h !== 0)) {
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
    this.context.events.schedule(this.slots[c], end);
  }

  /** The half going out on channel c ended. */
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
    const lim = this.regs[(this.L.txLim >>> 2) + c] & 0x1ff;
    if (lim !== 0 && this.sent[c] % lim === 0) this.raise(1 << (this.L.thrBit + c));
    if (++this.pointer[c] >= this.memItems(c)) {
      if ((this.regs[this.L.apbConf >>> 2] & WRAP_EN) === 0) {
        this.raise(1 << (3 * c + 2));
        this.stop(c);
        return;
      }
      this.pointer[c] = 0;
    }
    this.send(c, t);
  }

  private stop(c: number): void {
    this.active[c] = 0;
    this.regs[(this.L.conf0 >>> 2) + 2 * c + 1] &= ~TX_START;
    this.context.events.cancel(this.slots[c]);
    this.setLevel(c, this.idleLevel(c));
  }

  private setLevel(c: number, v: number): void {
    if (this.level[c] === v) return;
    this.level[c] = v;
    this.onOutput?.();
  }

  private raise(bits: number): void {
    this.regs[this.L.intRaw >>> 2] |= bits;
    this.updateInterrupt();
  }

  private updateInterrupt(): void {
    const high = (this.regs[this.L.intRaw >>> 2] & this.regs[(this.L.intRaw + 8) >>> 2]) !== 0;
    if (high === this.sourceHigh) return;
    this.sourceHigh = high;
    this.context.interrupts.setSource(this.L.source, high);
  }

  private unsupported(what: string): void {
    this.context.problems.report('warning', this.L.unsupportedCode, this.L.base, `RMT: ${what}.`);
  }
}
