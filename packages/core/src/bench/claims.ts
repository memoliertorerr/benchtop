/**
 * Pins an MCU can't give the circuit (BT136): a board's module wires some of the chip's pins to
 * its own parts — a WROVER's PSRAM on GPIO16/17, an R8 module's octal PSRAM on GPIO33–37 — while
 * the board's header may still carry them. The dynamic checks report a claimed pin that is wired
 * to another part (`pin-reserved`). Not a contract: an MCU opts in with `pinClaims()`, found by
 * `usesPinClaims`, as `usesSleep` finds `sleepState`.
 */

export interface PinClaim {
  /** The MCU pin, as a board's pinMap names it ('GPIO16'). */
  readonly pin: string;
  /** What holds it, for people: "the WROVER-E module's PSRAM (its chip select)". */
  readonly by: string;
  /** More for people, or undefined: "Serial2's default RX". */
  readonly note?: string;
}

/** An MCU whose module takes pins. `pinClaims()` is called by every dynamic check: keep its result. */
export interface PinClaims {
  pinClaims(): readonly PinClaim[];
}

export function usesPinClaims(mcu: object): mcu is PinClaims {
  return typeof (mcu as Partial<PinClaims>).pinClaims === 'function';
}
