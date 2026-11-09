/**
 * The ESP32's touch sensor (BT159; version 1), modeled from the register interface ESP-IDF 4.4
 * drives (hal/esp32 touch_sensor_ll.h, soc/sens_reg.h, rtc_io_reg.h, rtc_cntl_reg.h): ten pads,
 * T0–T9 on GPIO4, 0, 2, 15, 13, 12, 14, 27, 33, 32.
 *
 * Registers (offsets in the RTC_CNTL block's page; SENS at +0x800, RTC IO at +0x400):
 * - SENS SAR_TOUCH_CTRL1 (+0x58): MEAS_DELAY 15:0 — the measuring window in 8 MHz ticks —,
 *   XPD_WAIT 23:16, OUT_SEL 24 (0: a pad below its threshold is touched; 1: above), OUT_1EN 25
 *   (1: the interrupt and wake follow SET1 — OUTEN1 — alone; 0: both sets).
 * - SENS SAR_TOUCH_THRES1–5 (+0x5C…) and SAR_TOUCH_OUT1–5 (+0x70…): two pads each, the even one in
 *   31:16, the odd one in 15:0 — thresholds and readings.
 * - SENS SAR_TOUCH_CTRL2 (+0x84): MEAS_EN 9:0 (the pads triggered — sticky until MEAS_EN_CLR 30),
 *   MEAS_DONE 10, START_EN 12 (a software start on its rising edge), START_FORCE 13 (0 timer,
 *   1 software), SLEEP_CYCLES 29:14.
 * - SENS SAR_TOUCH_ENABLE (+0x8C): WORKEN 9:0 (the pads measured), OUTEN2 19:10, OUTEN1 29:20.
 * - RTC IO TOUCH_CFG (+0x490): DREFH 30:29, DREFL 28:27, DRANGE 26:25 (as version 2's codes);
 *   TOUCH_PADn (+0x494 + 4·n): DAC 25:23 — the pad's slope.
 * - RTC_CNTL STATE0 (0x18) TOUCH_SLP_TIMER_EN 23: the timer runs; INT_RAW/ENA TOUCH (bit 6).
 * The SENS registers swap pads 8 and 9 (IDF's TOUCH_LL_BITS_SWAP and touch_ll_num_wrap: bit 8 and
 * the OUT/THRES slot of pad 8 are pad 9's, and back); RTC IO's TOUCH_PADn don't.
 *
 * A round measures every WORKEN pad in turn: XPD_WAIT ticks, then the window of MEAS_DELAY ticks,
 * the reading the charge-discharge cycles that fit in it — window / (2·C·ΔV / I), with C the pad
 * (PAD_PF, @benchtop/esp32s3's touch model's constant) plus what the bench's touch source gives,
 * ΔV the swing between the reference voltages, I = slope × SLOPE_UA. More capacitance, fewer
 * cycles: a touch lowers the reading, as on the chip — Arduino's defaults read about 80 on a bare
 * pin, 67 with a touch pad, 37 with a finger on it (model constants, not measurements). MEAS_DONE
 * clears as a round starts and sets when it ends; the pads past their threshold then set MEAS_EN,
 * and the TOUCH interrupt is raised — every round while they stay touched, as the chip does. In
 * timer mode a round starts SLEEP_CYCLES slow-clock cycles after the last one ended.
 */

export const ESP32_TOUCH_PADS = 10;
/** T0–T9's GPIOs. */
export const ESP32_TOUCH_GPIO: readonly number[] = [4, 0, 2, 15, 13, 12, 14, 27, 33, 32];
/** The chip's pad and the board's trace (pF), and the charge current per slope step (µA): the S2/S3 model's constants. */
export const ESP32_PAD_PF = 10;
export const ESP32_SLOPE_UA = 1;
const TOUCH_CLOCK_HZ = 8_000_000;

/** Offsets in the RTC_CNTL block's page. */
export const SENS_TOUCH_CTRL1 = 0x858;
export const SENS_TOUCH_THRES1 = 0x85c;
export const SENS_TOUCH_OUT1 = 0x870;
export const SENS_TOUCH_CTRL2 = 0x884;
export const SENS_TOUCH_ENABLE = 0x88c;
export const RTC_IO_TOUCH_CFG = 0x490;
export const RTC_IO_TOUCH_PAD0 = 0x494;
export const RTC_STATE0 = 0x18;
/** RTC_CNTL INT_RAW's TOUCH bit. */
export const RTC_TOUCH_INT = 1 << 6;

const CTRL2_MEAS_DONE = 1 << 10;
const CTRL2_START_EN = 1 << 12;
const CTRL2_START_FORCE = 1 << 13;
const CTRL2_MEAS_EN_CLR = 1 << 30;
const STATE0_SLP_TIMER_EN = 1 << 23;
const DREFH_V = [2.4, 2.5, 2.6, 2.7] as const;
const DREFL_V = [0.5, 0.6, 0.7, 0.8] as const;
const DRANGE_V = [1.5, 1.0, 0.5, 0] as const;

/** Pad n's slot in SENS (bits and OUT/THRES): 8 and 9 swapped. */
const slot = (n: number): number => (n === 8 ? 9 : n === 9 ? 8 : n);

export interface Esp32TouchContext {
  readonly events: { add(callback: () => void): number; schedule(slot: number, time: number): void; cancel(slot: number): void; pending(slot: number): boolean; readonly firing: number };
  now(): number;
  hurry?(time: number): void;
}

/** What the sensor needs of RTC_CNTL: its page's registers (RTC IO included), its slow clock, its interrupt. */
export interface Esp32TouchRtc {
  read32(offset: number): number;
  slowHz(): number;
  raise(bits: number): void;
}

export class Esp32Touch {
  /** Picofarads the bench puts on GPIO `g`'s net; 0 by default. */
  source: (gpio: number) => number = () => 0;
  /** Each pad's latest reading and threshold, by pad (not by SENS slot). */
  readonly readings = new Uint16Array(ESP32_TOUCH_PADS);
  readonly thresholds = new Uint16Array(ESP32_TOUCH_PADS);
  /** Rounds measured since the chip started (tests). */
  rounds = 0;
  /** MEAS_EN as pads (not slots). */
  private triggered = 0;
  private measDone = false;
  private ctrl1 = 0;
  private ctrl2 = 0;
  private enable = 0;
  private readonly ctx: Esp32TouchContext;
  private readonly rtc: Esp32TouchRtc;
  private readonly refHz: number;
  private readonly slotEvent: number;
  private scanning = false;
  private pad = -1;
  private pendingReading = 0;

  constructor(ctx: Esp32TouchContext, rtc: Esp32TouchRtc, refHz: number) {
    this.ctx = ctx;
    this.rtc = rtc;
    this.refHz = refHz;
    this.slotEvent = ctx.events.add(() => this.fire());
  }

  /**
   * A chip reset: a round under way stops (STATE0's timer bit resets with the digital domain). SENS
   * is in the RTC domain: its registers and the readings stay unless `rtcDomain` resets too.
   */
  reset(rtcDomain: boolean): void {
    this.ctx.events.cancel(this.slotEvent);
    this.scanning = false;
    this.pad = -1;
    if (!rtcDomain) return;
    this.readings.fill(0);
    this.thresholds.fill(0);
    this.triggered = 0;
    this.measDone = false;
    this.ctrl1 = 0;
    this.ctrl2 = 0;
    this.enable = 0;
  }

  /** BT160: after a round whose triggered pads satisfy OUT_1EN (the interrupt's condition) — a touch wake. */
  onFire: (() => void) | null = null;

  /** BT160: the FSM goes on after the SoC's events were cleared (a deep sleep with touch wake). */
  resume(): void {
    this.scanning = false;
    this.pad = -1;
    this.kick();
  }

  /** BT160: the pads a touch wake watches (WORKEN and SET1), as T numbers. */
  wakePads(): number[] {
    const pads = this.workenPads() & this.fromSlots(this.enable >>> 20);
    const out: number[] = [];
    for (let n = 0; n < ESP32_TOUCH_PADS; n++) if ((pads & (1 << n)) !== 0) out.push(n);
    return out;
  }

  /** Owns RTC-page offset `offset` (SENS SAR_TOUCH_CTRL1 … SAR_TOUCH_ENABLE)? */
  owns(offset: number): boolean {
    return offset >= SENS_TOUCH_CTRL1 && offset <= SENS_TOUCH_ENABLE;
  }

  /** Is GPIO `g` a pad in WORKEN (the touch sensor's)? */
  uses(g: number): boolean {
    const n = ESP32_TOUCH_GPIO.indexOf(g);
    return n >= 0 && (this.workenPads() & (1 << n)) !== 0;
  }

  read32(offset: number): number {
    if (offset === SENS_TOUCH_CTRL1) return this.ctrl1;
    if (offset === SENS_TOUCH_CTRL2) return ((this.ctrl2 & ~(0x3ff | CTRL2_MEAS_DONE)) | this.toSlots(this.triggered) | (this.measDone ? CTRL2_MEAS_DONE : 0)) >>> 0;
    if (offset === SENS_TOUCH_ENABLE) return this.enable;
    if (offset >= SENS_TOUCH_THRES1 && offset < SENS_TOUCH_THRES1 + 20) return this.pair(this.thresholds, (offset - SENS_TOUCH_THRES1) >>> 2);
    if (offset >= SENS_TOUCH_OUT1 && offset < SENS_TOUCH_OUT1 + 20) return this.pair(this.readings, (offset - SENS_TOUCH_OUT1) >>> 2);
    return 0;
  }

  write32(offset: number, value: number): void {
    if (offset === SENS_TOUCH_CTRL1) this.ctrl1 = value >>> 0;
    else if (offset === SENS_TOUCH_CTRL2) {
      const before = this.ctrl2;
      if ((value & CTRL2_MEAS_EN_CLR) !== 0) this.triggered = 0;
      this.ctrl2 = (value & ~(CTRL2_MEAS_EN_CLR | 0x3ff | CTRL2_MEAS_DONE)) >>> 0;
      const software = (value & CTRL2_START_FORCE) !== 0;
      if (software && (value & CTRL2_START_EN) !== 0 && (before & CTRL2_START_EN) === 0) this.startRound(this.ctx.now());
      else if (!software) this.kick();
    } else if (offset === SENS_TOUCH_ENABLE) {
      this.enable = value >>> 0;
      this.kick();
    } else if (offset >= SENS_TOUCH_THRES1 && offset < SENS_TOUCH_THRES1 + 20) {
      const i = (offset - SENS_TOUCH_THRES1) >>> 2;
      this.thresholds[slot(2 * i)] = (value >>> 16) & 0xffff;
      this.thresholds[slot(2 * i + 1)] = value & 0xffff;
    }
  }

  /** RTC_CNTL wrote `offset` (STATE0: the timer). */
  rtcWritten(offset: number, value: number): void {
    if (offset !== RTC_STATE0) return;
    if ((value & STATE0_SLP_TIMER_EN) !== 0) this.kick();
    else if (!this.scanning) this.ctx.events.cancel(this.slotEvent);
  }

  /** Two pads' 16-bit values in a THRES/OUT word: slot 2i in 31:16, 2i + 1 in 15:0. */
  private pair(values: Uint16Array, i: number): number {
    return ((values[slot(2 * i)] << 16) | values[slot(2 * i + 1)]) >>> 0;
  }

  /** A pad mask as SENS bits (8 ↔ 9). */
  private toSlots(pads: number): number {
    return (pads & ~0x300) | ((pads & 0x100) << 1) | ((pads & 0x200) >>> 1);
  }

  private fromSlots(bits: number): number {
    return this.toSlots(bits & 0x3ff);
  }

  private workenPads(): number {
    return this.fromSlots(this.enable);
  }

  private timerOn(): boolean {
    return (this.ctrl2 & CTRL2_START_FORCE) === 0 && (this.rtc.read32(RTC_STATE0) & STATE0_SLP_TIMER_EN) !== 0;
  }

  private sleepPeriod(): number {
    const cycles = Math.max(1, (this.ctrl2 >>> 14) & 0xffff);
    return Math.ceil((cycles * this.refHz) / this.rtc.slowHz());
  }

  /** Timer mode with pads to measure and nothing scheduled: the next round after a sleep period. */
  private kick(): void {
    if (this.scanning || this.ctx.events.pending(this.slotEvent) || !this.timerOn() || this.workenPads() === 0) return;
    this.at(this.ctx.now() + this.sleepPeriod());
  }

  private at(time: number): void {
    this.ctx.events.schedule(this.slotEvent, time);
    this.ctx.hurry?.(time);
  }

  private startRound(now: number): void {
    this.scanning = true;
    this.measDone = false;
    this.pad = -1;
    this.measureNext(now, 0);
  }

  private measureNext(now: number, from: number): void {
    const pads = this.workenPads();
    let n = from;
    while (n < ESP32_TOUCH_PADS && (pads & (1 << n)) === 0) n++;
    if (n >= ESP32_TOUCH_PADS) {
      this.endRound(now);
      return;
    }
    this.pad = n;
    const window = this.ctrl1 & 0xffff;
    const wait = (this.ctrl1 >>> 16) & 0xff;
    this.pendingReading = this.reading(n, window);
    this.at(now + Math.max(1, Math.round(((wait + window) * this.refHz) / TOUCH_CLOCK_HZ)));
  }

  /** Charge-discharge cycles of pad `n` in a window of `window` fast-clock ticks. */
  private reading(n: number, window: number): number {
    const cfg = this.rtc.read32(RTC_IO_TOUCH_CFG);
    const high = DREFH_V[(cfg >>> 29) & 3] - DRANGE_V[(cfg >>> 25) & 3];
    const swing = Math.max(0.05, high - DREFL_V[(cfg >>> 27) & 3]);
    const slope = (this.rtc.read32(RTC_IO_TOUCH_PAD0 + 4 * n) >>> 23) & 7;
    if (slope === 0) return 0;
    const pf = ESP32_PAD_PF + Math.max(0, this.source(ESP32_TOUCH_GPIO[n]));
    const cycleSeconds = (2 * pf * 1e-12 * swing) / (slope * ESP32_SLOPE_UA * 1e-6);
    return Math.min(0xffff, Math.floor(window / TOUCH_CLOCK_HZ / cycleSeconds));
  }

  private fire(): void {
    const now = this.ctx.now();
    if (!this.scanning) {
      if (this.timerOn() && this.workenPads() !== 0) this.startRound(now);
      return;
    }
    const n = this.pad;
    this.readings[n] = this.pendingReading;
    this.measureNext(now, n + 1);
  }

  /** The round ended: MEAS_DONE, the pads past their thresholds, the interrupt; the next round. */
  private endRound(now: number): void {
    this.scanning = false;
    this.measDone = true;
    this.rounds++;
    const above = (this.ctrl1 & (1 << 24)) !== 0;
    const pads = this.workenPads();
    let hit = 0;
    for (let n = 0; n < ESP32_TOUCH_PADS; n++) {
      if ((pads & (1 << n)) === 0) continue;
      const value = this.readings[n];
      const th = this.thresholds[n];
      if (above ? value > th : value < th) hit |= 1 << n;
    }
    this.triggered |= hit;
    if (this.fires(hit)) {
      this.rtc.raise(RTC_TOUCH_INT);
      this.onFire?.();
    }
    if (this.timerOn() && pads !== 0) this.at(now + this.sleepPeriod());
  }

  /** Whether `hit` pads trigger the interrupt (and a wake): SET1 alone, or both sets (OUT_1EN). */
  fires(hit: number): boolean {
    const set1 = this.fromSlots(this.enable >>> 20);
    const set2 = this.fromSlots(this.enable >>> 10);
    if ((this.ctrl1 & (1 << 25)) !== 0) return (hit & set1) !== 0;
    return (hit & set1) !== 0 && (hit & set2) !== 0;
  }
}
