/**
 * ESP32 DevKit V1 (30-pin, ESP32-WROOM-32). Pin names and positions come from @wokwi/elements
 * 1.9.2 (MIT), `esp32-devkit-v1-element.js` `pinInfo`, converted from CSS px at 96 dpi to mm
 * (× 25.4 / 96) and copied here as data: packages/* are DOM-free and never import the element
 * (apps/web's esp32-devkit-v1-pins.test.ts reads the element's source and checks every name and
 * position here against it).
 *
 * Header pins map to GPIOs: D<n> → GPIO<n>, TX0/RX0 → GPIO1/GPIO3 (UART0, the USB serial), TX2/RX2
 * → GPIO17/GPIO16, VP/VN → GPIO36/GPIO39. 3V3 is the 3.3 V supply; VIN is USB's 5 V while prop
 * `usbPowered` is true (the default, BT44 — the model drives it at supply strength, so a module
 * on VIN is powered), else an input like the Uno's VIN; the two GND pins share a bus. EN (the
 * chip enable / reset button line) isn't modeled and maps to no GPIO.
 *
 * Model: `led1` follows GPIO2 through D2 (the DevKit's blue LED; brightness 0..1, so PWM dims it),
 * `ledPower` is always on. The ESP32's own Problems (unknown registers, reboots, the ROM) reach
 * the Problems panel through the report function the bench hands the MCU factory
 * (`BenchEnv.createMcu`), already attributed to this board.
 */

import { type PartContext, type PinDef, type PinRole, Strength } from '@benchtop/core';
import { definePart } from '../define.ts';
import { DutyChannel } from '../shared/duty.ts';

const PX = 25.4 / 96;

/** [name, x px, y px] from the element's pinInfo, left header top to bottom order as listed there. */
const PIN_INFO: readonly (readonly [string, number, number])[] = [
  ['VIN', 5, 158.5],
  ['GND.2', 5, 149],
  ['D13', 5, 139.5],
  ['D12', 5, 130.4],
  ['D14', 5, 120],
  ['D27', 5, 110.8],
  ['D26', 5, 101],
  ['D25', 5, 91.3],
  ['D33', 5, 81.7],
  ['D32', 5, 72.2],
  ['D35', 5, 62.9],
  ['D34', 5, 53.1],
  ['VN', 5, 44],
  ['VP', 5, 34],
  ['EN', 5, 24],
  ['3V3', 101.3, 158.5],
  ['GND.1', 101.3, 149],
  ['D15', 101.3, 139.5],
  ['D2', 101.3, 130.4],
  ['D4', 101.3, 120],
  ['RX2', 101.3, 110.8],
  ['TX2', 101.3, 101],
  ['D5', 101.3, 91.3],
  ['D18', 101.3, 81.7],
  ['D19', 101.3, 72.2],
  ['D21', 101.3, 62.9],
  ['RX0', 101.3, 53.1],
  ['TX0', 101.3, 44],
  ['D22', 101.3, 34],
  ['D23', 101.3, 24],
];
/** The element's pinInfo as copied (px), for the sync test in apps/web. */
export const ESP32_DEVKIT_PIN_PX = PIN_INFO;

const SUPPLY: Readonly<Record<string, number>> = { '3V3': 3.3, 'GND.1': 0, 'GND.2': 0 };
const INPUT_ONLY_ANALOG = new Set(['VP', 'VN', 'D34', 'D35']);

function role(name: string): PinRole {
  if (name.startsWith('GND')) return 'ground';
  if (name === '3V3' || name === 'VIN') return 'power';
  if (INPUT_ONLY_ANALOG.has(name)) return 'analog';
  return 'digital';
}

const mm = (px: number): number => Math.round(px * PX * 1000) / 1000;

const pins: PinDef[] = PIN_INFO.map(([name, x, y]) => {
  const pin: PinDef = { name, x: mm(x), y: mm(y), role: role(name) };
  const volts = SUPPLY[name];
  if (volts !== undefined) pin.volts = volts;
  return pin;
});

const pinMap: Record<string, string> = { TX0: 'GPIO1', RX0: 'GPIO3', TX2: 'GPIO17', RX2: 'GPIO16', VP: 'GPIO36', VN: 'GPIO39' };
for (const [name] of PIN_INFO) if (/^D\d+$/.test(name)) pinMap[name] = `GPIO${name.slice(1)}`;

export const esp32DevkitV1 = definePart({
  type: 'esp32-devkit-v1',
  title: 'ESP32 DevKit V1',
  category: 'boards',
  size: { w: 28.2, h: 54.053 },
  pins,
  buses: [['GND.1', 'GND.2']],
  defaults: { usbPowered: true },
  board: { mcu: 'esp32', pinMap },
  createModel(ctx: PartContext, props: { usbPowered: boolean }) {
    // USB power (BT44): on a real DevKit, USB 5 V reaches VIN through a diode (≈ 4.7 V; decided:
    // 5 V — the solver's supplies are nominal). Off, VIN is an input again.
    if (props.usbPowered !== false) ctx.pin('VIN').driveVolts(5, Strength.supply);
    const led1 = new DutyChannel(ctx);
    ctx.pin('D2').onChange((state) => led1.set(state.level === 1 && state.strength >= Strength.weak));
    return {
      visual: () => ({ led1: led1.brightness, ledPower: true }),
      reset() {
        led1.reset();
        ctx.invalidate();
      },
    };
  },
});
