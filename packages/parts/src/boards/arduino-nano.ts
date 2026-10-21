/**
 * Arduino Nano (V3, ATmega328P in TQFP-32). Pin names and positions come from @wokwi/elements
 * 1.9.2 (MIT), `arduino-nano-element.js` `pinInfo`, converted from CSS px at 96 dpi to mm
 * (× 25.4 / 96) and copied here as data: packages/* are DOM-free and never import the element
 * (apps/web's arduino-nano-pins.test.ts reads the element's source and checks every name and
 * position here against it).
 *
 * The two 15-pin headers are 0.6" apart, so the board straddles a breadboard's center channel.
 * Header pins '0'–'13' and 'A0'–'A5' map to the ATmega328P's ports as on the Uno; 'A6'/'A7' are
 * ADC6/ADC7, which the TQFP package has and the Uno's DIP doesn't — analog inputs only, with no
 * digital function (`pinMode`/`digitalWrite` on them do nothing; `analogRead` works). The two
 * GND pins share a bus, as do the two RESET pins. 3.3V comes from the USB chip (a supply); VIN is
 * an input like the Uno's.
 *
 * The element also lists the ICSP header (its `noBreadboard` pins '11.2', '12.2', '13.2', '5V.2',
 * 'GND.3', 'RESET.3'). They are left out, as the Uno leaves out its own: on the real board they
 * point up, but here every pin touches what lies under it, and on a breadboard GND.3 and 5V.2
 * would land in the columns of D1 and VIN and short them.
 *
 * Model: the Uno's onboard L, power, TX and RX LEDs (arduino-leds.ts).
 */

import type { PinDef, PinRole } from '@benchtop/core';
import { definePart } from '../define.ts';
import { arduinoLedsModel } from './arduino-leds.ts';

const PX = 25.4 / 96;

/** [name, x px, y px] from the element's pinInfo, in its order: top header, then bottom header. */
const PIN_INFO: readonly (readonly [string, number, number])[] = [
  ['12', 19.7, 4.8],
  ['11', 29.3, 4.8],
  ['10', 38.9, 4.8],
  ['9', 48.5, 4.8],
  ['8', 58.1, 4.8],
  ['7', 67.7, 4.8],
  ['6', 77.3, 4.8],
  ['5', 86.9, 4.8],
  ['4', 96.5, 4.8],
  ['3', 106.1, 4.8],
  ['2', 115.7, 4.8],
  ['GND.2', 125.3, 4.8],
  ['RESET.2', 134.9, 4.8],
  ['0', 144.5, 4.8],
  ['1', 154.1, 4.8],
  ['13', 19.7, 62.4],
  ['3.3V', 29.3, 62.4],
  ['AREF', 38.9, 62.4],
  ['A0', 48.5, 62.4],
  ['A1', 58.1, 62.4],
  ['A2', 67.7, 62.4],
  ['A3', 77.3, 62.4],
  ['A4', 86.9, 62.4],
  ['A5', 96.5, 62.4],
  ['A6', 106.1, 62.4],
  ['A7', 115.7, 62.4],
  ['5V', 125.3, 62.4],
  ['RESET', 134.9, 62.4],
  ['GND.1', 144.5, 62.4],
  ['VIN', 154.1, 62.4],
];
/** The element's pinInfo as copied (px), for the sync test in apps/web. */
export const ARDUINO_NANO_PIN_PX = PIN_INFO;

/** Supply pins: defined volts make them sources (see PinDef.volts). */
const SUPPLY: Readonly<Record<string, number>> = { '5V': 5, '3.3V': 3.3, 'GND.1': 0, 'GND.2': 0 };

function role(name: string): PinRole {
  if (name.startsWith('GND')) return 'ground';
  if (name === '5V' || name === '3.3V' || name === 'VIN') return 'power';
  if (name.startsWith('A')) return 'analog'; // A0–A7, AREF
  return 'digital';
}

const pins: PinDef[] = PIN_INFO.map(([name, x, y]) => {
  const pin: PinDef = { name, x: Math.round(x * PX * 1000) / 1000, y: Math.round(y * PX * 1000) / 1000, role: role(name) };
  const volts = SUPPLY[name];
  if (volts !== undefined) pin.volts = volts;
  return pin;
});

const pinMap: Record<string, string> = {};
for (let d = 0; d <= 7; d++) pinMap[String(d)] = `PD${d}`;
for (let d = 8; d <= 13; d++) pinMap[String(d)] = `PB${d - 8}`;
for (let a = 0; a <= 5; a++) pinMap[`A${a}`] = `PC${a}`;
pinMap.A6 = 'ADC6';
pinMap.A7 = 'ADC7';

export const arduinoNano = definePart({
  type: 'arduino-nano',
  title: 'Arduino Nano',
  category: 'boards',
  size: { w: 44.9, h: 17.8 },
  pins,
  buses: [
    ['GND.1', 'GND.2'],
    ['RESET', 'RESET.2'],
  ],
  defaults: {},
  board: { mcu: 'atmega328p', pinMap },
  createModel: arduinoLedsModel,
});
