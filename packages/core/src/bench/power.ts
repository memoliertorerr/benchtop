/**
 * BT200: whether a board's MCU has power. Not a contract: `PartModel` is frozen, so a board's model
 * opts in by carrying a `power` member and the bench reads it at every run slice — a bench
 * convention, like `storage`. A board without it always runs (on USB, as every board did before).
 *
 * The bench, for a board whose `power.on` is false: doesn't run its MCU and releases the MCU's pins
 * (they float, as an unpowered chip's do); when it turns true again: a power-on reset — the MCU
 * resets (its EEPROM or flash keeps what the firmware stored, `NonVolatile`) and its clock restarts
 * at bench time. What decides `on` — rails, regulators, a brown-out level — is the board model's.
 */

export interface BoardPower {
  /** The MCU's supply is good: at or above its brown-out level. */
  readonly on: boolean;
}

/** The power a board's part model reports, if it does. */
export function powerOf(model: unknown): BoardPower | null {
  if (typeof model !== 'object' || model === null || !('power' in model)) return null;
  const power = (model as { power: unknown }).power;
  if (typeof power !== 'object' || power === null || typeof (power as Partial<BoardPower>).on !== 'boolean') return null;
  return power as BoardPower;
}
