/**
 * What a part is: `@benchtop/parts` provides `PartDefinition`s (pins, buses, links, props and
 * an optional behavior model); the bench consumes them. A model talks to the circuit only
 * through the `PartContext` it is given, so it runs unchanged in the worker, in tests and in
 * the headless runner.
 *
 * Units: positions and sizes in mm, time in ns (`Nanos`), voltages in volts.
 */

import type { I2cDevice, SpiDevice } from './bus.ts';
import type { Level, NetState, Strength } from './signal.ts';
import type { Nanos } from './time.ts';

/**
 * Electrical role of a pin, used by the editor (wire colors) and the circuit checker:
 * - `digital`: logic input/output (MCU GPIOs, a button's logic side).
 * - `analog`: carries a voltage someone reads (a pot wiper, an ADC input).
 * - `power`: a supply pin (5V, 3V3, VCC).
 * - `ground`: a ground pin.
 * - `passive`: a component lead (resistor, LED, breadboard hole).
 * - `nc`: not connected inside the part.
 */
export type PinRole = 'digital' | 'analog' | 'power' | 'ground' | 'passive' | 'nc';

/** One pin of a part type. */
export interface PinDef {
  /** Unique within the part, e.g. `'13'`, `'GND.1'`, `'A'`. Wires and `PinRef`s use it. */
  name: string;
  /** mm from the unrotated part's left edge. */
  x: number;
  /** mm from the unrotated part's top edge. */
  y: number;
  /** Electrical role (see `PinRole`). */
  role: PinRole;
  /**
   * Volts. Defined ⇒ this pin is a supply source at that voltage (ground pins: 0); the bench
   * drives its net at `Strength.supply` (level 1 when volts > 0). Undefined ⇒ the pin only
   * consumes (a VCC input on a module, an LED lead) and gets no driver.
   */
  volts?: number;
}

/**
 * A two-terminal element inside a part that joins two nets through the resolver rather than
 * merging them: a resistor (`resistive`) or a switch/button contact (`switch`). Links are not
 * buses: the netlist keeps their pins on separate nets.
 */
export interface LinkDef {
  /** Unique within the part; `PartContext.link(id)` returns its handle. */
  id: string;
  /** Pin name of one end. */
  a: string;
  /** Pin name of the other end. */
  b: string;
  /**
   * `resistive`: passes the other end's level reduced to `weak` (never raises strength).
   * `switch`: passes level and strength unchanged while closed, nothing while open.
   */
  kind: 'resistive' | 'switch';
  /** Ohms, for `resistive` links. Digital resolution ignores the value; the analog solver uses it. */
  ohms?: number;
  /** Initial state of a `switch` link (default open). */
  closed?: boolean;
}

/** Prop values a part instance carries: what `PartInstance.props` may hold. */
export type PartProps = Record<string, string | number | boolean>;

/**
 * A part type in the catalog. `P` is the props shape; declare it as a type alias
 * (`type LedProps = { color: string }`), because interfaces have no implicit index signature
 * and don't satisfy `PartProps`.
 */
export interface PartDefinition<P extends PartProps = PartProps> {
  /** Catalog key, kebab-case, stored in `PartInstance.type`, e.g. `'arduino-uno'`. */
  type: string;
  /** Human-readable name for the palette and inspector. */
  title: string;
  /** Palette group: a `PART_CATEGORIES` id from `@benchtop/parts`. */
  category: string;
  /** mm, the unrotated part's bounding box; rotation is about its center. */
  size: { w: number; h: number };
  /** Every pin, with positions relative to the unrotated top-left corner. */
  pins: readonly PinDef[];
  /**
   * Pin groups shorted inside the part (a breadboard's 5-hole strips and rails, a board's
   * duplicated GND pins). The netlist merges each group into one net.
   */
  buses?: readonly (readonly string[])[];
  /** Resistive and switch elements between two of this part's pins (see `LinkDef`). */
  links?: readonly LinkDef[];
  /** Every prop with its default value. The bench merges instance props over these. */
  defaults: P;
  /** Present on MCU boards: the bench creates an `Mcu` for each instance. */
  board?: BoardSpec;
  /**
   * Behavior. Called by the bench once per instance each time it builds the circuit, with
   * `props` = defaults merged with the instance's props. Parts without behavior (breadboards)
   * omit it.
   */
  createModel?(ctx: PartContext, props: P): PartModel;
}

/** The MCU on a board part and how its header pins map to MCU pins. */
export interface BoardSpec {
  /** Which `Mcu` implementation the bench asks its environment for ('atmega2560': BT46, human-approved). */
  mcu: 'atmega328p' | 'atmega2560' | 'esp32';
  /** Header pin name (`PinDef.name`, e.g. `'13'`, `'A0'`) → MCU pin id (`McuPin.id`, e.g. `'PB5'`). */
  pinMap: Record<string, string>;
}

/**
 * A part model's handle on one of its pins, from `PartContext.pin()`. All methods are cheap and
 * allocation-free; models call them from pin listeners and timers.
 */
export interface PinHandle {
  /** The pin's `PinDef.name`. */
  readonly name: string;
  /**
   * Resolved state of this pin's net. The bench may reuse the returned object: read the fields
   * you need now and copy them if you keep them.
   */
  read(): NetState;
  /** Drive a digital level (0 V / the logic supply) at `strength` (default `Strength.strong`). */
  drive(level: Level, strength?: Strength): void;
  /**
   * Drive an analog voltage (volts) at `strength` (default `Strength.strong`). Digital readers
   * see the level the bench derives from it (high at or above half the logic supply).
   */
  driveVolts(volts: number, strength?: Strength): void;
  /** Stop driving: back to `Strength.hiz`. */
  release(): void;
  /**
   * Called synchronously whenever the net's resolved state changes, whoever caused it,
   * including from inside an MCU's run (so `PartContext.now()` is the edge's exact time).
   * `state` follows the same reuse rule as `read()`. Listeners must not allocate.
   */
  onChange(listener: (state: NetState) => void): void;
}

/** A part model's handle on one of its links, from `PartContext.link()`. */
export interface LinkHandle {
  /** Open or close a `switch` link (a button press, a relay contact). */
  setClosed(closed: boolean): void;
  /** Change a `resistive` link's value in ohms (a potentiometer, an LDR). */
  setOhms(ohms: number): void;
}

/** Everything a part model may do to the circuit. Provided by the bench to `createModel`. */
export interface PartContext {
  /**
   * Current simulated time, ns. While an MCU is executing, this is that MCU's current cycle
   * time, not the quantum start, so pulse widths measured in pin listeners are exact.
   */
  now(): Nanos;
  /** Handle for one of this part's pins, by `PinDef.name`. Get handles once, in `createModel`. */
  pin(name: string): PinHandle;
  /** Handle for one of this part's links, by `LinkDef.id`. Get handles once, in `createModel`. */
  link(id: string): LinkHandle;
  /**
   * Run `callback` once, `delay` ns of simulated time from now. Returns a timer id for
   * `cancel`. Reuse one preallocated callback per part rather than a closure per event.
   */
  schedule(delay: Nanos, callback: () => void): number;
  /** Cancel a pending timer; ids that already fired or were cancelled are ignored. */
  cancel(timerId: number): void;
  /** Visual state changed: the bench calls `PartModel.visual()` when it collects the next frame. */
  invalidate(): void;
  /** Report a problem for the Problems panel; `parts` should include this part's id. */
  report(problem: Problem): void;
  /**
   * Put `device` on an I2C bus: the bench attaches it to the MCU I2C controller whose SDA/SCL
   * pins share nets with this part's pins `sda` and `scl` (pin names). Call in `createModel`.
   */
  attachI2c(sda: string, scl: string, device: I2cDevice): void;
  /**
   * Put `device` on an SPI bus: the bench attaches it to the MCU SPI controller whose pins
   * share nets with this part's `sck`/`mosi`/`miso` pins; `cs` is the active-low select pin.
   * Call in `createModel`.
   */
  attachSpi(pins: { sck: string; mosi: string; miso: string; cs: string }, device: SpiDevice): void;
}

/** User input for a part, from the UI (clicks, drags, keys) or a headless script. */
export type PartInput =
  | { kind: 'press' }
  | { kind: 'release' }
  /** A continuous value: potentiometer position 0..1, a sensor reading in its own unit. */
  | { kind: 'value'; value: number }
  | { kind: 'key'; key: string; down: boolean };

/** A part's behavior, returned by `PartDefinition.createModel`. Every member is optional. */
export interface PartModel {
  /** Called by the bench when the UI or a script sends input to this part. */
  input?(event: PartInput): void;
  /**
   * Called by the bench only after `invalidate()`, when it collects a frame (~60 Hz), never on
   * the hot path. The frame is serialized before the next collection, so a model may return
   * the same object each time.
   */
  visual?(): VisualState;
  /** Bench reset: return to the power-on state. Timers scheduled before the reset are gone. */
  reset?(): void;
  /** The bench is being torn down (unload or a topology rebuild); release anything held. */
  dispose?(): void;
}

/** Small, serializable state a part view renders: LED brightness, LCD characters, servo angle. */
export type VisualState = Record<string, number | string | boolean | readonly number[]>;

/** Something wrong with the circuit or the run, for the Problems panel and the CLI report. */
export interface Problem {
  /** `error`: the circuit is wrong or damaged; `warning`: likely wrong; `info`: worth knowing. */
  severity: 'error' | 'warning' | 'info';
  /** Stable kebab-case id, e.g. `'short'`, `'i2c-address-conflict'`. */
  code: string;
  /** One sentence for a human. */
  message: string;
  /** Ids of the parts involved (`PartInstance.id`), for selection in the editor. */
  parts: string[];
}
