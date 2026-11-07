/**
 * What the ESP32-C3's peripheral models see of the SoC (BT92). Time is in reference cycles of
 * REF_HZ = 160 MHz — the fastest CPU clock, so an instruction costs a whole number of them at
 * every clock the C3 runs (1 at 160 MHz, 2 at 80 MHz, 4 on the 40 MHz crystal) and the SYSTIMER's
 * 16 MHz tick is 10.
 */

import type { EventTable, ProblemLog } from '@benchtop/esp32';

export const REF_HZ = 160_000_000;
export const XTAL_HZ = 40_000_000;
/** Reference cycles per SYSTIMER tick (16 MHz). */
export const SYSTIMER_TICK = 10;

/** BT124: where a model's interrupt sources go (the C3's controller; the S3's matrix). */
export interface InterruptSource {
  setSource(source: number, high: boolean): void;
}

export interface SocContext {
  /** Now, in reference cycles (inside a run: the running instruction's time). */
  now(): number;
  readonly events: EventTable;
  readonly matrix: InterruptSource;
  readonly problems: ProblemLog;
  /** The APB clock (80 MHz under the PLL, else the CPU clock). */
  readonly apbHz: number;
  /**
   * BT124: reference cycles per second — REF_HZ on the C3; the ESP32-S3, whose SoC shares these
   * models, runs them on its own 240 MHz base.
   */
  readonly refHz: number;
  /** BT124: a register's reset value from the chip's generated headers (the C3's `registerDefault`). */
  regDefault(address: number): number;
  /** Something scheduled an event inside the current slice: end the core's run early. */
  hurry(time: number): void;
}
