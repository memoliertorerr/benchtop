/**
 * More SSD1306 modules (BT181), beside the element's 0.96″ I2C `ssd1306`:
 * - `ssd1306-128x32`: the 0.91″ 128×32 on I2C (0x3C/0x3D), its glass wired for the sequential COM
 *   pins (Adafruit's 128×32 init is the identity, a 128×64 init draws every other RAM row). Four pins
 *   down its left end: GND, VCC, SCL, SDA.
 * - `ssd1306-spi`: the 0.96″ 128×64 on 4-wire SPI, seven pins along the top: GND, VCC, D0 (SCLK),
 *   D1 (SDIN), RES, DC, CS. Hardware SPI arrives through `attachSpi` (D/C read at each byte); a
 *   bit-banged one through its pins (`shared/soft-spi.ts`: D1 shifted on every D0 rising edge while
 *   CS is low, D/C sampled on the eighth — the datasheet's §8.1.3). It has no MISO: it names D1 for
 *   it, which the bench takes as write-only. RES low resets the controller and holds it (a floating
 *   RES is high: the module's RC pulls it up).
 * - BT182: `sh1106`, the 1.3″ 128×64 on I2C (0x3C/0x3D) with an SH1106 (`sh1106.ts`): four pins
 *   along the top, VCC first as on most 1.3″ modules: VCC, GND, SCL, SDA.
 * Positions in mm from our own drawings (apps/web views/oled.ts).
 */

import type { PartContext, SpiDevice } from '@benchtop/core';
import { definePart } from '../define.ts';
import { listenSoftSpi } from '../shared/soft-spi.ts';
import { Sh1106 } from './sh1106.ts';
import { oledModel, parseOledAddress, Ssd1306, ssd1306Model } from './ssd1306.ts';

const PITCH = 2.54;

export const ssd1306128x32 = definePart({
  type: 'ssd1306-128x32',
  title: 'OLED 128×32 (SSD1306, I2C, 0.91″)',
  category: 'displays',
  size: { w: 38, h: 12 },
  pins: [
    { name: 'GND', x: 1.6, y: 6 - 1.5 * PITCH, role: 'ground' },
    { name: 'VCC', x: 1.6, y: 6 - 0.5 * PITCH, role: 'power' },
    { name: 'SCL', x: 1.6, y: 6 + 0.5 * PITCH, role: 'digital' },
    { name: 'SDA', x: 1.6, y: 6 + 1.5 * PITCH, role: 'digital' },
  ],
  defaults: { address: '0x3C' },
  createModel: (ctx, props) => ssd1306Model(ctx, props.address, 'SDA', 'SCL', 32),
});

/** The SPI module's pins, left to right along its top edge. */
export const SSD1306_SPI_PINS = ['GND', 'VCC', 'D0', 'D1', 'RES', 'DC', 'CS'] as const;

function ssd1306SpiModel(ctx: PartContext) {
  // The address is unused on SPI.
  const oled = new Ssd1306(0x3c, () => ctx.invalidate(), { glass: 64, clock: ctx });
  const dc = ctx.pin('DC');
  const res = ctx.pin('RES');
  /** Held in reset while RES is driven low. */
  let held = res.read().level === 0;
  const take = (byte: number): void => {
    if (held) return;
    if (dc.read().level === 1) oled.dataByte(byte);
    else oled.commandByte(byte);
  };
  const device: SpiDevice = {
    transfer(mosi: number): number {
      take(mosi);
      return 0xff;
    },
  };
  ctx.attachSpi({ sck: 'D0', mosi: 'D1', miso: 'D1', cs: 'CS' }, device);
  const soft = listenSoftSpi(ctx.pin('D0'), ctx.pin('D1'), ctx.pin('CS'), take);
  res.onChange((state) => {
    const low = state.level === 0;
    if (low === held) return;
    held = low;
    if (low) {
      oled.reset();
      soft.reset();
      ctx.invalidate();
    }
  });
  return oledModel(ctx, oled);
}

export const ssd1306Spi = definePart({
  type: 'ssd1306-spi',
  title: 'OLED 128×64 (SSD1306, SPI, 7-pin)',
  category: 'displays',
  size: { w: 27.3, h: 27.8 },
  pins: SSD1306_SPI_PINS.map((name, i) => ({
    name,
    x: Math.round((27.3 / 2 + (i - 3) * PITCH) * 1000) / 1000,
    y: 1.6,
    role: name === 'GND' ? ('ground' as const) : name === 'VCC' ? ('power' as const) : ('digital' as const),
  })),
  defaults: {},
  createModel: (ctx) => ssd1306SpiModel(ctx),
});

/** BT182: the 1.3″ module's pins, left to right along its top edge. */
export const SH1106_PINS = ['VCC', 'GND', 'SCL', 'SDA'] as const;

export const sh1106 = definePart({
  type: 'sh1106',
  title: 'OLED 128×64 (SH1106, I2C, 1.3″)',
  category: 'displays',
  size: { w: 35.4, h: 33.5 },
  pins: SH1106_PINS.map((name, i) => ({
    name,
    x: Math.round((35.4 / 2 + (i - 1.5) * PITCH) * 1000) / 1000,
    y: 1.6,
    role: name === 'GND' ? ('ground' as const) : name === 'VCC' ? ('power' as const) : ('digital' as const),
  })),
  defaults: { address: '0x3C' },
  createModel(ctx, props) {
    const oled = new Sh1106(parseOledAddress(props.address), () => ctx.invalidate());
    ctx.attachI2c('SDA', 'SCL', oled);
    return oledModel(ctx, oled);
  },
});
