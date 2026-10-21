/**
 * Arduino Uno R3. Pin names and positions come from @wokwi/elements 1.9.2 (MIT),
 * `arduino-uno-element.js` `pinInfo`, converted from CSS px at 96 dpi to mm (× 25.4 / 96) and
 * copied here as data: packages/* are DOM-free and never import the element.
 *
 * Header pins '0'–'13' and 'A0'–'A5' map to the ATmega328P's ports; 'A4.2'/'A5.2' are the
 * SDA/SCL header next to AREF, joined to A4/A5 by buses, and the three GND pins share a bus.
 *
 * Model: the onboard L, power, TX and RX LEDs (arduino-leds.ts, shared with the Nano).
 */

import type { PinDef, PinRole } from '@benchtop/core';
import { definePart } from '../define.ts';
import { arduinoLedsModel } from './arduino-leds.ts';

/** [name, x mm, y mm] from the element, top header then bottom header. */
const PIN_TABLE: readonly (readonly [string, number, number])[] = [
  ['A5.2', 23.019, 2.381],
  ['A4.2', 25.665, 2.381],
  ['AREF', 28.046, 2.381],
  ['GND.1', 30.559, 2.381],
  ['13', 33.073, 2.381],
  ['12', 35.586, 2.381],
  ['11', 38.1, 2.381],
  ['10', 40.614, 2.381],
  ['9', 43.127, 2.381],
  ['8', 45.773, 2.381],
  ['7', 50.006, 2.381],
  ['6', 52.52, 2.381],
  ['5', 55.033, 2.381],
  ['4', 57.547, 2.381],
  ['3', 60.06, 2.381],
  ['2', 62.574, 2.381],
  ['1', 65.088, 2.381],
  ['0', 67.601, 2.381],
  ['IOREF', 34.66, 50.668],
  ['RESET', 37.174, 50.668],
  ['3.3V', 39.688, 50.668],
  ['5V', 42.333, 50.668],
  ['GND.2', 44.847, 50.668],
  ['GND.3', 47.36, 50.668],
  ['VIN', 49.874, 50.668],
  ['A0', 55.033, 50.668],
  ['A1', 57.547, 50.668],
  ['A2', 60.06, 50.668],
  ['A3', 62.574, 50.668],
  ['A4', 65.088, 50.668],
  ['A5', 67.601, 50.668],
];

/** Supply pins: defined volts make them sources (see PinDef.volts). */
const SUPPLY: Readonly<Record<string, number>> = { '5V': 5, '3.3V': 3.3, IOREF: 5, 'GND.1': 0, 'GND.2': 0, 'GND.3': 0 };

function role(name: string): PinRole {
  if (name.startsWith('GND')) return 'ground';
  if (name === '5V' || name === '3.3V' || name === 'IOREF' || name === 'VIN') return 'power';
  if (name.startsWith('A')) return 'analog'; // A0–A5, A4.2, A5.2, AREF
  return 'digital';
}

const pins: PinDef[] = PIN_TABLE.map(([name, x, y]) => {
  const pin: PinDef = { name, x, y, role: role(name) };
  const volts = SUPPLY[name];
  if (volts !== undefined) pin.volts = volts;
  return pin;
});

const pinMap: Record<string, string> = {};
for (let d = 0; d <= 7; d++) pinMap[String(d)] = `PD${d}`;
for (let d = 8; d <= 13; d++) pinMap[String(d)] = `PB${d - 8}`;
for (let a = 0; a <= 5; a++) pinMap[`A${a}`] = `PC${a}`;

export const arduinoUno = definePart({
  type: 'arduino-uno',
  title: 'Arduino Uno',
  category: 'boards',
  size: { w: 72.58, h: 53.34 },
  pins,
  buses: [
    ['GND.1', 'GND.2', 'GND.3'],
    ['A4', 'A4.2'],
    ['A5', 'A5.2'],
  ],
  defaults: {},
  board: { mcu: 'atmega328p', pinMap },
  createModel: arduinoLedsModel,
});
