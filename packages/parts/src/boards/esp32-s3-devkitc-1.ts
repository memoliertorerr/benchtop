/**
 * ESP32-S3-DevKitC-1 (BT126): Espressif's board with an ESP32-S3-WROOM-1 module. Our own pin table
 * — no element library draws this board — from the ESP32-S3-DevKitC-1 v1.0 user guide's header
 * tables: J1 down the left edge (3V3, 3V3, RST, 4, 5, 6, 7, 15, 16, 17, 18, 8, 3, 46, 9, 10, 11,
 * 12, 13, 14, 5V, G) and J3 down the right (G, TX, RX, 1, 2, 42, 41, 40, 39, 38, 37, 36, 35, 0,
 * 45, 48, 47, 21, 20, 19, G, G), 22 pins each on the 0.1" pitch, the two rows 0.9" apart (it
 * straddles a full breadboard's gap using its outer rows), the module and antenna at the top, the
 * two USB ports at the bottom (USB-UART on UART0, and the S3's own USB). Drawn by apps/web's
 * views/esp32-s3-devkitc-1.ts. GPIO26–32 (the module's flash) and 33–34 aren't on the headers.
 *
 * Header pins map to GPIOs: IO<n> → GPIO<n>, TX/RX → GPIO43/GPIO44 (UART0, which the board's
 * USB-UART bridge carries to the serial monitor). 3V3 is the 3.3 V supply; 5V is USB's 5 V while
 * prop `usbPowered` is true (the default), else an input; the GNDs and the 3V3s are each one bus.
 * BT135: prop `module` — `auto` (the default), `N8`, `N8R2` or `N8R8` (boards/modules.ts) — tells
 * the MCU factory which PSRAM the board's module has (on an R8 module the octal PSRAM also takes
 * GPIO33–37; IO35–37 are still on the header).
 * RST (CHIP_PU) isn't modeled and maps to no GPIO.
 *
 * Model: the board's RGB LED is a WS2812 on GPIO48 (v1.0; v1.1 moved it to GPIO38 — Arduino-ESP32
 * 2.0.17's `esp32s3` variant says 48: `RGB_BUILTIN`, which `neopixelWrite` drives through the RMT):
 * its DIN edges on IO48 are decoded like a NeoPixel's (Ws2812Decoder) and the color shows as
 * `pixels[0]` (0xRRGGBB) in the board's visual state, as the C3 DevKitM-1's does (so `pixel s3[0]
 * is #rrggbb` assertions read it); `ledPower` is always on.
 */

import { type PartContext, type PinDef, type PinRole, Strength } from '@benchtop/core';
import { Ws2812Decoder } from '../actuators/ws2812-decoder.ts';
import { definePart } from '../define.ts';

const PITCH = 2.54;
/** Board outline (mm): 1" × 2.5"; the headers 0.9" apart, 1.27 mm in from each edge. */
const WIDTH = 25.4;
const HEIGHT = 63.5;
const LEFT_X = 1.27;
const RIGHT_X = LEFT_X + 9 * PITCH;
const FIRST_Y = 3.81;
/** The RGB LED's GPIO (DIN). */
export const S3_DEVKITC1_RGB_GPIO = 48;

/** J1 (left) and J3 (right), top to bottom; repeated names numbered as the bench needs them unique. */
const J1 = ['3V3.1', '3V3.2', 'RST', 'IO4', 'IO5', 'IO6', 'IO7', 'IO15', 'IO16', 'IO17', 'IO18', 'IO8', 'IO3', 'IO46', 'IO9', 'IO10', 'IO11', 'IO12', 'IO13', 'IO14', '5V', 'GND.1'] as const;
const J3 = ['GND.2', 'TX', 'RX', 'IO1', 'IO2', 'IO42', 'IO41', 'IO40', 'IO39', 'IO38', 'IO37', 'IO36', 'IO35', 'IO0', 'IO45', 'IO48', 'IO47', 'IO21', 'IO20', 'IO19', 'GND.3', 'GND.4'] as const;
export const ESP32_S3_DEVKITC1_HEADERS = { J1, J3 };

function role(name: string): PinRole {
  if (name.startsWith('GND')) return 'ground';
  if (name.startsWith('3V3') || name === '5V') return 'power';
  return 'digital';
}

const pins: PinDef[] = [];
J1.forEach((name, i) => pins.push({ name, x: LEFT_X, y: Math.round((FIRST_Y + i * PITCH) * 1000) / 1000, role: role(name) }));
J3.forEach((name, i) => pins.push({ name, x: RIGHT_X, y: Math.round((FIRST_Y + i * PITCH) * 1000) / 1000, role: role(name) }));
for (const pin of pins) if (pin.name.startsWith('3V3')) pin.volts = 3.3;
for (const pin of pins) if (pin.name.startsWith('GND')) pin.volts = 0;

const pinMap: Record<string, string> = { TX: 'GPIO43', RX: 'GPIO44' };
for (const pin of pins) if (/^IO\d+$/.test(pin.name)) pinMap[pin.name] = `GPIO${pin.name.slice(2)}`;

export const esp32S3DevkitC1 = definePart({
  type: 'esp32-s3-devkitc-1',
  title: 'ESP32-S3-DevKitC-1',
  category: 'boards',
  size: { w: WIDTH, h: HEIGHT },
  pins,
  buses: [pins.filter((p) => p.name.startsWith('GND')).map((p) => p.name), ['3V3.1', '3V3.2']],
  defaults: { usbPowered: true, module: 'auto' },
  board: { mcu: 'esp32s3', pinMap },
  createModel(ctx: PartContext, props: { usbPowered: boolean; module: string }) {
    if (props.usbPowered !== false) ctx.pin('5V').driveVolts(5, Strength.supply);
    // The RGB LED: a WS2812 whose DIN is GPIO48 (the board's IO48 header pin is the same net).
    const din = ctx.pin(`IO${S3_DEVKITC1_RGB_GPIO}`);
    const decoder = new Ws2812Decoder(1);
    const pixels = [0];
    const visual = { pixels, ledPower: true };
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
        // Held high by something else on IO48: no latch until it falls again, which re-arms.
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
      visual() {
        pixels[0] = decoder.pixels[0];
        return visual;
      },
      reset() {
        decoder.reset();
        armed = false;
        high = din.read().level === 1;
        ctx.invalidate();
      },
    };
  },
});
