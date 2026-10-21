/**
 * Arduino Mega 2560 (Rev3, ATmega2560). Pin names and positions come from @wokwi/elements 1.9.2
 * (MIT), `arduino-mega-element.js` `pinInfo`, kept here in the element's CSS px and converted to
 * mm (× 25.4 / 96) as data: packages/* are DOM-free and never import the element (apps/web's
 * arduino-mega-pins.test.ts reads the element's source and checks every name and position here).
 *
 * Header pins '0'–'53' map to the ATmega2560's ports as the Arduino core's `mega` variant does
 * (pins_arduino.h `digital_pin_to_port_PGM`/`_bit_mask_PGM`: D0/D1 USART0 on PE0/PE1, D13 PB7,
 * D14–D19 USART3/2/1, D20/D21 SDA/SCL on PD1/PD0, D22–D29 port A, D50–D53 SPI on PB3–PB0, …);
 * 'A0'–'A15' are PF0–PF7 and PK0–PK7. 'SCL'/'SDA' (the header by AREF) are joined to D21/D20 by
 * buses; the five GND pins share a bus, as do 5V, 5V.1 and 5V.2. VIN is an input like the Uno's.
 *
 * Model: the Uno's onboard L, power, TX and RX LEDs (arduino-leds.ts; L follows D13).
 */

import type { PinDef, PinRole } from '@benchtop/core';
import { definePart } from '../define.ts';
import { arduinoLedsModel } from './arduino-leds.ts';

const PX = 25.4 / 96;

/** [name, x px, y px] from the element's pinInfo, in its order: top header, double header, power/analog. */
const PIN_INFO: readonly (readonly [string, number, number])[] = [
  ['SCL', 90, 9],
  ['SDA', 100, 9],
  ['AREF', 109, 9],
  ['GND.1', 119, 9],
  ['13', 129, 9],
  ['12', 138, 9],
  ['11', 148, 9],
  ['10', 157.5, 9],
  ['9', 167.5, 9],
  ['8', 177, 9],
  ['7', 190, 9],
  ['6', 200, 9],
  ['5', 209.5, 9],
  ['4', 219, 9],
  ['3', 228.5, 9],
  ['2', 238, 9],
  ['1', 247.5, 9],
  ['0', 257.5, 9],
  ['14', 270.5, 9],
  ['15', 280, 9],
  ['16', 289.5, 9],
  ['17', 299, 9],
  ['18', 308.5, 9],
  ['19', 318.5, 9],
  ['20', 328, 9],
  ['21', 337.5, 9],
  ['5V.1', 361, 8],
  ['5V.2', 371, 8],
  ['22', 361, 17.5],
  ['23', 371, 17.5],
  ['24', 361, 27.25],
  ['25', 371, 27.25],
  ['26', 361, 36.75],
  ['27', 371, 36.75],
  ['28', 361, 46.25],
  ['29', 371, 46.25],
  ['30', 361, 56],
  ['31', 371, 56],
  ['32', 361, 65.5],
  ['33', 371, 65.5],
  ['34', 361, 75],
  ['35', 371, 75],
  ['36', 361, 84.5],
  ['37', 371, 84.5],
  ['38', 361, 94.25],
  ['39', 371, 94.25],
  ['40', 361, 103.75],
  ['41', 371, 103.75],
  ['42', 361, 113.5],
  ['43', 371, 113.5],
  ['44', 361, 123],
  ['45', 371, 123],
  ['46', 361, 132.75],
  ['47', 371, 132.75],
  ['48', 361, 142.25],
  ['49', 371, 142.25],
  ['50', 361, 152],
  ['51', 371, 152],
  ['52', 361, 161.5],
  ['53', 371, 161.5],
  ['GND.4', 361, 171.25],
  ['GND.5', 371, 171.25],
  ['IOREF', 136, 184.5],
  ['RESET', 145.5, 184.5],
  ['3.3V', 155, 184.5],
  ['5V', 164.5, 184.5],
  ['GND.2', 174.25, 184.5],
  ['GND.3', 183.75, 184.5],
  ['VIN', 193.5, 184.5],
  ['A0', 208.5, 184.5],
  ['A1', 218, 184.5],
  ['A2', 227.5, 184.5],
  ['A3', 237.25, 184.5],
  ['A4', 246.75, 184.5],
  ['A5', 256.25, 184.5],
  ['A6', 266, 184.5],
  ['A7', 275.5, 184.5],
  ['A8', 290.25, 184.5],
  ['A9', 300, 184.5],
  ['A10', 309.5, 184.5],
  ['A11', 319.25, 184.5],
  ['A12', 328.75, 184.5],
  ['A13', 338.5, 184.5],
  ['A14', 348, 184.5],
  ['A15', 357.75, 184.5],
];
/** The element's pinInfo as copied (px), for the sync test in apps/web. */
export const ARDUINO_MEGA_PIN_PX = PIN_INFO;

/** D0–D53's port pins (the core's `mega` variant). */
const DIGITAL: readonly string[] = [
  'PE0', 'PE1', 'PE4', 'PE5', 'PG5', 'PE3', 'PH3', 'PH4', 'PH5', 'PH6',
  'PB4', 'PB5', 'PB6', 'PB7', 'PJ1', 'PJ0', 'PH1', 'PH0', 'PD3', 'PD2',
  'PD1', 'PD0', 'PA0', 'PA1', 'PA2', 'PA3', 'PA4', 'PA5', 'PA6', 'PA7',
  'PC7', 'PC6', 'PC5', 'PC4', 'PC3', 'PC2', 'PC1', 'PC0', 'PD7', 'PG2',
  'PG1', 'PG0', 'PL7', 'PL6', 'PL5', 'PL4', 'PL3', 'PL2', 'PL1', 'PL0',
  'PB3', 'PB2', 'PB1', 'PB0',
];

/** Supply pins: defined volts make them sources (see PinDef.volts). */
const SUPPLY: Readonly<Record<string, number>> = {
  '5V': 5,
  '5V.1': 5,
  '5V.2': 5,
  '3.3V': 3.3,
  IOREF: 5,
  'GND.1': 0,
  'GND.2': 0,
  'GND.3': 0,
  'GND.4': 0,
  'GND.5': 0,
};

function role(name: string): PinRole {
  if (name.startsWith('GND')) return 'ground';
  if (name.startsWith('5V') || name === '3.3V' || name === 'IOREF' || name === 'VIN') return 'power';
  if (name.startsWith('A')) return 'analog'; // A0–A15, AREF
  return 'digital';
}

const pins: PinDef[] = PIN_INFO.map(([name, x, y]) => {
  const pin: PinDef = { name, x: Math.round(x * PX * 1000) / 1000, y: Math.round(y * PX * 1000) / 1000, role: role(name) };
  const volts = SUPPLY[name];
  if (volts !== undefined) pin.volts = volts;
  return pin;
});

const pinMap: Record<string, string> = {};
DIGITAL.forEach((port, d) => {
  pinMap[String(d)] = port;
});
for (let a = 0; a < 8; a++) {
  pinMap[`A${a}`] = `PF${a}`;
  pinMap[`A${a + 8}`] = `PK${a}`;
}

export const arduinoMega = definePart({
  type: 'arduino-mega',
  title: 'Arduino Mega 2560',
  category: 'boards',
  size: { w: 102.66, h: 50.8 },
  pins,
  buses: [
    ['GND.1', 'GND.2', 'GND.3', 'GND.4', 'GND.5'],
    ['5V', '5V.1', '5V.2'],
    ['SCL', '21'],
    ['SDA', '20'],
  ],
  defaults: {},
  board: { mcu: 'atmega2560', pinMap },
  createModel: arduinoLedsModel,
});
