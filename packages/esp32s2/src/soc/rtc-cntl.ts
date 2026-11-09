/**
 * The ESP32-S2's RTC controller (BT148; rtc_cntl_reg.h at 0x3F40_8000) and eFuse controller
 * (efuse_reg.h at 0x3F41_A000) — the S3's models' behavior at the S2's offsets.
 *
 * RTC_CNTL (BT152): @benchtop/esp32s3's S3RtcCntl with the S2's `RtcChip` — the RTC timer on the
 * S2's slow clocks (CLK_CONF.ANA_CLK_RTC_SEL: 0 RC_SLOW 90 kHz, 1 XTAL32K, 2 RC_FAST/256 31.25 kHz),
 * TIME_UPDATE/TIME_LOW0/HIGH0, the reset cause in RESET_STATE, OPTIONS0.SW_SYS_RST
 * (`onSoftwareReset`), SENS at +0x800 (`sens`, BT149: the ADC), and sleep: STATE0.SLEEP_EN (`onSleep`;
 * deep with DIG_PWC 0x8C's DG_WRAP_PD_EN), WAKEUP_STATE's enables, the timer (SLP_TIMER0/1), ext0
 * (RTC_IO's EXT_WAKEUP0), ext1 (EXT_WAKEUP1 0xDC, its STATUS 0xE0), the cause in SLP_WAKEUP_CAUSE
 * (0x12C), the RTC domain kept through a system reset (STORE0–3 0x50–0x5C, STORE4–7 0xBC–0xC8), and
 * RTC_IO's pads at 0x484 + 4·n — the S3's layout exactly. The RTC watchdog isn't modeled (direct
 * boot leaves it off, as the app's startup turns the bootloader's off; WDTCONFIG0 reads back).
 *
 * EFUSE: the S3's register layout (efuse_reg.h, the same offsets) — rev 0 with Espressif's MAC
 * 7C:DF:A1:00:52:01 (or the one the SoC is built with) in BLK1; CMD's READ/PGM bits complete at once.
 */

import type { Peripheral } from '@benchtop/esp32';
import { type RtcChip, S3RtcCntl } from '@benchtop/esp32s3';
import { registerDefault } from './periph.ts';

export const RTC_CNTL_BASE = 0x3f408000;
export const EFUSE_BASE = 0x3f41a000;
export const REF_HZ = 240_000_000;
/** RTC slow clock sources (ANA_CLK_RTC_SEL 0, 1, 2). */
export const SLOW_CLOCK_HZ = [90_000, 32_768, 31_250] as const;

/** Reset causes (RESET_STATE's PROCPU field; esp_rom reset_reasons.h). */
export const S2_RESET_REASON = { POWERON: 1, SW_SYS: 3, DEEPSLEEP: 5, TG0WDT_SYS: 7, TG1WDT_SYS: 8, RTCWDT_SYS: 9, TG0WDT_CPU: 11, SW_CPU: 12, RTCWDT_CPU: 13 } as const;
/** BT152: wake sources (WAKEUP_STATE ENA, SLP_WAKEUP_CAUSE; esp32s2 rtc.h — the S3's bits). */
export const S2_WAKE = { EXT0: 1 << 0, EXT1: 1 << 1, GPIO: 1 << 2, TIMER: 1 << 3 } as const;

/** BT152: the S2's RTC_CNTL for the S3's model (rtc_cntl_reg.h). */
export const S2_RTC_CHIP: RtcChip = {
  base: RTC_CNTL_BASE,
  defaults: registerDefault,
  slowHz: SLOW_CLOCK_HZ,
  digPwc: 0x8c,
  extWakeup1: 0xdc,
  extWakeup1Status: 0xe0,
  slpWakeupCause: 0x12c,
  stores: [0x50, 0x54, 0x58, 0x5c, 0xbc, 0xc0, 0xc4, 0xc8],
};

export class S2RtcCntl extends S3RtcCntl {
  constructor(now: () => number) {
    super(now, S2_RTC_CHIP);
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
