/**
 * The ESP32-C3's RTC controller and eFuse controller (BT92), which share the 4 KB block at
 * 0x60008000: RTC_CNTL below 0x800 (rtc_cntl_reg.h), EFUSE from 0x800 (efuse_reg.h).
 *
 * RTC_CNTL: the RTC timer counts the RTC slow clock (CLK_CONF.ANA_CLK_RTC_SEL: 0 RC_SLOW 136 kHz,
 * 1 XTAL32K, 2 RC_FAST/256) from power-on; TIME_UPDATE latches it into TIME_LOW0/HIGH0, which
 * rtc_time_get reads. RESET_STATE holds the reset cause (`resetCause`). OPTIONS0.SW_SYS_RST asks
 * for a system reset (`onSoftwareReset`). BT122: sleep — STATE0.SLEEP_EN (31) sleeps the chip
 * (`onSleep`; deep with DIG_PWC.DG_WRAP_PD_EN, 31); WAKEUP_STATE (0x3C) ENA (31:15) enables wake
 * sources (GPIO bit 2, TIMER 3, …); the timer wakes at SLP_TIMER0/1 on the RTC timer; GPIO_WAKEUP
 * (0x110) arms deep-sleep GPIO wakes on GPIO0–5 (enables 31:26, level types 25:8 three bits each, 4
 * low / 5 high; STATUS 5:0, STATUS_CLR 6); a wake sets SLP_WAKEUP_CAUSE (0xF8) and INT_RAW (0x44)
 * bit 0, cleared through INT_CLR (0x4C). Everything else reads back as written.
 *
 * EFUSE: a v0.3 chip (WAFER_VERSION 3, the revision the Arduino core requires) with Espressif's
 * MAC 34:85:18:00:C3:01 (BT107: or the one the SoC is built with); CMD's READ/PGM bits complete
 * at once.
 */

import type { Peripheral } from '@benchtop/esp32';
import { REF_HZ, type SocContext } from './context.ts';
import { registerDefault } from './periph.ts';
import { SLOW_CLOCK_HZ } from './timg.ts';

export const RTC_CNTL_BASE = 0x60008000;
const EFUSE_OFFSET = 0x800;

const OPTIONS0 = 0x00;
const TIME_UPDATE = 0x0c;
const TIME_LOW0 = 0x10;
const TIME_HIGH0 = 0x14;
const RESET_STATE = 0x38;
const CLK_CONF = 0x70;
const SLP_TIMER0 = 0x04;
const SLP_TIMER1 = 0x08;
const STATE0 = 0x18;
const WAKEUP_STATE = 0x3c;
const INT_RAW = 0x44;
const INT_CLR = 0x4c;
const DIG_PWC = 0x88;
const SLP_WAKEUP_CAUSE = 0xf8;
const GPIO_WAKEUP = 0x110;
const SLEEP_EN = 1 << 31;
/** BT122: wake sources (WAKEUP_STATE ENA, SLP_WAKEUP_CAUSE; esp32c3 rtc.h). */
export const WAKE = { GPIO: 1 << 2, TIMER: 1 << 3 } as const;
/** Registers the RTC domain keeps through a system reset (a deep sleep's wake): STORE0–7, the sleep and wake ones. */
const RTC_DOMAIN = [SLP_TIMER0, SLP_TIMER1, WAKEUP_STATE, DIG_PWC, SLP_WAKEUP_CAUSE, GPIO_WAKEUP, 0x50, 0x54, 0x58, 0x5c, 0xb8, 0xbc, 0xc0, 0xc4];
const SW_SYS_RST = 1 << 31;
const TWO32 = 2 ** 32;

/** Reset causes (RESET_STATE's PROCPU field; esp_rom reset_reasons.h). */
export const RESET_REASON = { POWERON: 1, SW_SYS: 3, DEEPSLEEP: 5, TG0WDT_SYS: 7, TG1WDT_SYS: 8, RTCWDT_SYS: 9, SW_CPU: 12, TG0WDT_CPU: 11, RTCWDT_CPU: 13 } as const;

const EFUSE_CMD = 0x1d4;
const EFUSE_STATUS = 0x1d0;
/** RD_MAC_SPI_SYS_0..3 (BLK1 words 0–3). */
const MAC0 = 0x44;
const MAC1 = 0x48;
const SYS3 = 0x50;

/** 34:85:18:00:C3:01, as BLK1 stores it (the bytes reversed). */
export const EFUSE_MAC = [0x34, 0x85, 0x18, 0x00, 0xc3, 0x01];

export class RtcCntl implements Peripheral {
  private readonly ctx: SocContext;
  private readonly regs = new Uint32Array(512);
  private readonly efuse = new Uint32Array(512);
  private latched = 0;
  resetCause: number = RESET_REASON.POWERON;
  /** Reference time of the last power-on (the RTC timer counts from it). */
  private origin = 0;
  onSoftwareReset: (() => void) | null = null;
  /** BT107: the factory MAC in BLK1 (the station's; the soft-AP's is one more). */
  readonly mac: readonly number[];

  constructor(ctx: SocContext, mac: readonly number[] = EFUSE_MAC) {
    this.ctx = ctx;
    this.mac = mac.length === 6 ? mac.slice() : EFUSE_MAC;
    this.systemReset(true);
  }

  systemReset(rtcDomain: boolean): void {
    if (rtcDomain) {
      for (let i = 0; i < this.regs.length; i++) this.regs[i] = registerDefault(RTC_CNTL_BASE + i * 4);
      this.origin = this.ctx.now();
    }
    for (let i = 0; i < this.efuse.length; i++) this.efuse[i] = registerDefault(RTC_CNTL_BASE + EFUSE_OFFSET + i * 4);
    const m = this.mac;
    this.efuse[MAC0 >>> 2] = (m[2] << 24) | (m[3] << 16) | (m[4] << 8) | m[5];
    this.efuse[MAC1 >>> 2] = (this.efuse[MAC1 >>> 2] & 0xffff0000) | (m[0] << 8) | m[1];
    this.efuse[SYS3 >>> 2] = (this.efuse[SYS3 >>> 2] & ~(7 << 18)) | (3 << 18); // WAFER_VERSION 3
  }

  /** BT118: the power-on the RTC timer counts from — a system reset (a new chip at a reboot) keeps the old one's. */
  get powerOn(): number {
    return this.origin;
  }

  set powerOn(time: number) {
    this.origin = time;
  }

  private slowHz(): number {
    const sel = this.regs[CLK_CONF >>> 2] >>> 30;
    return sel === 1 ? SLOW_CLOCK_HZ[2] : sel === 2 ? SLOW_CLOCK_HZ[1] : SLOW_CLOCK_HZ[0];
  }

  /** RTC slow clock cycles since power-on. */
  rtcTime(t = this.ctx.now()): number {
    return Math.floor(((t - this.origin) * this.slowHz()) / REF_HZ);
  }

  // ── Sleep (BT122) ───────────────────────────────────────────────────────────────────────

  /** STATE0.SLEEP_EN was set: `deep` with the digital domain powered down. */
  onSleep: ((deep: boolean) => void) | null = null;

  wakeSources(): number {
    return (this.regs[WAKEUP_STATE >>> 2] >>> 15) & 0x1ffff;
  }

  /** The reference time the timer wakes the chip at, or −1. */
  wakeTime(): number {
    if ((this.wakeSources() & WAKE.TIMER) === 0) return -1;
    const ticks = (this.regs[SLP_TIMER1 >>> 2] & 0xffff) * TWO32 + (this.regs[SLP_TIMER0 >>> 2] >>> 0);
    return this.origin + Math.ceil((ticks * REF_HZ) / this.slowHz());
  }

  /** Do GPIO_WAKEUP's armed pins (GPIO0–5) hold their levels now? Latches GPIO_WAKEUP's STATUS. */
  gpioWake(level: (gpio: number) => number): boolean {
    if ((this.wakeSources() & WAKE.GPIO) === 0) return false;
    const reg = this.regs[GPIO_WAKEUP >>> 2];
    let status = 0;
    for (let pin = 0; pin < 6; pin++) {
      if (((reg >>> (31 - pin)) & 1) === 0) continue;
      const type = (reg >>> (23 - 3 * pin)) & 7;
      const l = level(pin);
      if ((type === 4 && l === 0) || (type === 5 && l === 1)) status |= 1 << pin;
    }
    if (status === 0) return false;
    this.regs[GPIO_WAKEUP >>> 2] = (reg & ~0x3f) | status;
    return true;
  }

  /** BT123: GPIO_WAKEUP's armed pins in words ("GPIO4 low"), when WAKEUP_STATE enables the GPIO wake. */
  wakePins(): string[] {
    const pins: string[] = [];
    if ((this.wakeSources() & WAKE.GPIO) === 0) return pins;
    const reg = this.regs[GPIO_WAKEUP >>> 2];
    for (let pin = 0; pin < 6; pin++) {
      const type = (reg >>> (23 - 3 * pin)) & 7;
      if (((reg >>> (31 - pin)) & 1) !== 0 && (type === 4 || type === 5)) pins.push(`GPIO${pin} ${type === 4 ? 'low' : 'high'}`);
    }
    return pins;
  }

  /** The chip woke for `cause` (WAKE bits). */
  woke(cause: number): void {
    this.regs[SLP_WAKEUP_CAUSE >>> 2] = cause & 0x1ffff;
    this.regs[STATE0 >>> 2] &= ~SLEEP_EN;
    this.regs[INT_RAW >>> 2] |= 1;
  }

  /** The RTC-domain registers, to carry into the chip a system reset builds. */
  rtcDomain(): number[] {
    return RTC_DOMAIN.map((offset) => this.regs[offset >>> 2]);
  }

  keepRtcDomain(values: readonly number[]): void {
    RTC_DOMAIN.forEach((offset, i) => (this.regs[offset >>> 2] = values[i] ?? 0));
  }

  read32(offset: number): number {
    if (offset >= EFUSE_OFFSET) return this.readEfuse(offset - EFUSE_OFFSET);
    switch (offset) {
      case TIME_LOW0:
        return this.latched % TWO32 >>> 0;
      case TIME_HIGH0:
        return Math.floor(this.latched / TWO32) & 0xffff;
      case TIME_UPDATE:
        return this.regs[TIME_UPDATE >>> 2] & 0x7fffffff;
      case RESET_STATE:
        return ((this.regs[RESET_STATE >>> 2] & ~0xfff) | (this.resetCause << 6) | this.resetCause) >>> 0;
    }
    return this.regs[offset >>> 2];
  }

  write32(offset: number, value: number): void {
    if (offset >= EFUSE_OFFSET) {
      this.writeEfuse(offset - EFUSE_OFFSET, value);
      return;
    }
    if (offset === TIME_UPDATE && (value & (1 << 31)) !== 0) this.latched = this.rtcTime();
    if (offset === OPTIONS0 && (value & SW_SYS_RST) !== 0) {
      this.regs[0] = value & ~SW_SYS_RST;
      this.onSoftwareReset?.();
      return;
    }
    if (offset === INT_CLR) {
      this.regs[INT_RAW >>> 2] &= ~value;
      return;
    }
    if (offset === INT_RAW || offset === SLP_WAKEUP_CAUSE) return; // read-only
    if (offset === GPIO_WAKEUP && (value & (1 << 6)) !== 0) value &= ~0x7f; // STATUS_CLR
    const before = this.regs[offset >>> 2];
    this.regs[offset >>> 2] = value;
    if (offset === STATE0 && (value & SLEEP_EN) !== 0 && (before & SLEEP_EN) === 0) this.onSleep?.((this.regs[DIG_PWC >>> 2] & (1 << 31)) !== 0);
  }

  private readEfuse(offset: number): number {
    if (offset === EFUSE_CMD) return 0;
    if (offset === EFUSE_STATUS) return (this.efuse[offset >>> 2] & ~0xf) | 1; // idle
    return this.efuse[offset >>> 2];
  }

  private writeEfuse(offset: number, value: number): void {
    if (offset === EFUSE_CMD) return; // read and program commands complete at once
    this.efuse[offset >>> 2] = value;
  }
}
