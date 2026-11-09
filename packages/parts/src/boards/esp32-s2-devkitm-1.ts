/**
 * ESP32-S2-DevKitM-1 (BT150): Espressif's board with an ESP32-S2-MINI-1 module (the ESP32-S2FH4:
 * 4 MB of flash in the package, no PSRAM). Our own pin table — no element library draws this board —
 * from the ESP32-S2-DevKitM-1 user guide's header tables: J1 down the left edge (3V3, 0–17, 5V, G)
 * and J3 down the right (G, RST, 46, 45, RX, TX, 42–33, 26, 21, 20, 19, 18), 21 pins each on the
 * 0.1" pitch, the two rows 0.9" apart (it straddles a full breadboard's gap using its outer rows),
 * the module and antenna at the top, the one micro-USB port (the USB-UART bridge on UART0) at the
 * bottom. Drawn by apps/web's views/esp32-s2-devkitm-1.ts. GPIO27–32 (the flash) aren't on the
 * headers; GPIO26 (SPICS1, the PSRAM chip select the S2FH4 doesn't use) is.
 *
 * Header pins map to GPIOs: <n> → GPIO<n>, TX/RX → GPIO43/GPIO44 (UART0, which the board's USB-UART
 * bridge carries to the serial monitor). GPIO19/20 are the S2's own USB (D−/D+): the bench's USB
 * host is on them as if a cable were plugged there (a `CDCOnBoot=cdc` build's `Serial`). 3V3 is the
 * 3.3 V supply; 5V is USB's 5 V while prop `usbPowered` is true (the default), else an input; the
 * GNDs are one bus. RST (CHIP_PU) isn't modeled and maps to no GPIO. GPIO46 is input-only on the
 * chip (the model doesn't refuse driving it).
 *
 * BT154: prop `module` — `auto` (the default), `N4` or `N4R2` (boards/modules.ts) — tells the MCU
 * factory whether the board's module has PSRAM (an N4R2's 2 MB, whose chip select is GPIO26: the
 * IO26 header pin is then the module's, `pin-reserved` if wired). The DevKitM-1 has shipped with
 * both (ESP32-S2-MINI-1/-MINI-2, N4 and N4R2 variants).
 *
 * Model: the board's RGB LED is a WS2812 on GPIO18 (Arduino-ESP32 2.0.17's `esp32s2` variant:
 * `RGB_BUILTIN`, which `neopixelWrite` drives through the RMT): its DIN edges on IO18 are decoded
 * like a NeoPixel's (Ws2812Decoder) and the color shows as `pixels[0]` (0xRRGGBB) in the board's
 * visual state, as the C3's and S3's DevKits do (so `pixel s2[0] is #rrggbb` assertions read it);
 * `ledPower` is always on.
 */

import { type PartContext, type PinDef, type PinRole, Strength } from '@benchtop/core';
import { Ws2812Decoder } from '../actuators/ws2812-decoder.ts';
import { definePart } from '../define.ts';

const PITCH = 2.54;
/** Board outline (mm): 1" × 2.4"; the headers 0.9" apart, 1.27 mm in from each edge. */
const WIDTH = 25.4;
const HEIGHT = 60.96;
const LEFT_X = 1.27;
const RIGHT_X = LEFT_X + 9 * PITCH;
const FIRST_Y = 3.81;
/** The RGB LED's GPIO (DIN). */
export const S2_DEVKITM1_RGB_GPIO = 18;

/** J1 (left) and J3 (right), top to bottom; repeated names numbered as the bench needs them unique. */
const J1 = ['3V3', 'IO0', 'IO1', 'IO2', 'IO3', 'IO4', 'IO5', 'IO6', 'IO7', 'IO8', 'IO9', 'IO10', 'IO11', 'IO12', 'IO13', 'IO14', 'IO15', 'IO16', 'IO17', '5V', 'GND.1'] as const;
const J3 = ['GND.2', 'RST', 'IO46', 'IO45', 'RX', 'TX', 'IO42', 'IO41', 'IO40', 'IO39', 'IO38', 'IO37', 'IO36', 'IO35', 'IO34', 'IO33', 'IO26', 'IO21', 'IO20', 'IO19', 'IO18'] as const;
export const ESP32_S2_DEVKITM1_HEADERS = { J1, J3 };

function role(name: string): PinRole {
  if (name.startsWith('GND')) return 'ground';
  if (name === '3V3' || name === '5V') return 'power';
  return 'digital';
}

const pins: PinDef[] = [];
J1.forEach((name, i) => pins.push({ name, x: LEFT_X, y: Math.round((FIRST_Y + i * PITCH) * 1000) / 1000, role: role(name) }));
J3.forEach((name, i) => pins.push({ name, x: RIGHT_X, y: Math.round((FIRST_Y + i * PITCH) * 1000) / 1000, role: role(name) }));
for (const pin of pins) if (pin.name === '3V3') pin.volts = 3.3;
for (const pin of pins) if (pin.name.startsWith('GND')) pin.volts = 0;

const pinMap: Record<string, string> = { TX: 'GPIO43', RX: 'GPIO44' };
for (const pin of pins) if (/^IO\d+$/.test(pin.name)) pinMap[pin.name] = `GPIO${pin.name.slice(2)}`;

export const esp32S2DevkitM1 = definePart({
  type: 'esp32-s2-devkitm-1',
  title: 'ESP32-S2-DevKitM-1',
  category: 'boards',
  size: { w: WIDTH, h: HEIGHT },
  pins,
  buses: [pins.filter((p) => p.name.startsWith('GND')).map((p) => p.name)],
  defaults: { usbPowered: true, module: 'auto' },
  board: { mcu: 'esp32s2', pinMap },
  createModel(ctx: PartContext, props: { usbPowered: boolean; module: string }) {
    if (props.usbPowered !== false) ctx.pin('5V').driveVolts(5, Strength.supply);
    // The RGB LED: a WS2812 whose DIN is GPIO18 (the board's IO18 header pin is the same net).
    const din = ctx.pin(`IO${S2_DEVKITM1_RGB_GPIO}`);
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
        // Held high by something else on IO18: no latch until it falls again, which re-arms.
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
