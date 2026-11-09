/**
 * Capacitive touch (BT155): an MCU with touch channels (the ESP32-S2's TOUCH1–14) measures the
 * capacitance on its touch pins; parts on those pins' nets add to it — a touch pad's electrode,
 * and the finger on it. Not a contract: an MCU opts in with `touchPins()` / `setTouchSource()`,
 * found by `usesTouch` (as `usesSleep` finds `sleepState`), and a part model by carrying a
 * `touchLoad` member, found by `touchLoadOf` (as `storageOf` finds `storage`).
 *
 * The bench gives each such MCU a source: for a touch pin, the picofarads the touch loads on its
 * net add (0 with nothing there). The MCU asks once per measurement, so a press shows at the next
 * reading; it adds the chip's own pad capacitance itself.
 */

/** An MCU with capacitive touch channels. */
export interface TouchSensing {
  /** The MCU pins with a touch channel, as a board's pinMap names them ('GPIO1'). */
  touchPins(): readonly string[];
  /** The bench's source: picofarads on a touch pin's net beyond the chip's own (null: none). */
  setTouchSource(source: ((pin: string) => number) | null): void;
}

export function usesTouch(mcu: object): mcu is TouchSensing {
  const m = mcu as Partial<TouchSensing>;
  return typeof m.touchPins === 'function' && typeof m.setTouchSource === 'function';
}

/** A part that adds capacitance to the nets its pins are on. */
export interface TouchLoad {
  /** Picofarads it adds now (an electrode, plus a finger while touched). */
  pf(): number;
}

/** The touch load a part model carries, if any. */
export function touchLoadOf(model: unknown): TouchLoad | undefined {
  if (typeof model !== 'object' || model === null || !('touchLoad' in model)) return undefined;
  const load = (model as { touchLoad: unknown }).touchLoad;
  return typeof load === 'object' && load !== null && typeof (load as Partial<TouchLoad>).pf === 'function' ? (load as TouchLoad) : undefined;
}
