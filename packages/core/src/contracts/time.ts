/**
 * Simulation time is kept in nanoseconds as a float64. Integers stay exact up to 2^53 ns
 * (~104 days of simulated time), which is far beyond any session. MCUs keep their own cycle
 * counters and convert at quantum boundaries with these helpers.
 */
export type Nanos = number;

/** Nanoseconds per microsecond. */
export const NS_PER_US = 1_000;
/** Nanoseconds per millisecond. */
export const NS_PER_MS = 1_000_000;
/** Nanoseconds per second. */
export const NS_PER_S = 1_000_000_000;

/** Simulated time, ns, of `cycles` cycles of a `clockHz` clock. Called by the bench. */
export function cyclesToNanos(cycles: number, clockHz: number): Nanos {
  return (cycles * NS_PER_S) / clockHz;
}

/** Whole cycles that fit in `ns`, rounded down so an MCU never runs past the target time. */
export function nanosToCycles(ns: Nanos, clockHz: number): number {
  return Math.floor((ns * clockHz) / NS_PER_S);
}
