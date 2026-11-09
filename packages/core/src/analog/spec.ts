/**
 * What the analog layer needs from a part beyond its links: its diodes (LEDs) and, BT166, its
 * capacitors, BT168, its transistors. Not part of the frozen contracts — the bench takes an `analogSpecFor(type, props)`
 * function as an option (`@benchtop/parts` provides one). Deferred: fold AnalogSpec into
 * PartDefinition at the next contract revision.
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

/** BT166: a capacitor between two pins. */
export interface CapacitorSpec {
  a: string;
  b: string;
  /** Capacitance, farads. */
  farads: number;
}

/**
 * BT168: a bipolar transistor — the base–emitter junction a piecewise-linear diode (knee `vbe`,
 * `rb` above it), the collector current β·Ib while active, Vce(sat) behind `rsat` when the circuit
 * can't take that much. A PNP is the same with every voltage and current negated.
 */
export interface BjtSpec {
  kind: 'npn' | 'pnp';
  c: string;
  b: string;
  e: string;
  beta: number;
  vbe: number;
  rb: number;
  vceSat: number;
  rsat: number;
}

/**
 * BT168: a MOSFET — no gate current; off below `vth`; on, the drain–source a conductance rising
 * linearly from 0 at `vth` to 1/`rdsOn` at `vgsOn`, flat above (a P-channel's voltages negated).
 */
export interface MosfetSpec {
  kind: 'nmos' | 'pmos';
  d: string;
  g: string;
  s: string;
  vth: number;
  rdsOn: number;
  vgsOn: number;
}

export type TransistorSpec = BjtSpec | MosfetSpec;

export interface AnalogSpec {
  diodes: readonly DiodeSpec[];
  /** BT166: capacitors (none when absent). */
  capacitors?: readonly CapacitorSpec[];
  /** BT168: transistors (none when absent). */
  transistors?: readonly TransistorSpec[];
}

export type AnalogSpecFor = (type: string, props: PartProps) => AnalogSpec | undefined;

/**
 * Prop the bench adds (at run time only, never in documents: `$` can't start a prop key) to the
 * props of a part that has an AnalogSpec while the analog layer is on, so its model knows to
 * read currents from volts.
 */
export const ANALOG_PROP = '$analog';
