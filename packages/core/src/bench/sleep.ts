/**
 * A board asleep (BT123): the ESP32s' light and deep sleep — whether it sleeps, how, and what wakes
 * it — for the hosts to show (the board view, `sim_state`). Not a contract: an MCU that can sleep
 * opts in with `sleepState()`, found by `usesSleep`, as `usesNonVolatile` finds its memory.
 */

export interface McuSleep {
  /** Deep sleep: the wake is a reset (RTC memory kept). Light: the run goes on where it stopped. */
  readonly deep: boolean;
  /** Nanoseconds until the RTC timer wakes it, or null when the timer doesn't. */
  readonly wakeIn: number | null;
  /** The pin wakes armed, as "GPIO4 low", "GPIO32 high" (ESP32 ext1: "GPIO32 high (any)", "… low (all)"). */
  readonly pins: readonly string[];
}

/** An MCU that can sleep; `sleepState()` is null while it is awake. */
export interface Sleeper {
  sleepState(): McuSleep | null;
}

export function usesSleep(mcu: object): mcu is Sleeper {
  return typeof (mcu as Partial<Sleeper>).sleepState === 'function';
}

/** A board's sleep as the bench reports it: the timer's wake as a bench time. */
export interface BoardSleep {
  readonly deep: boolean;
  /** When the timer wakes it (bench ns), or null. */
  readonly wakeAt: number | null;
  readonly pins: readonly string[];
}

/** "deep sleep — wakes: timer at 5.2 s, GPIO4 low" style words for a board's sleep. */
export function describeSleep(sleep: BoardSleep): string {
  const wakes: string[] = [];
  if (sleep.wakeAt !== null) wakes.push(`timer at ${(sleep.wakeAt / 1e9).toFixed(3)} s`);
  wakes.push(...sleep.pins);
  return `${sleep.deep ? 'deep' : 'light'} sleep — ${wakes.length === 0 ? 'nothing wakes it' : `wakes: ${wakes.join(', ')}`}`;
}
