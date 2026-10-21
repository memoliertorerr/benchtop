/**
 * What the environment needs to know about a part type (BT54): whether it holds the ambient
 * conditions, is a source (gas, heat, flame, light, sound, a fan), a body (a person, an object)
 * or a sensor that samples the world. Not part of the frozen contracts — the bench takes an
 * `envSpecFor(type, props)` function as an option, like `analogSpecFor`; `@benchtop/parts`
 * provides one.
 *
 * Units throughout: metres, seconds, °C, %RH, ppm, lux, dB SPL.
 */

import type { PartProps } from '../contracts/part.ts';

/** What a sensor can sample at its position. */
export type EnvField =
  /** ppm: the ambient baseline plus the gas grid. */
  | 'gas'
  /** °C: the ambient plus the heat grid. */
  | 'temperature'
  /** %RH: the ambient's absolute humidity at the local temperature. */
  | 'humidity'
  /** lux: the ambient plus every lamp and flame, inverse-square. */
  | 'light'
  /** dB SPL: the ambient and every sound source, added as energies. */
  | 'sound'
  /** 0..1: infrared from flames inside the sensor's cone. */
  | 'flame'
  /** m: the nearest body inside the sensor's cone, 0 when none within range. */
  | 'distance'
  /** 1 while a warm body moves inside the sensor's cone, else 0. */
  | 'motion';

/** The fields a grid or a closed form can give at any point (the overlay and `env` expectations). */
export const POINT_FIELDS = ['gas', 'temperature', 'humidity', 'light', 'sound'] as const;
export type PointField = (typeof POINT_FIELDS)[number];

/** How a sample reaches the part: its inputs are its interface (no contract change). */
export type EnvDelivery =
  /** `{ kind: 'value', value }`. */
  | { kind: 'value' }
  /** `{ kind: 'key', key: 'set:<channel>=<v>', down: true }` (the channel-input convention). */
  | { kind: 'channel'; channel: string }
  /** `{ kind: 'press' }` at every sampling period while the sample is nonzero (a PIR's trigger). */
  | { kind: 'press-while' };

export interface EnvSample {
  field: EnvField;
  deliver: EnvDelivery;
  /** World value → the part's input value (e.g. metres → cm). Identity when absent. */
  map?: (value: number) => number;
  /** Smallest change (in the delivered unit) worth an input; ignored for press-while. */
  epsilon: number;
}

/** A sensor's field of view: a cone around its facing, turned with the part. */
export interface EnvCone {
  /** Half the opening angle, degrees. */
  halfAngleDeg: number;
  /** Reach, metres. */
  range: number;
  /**
   * Where the unrotated part looks, a unit vector in its own frame (y down): (0, −1), up on the
   * screen, by default — a module drawn face-on with its pins at the bottom; (−1, 0) for one
   * whose sensor sits at its left end.
   */
  facing?: { x: number; y: number };
}

export type SourceKind = 'gas' | 'heat' | 'flame' | 'light' | 'sound' | 'fan';

export interface SourceSpec {
  kind: SourceKind;
  /**
   * Parameters by name, from the part's props: gas `rate` (L/min of pure gas), heat `watts`,
   * flame `strength` (1 ≈ a candle), light `lumens`, sound `db` (at 1 m), fan `flow` (m³/min
   * extracted at its position). Channel inputs `set:<name>=<v>` change them while running.
   */
  params: Readonly<Record<string, number>>;
  /** Initially on. `set:on=0|1`, press (on) and release (off) switch it while running. */
  on: boolean;
  /** A control input pair: while IN is wired, the source is on while V(IN) − V(GND) > 1.5 V. */
  control?: { pin: string; ground?: string };
}

export interface BodySpec {
  /** A person (a warm circle a PIR sees) or an object (a box). */
  shape: { kind: 'circle'; radius: number } | { kind: 'box'; w: number; h: number };
  warm: boolean;
  /**
   * Patrol: from the part's position to that position + (toX, toY) bench mm, at `speed` m/s,
   * pausing `pause` s at each end, and back, forever. No patrol when speed ≤ 0 or the offset is 0.
   */
  toX: number;
  toY: number;
  speed: number;
  pause: number;
  /** Initially walking. `set:on=0|1` stops and resumes the patrol where it is. */
  on: boolean;
}

export interface AmbientSpec {
  temperature: number;
  humidity: number;
  light: number;
  sound: number;
  gas: number;
  /** Air changes per hour: the gas and heat grids decay at ACH/3600 per second. */
  ventilation: number;
  /** Turbulent mixing (diffusion) coefficient, m²/s. */
  mixing: number;
  /**
   * The room's floor, m: the grids cover it (closed walls), centred on the parts and grown to
   * hold every part with a 25 cm margin. Its volume decides how fast gas and heat build up.
   */
  roomWidth: number;
  roomDepth: number;
  /**
   * Mixing layer, m: the air a source first spreads into — one cell column this tall. The grids
   * are 2D, so this stands for how far gas and warm air spread vertically near the source.
   */
  layer: number;
  /** Extra heat loss rate (walls, furniture), 1/s. */
  heatLoss: number;
  /** Room mm per bench mm: positions in the world are bench mm × scale / 1000. */
  scale: number;
  /** Heatmap overlay field: 0 off, 1 gas, 2 temperature, 3 light, 4 sound. */
  overlay: number;
}

export type EnvSpec =
  | { role: 'ambient'; ambient: AmbientSpec }
  | { role: 'source'; source: SourceSpec }
  | { role: 'body'; body: BodySpec }
  | { role: 'sensor'; samples: readonly EnvSample[]; cone?: EnvCone };

export type EnvSpecFor = (type: string, props: PartProps) => EnvSpec | undefined;

/** Overlay codes (AmbientSpec.overlay, the ambient part's `set:overlay=<code>`). */
export const OVERLAY_FIELDS: readonly (PointField | null)[] = [null, 'gas', 'temperature', 'light', 'sound'];

/**
 * A sensor part's prop that opts out of the environment (`followEnvironment: false`): its own
 * props and inputs drive it as without an environment.
 */
export const FOLLOW_ENV_PROP = 'followEnvironment';
