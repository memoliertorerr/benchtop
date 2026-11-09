/**
 * The ESP32-S2's RTC controller (BT148; rtc_cntl_reg.h at 0x3F40_8000) and eFuse controller
 * (efuse_reg.h at 0x3F41_A000) — the S3's models' behavior at the S2's offsets.
 *
 * RTC_CNTL: the RTC timer counts the RTC slow clock (CLK_CONF (0x74) ANA_CLK_RTC_SEL 31:30: 0 RC_SLOW
 * 90 kHz, 1 XTAL32K, 2 RC_FAST/256) from power-on; TIME_UPDATE (0x0C) latches it into TIME_LOW0 /
 * HIGH0 (0x10 / 0x14), which rtc_time_get reads. RESET_STATE (0x38) holds the reset cause
 * (`resetCause`) in its PROCPU and APPCPU fields. OPTIONS0.SW_SYS_RST (31) asks for a system reset
 * (`onSoftwareReset`). The RTC watchdog isn't modeled (direct boot leaves it off, as the app's
 * startup turns the bootloader's off; WDTCONFIG0 reads back). BT149: offsets 0x800–0x8FF are SENS
 * (`sens`: @benchtop/esp32s3's S3Sens, the ADC). BT150: STATE0.SLEEP_EN (0x18 bit 31) — the
 * firmware entering light or deep sleep, not modeled on the S2 yet — calls `onSleep` (the SoC halts
 * with a reason). The rest reads back as written.
 *
 * EFUSE: the S3's register layout (efuse_reg.h, the same offsets) — rev 0 with Espressif's MAC
 * 7C:DF:A1:00:52:01 (or the one the SoC is built with) in BLK1; CMD's READ/PGM bits complete at once.
 */

import type { Peripheral } from '@benchtop/esp32';
import { SENS_OFFSET, SENS_SIZE } from '@benchtop/esp32s3';
import { registerDefault } from './periph.ts';

export const RTC_CNTL_BASE = 0x3f408000;
export const EFUSE_BASE = 0x3f41a000;
export const REF_HZ = 240_000_000;
/** RTC slow clock sources (ANA_CLK_RTC_SEL 0, 1, 2). */
export const SLOW_CLOCK_HZ = [90_000, 32_768, 31_250] as const;

const OPTIONS0 = 0x00;
const TIME_UPDATE = 0x0c;
const TIME_LOW0 = 0x10;
const TIME_HIGH0 = 0x14;
const STATE0 = 0x18;
const SLEEP_EN = 1 << 31;
const RESET_STATE = 0x38;
const CLK_CONF = 0x74;
const SW_SYS_RST = 1 << 31;
const TWO32 = 2 ** 32;

/** Reset causes (RESET_STATE's PROCPU field; esp_rom reset_reasons.h). */
export const S2_RESET_REASON = { POWERON: 1, SW_SYS: 3, DEEPSLEEP: 5, TG0WDT_SYS: 7, TG1WDT_SYS: 8, RTCWDT_SYS: 9, TG0WDT_CPU: 11, SW_CPU: 12, RTCWDT_CPU: 13 } as const;

export class S2RtcCntl implements Peripheral {
  private readonly now: () => number;
  private readonly regs = new Uint32Array(1024);
  private latched = 0;
  resetCause: number = S2_RESET_REASON.POWERON;
  /** Reference time of the last power-on (the RTC timer counts from it). */
  origin = 0;
  onSoftwareReset: (() => void) | null = null;
  /** SENS, in this block's page (BT149). */
  sens: Peripheral | null = null;
  /** BT150: the firmware set STATE0.SLEEP_EN — light or deep sleep, which isn't modeled on the S2 yet. */
  onSleep: (() => void) | null = null;

  constructor(now: () => number) {
    this.now = now;
    this.systemReset(true);
  }

  systemReset(rtcDomain: boolean): void {
    if (!rtcDomain) return;
    for (let i = 0; i < this.regs.length; i++) this.regs[i] = registerDefault(RTC_CNTL_BASE + i * 4);
    this.origin = this.now();
  }

  private slowHz(): number {
    const sel = this.regs[CLK_CONF >>> 2] >>> 30;
    return sel === 1 ? SLOW_CLOCK_HZ[1] : sel === 2 ? SLOW_CLOCK_HZ[2] : SLOW_CLOCK_HZ[0];
  }

  /** RTC slow clock cycles since power-on. */
  rtcTime(t = this.now()): number {
    return Math.floor(((t - this.origin) * this.slowHz()) / REF_HZ);
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
    if (offset === STATE0 && (value & SLEEP_EN) !== 0) {
      this.regs[STATE0 >>> 2] = value & ~SLEEP_EN;
      this.onSleep?.();
      return;
    }
    if (offset === OPTIONS0 && (value & SW_SYS_RST) !== 0) {
      this.regs[0] = value & ~SW_SYS_RST;
      this.onSoftwareReset?.();
      return;
    }
    this.regs[offset >>> 2] = value;
  }
}

const EFUSE_CMD = 0x1d4;
const EFUSE_STATUS = 0x1d0;
/** RD_MAC_SPI_SYS_0/1 (BLK1 words 0–1). */
const MAC0 = 0x44;
const MAC1 = 0x48;

/** 7C:DF:A1:00:52:01 — an Espressif OUI the S2's modules carry — as BLK1 stores it (the bytes reversed). */
export const S2_EFUSE_MAC = [0x7c, 0xdf, 0xa1, 0x00, 0x52, 0x01];

export class S2Efuse implements Peripheral {
  private readonly regs = new Uint32Array(1024);
  readonly mac: readonly number[];

  constructor(mac: readonly number[] = S2_EFUSE_MAC) {
    this.mac = mac.length === 6 ? mac.slice() : S2_EFUSE_MAC;
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
