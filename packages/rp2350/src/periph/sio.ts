/**
 * The RP2350's SIO (BT65; datasheet §3.1), seen per hart: CPUID; GPIO_OUT/OE (and their SET, CLR,
 * XOR and HI variants) for 48 GPIOs, GPIO_IN from the pins; the two inter-core FIFOs (4 words
 * each, FIFO_ST's VLD/RDY/WOF/ROE); 32 spinlocks (a read claims: nonzero when it won; a write
 * releases); doorbells; RISCV_SOFTIRQ (each core's machine software interrupt); and the RISC-V
 * machine timer — MTIME (shared, 1 µs a tick: the TICKS rate the SDK programs; FULLSPEED counts
 * clk_sys cycles) with MTIMECMP per core driving that core's mip.mtip. Both harts run the real
 * bootrom, so core 1's side of a launch is the bootrom's own code reading this FIFO.
 */

import type { Alarm, SocClock } from '../clock.ts';

const FIFO_DEPTH = 4;
const ST_VLD = 1;
const ST_RDY = 2;
const ST_WOF = 4;
const ST_ROE = 8;

export interface SioHost {
  now(): number;
  /** clk_sys, Hz (MTIME_CTRL.FULLSPEED). */
  sysHz(): number;
  /** GPIO 0–47 output or enable changed. */
  gpioChanged(): void;
  /** GPIO input levels (bit per GPIO, low and high words). */
  gpioIn(high: boolean): number;
  /** A hart's machine software / timer interrupt line. */
  setSoftIrq(hart: number, level: boolean): void;
  setTimerIrq(hart: number, level: boolean): void;
  unmodelled(block: string, address: number, write: boolean): void;
}

export class Sio {
  gpioOut = 0;
  gpioHiOut = 0;
  gpioOe = 0;
  gpioHiOe = 0;
  private readonly fifos = [[] as number[], [] as number[]]; // [0]: core 0 → core 1, [1]: core 1 → core 0
  private readonly fifoFlags = new Uint8Array(2);
  private spinlocks = 0;
  private readonly doorbells = new Uint32Array(2);
  private softirq = 0;
  private mtimeCtrl = 0xd;
  /** MTIME = elapsed ticks + mtimeOffset while enabled; frozen at mtimeFrozen while not. */
  private mtimeOffset = 0;
  private mtimeFrozen = 0;
  private readonly mtimecmp = [0xffffffffffffffff, 0xffffffffffffffff];
  private readonly mtimecmpHalves = new Uint32Array(4);
  private readonly timerAlarms: Alarm[];
  private readonly host: SioHost;

  constructor(host: SioHost, clock: SocClock) {
    this.host = host;
    this.timerAlarms = [0, 1].map((hart) => clock.alarm(() => this.updateTimer(hart)));
    this.reset();
  }

  reset(): void {
    this.gpioOut = this.gpioHiOut = this.gpioOe = this.gpioHiOe = 0;
    this.fifos[0].length = this.fifos[1].length = 0;
    this.fifoFlags.fill(0);
    this.spinlocks = 0;
    this.doorbells.fill(0);
    this.softirq = 0;
    this.mtimeCtrl = 0xd;
    this.mtimeOffset = 0;
    this.mtimeFrozen = 0;
    this.mtimecmp[0] = this.mtimecmp[1] = Number.MAX_SAFE_INTEGER;
    this.mtimecmpHalves.fill(0xffffffff);
    for (const alarm of this.timerAlarms) alarm.cancel();
  }

  // ── The RISC-V machine timer ────────────────────────────────────────────────────────────

  private ticks(): number {
    const now = this.host.now();
    return (this.mtimeCtrl & 2) !== 0 ? Math.floor((now * this.host.sysHz()) / 1e9) : Math.floor(now / 1000);
  }

  mtime(): number {
    return (this.mtimeCtrl & 1) !== 0 ? this.ticks() + this.mtimeOffset : this.mtimeFrozen;
  }

  private setMtime(value: number): void {
    if ((this.mtimeCtrl & 1) !== 0) this.mtimeOffset = value - this.ticks();
    else this.mtimeFrozen = value;
    this.updateTimer(0);
    this.updateTimer(1);
  }

  private updateTimer(hart: number): void {
    const now = this.mtime();
    const cmp = this.mtimecmp[hart];
    this.host.setTimerIrq(hart, now >= cmp);
    const alarm = this.timerAlarms[hart];
    if (now >= cmp || (this.mtimeCtrl & 1) === 0 || cmp >= Number.MAX_SAFE_INTEGER) {
      alarm.cancel();
      return;
    }
    const tickNanos = (this.mtimeCtrl & 2) !== 0 ? 1e9 / this.host.sysHz() : 1000;
    alarm.scheduleAt(this.host.now() + (cmp - now) * tickNanos);
  }

  private pushTo(fifo: number, value: number): void {
    const q = this.fifos[fifo];
    if (q.length >= FIFO_DEPTH) this.fifoFlags[fifo] |= ST_WOF;
    else q.push(value >>> 0);
  }

  /** Core 1 went through reset: its FIFO side starts empty. */
  resetCore1(): void {
    this.fifos[1].length = 0;
    this.fifoFlags[1] = 0;
  }

  // ── Registers ───────────────────────────────────────────────────────────────────────────

  read(hart: number, offset: number): number {
    switch (offset) {
      case 0x000:
        return hart;
      case 0x004:
        return this.host.gpioIn(false);
      case 0x008:
        return this.host.gpioIn(true);
      case 0x010:
        return this.gpioOut;
      case 0x014:
        return this.gpioHiOut;
      case 0x030:
        return this.gpioOe;
      case 0x034:
        return this.gpioHiOe;
      case 0x050: {
        const rx = this.fifos[1 - hart];
        const tx = this.fifos[hart];
        return (rx.length > 0 ? ST_VLD : 0) | (tx.length < FIFO_DEPTH ? ST_RDY : 0) | (this.fifoFlags[hart] & ST_WOF) | (this.fifoFlags[1 - hart] & ST_ROE);
      }
      case 0x058: {
        const value = this.fifos[1 - hart].shift();
        if (value === undefined) this.fifoFlags[1 - hart] |= ST_ROE;
        return value ?? 0;
      }
      case 0x05c:
        return this.spinlocks >>> 0;
      case 0x1a0:
        return this.softirq;
      case 0x1a4:
        return this.mtimeCtrl;
      case 0x1b0:
        return this.mtime() >>> 0;
      case 0x1b4:
        return Math.floor(this.mtime() / 0x100000000) >>> 0;
      case 0x1b8:
        return this.mtimecmpHalves[2 * hart];
      case 0x1bc:
        return this.mtimecmpHalves[2 * hart + 1];
      case 0x180:
      case 0x188:
        return this.doorbells[hart];
      default:
        if (offset >= 0x100 && offset < 0x180) {
          const bit = 1 << ((offset - 0x100) >>> 2);
          if ((this.spinlocks & bit) !== 0) return 0;
          this.spinlocks |= bit;
          return bit >>> 0;
        }
        this.host.unmodelled('SIO', 0xd0000000 + offset, false);
        return 0;
    }
  }

  write(hart: number, offset: number, value: number): void {
    const v = value >>> 0;
    switch (offset) {
      case 0x010:
        this.gpioOut = v;
        break;
      case 0x014:
        this.gpioHiOut = v & 0xffff;
        break;
      case 0x018:
        this.gpioOut = (this.gpioOut | v) >>> 0;
        break;
      case 0x01c:
        this.gpioHiOut = (this.gpioHiOut | v) & 0xffff;
        break;
      case 0x020:
        this.gpioOut = (this.gpioOut & ~v) >>> 0;
        break;
      case 0x024:
        this.gpioHiOut = this.gpioHiOut & ~v & 0xffff;
        break;
      case 0x028:
        this.gpioOut = (this.gpioOut ^ v) >>> 0;
        break;
      case 0x02c:
        this.gpioHiOut = (this.gpioHiOut ^ v) & 0xffff;
        break;
      case 0x030:
        this.gpioOe = v;
        break;
      case 0x034:
        this.gpioHiOe = v & 0xffff;
        break;
      case 0x038:
        this.gpioOe = (this.gpioOe | v) >>> 0;
        break;
      case 0x03c:
        this.gpioHiOe = (this.gpioHiOe | v) & 0xffff;
        break;
      case 0x040:
        this.gpioOe = (this.gpioOe & ~v) >>> 0;
        break;
      case 0x044:
        this.gpioHiOe = this.gpioHiOe & ~v & 0xffff;
        break;
      case 0x048:
        this.gpioOe = (this.gpioOe ^ v) >>> 0;
        break;
      case 0x04c:
        this.gpioHiOe = (this.gpioHiOe ^ v) & 0xffff;
        break;
      case 0x050:
        this.fifoFlags[hart] &= ~ST_WOF;
        this.fifoFlags[1 - hart] &= ~ST_ROE;
        return;
      case 0x054:
        this.pushTo(hart, v);
        return;
      case 0x1a0: {
        let s = this.softirq | (v & 3);
        s &= ~((v >>> 8) & 3);
        this.softirq = s;
        this.host.setSoftIrq(0, (s & 1) !== 0);
        this.host.setSoftIrq(1, (s & 2) !== 0);
        return;
      }
      case 0x1a4: {
        const now = this.mtime();
        this.mtimeCtrl = v & 0xf;
        this.setMtime(now);
        return;
      }
      case 0x1b0:
        this.setMtime(Math.floor(this.mtime() / 0x100000000) * 0x100000000 + v);
        return;
      case 0x1b4:
        this.setMtime(v * 0x100000000 + (this.mtime() >>> 0));
        return;
      case 0x1b8:
      case 0x1bc: {
        this.mtimecmpHalves[2 * hart + (offset === 0x1bc ? 1 : 0)] = v;
        this.mtimecmp[hart] = this.mtimecmpHalves[2 * hart + 1] * 0x100000000 + this.mtimecmpHalves[2 * hart];
        this.updateTimer(hart);
        return;
      }
      case 0x180:
        this.doorbells[1 - hart] |= v;
        return;
      case 0x184:
        this.doorbells[1 - hart] &= ~v;
        return;
      case 0x188:
        this.doorbells[hart] |= v;
        return;
      case 0x18c:
        this.doorbells[hart] &= ~v;
        return;
      default:
        if (offset >= 0x100 && offset < 0x180) {
          this.spinlocks &= ~(1 << ((offset - 0x100) >>> 2));
          return;
        }
        this.host.unmodelled('SIO', 0xd0000000 + offset, true);
        return;
    }
    this.host.gpioChanged();
  }
}
