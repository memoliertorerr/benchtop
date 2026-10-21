/**
 * Groups of AVR I/O pins whose summed current the datasheets cap, sourcing (I_OH) and sinking
 * (I_OL) separately: the pins of a group share VCC and GND bond pins. Each pin may carry 40 mA
 * (`MAX_PIN_AMPS`), but a group carries less than the sum of its pins. Copied from the
 * DC Characteristics notes 3 (I_OL) and 4 (I_OH), whose consequence for exceeding them is that
 * V_OL/V_OH may leave the specification — so `port-overcurrent` is a warning, where a pin past its
 * absolute maximum is an error. Pin ids are `McuPin.id`s ('PB5' is port B bit 5).
 */

import type { BoardSpec } from '../contracts/part.ts';

/** One group of pins and the most current they may source (or sink) together. */
export interface PortGroup {
  /** As the datasheet names it, e.g. 'B0–B5, D5–D7'. */
  name: string;
  /** `McuPin.id`s in the group. */
  pins: readonly string[];
  maxAmps: number;
}

export interface PortGroups {
  /** Groups for the current pins source (driving high into a load to ground). */
  source: readonly PortGroup[];
  /** Groups for the current pins sink (driving low against a load from a supply). */
  sink: readonly PortGroup[];
}

/** A group from datasheet ranges like 'B0-B5' (port letter, first and last bit). */
function group(milliamps: number, ...ranges: string[]): PortGroup {
  const pins: string[] = [];
  for (const range of ranges) {
    const [first, last = first] = range.split('-');
    for (let bit = Number(first.slice(1)); bit <= Number(last.slice(1)); bit++) pins.push(`P${first[0]}${bit}`);
  }
  return { name: ranges.map((r) => r.replace('-', '–')).join(', '), pins, maxAmps: milliamps / 1000 };
}

export const PORT_GROUPS: Readonly<Record<BoardSpec['mcu'], PortGroups>> = {
  // ATmega328P datasheet 7810D–AVR–01/15, 28.2 DC Characteristics, notes 3 and 4. The
  // ATmega48A/PA/88A/PA/168A/PA/328/P datasheet (DS40002061, Common DC Characteristics) gives the
  // same groups and limits and adds ADC6, ADC7 and RESET. Left out: those, and XTAL1/XTAL2
  // (PB6/PB7, the crystal) — none of them drives a header on the Uno or Nano.
  atmega328p: {
    source: [group(150, 'C0-C5', 'D0-D4'), group(150, 'B0-B5', 'D5-D7')],
    sink: [group(100, 'C0-C5'), group(100, 'B0-B5', 'D5-D7'), group(100, 'D0-D4')],
  },
  // ATmega640/V-1280/V-1281/V-2560/V-2561/V datasheet 2549Q–AVR–02/2014, 31.1 DC
  // Characteristics, notes 3 and 4, the ATmega640/1280/2560 lists (the 100-pin package). Sink
  // group 3 reads "H0-B7" there, a typo: the source list's H0–H7.
  atmega2560: {
    source: [
      group(200, 'J0-J7', 'G2', 'A0-A7'),
      group(200, 'C0-C7', 'G0-G1', 'D0-D7', 'L0-L7'),
      group(200, 'G3-G4', 'B0-B7', 'H0-H7'),
      group(100, 'E0-E7', 'G5'),
      group(100, 'F0-F7', 'K0-K7'),
    ],
    sink: [
      group(200, 'J0-J7', 'A0-A7', 'G2'),
      group(200, 'C0-C7', 'G0-G1', 'D0-D7', 'L0-L7'),
      group(200, 'G3-G4', 'B0-B7', 'H0-H7'),
      group(100, 'E0-E7', 'G5'),
      group(100, 'F0-F7', 'K0-K7'),
    ],
  },
  // ESP32: none modelled (its datasheet words current limits per power domain, not pin group).
  esp32: { source: [], sink: [] },
};
