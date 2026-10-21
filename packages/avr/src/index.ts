import type { BoardSpec, Mcu } from '@benchtop/core';
import { createAtmega2560 } from './atmega2560.ts';
import { createAtmega328p } from './atmega328p.ts';

export * from './atmega328p.ts';
export * from './atmega2560.ts';
export { AVR_VIH, AVR_VIL, type AvrChip, AvrMcu } from './avr-mcu.ts';

/** The bench's MCU factory for AVR boards: an ATmega328P or ATmega2560 by `BoardSpec.mcu`, else undefined. */
export function avrMcuFactory(board: BoardSpec): Mcu | undefined {
  if (board.mcu === 'atmega328p') return createAtmega328p();
  if (board.mcu === 'atmega2560') return createAtmega2560();
  return undefined;
}
export * from './debug.ts';
export * from './gdb/index.ts';
