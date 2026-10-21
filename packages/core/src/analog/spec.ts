/**
 * What the analog layer needs from a part beyond its links: its diodes (LEDs). Not part of the
 * frozen contracts — the bench takes an `analogSpecFor(type, props)` function as an option
 * (`@benchtop/parts` provides one). Deferred: fold AnalogSpec into PartDefinition at the next
 * contract revision.
 */

import type { PartProps } from '../contracts/part.ts';

/** A piecewise-linear diode: off below `vf`, I = (Vd − vf) / rs above it. */
export interface DiodeSpec {
  /** Pin name of the anode. */
  anode: string;
  /** Pin name of the cathode. */
  cathode: string;
  /** Knee voltage, volts. */
  vf: number;
  /** Series resistance above the knee, ohms. */
  rs: number;
}

export interface AnalogSpec {
  diodes: readonly DiodeSpec[];
}

export type AnalogSpecFor = (type: string, props: PartProps) => AnalogSpec | undefined;

/**
 * Prop the bench adds (at run time only, never in documents: `$` can't start a prop key) to the
 * props of a part that has an AnalogSpec while the analog layer is on, so its model knows to
 * read currents from volts.
 */
export const ANALOG_PROP = '$analog';
