/** Which FQBN the compile bridge builds a board's sketch with (DOM-free; sketch-actions re-exports it). */

import { CATALOG } from '@benchtop/parts';

/** The FQBN per board part type (BT45: per board, not per MCU — the Nano and the Uno share a chip). */
const FQBNS: Readonly<Record<string, string>> = {
  'arduino-uno': 'arduino:avr:uno',
  'arduino-nano': 'arduino:avr:nano',
  'arduino-mega': 'arduino:avr:mega',
  'esp32-devkit-v1': 'esp32:esp32:esp32',
  'raspberry-pi-pico': 'rp2040:rp2040:rpipico',
};
/** Boards without their own entry: the FQBN of their MCU's reference board. */
const MCU_FQBNS = {
  atmega328p: 'arduino:avr:uno',
  atmega2560: 'arduino:avr:mega',
  esp32: 'esp32:esp32:esp32',
  rp2040: 'rp2040:rp2040:rpipico',
  rp2350: 'rp2040:rp2040:rpipico2:arch=riscv',
} as const;

/** The FQBN the bridge compiles for a board part type, or undefined for non-boards. */
export function fqbnOf(partType: string): string | undefined {
  const mcu = CATALOG.get(partType)?.board?.mcu;
  return mcu === undefined ? undefined : (FQBNS[partType] ?? MCU_FQBNS[mcu]);
}

/** BT63: the MicroPython sketch "FQBN" per MCU, for boards whose stock MicroPython runs here. */
const MICROPYTHON_FQBNS: Readonly<Record<string, string>> = {
  rp2040: 'micropython:rp2:pico',
  rp2350: 'micropython:rp2:pico2',
};

/** The FQBN of a MicroPython sketch for a board part type, or undefined where MicroPython doesn't run. */
export function micropythonFqbnOf(partType: string): string | undefined {
  const mcu = CATALOG.get(partType)?.board?.mcu;
  return mcu === undefined ? undefined : MICROPYTHON_FQBNS[mcu];
}
