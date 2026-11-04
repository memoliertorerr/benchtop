/**
 * The ESP32-C3's RTC controller and eFuse controller (BT92), which share the 4 KB block at
 * 0x60008000: RTC_CNTL below 0x800 (rtc_cntl_reg.h), EFUSE from 0x800 (efuse_reg.h).
 *
 * RTC_CNTL: the RTC timer counts the RTC slow clock (CLK_CONF.ANA_CLK_RTC_SEL: 0 RC_SLOW 136 kHz,
 * 1 XTAL32K, 2 RC_FAST/256) from power-on; TIME_UPDATE latches it into TIME_LOW0/HIGH0, which
 * rtc_time_get reads. RESET_STATE holds the reset cause (`resetCause`). OPTIONS0.SW_SYS_RST asks
 * for a system reset (`onSoftwareReset`). Everything else reads back as written.
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

  /** RTC slow clock cycles since power-on. */
  rtcTime(t = this.ctx.now()): number {
    const sel = this.regs[CLK_CONF >>> 2] >>> 30;
    const hz = sel === 1 ? SLOW_CLOCK_HZ[2] : sel === 2 ? SLOW_CLOCK_HZ[1] : SLOW_CLOCK_HZ[0];
    return Math.floor(((t - this.origin) * hz) / REF_HZ);
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
    this.regs[offset >>> 2] = value;
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
