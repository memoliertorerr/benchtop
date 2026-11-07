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
const OPTIONS0 = 0x00;
const TIME_UPDATE = 0x0c;
const TIME_LOW0 = 0x10;
const TIME_HIGH0 = 0x14;
const RESET_STATE = 0x38;
const CLK_CONF = 0x74;
const SW_SYS_RST = 1 << 31;
const TWO32 = 2 ** 32;

/** Reset causes (RESET_STATE's PROCPU and APPCPU fields; esp_rom reset_reasons.h). */
export const S3_RESET_REASON = { POWERON: 1, SW_SYS: 3, DEEPSLEEP: 5, TG0WDT_SYS: 7, TG1WDT_SYS: 8, RTCWDT_SYS: 9, TG0WDT_CPU: 11, SW_CPU: 12, RTCWDT_CPU: 13 } as const;

export class S3RtcCntl implements Peripheral {
  private readonly now: () => number;
  private readonly regs = new Uint32Array(1024);
  private latched = 0;
  resetCause: number = S3_RESET_REASON.POWERON;
  /** Reference time of the last power-on (the RTC timer counts from it). */
  origin = 0;
  onSoftwareReset: (() => void) | null = null;
  /** BT125: SENS, at +0x800 in this page. */
  sens: Peripheral | null = null;

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
