/**
 * WS2812B NeoPixels: an 8-pixel strip, a 16-pixel ring and an 8×8 matrix (prop `serpentine`).
 * Their element's drawing (and so its pins) depends on the pixel count, and a part type's pins
 * are fixed, so each size is its own type. DIN edges are decoded by Ws2812Decoder; after its
 * own pixels, DIN is mirrored onto DOUT synchronously (DOUT is 0 otherwise). Visual: `pixels`
 * (0xRRGGBB, chain order) plus the last frame's decode stats (`bits`, `errors`, `t0hMin`,
 * `t0hMax`, `t1hMin`, `t1hMax` in ns). More than 1 % bad bits in a frame reports a
 * 'neopixel-timing' warning. Pins from @wokwi/elements 1.9.2 neopixel-matrix-element (rows 1 or
 * 8) and led-ring-element.
 */

import { type PartContext, type PinDef, Strength } from '@benchtop/core';
import { definePart } from '../define.ts';
import { Ws2812Decoder } from './ws2812-decoder.ts';

function neopixelModel(ctx: PartContext, length: number) {
  const din = ctx.pin('DIN');
  const dout = ctx.pin('DOUT');
  const decoder = new Ws2812Decoder(length);
  const pixels: number[] = new Array<number>(length).fill(0);
  const visual = { pixels, bits: 0, errors: 0, t0hMin: 0, t0hMax: 0, t1hMin: 0, t1hMax: 0 };
  let armed = false;
  let high = false;
  const latched = (): void => {
    if (decoder.frameBits > 0 && decoder.frameErrors * 100 > decoder.frameBits) {
      ctx.report({
        severity: 'warning',
        code: 'neopixel-timing',
        message: `${decoder.frameErrors} of ${decoder.frameBits} WS2812 bits had a high time outside 0.2–1.0 µs.`,
        parts: [],
      });
    }
    ctx.invalidate();
  };
  const check = (): void => {
    const now = ctx.now();
    if (decoder.due(now)) {
      armed = false;
      if (decoder.latch()) latched();
    } else if (decoder.bits > 0 || decoder.passing) {
      ctx.schedule(Math.max(1, decoder.latchAt - now), check);
    } else {
      armed = false;
    }
  };
  din.onChange((state) => {
    const level = state.level === 1;
    if (level === high) return;
    high = level;
    const now = ctx.now();
    if (level) {
      const latchesBefore = decoder.latches;
      const pass = decoder.rise(now);
      if (decoder.latches !== latchesBefore) latched();
      if (pass) dout.drive(1, Strength.strong);
    } else {
      if (decoder.fall(now)) dout.drive(0, Strength.strong);
      if (!armed) {
        armed = true;
        ctx.schedule(decoder.latchAt - now, check);
      }
    }
  });
  dout.drive(0, Strength.strong);
  return {
    visual() {
      for (let i = 0; i < length; i++) pixels[i] = decoder.pixels[i];
      visual.bits = decoder.frameBits;
      visual.errors = decoder.frameErrors;
      visual.t0hMin = decoder.t0hMin;
      visual.t0hMax = decoder.t0hMax;
      visual.t1hMin = decoder.t1hMin;
      visual.t1hMax = decoder.t1hMax;
      return visual;
    },
    reset() {
      decoder.reset();
      armed = false;
      high = din.read().level === 1;
      dout.drive(0, Strength.strong);
      ctx.invalidate();
    },
  };
}

/** GND, VCC, DIN, DOUT on 0.1" pitch, centred at `cx`, at height `y` (mm). */
function headerPins(cx: number, y: number): PinDef[] {
  return [
    { name: 'GND', x: cx - 3.81, y, role: 'ground' },
    { name: 'VCC', x: cx - 1.27, y, role: 'power' },
    { name: 'DIN', x: cx + 1.27, y, role: 'digital' },
    { name: 'DOUT', x: cx + 3.81, y, role: 'digital' },
  ];
}

export const neopixelStrip = definePart({
  type: 'neopixel-strip',
  title: 'NeoPixel strip (8)',
  category: 'output',
  size: { w: 52.28, h: 5 },
  pins: headerPins(26.643, 6.001),
  defaults: {},
  createModel: (ctx) => neopixelModel(ctx, 8),
});

export const neopixelRing = definePart({
  type: 'neopixel-ring',
  title: 'NeoPixel ring (16)',
  category: 'output',
  size: { w: 37.465, h: 40.465 },
  pins: headerPins(18.735, 40.47),
  defaults: {},
  createModel: (ctx) => neopixelModel(ctx, 16),
});

export const neopixelMatrix = definePart({
  type: 'neopixel-matrix',
  title: 'NeoPixel matrix (8×8)',
  category: 'output',
  size: { w: 52.28, h: 47 },
  pins: headerPins(26.643, 48.006),
  defaults: { serpentine: false },
  createModel: (ctx) => neopixelModel(ctx, 64),
});
