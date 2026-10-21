/** Which FQBN the compile bridge builds a board's sketch with (DOM-free; sketch-actions re-exports it). */

import { CATALOG } from '@benchtop/parts';

/** The FQBN per board part type (BT45: per board, not per MCU — the Nano and the Uno share a chip). */
const FQBNS: Readonly<Record<string, string>> = {
  'arduino-uno': 'arduino:avr:uno',
  'arduino-nano': 'arduino:avr:nano',
  'arduino-mega': 'arduino:avr:mega',
  'esp32-devkit-v1': 'esp32:esp32:esp32',
};
/** Boards without their own entry: the FQBN of their MCU's reference board. */
const MCU_FQBNS = { atmega328p: 'arduino:avr:uno', atmega2560: 'arduino:avr:mega', esp32: 'esp32:esp32:esp32' } as const;

/** The FQBN the bridge compiles for a board part type, or undefined for non-boards. */
export function fqbnOf(partType: string): string | undefined {
  const mcu = CATALOG.get(partType)?.board?.mcu;
  return mcu === undefined ? undefined : (FQBNS[partType] ?? MCU_FQBNS[mcu]);
}
