/**
 * Switch-level signal values. Every net resolves to a level and the strength that set it;
 * resistors lower strength, switches pass it. Numeric constants, not string unions, because
 * these values sit in typed arrays on the resolver's hot path.
 */

/**
 * How hard a driver holds its net, weakest first. The strongest driver on a net sets its
 * level; two opposite levels at `strong` or above are a conflict (a short).
 * - `hiz`: not driving (an input pin, a released driver).
 * - `weak`: a pull-up/pull-down, or anything seen through a resistor.
 * - `strong`: an MCU output, a part output.
 * - `supply`: a supply or ground pin (`PinDef.volts` defined).
 *
 * Used by part models (`PinHandle.drive`), the bench's MCU pin drivers and the resolver.
 */
export const Strength = { hiz: 0, weak: 1, strong: 2, supply: 3 } as const;
/** One of the `Strength` values, 0–3. Comparable with `<` / `>`. */
export type Strength = (typeof Strength)[keyof typeof Strength];

/** A digital level: 0 = low, 1 = high. */
export type Level = 0 | 1;

/**
 * The resolved state of one net. Produced by the bench's resolver; parts read it through
 * `PinHandle.read()` / `onChange`, MCUs receive it through `McuPin.setInput()`.
 */
export interface NetState {
  /** The winning driver's level; `null` = floating (no driver above `hiz`). */
  level: Level | null;
  /** The winning driver's strength; `Strength.hiz` when floating. */
  strength: Strength;
  /**
   * Opposite levels both at `strong` or above: a short. `level` is then that of the strictly
   * stronger side, or `null` when both sides are equally strong.
   */
  conflict: boolean;
  /**
   * Volts. Digital drivers carry 0 V for level 0 and their supply voltage for level 1; analog
   * drivers (`driveVolts`) carry their own value. 0 when floating.
   */
  volts: number;
}
