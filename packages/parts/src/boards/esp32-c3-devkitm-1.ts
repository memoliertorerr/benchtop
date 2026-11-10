/**
 * ESP32-C3-DevKitM-1 (BT94): Espressif's board with an ESP32-C3-MINI-1 module. Our own pin table
 * — no element library draws this board — from the ESP32-C3-DevKitM-1 user guide's header
 * tables: J1 down the left edge (GND, 3V3, 3V3, IO2, IO3, GND, RST, GND, IO0, IO1, IO10, GND, 5V,
 * 5V, GND) and J3 down the right (GND, TX, RX, GND, IO9, IO8, GND, IO7, IO6, IO5, IO4, GND, IO18,
 * IO19, GND), 15 pins each on the 0.1" pitch, the two rows 0.9" apart (it straddles a full
 * breadboard's gap using its outer rows), the module and antenna at the top, the micro-USB
 * connector at the bottom. Drawn by apps/web's views/esp32-c3-devkitm-1.ts.
 *
 * Header pins map to GPIOs: IO<n> → GPIO<n>, TX/RX → GPIO21/GPIO20 (UART0, which the board's
 * USB-UART bridge carries to the serial monitor). 3V3 is the 3.3 V rail; 5V is USB's 5 V while
 * prop `usbPowered` is true (the default), else an input; the GNDs, the 3V3s and the 5Vs are each
 * one bus. RST (CHIP_PU) isn't modeled and maps to no GPIO.
 *
 * Model: the board's RGB LED is a WS2812 on GPIO8 (`RGB_BUILTIN`, which Arduino's
 * `neopixelWrite` drives through the RMT): its DIN edges on IO8 are decoded like a NeoPixel's
 * (Ws2812Decoder) and the color shows as `pixels[0]` (0xRRGGBB) in the board's visual state, as
 * a NeoPixel's do (so `pixel c3[0] is #rrggbb` assertions read it); `ledPower` the power LED. BT202: its power
 * (board-power.ts) — 5V through the board's LDO to 3V3, or 3V3 from outside; the brown-out.
 */

import type { PartContext, PinDef, PinRole } from '@benchtop/core';
import { Ws2812Decoder } from '../actuators/ws2812-decoder.ts';
import { definePart } from '../define.ts';
import { boardPower, type BoardPowerSpec, LDO_DROPOUT } from './board-power.ts';

const PITCH = 2.54;
/** Board outline (mm): 1" wide; the headers 0.9" apart, 1.27 mm in from each edge. */
const WIDTH = 25.4;
const HEIGHT = 48.26;
const LEFT_X = 1.27;
const RIGHT_X = LEFT_X + 9 * PITCH;
const FIRST_Y = 5.08;

/** J1 (left) and J3 (right), top to bottom; repeated names numbered as the bench needs them unique. */
const J1 = ['GND.1', '3V3.1', '3V3.2', 'IO2', 'IO3', 'GND.2', 'RST', 'GND.3', 'IO0', 'IO1', 'IO10', 'GND.4', '5V.1', '5V.2', 'GND.5'] as const;
const J3 = ['GND.6', 'TX', 'RX', 'GND.7', 'IO9', 'IO8', 'GND.8', 'IO7', 'IO6', 'IO5', 'IO4', 'GND.9', 'IO18', 'IO19', 'GND.10'] as const;
export const ESP32_C3_DEVKITM1_HEADERS = { J1, J3 };

function role(name: string): PinRole {
  if (name.startsWith('GND')) return 'ground';
  if (name.startsWith('3V3') || name.startsWith('5V')) return 'power';
  return 'digital';
}

const pins: PinDef[] = [];
J1.forEach((name, i) => pins.push({ name, x: LEFT_X, y: Math.round((FIRST_Y + i * PITCH) * 1000) / 1000, role: role(name) }));
J3.forEach((name, i) => pins.push({ name, x: RIGHT_X, y: Math.round((FIRST_Y + i * PITCH) * 1000) / 1000, role: role(name) }));
for (const pin of pins) if (pin.name.startsWith('GND')) pin.volts = 0;

const pinMap: Record<string, string> = { TX: 'GPIO21', RX: 'GPIO20' };
for (const pin of pins) if (/^IO\d+$/.test(pin.name)) pinMap[pin.name] = `GPIO${pin.name.slice(2)}`;

/** BT202: USB's (or an outside) 5 V on 5V through the board's 3.3 V LDO (its input taken as 6 V at most, its dropout as the AMS1117's). */
const C3_DEVKIT_POWER: BoardPowerSpec = {
  board: 'ESP32-C3-DevKitM-1',
  ground: 'GND.1',
  usbPins: ['5V.1'],
  input: '5V.1',
  rail: '3V3.1',
  regulator: { kind: 'ldo', dropout: LDO_DROPOUT, maxIn: 6 },
  brownOut: 2.5,
  maxRail: 3.6,
  minRail: 3.0,
  chip: 'ESP32-C3',
};

export const esp32C3DevkitM1 = definePart({
  type: 'esp32-c3-devkitm-1',
  title: 'ESP32-C3-DevKitM-1',
  category: 'boards',
  size: { w: WIDTH, h: HEIGHT },
  pins,
  buses: [pins.filter((p) => p.name.startsWith('GND')).map((p) => p.name), ['3V3.1', '3V3.2'], ['5V.1', '5V.2']],
  defaults: { usbPowered: true },
  board: { mcu: 'esp32c3', pinMap },
  createModel(ctx: PartContext, props: { usbPowered: boolean }) {
    // BT202: USB's 5 V on 5V, through the board's LDO to 3V3 (board-power.ts).
    const supply = boardPower(ctx, props.usbPowered !== false, C3_DEVKIT_POWER);
    // The RGB LED: a WS2812 whose DIN is GPIO8 (the board's IO8 header pin is the same net).
    const din = ctx.pin('IO8');
    const decoder = new Ws2812Decoder(1);
    const pixels = [0];
    const visual = { pixels, ledPower: supply.led.on };
    let high = false;
    let armed = false;
    const check = (): void => {
      const now = ctx.now();
      if (decoder.due(now)) {
        armed = false;
        if (decoder.latch()) ctx.invalidate();
      } else if (decoder.bits > 0 && !high) {
        ctx.schedule(Math.max(1, decoder.latchAt - now), check);
      } else {
        // Held high (GPIO8 doubles as Wire's SDA): no latch until it falls again, which re-arms.
        armed = false;
      }
    };
    din.onChange((state) => {
      const level = state.level === 1;
      if (level === high) return;
      high = level;
      const now = ctx.now();
      if (level) {
        const before = decoder.latches;
        decoder.rise(now);
        if (decoder.latches !== before) ctx.invalidate();
      } else {
        decoder.fall(now);
        if (!armed) {
          armed = true;
          ctx.schedule(decoder.latchAt - now, check);
        }
      }
    });
    return {
      power: supply.power,
      visual() {
        pixels[0] = decoder.pixels[0];
        visual.ledPower = supply.led.on;
        return visual;
      },
      reset() {
        supply.reset();
        decoder.reset();
        armed = false;
        high = din.read().level === 1;
        ctx.invalidate();
      },
    };
  },
});
