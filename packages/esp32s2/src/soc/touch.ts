/**
 * The ESP32-S2's touch sensor (BT155): @benchtop/esp32s3's version-2 model (`TouchV2`, BT158
 * shared with the S3) over the S2's layout (esp32s2 rtc_cntl_reg.h, sens_reg.h, rtc_io_reg.h):
 * RTC_CNTL TOUCH_CTRL1 0x104, CTRL2 0x108, SCAN_CTRL 0x10C, SLP_THRES 0x110, FILTER_CTRL 0x118,
 * TIMEOUT_CTRL 0x120; each pad's slope in RTC_IO's TOUCH_PADn (0x484 + 4·n in RTC_CNTL's page,
 * DAC 25:23); SENS SAR_TOUCH_CONF 0x5C, THRES1 0x60, CHN_ST 0xD4, STATUS0 0xD8, STATUS1 0xDC …
 * APPR_STATUS 0x118. TOUCH1–14 are GPIO1–14.
 */

import { TOUCH_INT, type TouchChip, type TouchContext, type TouchRtc, TouchV2 } from '@benchtop/esp32s3';

export { PAD_PF, SLOPE_UA, TOUCH_CHANNELS, TOUCH_CLOCK_HZ, type TouchContext, type TouchRtc } from '@benchtop/esp32s3';
/** RTC_CNTL interrupt bits (the shared model's). */
export const S2_TOUCH_INT = TOUCH_INT;

/** RTC_CNTL offsets (in its page). */
export const TOUCH_CTRL1 = 0x104;
export const TOUCH_CTRL2 = 0x108;
export const TOUCH_SCAN_CTRL = 0x10c;
export const TOUCH_SLP_THRES = 0x110;
export const TOUCH_FILTER_CTRL = 0x118;
export const TOUCH_TIMEOUT_CTRL = 0x120;
/** RTC_IO's TOUCH_PAD0 (RTC_IO + 0x84) in RTC_CNTL's page. */
export const TOUCH_PAD0 = 0x484;
/** SENS offsets (in SENS). */
export const SAR_TOUCH_CONF = 0x5c;
export const SAR_TOUCH_THRES1 = 0x60;
export const SAR_TOUCH_CHN_ST = 0xd4;
export const SAR_TOUCH_STATUS0 = 0xd8;
export const SAR_TOUCH_STATUS1 = 0xdc;

export const S2_TOUCH_CHIP: TouchChip = {
  ctrl1: TOUCH_CTRL1,
  ctrl2: TOUCH_CTRL2,
  scanCtrl: TOUCH_SCAN_CTRL,
  slpThres: TOUCH_SLP_THRES,
  filterCtrl: TOUCH_FILTER_CTRL,
  timeoutCtrl: TOUCH_TIMEOUT_CTRL,
  slope: (read, n) => (read(TOUCH_PAD0 + 4 * n) >>> 23) & 7,
  conf: SAR_TOUCH_CONF,
  thres1: SAR_TOUCH_THRES1,
  chnSt: SAR_TOUCH_CHN_ST,
  status0: SAR_TOUCH_STATUS0,
  status1: SAR_TOUCH_STATUS1,
  sensLast: 0x118,
};

/** The S2's sensor: the shared model at the S2's offsets. */
export class S2Touch extends TouchV2 {
  constructor(ctx: TouchContext, rtc: TouchRtc, refHz: number) {
    super(ctx, rtc, refHz, S2_TOUCH_CHIP);
  }
}
