/**
 * What an MCU adapter implements: `@benchtop/avr` (ATmega328P, ATmega2560), `@benchtop/esp32` and
 * `@benchtop/rp2040`. The bench owns time and nets; an `Mcu` executes firmware up to a cycle
 * count it is given and reports its pins through `McuPin`. Nothing here knows about parts.
 */

import type { I2cController, SpiController } from './bus.ts';
import type { Level, NetState } from './signal.ts';

/**
 * What a pin is doing, as configured by firmware:
 * - `input`: high impedance, no pull.
 * - `input-pullup` / `input-pulldown`: input with the internal pull resistor on.
 * - `output`: driving `outputLevel()` from the GPIO register.
 * - `analog`: routed to an ADC/DAC; no digital drive.
 * - `peripheral`: driven by a peripheral (timer PWM, UART TX, …), level in `outputLevel()`.
 */
export type PinMode = 'input' | 'input-pullup' | 'input-pulldown' | 'output' | 'analog' | 'peripheral';

/** One MCU pin. Objects stay the same across `Mcu.reset()` so bench listeners survive resets. */
export interface McuPin {
  /** MCU pin id, e.g. `'PB5'` (AVR) or `'GPIO2'` (ESP32); `BoardSpec.pinMap` values name these. */
  readonly id: string;
  /** Current mode. Called by the bench after `onOutputChange` fires. */
  mode(): PinMode;
  /** Driven level; meaningful when `mode()` is `output` or `peripheral`. */
  outputLevel(): Level;
  /**
   * Optional (BT41): the analog voltage the pin outputs (a DAC), volts, or undefined while it
   * outputs none. When defined the bench drives the net with it at `Strength.strong`, whatever
   * `mode()` says. The MCU calls the `onOutputChange` listener when it changes.
   */
  outputVolts?(): number | undefined;
  /**
   * Called by the bench with the resolved state of the net this pin sits on, whenever it
   * changes (and once after build). The MCU applies its input thresholds to `volts`/`level`
   * and feeds the ADC. The bench may reuse `state`: copy what you keep.
   */
  setInput(state: NetState): void;
  /**
   * Register a listener for mode or output-level changes. The MCU calls it synchronously from
   * inside `runUntil`, so the bench sees the edge at the exact cycle. Registered once by the
   * bench; listeners must survive `reset()`.
   */
  onOutputChange(listener: () => void): void;
}

/**
 * Firmware bytes, as handed to `Mcu.load`. Untrusted: adapters validate sizes and addresses.
 * `uf2`: a USB Flashing Format file (BT60, additive, approved 2026-10-21) — the RP2040's and
 * RP2350's native image. `micropython`: a MicroPython sketch (BT63, additive, approved
 * 2026-10-21) — `.py` files by name, `main` naming the one that runs at boot; the board's stock
 * interpreter runs it.
 */
export type FirmwareImage =
  | { format: 'hex'; text: string }
  | { format: 'elf'; bytes: Uint8Array }
  | { format: 'esp32-bin'; app: Uint8Array; partitions?: Uint8Array }
  | { format: 'uf2'; bytes: Uint8Array }
  | { format: 'micropython'; files: Readonly<Record<string, string>>; main: string };

/** Why `runUntil` returned. */
export interface RunResult {
  /**
   * `target`: reached the requested cycle; `breakpoint`: stopped at a debugger breakpoint;
   * `halted`: the CPU stopped for good (sleep forever, nothing loaded); `fault`: an emulation
   * error or crash loop, described in `detail`.
   */
  reason: 'target' | 'breakpoint' | 'halted' | 'fault';
  /** Human-readable detail, for `fault` and `halted`. */
  detail?: string;
}

/** One microcontroller, created by the bench's environment for a board part. */
export interface Mcu {
  /** Which chip; matches `BoardSpec.mcu` ('rp2040', 'rp2350': BT60/BT65, additive, approved 2026-10-21). */
  readonly kind: 'atmega328p' | 'atmega2560' | 'esp32' | 'rp2040' | 'rp2350';
  /**
   * Hz: the rate at which `cycles` advances. Constant for the life of the Mcu; an MCU whose CPU
   * clock changes at run time (ESP32) counts `cycles` in a fixed reference clock. The bench
   * converts with `cyclesToNanos` / `nanosToCycles`.
   */
  readonly clockHz: number;
  /** Cycles executed since the last reset, at `clockHz`. */
  readonly cycles: number;
  /** Every pin, keyed by `McuPin.id`. The same map and objects for the Mcu's whole life. */
  readonly pins: ReadonlyMap<string, McuPin>;
  /** Called by the bench: load firmware, then reset. Throws on an invalid image. */
  load(image: FirmwareImage): void;
  /** Called by the bench: hardware reset; `cycles` returns to 0, loaded firmware stays. */
  reset(): void;
  /**
   * Called by the bench: execute until `cycles` ≥ `targetCycles` (an absolute count), or
   * earlier with another reason. Never runs more than one instruction past the target.
   */
  runUntil(targetCycles: number): RunResult;
  /** UART `index` (0 = the one wired to USB serial), or undefined if the chip has none there. */
  uart(index: number): UartPort | undefined;
  /** I2C controller `index`, or undefined. The bench attaches part devices to it. */
  i2c(index: number): I2cController | undefined;
  /** SPI controller `index`, or undefined. The bench attaches part devices to it. */
  spi(index: number): SpiController | undefined;
}

/** A byte-level UART, as the bench and the serial monitor see it. */
export interface UartPort {
  /** Register a listener for each byte the firmware transmits (0–255), called inside `runUntil`. */
  onTransmit(listener: (byte: number) => void): void;
  /** Queue bytes for the firmware to receive; the MCU delivers them at its configured baud. */
  receive(bytes: Uint8Array): void;
  /**
   * BT39 (additive, approved 2026-10-20): the `McuPin` ids carrying this UART's TX and RX now —
   * they can move (the ESP32's GPIO matrix) — each undefined while that side isn't on a pin.
   * The bench forwards bytes between boards whose TX and RX share a net.
   */
  pins?(): { tx?: string; rx?: string };
  /** BT39 (additive): the baud rate the firmware configured, or undefined before it set one. */
  baud?(): number | undefined;
}
