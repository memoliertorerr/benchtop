/**
 * The ESP32-S3's RTC controller (BT124; rtc_cntl_reg.h at 0x6000_8000) and eFuse controller
 * (efuse_reg.h at 0x6000_7000) — the C3's models' behavior at the S3's offsets (about half of
 * RTC_CNTL's moved: CLK_CONF 0x74, WDTCONFIG0 0x98, SW_CPU_STALL 0xBC, STORE4 0xC0, …).
 *
 * RTC_CNTL: the RTC timer counts the RTC slow clock (CLK_CONF.ANA_CLK_RTC_SEL: 0 RC_SLOW 136 kHz,
 * 1 XTAL32K, 2 RC_FAST/256) from power-on; TIME_UPDATE latches it into TIME_LOW0/HIGH0, which
 * rtc_time_get reads. RESET_STATE holds the reset cause of both CPUs (`resetCause`).
 * OPTIONS0.SW_SYS_RST (31) asks for a system reset (`onSoftwareReset`). The RTC watchdog isn't
 * modeled (direct boot leaves it off, as the bootloader's app handoff does; WDTCONFIG0 reads
 * back). BT125: offsets 0x800–0x8FF are SENS (`sens`, sens.ts — the ADC). The rest reads back as
 * written.
 *
 * BT128: sleep, as the ESP32's and the C3's (BT121–BT122) at the S3's offsets — STATE0.SLEEP_EN
 * (31) sleeps the chip (`onSleep`; deep with DIG_PWC.DG_WRAP_PD_EN, 31); WAKEUP_STATE (0x3C) ENA
 * (31:15) enables wake sources (EXT0 bit 0, EXT1 1, GPIO 2, TIMER 3; rtc.h's *_TRIG_EN); the timer
 * wakes at SLP_TIMER0/1 on the RTC timer; ext0 is RTC_IO's EXT_WAKEUP0 SEL (an RTC GPIO, which on
 * the S3 is the GPIO of the same number, 0–21) at EXT_WAKEUP_CONF's EXT_WAKEUP0_LV (30); ext1 the
 * RTC GPIOs EXT_WAKEUP1.SEL (21:0) selects — all low, or any high with EXT_WAKEUP1_LV (31) —,
 * latched into EXT_WAKEUP1_STATUS (0xE4), STATUS_CLR (22) clearing it. A wake sets
 * SLP_WAKEUP_CAUSE (0x130) and INT_RAW (0x44) bit 0, cleared through INT_CLR (0x4C). The RTC
 * domain — those registers, STORE0–7 and RTC_IO's — survives a system reset (`rtcDomain`,
 * `keepRtcDomain`). RTC_IO (0x400–0x7FF here): a pad routed to the RTC (TOUCH_PADn/…/RTC_PAD21 at
 * 0x484 + 4·n, MUX_SEL 19) takes its pulls from RUE (27) / RDE (28) — `rtcPad`.
 *
 * BT152: the ESP32-S2 runs this model too, through an `RtcChip`: its RTC_CNTL is the S3's for
 * everything here but five offsets (DIG_PWC 0x8C, EXT_WAKEUP1 0xDC, its STATUS 0xE0,
 * SLP_WAKEUP_CAUSE 0x12C, STORE4–7 0xBC–0xC8), its base and reset values, and its slow clocks; its
 * RTC_IO is the S3's exactly.
 *
 * EFUSE: rev 0 (WAFER_VERSION 0 — the S3 ROM in the pinned release is rev 0) with Espressif's MAC
 * 34:85:18:00:53:01 (or the one the SoC is built with) in BLK1; CMD's READ/PGM bits complete at
 * once.
 */

import type { Peripheral } from '@benchtop/esp32';
import { registerDefault } from './periph.ts';

export const RTC_CNTL_BASE = 0x60008000;
export const EFUSE_BASE = 0x60007000;
export const REF_HZ = 240_000_000;
/** RTC slow clock sources (ANA_CLK_RTC_SEL 0, 1, 2). */
export const SLOW_CLOCK_HZ = [136_000, 32_768, 68_359] as const;

const SENS_OFFSET = 0x800;
const SENS_SIZE = 0x100;

/** BT152: where a chip keeps what this model reads (the S3's, or the S2's). */
export interface RtcChip {
  base: number;
  defaults: (address: number) => number;
  /** RTC slow clock sources (ANA_CLK_RTC_SEL 0, 1, 2) in Hz. */
  slowHz: readonly [number, number, number];
  digPwc: number;
  extWakeup1: number;
  extWakeup1Status: number;
  slpWakeupCause: number;
  /** STORE0–7. */
  stores: readonly number[];
}

export const S3_RTC_CHIP: RtcChip = {
  base: RTC_CNTL_BASE,
  defaults: registerDefault,
  slowHz: SLOW_CLOCK_HZ,
  digPwc: 0x90,
  extWakeup1: 0xe0,
  extWakeup1Status: 0xe4,
  slpWakeupCause: 0x130,
  stores: [0x50, 0x54, 0x58, 0x5c, 0xc0, 0xc4, 0xc8, 0xcc],
};

const OPTIONS0 = 0x00;
const TIME_UPDATE = 0x0c;
const TIME_LOW0 = 0x10;
const TIME_HIGH0 = 0x14;
const RESET_STATE = 0x38;
const CLK_CONF = 0x74;
const SW_SYS_RST = 1 << 31;
const TWO32 = 2 ** 32;
const SLP_TIMER0 = 0x04;
const SLP_TIMER1 = 0x08;
const STATE0 = 0x18;
const WAKEUP_STATE = 0x3c;
const INT_RAW = 0x44;
const INT_CLR = 0x4c;
const EXT_WAKEUP_CONF = 0x64;
const SLEEP_EN = 1 << 31;
const EXT_WAKEUP0_LV = 1 << 30;
const EXT_WAKEUP1_LV = 1 << 31;
const EXT_WAKEUP1_STATUS_CLR = 1 << 22;
/** RTC_IO (0x6000_8400) in this page: the RTC pads' registers (GPIO0–21) and EXT_WAKEUP0. */
const RTC_IO = 0x400;
const RTC_PAD0 = RTC_IO + 0x84;
const EXT_WAKEUP0 = RTC_IO + 0xdc;
const RTC_PADS = 22;
const PAD_MUX_SEL = 1 << 19;
const PAD_RUE = 1 << 27;
const PAD_RDE = 1 << 28;
/** BT128: wake sources (WAKEUP_STATE ENA, SLP_WAKEUP_CAUSE; esp32s3 rtc.h). */
export const S3_WAKE = { EXT0: 1 << 0, EXT1: 1 << 1, GPIO: 1 << 2, TIMER: 1 << 3 } as const;

/** Reset causes (RESET_STATE's PROCPU and APPCPU fields; esp_rom reset_reasons.h). */
export const S3_RESET_REASON = { POWERON: 1, SW_SYS: 3, DEEPSLEEP: 5, TG0WDT_SYS: 7, TG1WDT_SYS: 8, RTCWDT_SYS: 9, TG0WDT_CPU: 11, SW_CPU: 12, RTCWDT_CPU: 13 } as const;

export class S3RtcCntl implements Peripheral {
  private readonly now: () => number;
  private readonly regs = new Uint32Array(1024);
  private readonly chip: RtcChip;
  private readonly DIG_PWC: number;
  private readonly EXT_WAKEUP1: number;
  private readonly EXT_WAKEUP1_STATUS: number;
  private readonly SLP_WAKEUP_CAUSE: number;
  /** Registers the RTC domain keeps through a system reset: the sleep and wake ones, STORE0–7. */
  private readonly RTC_DOMAIN: readonly number[];
  private latched = 0;
  resetCause: number = S3_RESET_REASON.POWERON;
  /** Reference time of the last power-on (the RTC timer counts from it). */
  origin = 0;
  onSoftwareReset: (() => void) | null = null;
  /** BT125: SENS, at +0x800 in this page. */
  sens: Peripheral | null = null;

  constructor(now: () => number, chip: RtcChip = S3_RTC_CHIP) {
    this.now = now;
    this.chip = chip;
    this.DIG_PWC = chip.digPwc;
    this.EXT_WAKEUP1 = chip.extWakeup1;
    this.EXT_WAKEUP1_STATUS = chip.extWakeup1Status;
    this.SLP_WAKEUP_CAUSE = chip.slpWakeupCause;
    this.RTC_DOMAIN = [SLP_TIMER0, SLP_TIMER1, WAKEUP_STATE, EXT_WAKEUP_CONF, chip.digPwc, chip.extWakeup1, chip.extWakeup1Status, chip.slpWakeupCause, ...chip.stores];
    this.systemReset(true);
  }

  systemReset(rtcDomain: boolean): void {
    if (!rtcDomain) return;
    for (let i = 0; i < this.regs.length; i++) this.regs[i] = this.chip.defaults(this.chip.base + i * 4);
    this.origin = this.now();
  }

  private slowHz(): number {
    const sel = this.regs[CLK_CONF >>> 2] >>> 30;
    const hz = this.chip.slowHz;
    return sel === 1 ? hz[1] : sel === 2 ? hz[2] : hz[0];
  }

  /** BT134: USB_CONF (0x120) — which controller has the internal USB PHY (bits 20 and 19). */
  usbConf(): number {
    return this.regs[0x120 >>> 2];
  }

  /** RTC slow clock cycles since power-on. */
  rtcTime(t = this.now()): number {
    return Math.floor(((t - this.origin) * this.slowHz()) / REF_HZ);
  }

  // ── Sleep (BT128) ───────────────────────────────────────────────────────────────────────

  /** STATE0.SLEEP_EN was set: `deep` with the digital domain powered down. */
  onSleep: ((deep: boolean) => void) | null = null;
  /** An RTC pad's routing or pulls changed. */
  onRtcPads: (() => void) | null = null;

  wakeSources(): number {
    return (this.regs[WAKEUP_STATE >>> 2] >>> 15) & 0x1ffff;
  }

  /** The reference time the timer wakes the chip at, or −1. */
  wakeTime(): number {
    if ((this.wakeSources() & S3_WAKE.TIMER) === 0) return -1;
    const ticks = (this.regs[SLP_TIMER1 >>> 2] & 0xffff) * TWO32 + (this.regs[SLP_TIMER0 >>> 2] >>> 0);
    return this.origin + Math.ceil((ticks * REF_HZ) / this.slowHz());
  }

  /** ext0's wake pin (EXT_WAKEUP0 SEL, an RTC GPIO = the GPIO of that number), or −1. */
  ext0Gpio(): number {
    const n = (this.regs[EXT_WAKEUP0 >>> 2] >>> 27) & 0x1f;
    return n < RTC_PADS ? n : -1;
  }

  /**
   * The pin wake sources that hold now (S3_WAKE.EXT0 / EXT1 bits), `level(gpio)` the pads' input
   * levels; ext1's pins are latched into EXT_WAKEUP1_STATUS.
   */
  pinWake(level: (gpio: number) => number): number {
    const sources = this.wakeSources();
    const conf = this.regs[EXT_WAKEUP_CONF >>> 2];
    let cause = 0;
    if ((sources & S3_WAKE.EXT0) !== 0) {
      const g = this.ext0Gpio();
      if (g >= 0 && level(g) === ((conf & EXT_WAKEUP0_LV) !== 0 ? 1 : 0)) cause |= S3_WAKE.EXT0;
    }
    if ((sources & S3_WAKE.EXT1) !== 0) {
      const sel = this.regs[this.EXT_WAKEUP1 >>> 2] & 0x3fffff;
      if (sel !== 0) {
        let high = 0;
        for (let n = 0; n < RTC_PADS; n++) if (((sel >>> n) & 1) !== 0 && level(n) === 1) high |= 1 << n;
        const anyHigh = (conf & EXT_WAKEUP1_LV) !== 0;
        if (anyHigh ? high !== 0 : high === 0) {
          cause |= S3_WAKE.EXT1;
          this.regs[this.EXT_WAKEUP1_STATUS >>> 2] = anyHigh ? high : sel;
        }
      }
    }
    return cause;
  }

  /** The pin wakes WAKEUP_STATE enables, in words: ext0's pin and level, ext1's pins. */
  wakePins(): string[] {
    const sources = this.wakeSources();
    const conf = this.regs[EXT_WAKEUP_CONF >>> 2];
    const pins: string[] = [];
    if ((sources & S3_WAKE.EXT0) !== 0) {
      const g = this.ext0Gpio();
      if (g >= 0) pins.push(`GPIO${g} ${(conf & EXT_WAKEUP0_LV) !== 0 ? 'high' : 'low'}`);
    }
    if ((sources & S3_WAKE.EXT1) !== 0) {
      const sel = this.regs[this.EXT_WAKEUP1 >>> 2] & 0x3fffff;
      const mode = (conf & EXT_WAKEUP1_LV) !== 0 ? 'high (any)' : 'low (all)';
      for (let n = 0; n < RTC_PADS; n++) if (((sel >>> n) & 1) !== 0) pins.push(`GPIO${n} ${mode}`);
    }
    return pins;
  }

  /** The chip woke for `cause` (S3_WAKE bits). */
  woke(cause: number): void {
    this.regs[this.SLP_WAKEUP_CAUSE >>> 2] = cause & 0x1ffff;
    this.regs[STATE0 >>> 2] &= ~SLEEP_EN;
    this.regs[INT_RAW >>> 2] |= 1; // SLP_WAKEUP_INT_RAW
  }

  /** −1 when GPIO `g` isn't routed to the RTC; else its RTC pulls: 0 none, 1 up, 2 down. */
  rtcPad(g: number): number {
    if (g < 0 || g >= RTC_PADS) return -1;
    const pad = this.regs[(RTC_PAD0 >>> 2) + g];
    if ((pad & PAD_MUX_SEL) === 0) return -1;
    return (pad & PAD_RUE) !== 0 ? 1 : (pad & PAD_RDE) !== 0 ? 2 : 0;
  }

  /** What the RTC domain keeps through a system reset (a deep sleep's wake). */
  rtcDomain(): Uint32Array {
    const domain = this.RTC_DOMAIN;
    const kept = new Uint32Array(domain.length + 256);
    domain.forEach((offset, i) => (kept[i] = this.regs[offset >>> 2]));
    kept.set(this.regs.subarray(RTC_IO >>> 2, (RTC_IO >>> 2) + 256), domain.length);
    return kept;
  }

  keepRtcDomain(kept: Uint32Array): void {
    const domain = this.RTC_DOMAIN;
    domain.forEach((offset, i) => (this.regs[offset >>> 2] = kept[i]));
    this.regs.set(kept.subarray(domain.length, domain.length + 256), RTC_IO >>> 2);
    this.onRtcPads?.();
  }

  read32(offset: number): number {
    if (this.sens !== null && offset >= SENS_OFFSET && offset < SENS_OFFSET + SENS_SIZE) return this.sens.read32(offset - SENS_OFFSET);
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
    if (this.sens !== null && offset >= SENS_OFFSET && offset < SENS_OFFSET + SENS_SIZE) {
      this.sens.write32(offset - SENS_OFFSET, value);
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
    if (offset === INT_RAW || offset === this.SLP_WAKEUP_CAUSE) return; // read-only
    if (offset === this.EXT_WAKEUP1 && (value & EXT_WAKEUP1_STATUS_CLR) !== 0) {
      this.regs[this.EXT_WAKEUP1_STATUS >>> 2] = 0;
      value &= ~EXT_WAKEUP1_STATUS_CLR;
    }
    const before = this.regs[offset >>> 2];
    this.regs[offset >>> 2] = value;
    if (offset === STATE0 && (value & SLEEP_EN) !== 0 && (before & SLEEP_EN) === 0) this.onSleep?.((this.regs[this.DIG_PWC >>> 2] & (1 << 31)) !== 0);
    if (offset >= RTC_PAD0 && offset < RTC_PAD0 + RTC_PADS * 4 && ((before ^ value) & (PAD_MUX_SEL | PAD_RUE | PAD_RDE)) !== 0) this.onRtcPads?.();
  }
}

const EFUSE_CMD = 0x1d4;
const EFUSE_STATUS = 0x1d0;
/** RD_MAC_SPI_SYS_0/1 (BLK1 words 0–1). */
const MAC0 = 0x44;
const MAC1 = 0x48;

/** 34:85:18:00:53:01, as BLK1 stores it (the bytes reversed). */
export const S3_EFUSE_MAC = [0x34, 0x85, 0x18, 0x00, 0x53, 0x01];

export class S3Efuse implements Peripheral {
  private readonly regs = new Uint32Array(1024);
  readonly mac: readonly number[];

  constructor(mac: readonly number[] = S3_EFUSE_MAC) {
    this.mac = mac.length === 6 ? mac.slice() : S3_EFUSE_MAC;
    this.systemReset();
  }

  systemReset(): void {
    for (let i = 0; i < this.regs.length; i++) this.regs[i] = registerDefault(EFUSE_BASE + i * 4);
    const m = this.mac;
    this.regs[MAC0 >>> 2] = ((m[2] << 24) | (m[3] << 16) | (m[4] << 8) | m[5]) >>> 0;
    this.regs[MAC1 >>> 2] = ((this.regs[MAC1 >>> 2] & 0xffff0000) | (m[0] << 8) | m[1]) >>> 0;
  }

  read32(offset: number): number {
    if (offset === EFUSE_CMD) return 0;
    if (offset === EFUSE_STATUS) return (this.regs[offset >>> 2] & ~0xf) | 1; // idle
    return this.regs[offset >>> 2];
  }

  write32(offset: number, value: number): void {
    if (offset === EFUSE_CMD) return; // read and program commands complete at once
    this.regs[offset >>> 2] = value;
  }
}
