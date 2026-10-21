/**
 * What the ESP32 peripheral models need from the SoC (BT32): the time, the clocks, the event
 * table, the interrupt matrix, the Problem log and (BT33) resets. Esp32Soc implements it; the
 * peripherals take it in their constructors (no import cycle with soc.ts).
 */

import type { EventTable } from './events.ts';
import type { ProblemLog } from './periph.ts';
import type { ResetSink } from './reset.ts';

/** Reference cycles per second: the SoC's time unit is a 240 MHz cycle. */
export const REF_HZ = 240_000_000;
/** The crystal Benchtop's ESP32 has (RTC_CNTL_STORE4 says so to the app). */
export const XTAL_HZ = 40_000_000;

export interface InterruptSink {
  /** A peripheral's level interrupt line (source 0–68 of the interrupt matrix). */
  setSource(source: number, high: boolean): void;
}

export interface SocContext {
  /** Now, in reference cycles (the executing core's local time while one runs). */
  now(): number;
  /** The APB clock in Hz (80 MHz under the PLL, the CPU clock otherwise). */
  readonly apbHz: number;
  readonly events: EventTable;
  readonly interrupts: InterruptSink;
  readonly problems: ProblemLog;
  readonly resets: ResetSink;
  /** PC of the instruction now executing (for Problems), or 0. */
  pc(): number;
  /** A clock-select register changed: recompute the CPU and APB clocks. */
  clockChanged(): void;
}
