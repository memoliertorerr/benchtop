/**
 * Resets and reboots (BT33). Reset causes are the ROM's RESET_REASON values
 * (SDK/include/esp_rom/include/esp32/rom/rtc.h; soc/reset_reasons.h names the same numbers) — what
 * RTC_CNTL_RESET_STATE reports per CPU after the reset.
 *
 * Benchtop reboots the whole chip the same way for every cause: after RESET_SETTLE the PRO_CPU
 * "leaves the ROM" — every digital block returns to its reset state, RAM keeps its contents (as
 * on hardware; the app re-initializes what it uses), RTC_CNTL keeps STORE0–7 and RTC FAST/SLOW
 * memory are kept (an RTC reset clears those too), the flash keeps whatever the firmware wrote,
 * and direct boot runs again with the new cause. The ROM banner and the 2nd-stage bootloader's
 * work (≈ 0.3 s on hardware) are skipped, as on the first boot.
 *
 * Who reboots when:
 *   - RTC_CNTL_OPTIONS0 SW_SYS_RST → SW_RESET (3), at once for both CPUs.
 *   - SW_PROCPU_RST → SW_CPU_RESET (12): the PRO_CPU stops; it reboots the chip once it has been
 *     out of reset and not stalled for RESET_SETTLE. esp_restart_noos resets the other CPU, stalls
 *     it, waits for the UARTs, …, then resets and unstalls the PRO_CPU last — so the reboot lands
 *     after the whole sequence, as it does on hardware.
 *   - SW_APPCPU_RST: the APP_CPU alone restarts at the ROM reset vector (no reboot).
 *   - Watchdog reset actions: TIMG MWDT "reset system" → TG0WDT_SYS_RESET (7) / TG1WDT_SYS_RESET
 *     (8); MWDT "reset CPU" → TGWDT_CPU_RESET (11); RTC WDT → RTCWDT_CPU_RESET (13),
 *     RTCWDT_SYS_RESET (9) or RTCWDT_RTC_RESET (16, which also clears the RTC domain).
 *
 * Loop guard: a reboot less than 1 s of simulated time after the previous boot is rapid. After 5
 * rapid reboots in a row the next rapid one stops the run with "reboot loop: <cause>" instead of
 * rebooting — a slow crash-and-reboot cycle (a watchdog firing every few seconds) keeps running,
 * as hardware does.
 */

import { REF_HZ } from './context.ts';

export const RESET_REASON = {
  POWERON: 1,
  SW: 3,
  TG0WDT_SYS: 7,
  TG1WDT_SYS: 8,
  RTCWDT_SYS: 9,
  TGWDT_CPU: 11,
  SW_CPU: 12,
  RTCWDT_CPU: 13,
  RTCWDT_RTC: 16,
} as const;

const NAMES: Record<number, string> = {
  1: 'POWERON_RESET',
  3: 'SW_RESET',
  7: 'TG0WDT_SYS_RESET',
  8: 'TG1WDT_SYS_RESET',
  9: 'RTCWDT_SYS_RESET',
  11: 'TGWDT_CPU_RESET',
  12: 'SW_CPU_RESET',
  13: 'RTCWDT_CPU_RESET',
  16: 'RTCWDT_RTC_RESET',
};

/** "SW_CPU_RESET (0x0c)". */
export function resetName(reason: number): string {
  return `${NAMES[reason] ?? 'RESET'} (0x${reason.toString(16).padStart(2, '0')})`;
}

/** How long a reset holds the chip before the reboot (100 µs of reference time). */
export const RESET_SETTLE = REF_HZ / 10_000;
/** A reboot sooner than this after the previous boot is rapid. */
export const RAPID_REBOOT = REF_HZ;
/** Rapid reboots allowed in a row; the next rapid one ends the run. */
export const RAPID_LIMIT = 5;

/** What a peripheral can ask of the SoC: a reboot with a cause (RESET_REASON). */
export interface ResetSink {
  /** The whole chip resets now (system reset, watchdog): both CPUs stop until the reboot. */
  systemReset(reason: number, rtcDomain?: boolean): void;
  /** RTC_CNTL_SW_PROCPU_RST: the PRO_CPU stops; the chip reboots once it is released. */
  proCpuReset(): void;
  /** RTC_CNTL_SW_APPCPU_RST: the APP_CPU restarts at the ROM reset vector. */
  appCpuReset(): void;
  /** The SW_CPU_STALL / OPTIONS0 stall fields changed. */
  stallChanged(): void;
}
