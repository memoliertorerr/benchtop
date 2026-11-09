/**
 * The ESP32-S2's and ESP32-S3's touch sensor (version 2; BT155 for the S2, BT158 shared with the
 * S3), modeled from the register interface ESP-IDF 4.4 drives (hal/esp32s2 and hal/esp32s3
 * touch_sensor_ll.h, soc/rtc_cntl_reg.h, sens_reg.h, rtc_io_reg.h): 15 channels — TOUCH1–14 on
 * GPIO1–14, channel 0 the internal denoise channel. The two chips have the same fields at other
 * offsets: a `TouchChip` says where (S2_TOUCH_CHIP is @benchtop/esp32s2's, S3_TOUCH_CHIP here).
 *
 * Registers: RTC_CNTL's TOUCH_CTRL1 (MEAS_NUM 31:16, SLEEP_CYCLES 15:0), TOUCH_CTRL2 (RESET 29,
 * TIMER_FORCE_DONE 28:27, XPD_WAIT 24:17, START_FORCE 16 — 0 timer, 1 software —, START_EN 15,
 * SLP_TIMER_EN 13, REFC 11:9, DREFH 7:6, DREFL 5:4, DRANGE 3:2), TOUCH_SCAN_CTRL (SCAN_PAD_MAP
 * 24:10, DENOISE_EN 2, DENOISE_RES 1:0), TOUCH_FILTER_CTRL (FILTER_EN 31, FILTER_MODE 30:28,
 * DEBOUNCE 27:25, JITTER_STEP 14:11, SMOOTH_LVL 10:9), TOUCH_TIMEOUT_CTRL (TIMEOUT_EN 22,
 * TIMEOUT_NUM 21:0) and the interrupt bits (SCAN_DONE 4, DONE 6, ACTIVE 7, INACTIVE 8, TIMEOUT 18
 * in INT_ENA/RAW/ST/CLR) — read from the RTC_CNTL model, which tells this one about writes; SENS's
 * SAR_TOUCH_CONF (DATA_SEL 17:16, STATUS_CLR 15, OUTEN 14:0), THRES1–14, SAR_TOUCH_CHN_ST
 * (MEAS_DONE 31, CHANNEL_CLR 29:15, PAD_ACTIVE 14:0), SAR_TOUCH_STATUS0 (SCAN_CURR 25:22,
 * DENOISE_DATA 21:0) and STATUS1–14 (data 21:0), owned here; each pad's slope (DAC) — the S2's in
 * RTC_IO's TOUCH_PADn (25:23), the S3's in RTC_CNTL's TOUCH_DAC/TOUCH_DAC1 (3 bits a pad).
 *
 * The FSM: in timer mode (START_FORCE 0) a scan starts SLEEP_CYCLES slow-clock cycles after the
 * last one ended while SLP_TIMER_EN is set; in software mode one scan per START_EN rising edge.
 * A scan measures the denoise channel (with DENOISE_EN) and every channel in SCAN_PAD_MAP in
 * order. A measurement takes XPD_WAIT ticks of the 8 MHz RTC fast clock, then MEAS_NUM charge and
 * discharge cycles of the pad: each 2·C·ΔV / I, with C the pad's capacitance (PAD_PF, the chip's
 * pad and the board's trace, plus what the bench puts on its net — a touch pad, a finger), ΔV
 * between the reference voltages (DREFH 2.4–2.7 V less DRANGE's 1.5/1.0/0.5/0 V, DREFL 0.5–0.8 V)
 * and I = slope × SLOPE_UA µA. The reading is that time in fast-clock ticks — so a touch raises
 * it, as on the chip. Slope 0 never finishes charging: the channel reads 0.
 *
 * Denoise: channel 0 measures the internal reference capacitor REFC (5 + 1.4·code pF); its reading,
 * clipped to DENOISE_RES (12, 10, 8 or 4 bits), is subtracted from each channel's. The benchmark is
 * a channel's first reading after a channel clear (CHN_ST.CHANNEL_CLR, TOUCH_CTRL2.RESET); with
 * FILTER_EN the smoothed value follows the readings (IIR by SMOOTH_LVL) and the benchmark follows
 * the smoothed value while the channel is inactive (IIR by FILTER_MODE, or JITTER_STEP steps).
 * A channel is active while smooth − benchmark exceeds its threshold (for DEBOUNCE + 1 readings
 * with the filter on). Each reading raises DONE (SCAN_CURR names the channel), a change ACTIVE or
 * INACTIVE, the scan's end SCAN_DONE; a reading over TIMEOUT_NUM with TIMEOUT_EN raises TIMEOUT and
 * is dropped.
 *
 * Model constants, not measurements: PAD_PF and SLOPE_UA are chosen so Arduino's defaults (500
 * cycles, 2.7 V / 0.5 V less 0.5 V, slope 7, denoise 4-bit at 10.6 pF) read about 19,400 on a bare
 * pin and some 42,700 with a finger on a touch pad — tens of thousands, rising when touched, as an
 * S2 or S3 does. Not modeled: noise, the waterproof shield and proximity modes.
 */

import type { EventTable } from '@benchtop/esp32';

export const TOUCH_CHANNELS = 15;
/** The chip's pad and the board's trace, before anything the bench adds (pF; a model constant). */
export const PAD_PF = 10;
/** Charge current per slope step (µA; a model constant). */
export const SLOPE_UA = 1;
/** The RTC fast clock the measurement counts. */
export const TOUCH_CLOCK_HZ = 8_000_000;
/** RTC_CNTL interrupt bits (the same on the S2 and S3). */
export const TOUCH_INT = { SCAN_DONE: 1 << 4, DONE: 1 << 6, ACTIVE: 1 << 7, INACTIVE: 1 << 8, TIMEOUT: 1 << 18 } as const;

/** Where a chip keeps the sensor's registers. */
export interface TouchChip {
  /** RTC_CNTL offsets (in its page). */
  readonly ctrl1: number;
  readonly ctrl2: number;
  readonly scanCtrl: number;
  readonly slpThres: number;
  readonly filterCtrl: number;
  readonly timeoutCtrl: number;
  /** Pad `n`'s slope (DAC, 0–7), from RTC_CNTL's page (`read`: an offset there). */
  slope(read: (offset: number) => number, n: number): number;
  /** SENS offsets (in SENS): SAR_TOUCH_CONF, THRES1, CHN_ST, STATUS0, STATUS1, and the last word the model owns. */
  readonly conf: number;
  readonly thres1: number;
  readonly chnSt: number;
  readonly status0: number;
  readonly status1: number;
  readonly sensLast: number;
}

/**
 * The S3's layout (esp32s3 rtc_cntl_reg.h, sens_reg.h): RTC_CNTL TOUCH_CTRL1 0x108 … TIMEOUT_CTRL
 * 0x124; the slopes in TOUCH_DAC (0x14C: pad n at bits 31−3n … 29−3n) and TOUCH_DAC1 (0x150: pads
 * 10–14 the same way); SENS SAR_TOUCH_CONF 0x5C, THRES1 0x64, CHN_ST 0x9C, STATUS0 0xA0, STATUS1
 * 0xA4 … APPR_STATUS 0xE0.
 */
export const S3_TOUCH_CHIP: TouchChip = {
  ctrl1: 0x108,
  ctrl2: 0x10c,
  scanCtrl: 0x110,
  slpThres: 0x114,
  filterCtrl: 0x11c,
  timeoutCtrl: 0x124,
  slope: (read, n) => (n < 10 ? read(0x14c) >>> (29 - 3 * n) : read(0x150) >>> (29 - 3 * (n - 10))) & 7,
  conf: 0x5c,
  thres1: 0x64,
  chnSt: 0x9c,
  status0: 0xa0,
  status1: 0xa4,
  sensLast: 0xe0,
};

const CTRL2_RESET = 1 << 29;
const CTRL2_FORCE_DONE = 3 << 27;
const CTRL2_START_FORCE = 1 << 16;
const CTRL2_START_EN = 1 << 15;
const CTRL2_SLP_TIMER_EN = 1 << 13;
const CONF_STATUS_CLR = 1 << 15;
const DATA_MASK = 0x3fffff;
const DREFH_V = [2.4, 2.5, 2.6, 2.7] as const;
const DREFL_V = [0.5, 0.6, 0.7, 0.8] as const;
const DRANGE_V = [1.5, 1.0, 0.5, 0] as const;
const DENOISE_BITS = [12, 10, 8, 4] as const;

/** What the sensor needs of the SoC. */
export interface TouchContext {
  readonly events: EventTable;
  /** Reference time (cycles of `refHz`). */
  now(): number;
  /** A model scheduled an event inside the running slice. */
  hurry(time: number): void;
}

/** What it needs of RTC_CNTL: its registers, its slow clock, its interrupt. */
export interface TouchRtc {
  read32(offset: number): number;
  slowHz(): number;
  raise(bits: number): void;
}

export class TouchV2 {
  /** Picofarads the bench puts on GPIO `g`'s net (a touch pad, a finger); 0 by default. */
  source: (gpio: number) => number = () => 0;
  /** Latest reading per channel (after denoise), benchmark and smoothed value. */
  readonly raw = new Uint32Array(TOUCH_CHANNELS);
  readonly benchmark = new Float64Array(TOUCH_CHANNELS);
  readonly smooth = new Float64Array(TOUCH_CHANNELS);
  readonly thresholds = new Uint32Array(TOUCH_CHANNELS);
  /** PAD_ACTIVE: channels whose smooth − benchmark is over their threshold. */
  active = 0;
  /** Measurements made since the chip started (tests). */
  measurements = 0;
  private conf = 0;
  private denoise = 0;
  private scanCurr = 0;
  private measDone = false;
  private readonly benchSet = new Uint8Array(TOUCH_CHANNELS);
  private readonly over = new Uint8Array(TOUCH_CHANNELS);
  private readonly ctx: TouchContext;
  private readonly rtc: TouchRtc;
  private readonly chip: TouchChip;
  private readonly refHz: number;
  private readonly slot: number;
  /** The channel being measured (−1: none), the next one to measure, and what a scan reads. */
  private channel = -1;
  private nextChannel = 0;
  private scanning = false;
  private pendingRaw = 0;
  /** RTC_CNTL's page, for the chip's slope (a bound reader: no closure per measurement). */
  private readonly readRtc: (offset: number) => number;

  constructor(ctx: TouchContext, rtc: TouchRtc, refHz: number, chip: TouchChip = S3_TOUCH_CHIP) {
    this.ctx = ctx;
    this.rtc = rtc;
    this.chip = chip;
    this.refHz = refHz;
    this.slot = ctx.events.add(() => this.fire());
    this.readRtc = (offset) => this.rtc.read32(offset);
  }

  // ── SENS ─────────────────────────────────────────────────────────────────────────────────

  /** BT160: the sleep pad read over its sleep threshold (TOUCH_SLP_THRES) — a touch wake. */
  onSleepPad: (() => void) | null = null;

  /** BT160: the FSM goes on after the SoC's events were cleared (a deep sleep with touch wake). */
  resume(): void {
    this.scanning = false;
    this.channel = -1;
    this.kick();
  }

  /** BT160: the sleep pad (TOUCH_SLP_THRES 31:27; 0: none). */
  sleepPad(): number {
    return (this.rtc.read32(this.chip.slpThres) >>> 27) & 0x1f;
  }

  /** Is GPIO `g` a channel in the scan map (its pad is the touch sensor's)? */
  uses(g: number): boolean {
    return g >= 1 && g < TOUCH_CHANNELS && (this.scanMap() & (1 << g)) !== 0;
  }

  /** Owns SENS offset `offset` (SAR_TOUCH_CONF … SAR_TOUCH_APPR_STATUS)? */
  owns(offset: number): boolean {
    return offset >= this.chip.conf && offset <= this.chip.sensLast;
  }

  read32(offset: number): number {
    const c = this.chip;
    if (offset === c.conf) return this.conf;
    if (offset >= c.thres1 && offset < c.thres1 + 14 * 4) return this.thresholds[1 + ((offset - c.thres1) >>> 2)];
    if (offset === c.chnSt) return ((this.measDone ? 1 << 31 : 0) | (this.active & 0x7fff)) >>> 0;
    if (offset === c.status0) return ((this.scanCurr << 22) | (this.denoise & DATA_MASK)) >>> 0;
    if (offset >= c.status1 && offset < c.status1 + 14 * 4) {
      const n = 1 + ((offset - c.status1) >>> 2);
      const sel = (this.conf >>> 16) & 3;
      const value = sel === 2 ? this.benchmark[n] : sel === 3 ? this.smooth[n] : this.raw[n];
      return Math.round(value) & DATA_MASK;
    }
    return 0;
  }

  write32(offset: number, value: number): void {
    const c = this.chip;
    if (offset === c.conf) {
      if ((value & CONF_STATUS_CLR) !== 0) this.active = 0;
      this.conf = value & ~CONF_STATUS_CLR;
    } else if (offset >= c.thres1 && offset < c.thres1 + 14 * 4) {
      this.thresholds[1 + ((offset - c.thres1) >>> 2)] = value & DATA_MASK;
    } else if (offset === c.chnSt) {
      const clear = (value >>> 15) & 0x7fff;
      for (let n = 0; n < TOUCH_CHANNELS; n++) {
        if ((clear & (1 << n)) === 0) continue;
        this.benchSet[n] = 0;
        this.over[n] = 0;
        this.active &= ~(1 << n);
      }
    }
  }

  // ── RTC_CNTL (written there, read here) ─────────────────────────────────────────────────

  /** RTC_CNTL wrote `offset`: the FSM's controls. */
  rtcWritten(offset: number, value: number, before: number): void {
    if (offset === this.chip.ctrl2) {
      if ((value & CTRL2_RESET) !== 0 && (before & CTRL2_RESET) === 0) this.reset();
      if ((value & CTRL2_FORCE_DONE) === CTRL2_FORCE_DONE) this.stop();
      const software = (value & CTRL2_START_FORCE) !== 0;
      if (software && (value & CTRL2_START_EN) !== 0 && (before & CTRL2_START_EN) === 0) this.startScan(this.ctx.now());
      if (!software && (value & CTRL2_SLP_TIMER_EN) !== 0) this.kick();
      if ((value & CTRL2_SLP_TIMER_EN) === 0 && !this.scanning) this.ctx.events.cancel(this.slot);
    } else if (offset === this.chip.scanCtrl) {
      this.kick();
    }
  }

  /** Timer mode with channels to scan and nothing scheduled: the next scan after a sleep period. */
  private kick(): void {
    if (this.scanning || this.ctx.events.pending(this.slot) || !this.timerOn() || this.scanMap() === 0) return;
    this.at(this.ctx.now() + this.sleepPeriod());
  }

  private timerOn(): boolean {
    const ctrl2 = this.rtc.read32(this.chip.ctrl2);
    return (ctrl2 & CTRL2_START_FORCE) === 0 && (ctrl2 & CTRL2_SLP_TIMER_EN) !== 0;
  }

  private scanMap(): number {
    return (this.rtc.read32(this.chip.scanCtrl) >>> 10) & 0x7ffe;
  }

  private sleepPeriod(): number {
    const cycles = Math.max(1, this.rtc.read32(this.chip.ctrl1) & 0xffff);
    return Math.ceil((cycles * this.refHz) / this.rtc.slowHz());
  }

  private reset(): void {
    this.raw.fill(0);
    this.benchmark.fill(0);
    this.smooth.fill(0);
    this.benchSet.fill(0);
    this.over.fill(0);
    this.active = 0;
    this.denoise = 0;
    this.measDone = false;
  }

  private stop(): void {
    this.ctx.events.cancel(this.slot);
    this.scanning = false;
    this.channel = -1;
  }

  private at(time: number): void {
    this.ctx.events.schedule(this.slot, time);
    this.ctx.hurry(time);
  }

  // ── Scans ────────────────────────────────────────────────────────────────────────────────

  private startScan(now: number): void {
    this.scanning = true;
    this.measDone = false;
    this.nextChannel = (this.rtc.read32(this.chip.scanCtrl) & (1 << 2)) !== 0 ? 0 : 1;
    this.measureNext(now);
  }

  /** Starts the next channel of the scan, or ends the scan. */
  private measureNext(now: number): void {
    const map = this.scanMap();
    let n = this.nextChannel;
    while (n < TOUCH_CHANNELS && n !== 0 && (map & (1 << n)) === 0) n++;
    if (n >= TOUCH_CHANNELS) {
      this.endScan(now);
      return;
    }
    this.channel = n;
    this.nextChannel = n + 1;
    const ticks = this.measureTicks(n);
    this.pendingRaw = ticks.reading;
    this.at(now + Math.max(1, Math.round(((ticks.wait + ticks.reading) * this.refHz) / TOUCH_CLOCK_HZ)));
  }

  /** Fast-clock ticks a measurement of channel `n` waits and then counts. */
  private measureTicks(n: number): { wait: number; reading: number } {
    const ctrl1 = this.rtc.read32(this.chip.ctrl1);
    const ctrl2 = this.rtc.read32(this.chip.ctrl2);
    const wait = (ctrl2 >>> 17) & 0xff;
    const measNum = ctrl1 >>> 16;
    const high = DREFH_V[(ctrl2 >>> 6) & 3] - DRANGE_V[(ctrl2 >>> 2) & 3];
    const swing = Math.max(0.05, high - DREFL_V[(ctrl2 >>> 4) & 3]);
    let pf: number;
    let slope: number;
    if (n === 0) {
      pf = 5 + 1.4 * ((ctrl2 >>> 9) & 7);
      slope = 7;
    } else {
      pf = PAD_PF + Math.max(0, this.source(n));
      slope = this.chip.slope(this.readRtc, n);
    }
    if (slope === 0) return { wait, reading: 0 };
    const cycleSeconds = (2 * pf * 1e-12 * swing) / (slope * SLOPE_UA * 1e-6);
    return { wait, reading: Math.round(measNum * cycleSeconds * TOUCH_CLOCK_HZ) };
  }

  private fire(): void {
    const now = this.ctx.now();
    if (!this.scanning) {
      if (this.timerOn() && this.scanMap() !== 0) this.startScan(now);
      return;
    }
    const n = this.channel;
    this.channel = -1;
    this.measurements++;
    this.reading(n, this.pendingRaw);
    this.measureNext(now);
  }

  /** Channel `n` read `ticks`: its data, its state, the interrupts. */
  private reading(n: number, ticks: number): void {
    const timeout = this.rtc.read32(this.chip.timeoutCtrl);
    if ((timeout & (1 << 22)) !== 0 && ticks > (timeout & DATA_MASK)) {
      this.scanCurr = n;
      this.rtc.raise(TOUCH_INT.TIMEOUT);
      return;
    }
    if (n === 0) {
      this.denoise = ticks & DATA_MASK;
      return;
    }
    const scan = this.rtc.read32(this.chip.scanCtrl);
    let value = ticks;
    if ((scan & (1 << 2)) !== 0) value = Math.max(0, value - Math.min(this.denoise, (1 << DENOISE_BITS[scan & 3]) - 1));
    this.raw[n] = value & DATA_MASK;
    const filter = this.rtc.read32(this.chip.filterCtrl);
    const filterOn = (filter & (1 << 31)) !== 0;
    if (this.benchSet[n] === 0) {
      this.benchSet[n] = 1;
      this.benchmark[n] = value;
      this.smooth[n] = value;
    } else if (filterOn) {
      const lvl = (filter >>> 9) & 3;
      this.smooth[n] += (value - this.smooth[n]) / (1 << lvl);
    } else this.smooth[n] = value;
    const bit = 1 << n;
    const wasActive = (this.active & bit) !== 0;
    if (filterOn && !wasActive) {
      const mode = (filter >>> 28) & 7;
      const diff = this.smooth[n] - this.benchmark[n];
      if (mode === 7) {
        const step = (filter >>> 11) & 0xf;
        this.benchmark[n] += Math.sign(diff) * Math.min(Math.abs(diff), step);
      } else this.benchmark[n] += diff / (1 << (mode + 2));
    }
    const over = this.smooth[n] - this.benchmark[n] > this.thresholds[n];
    // BT160: the sleep pad over the sleep threshold (TOUCH_SLP_THRES 21:0) wakes a sleeping chip.
    if (this.onSleepPad !== null && n === this.sleepPad() && this.smooth[n] - this.benchmark[n] > (this.rtc.read32(this.chip.slpThres) & DATA_MASK)) this.onSleepPad();
    const debounce = filterOn ? (filter >>> 25) & 7 : 0;
    this.over[n] = over === wasActive ? 0 : Math.min(255, this.over[n] + 1);
    this.scanCurr = n;
    let bits: number = TOUCH_INT.DONE;
    if (this.over[n] > debounce && (this.conf & bit) !== 0) {
      this.over[n] = 0;
      if (over) this.active |= bit;
      else this.active &= ~bit;
      bits |= over ? TOUCH_INT.ACTIVE : TOUCH_INT.INACTIVE;
    }
    this.rtc.raise(bits);
  }

  private endScan(now: number): void {
    this.scanning = false;
    this.measDone = true;
    this.rtc.raise(TOUCH_INT.SCAN_DONE);
    if (this.timerOn() && this.scanMap() !== 0) this.at(now + this.sleepPeriod());
  }
}
