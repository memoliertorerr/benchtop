/**
 * Raspberry Pi Pico (RP2040; BT61). The element library has no Pico, so the pin table is our own,
 * from the Pico datasheet's mechanical drawing and pinout: a 21 × 51 mm board, two rows of 20
 * castellated pads on a 2.54 mm pitch, 17.78 mm (0.7″) apart — so it straddles a breadboard's
 * channel with two free rows on each side — with the micro-USB connector at the top. Pin 1 (GP0)
 * is top left; the left row runs pins 1–20 down, the right row pins 40–21 (VBUS at the top right,
 * GP16 at the bottom right). Header names are the pinout's: GP0–GP22, GP26–GP28, RUN, ADC_VREF,
 * 3V3, 3V3_EN, VSYS, VBUS, GND.1–GND.7 (all on one bus with AGND, pin 33).
 *
 * TP5 is the board's GP25 test pad (the onboard LED's pin; the datasheet's test points table)
 * — a pin so the model can watch the LED, placed off the 2.54 mm grid near the LED where no
 * breadboard hole lies under it.
 *
 * Supplies: 3V3 is the board regulator's 3.3 V output; VBUS and VSYS carry USB's 5 V while prop
 * `usbPowered` is true (the default; VSYS sits a Schottky drop lower on the board — nominal 5 V
 * here, as for the ESP32 DevKit's VIN), else they are inputs. ADC_VREF (3.3 V through the
 * board's filter), RUN and 3V3_EN (both pulled up on the board) are inputs the simulation
 * doesn't use.
 *
 * Model: `led` follows GP25 through TP5 (brightness 0..1, so PWM dims it).
 *
 * The Raspberry Pi Pico 2 (BT66, `raspberry-pi-pico-2`) has the same footprint, pinout, TP5/LED
 * and supplies around an RP2350A: the same definition with its own type, title and MCU.
 */

import { type PartContext, type PinDef, type PinRole, Strength } from '@benchtop/core';
import { definePart } from '../define.ts';
import { DutyChannel } from '../shared/duty.ts';

export const PICO_WIDTH = 21;
export const PICO_HEIGHT = 51;
/** The pad rows' x (mm): (21 − 17.78) / 2 in from each long edge. */
const LEFT_X = 1.61;
const RIGHT_X = 19.39;
/** Pin 1's y (mm): the 20 pads (48.26 mm span) centred on the 51 mm board. */
const TOP_Y = 1.37;
const PITCH = 2.54;

/** The pinout: physical pins 1–40 (datasheet, Raspberry Pi Pico pinout). */
export const PICO_PINOUT: readonly string[] = [
  'GP0', 'GP1', 'GND.1', 'GP2', 'GP3', 'GP4', 'GP5', 'GND.2', 'GP6', 'GP7',
  'GP8', 'GP9', 'GND.3', 'GP10', 'GP11', 'GP12', 'GP13', 'GND.4', 'GP14', 'GP15',
  'GP16', 'GP17', 'GND.5', 'GP18', 'GP19', 'GP20', 'GP21', 'GND.6', 'GP22', 'RUN',
  'GP26', 'GP27', 'AGND', 'GP28', 'ADC_VREF', '3V3', '3V3_EN', 'GND.7', 'VSYS', 'VBUS',
];

function role(name: string): PinRole {
  if (name.startsWith('GND') || name === 'AGND') return 'ground';
  if (name === '3V3' || name === 'VSYS' || name === 'VBUS') return 'power';
  if (name === 'ADC_VREF') return 'analog';
  return 'digital';
}

const pins: PinDef[] = PICO_PINOUT.map((name, i) => {
  const physical = i + 1;
  const left = physical <= 20;
  const row = left ? physical - 1 : 40 - physical;
  const pin: PinDef = { name, x: left ? LEFT_X : RIGHT_X, y: Math.round((TOP_Y + row * PITCH) * 1000) / 1000, role: role(name) };
  if (name === '3V3') pin.volts = 3.3;
  if (name.startsWith('GND') || name === 'AGND') pin.volts = 0;
  return pin;
});
pins.push({ name: 'TP5', x: 5.05, y: 3.2, role: 'digital' });

const pinMap: Record<string, string> = { TP5: 'GPIO25' };
for (const name of PICO_PINOUT) if (/^GP\d+$/.test(name)) pinMap[name] = `GPIO${name.slice(2)}`;

/** A Pico-footprint board around `mcu`. */
function pico(type: string, title: string, mcu: 'rp2040' | 'rp2350') {
  return definePart({
    type,
    title,
    category: 'boards',
    size: { w: PICO_WIDTH, h: PICO_HEIGHT },
    pins,
    buses: [['GND.1', 'GND.2', 'GND.3', 'GND.4', 'GND.5', 'GND.6', 'GND.7', 'AGND']],
    defaults: { usbPowered: true },
    board: { mcu, pinMap },
    createModel: picoModel,
  });
}

function picoModel(ctx: PartContext, props: { usbPowered: boolean }) {
  if (props.usbPowered !== false) {
    ctx.pin('VBUS').driveVolts(5, Strength.supply);
    ctx.pin('VSYS').driveVolts(5, Strength.supply);
  }
  const led = new DutyChannel(ctx);
  ctx.pin('TP5').onChange((state) => led.set(state.level === 1 && state.strength >= Strength.weak));
  return {
    visual: () => ({ led: led.brightness }),
    reset() {
      led.reset();
      ctx.invalidate();
    },
  };
}

export const raspberryPiPico = pico('raspberry-pi-pico', 'Raspberry Pi Pico', 'rp2040');
export const raspberryPiPico2 = pico('raspberry-pi-pico-2', 'Raspberry Pi Pico 2', 'rp2350');
