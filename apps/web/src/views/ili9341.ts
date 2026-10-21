/**
 * The ILI9341 TFT's screen (BT51): the element's own 240×320 canvas, painted from the
 * accumulated framebuffer the frame dispatcher keeps per part (`tftFrame`, RGB565 packed two to
 * a number) — only the
 * update's dirty rectangle after the first paint, everything when the element is new or the
 * display's on/invert state changed. A dark panel (display off, asleep, backlight low) is black.
 */

import type { VisualState } from '@benchtop/core';
import { TFT_HEIGHT, TFT_WIDTH, unpackPixel } from '@benchtop/parts';

interface TftElement extends HTMLElement {
  canvas?: HTMLCanvasElement | null;
}

interface Paint {
  image: ImageData;
  /** The on/invert state last painted; anything else forces a full repaint. */
  key: string;
}

const paints = new WeakMap<HTMLElement, Paint>();

/** Writes RGB565 pixels of `frame` in the rectangle into RGBA `out`. */
function convert(frame: readonly number[], out: Uint8ClampedArray, x: number, y: number, w: number, h: number, on: boolean, invert: boolean): void {
  for (let row = y; row < y + h; row++) {
    for (let col = x; col < x + w; col++) {
      const i = row * TFT_WIDTH + col;
      let c = on ? unpackPixel(frame, i) : 0;
      if (on && invert) c = ~c & 0xffff;
      const o = i * 4;
      out[o] = (((c >> 11) & 0x1f) * 527 + 23) >> 6;
      out[o + 1] = (((c >> 5) & 0x3f) * 259 + 33) >> 6;
      out[o + 2] = ((c & 0x1f) * 527 + 23) >> 6;
      out[o + 3] = 255;
    }
  }
}

export function applyIli9341(el: HTMLElement, visual: VisualState): void {
  const canvas = (el as TftElement).canvas;
  if (canvas === null || canvas === undefined) {
    // The element renders its canvas on first update: paint then.
    el.addEventListener('canvas-ready', () => applyIli9341(el, visual), { once: true });
    return;
  }
  const frame = visual.tftFrame;
  if (!Array.isArray(frame)) return;
  const on = visual.on === true;
  const invert = visual.invert === true;
  const key = `${on}|${invert}`;
  let paint = paints.get(el);
  let x = 0;
  let y = 0;
  let w = TFT_WIDTH;
  let h = TFT_HEIGHT;
  if (paint === undefined || paint.key !== key) {
    paint ??= { image: new ImageData(TFT_WIDTH, TFT_HEIGHT), key };
    paint.key = key;
    paints.set(el, paint);
  } else {
    if (typeof visual.tftW !== 'number') return;
    x = Number(visual.tftX);
    y = Number(visual.tftY);
    w = visual.tftW;
    h = Number(visual.tftH);
  }
  convert(frame, paint.image.data, x, y, w, h, on, invert);
  canvas.getContext('2d')?.putImageData(paint.image, 0, 0, x, y, w, h);
}
