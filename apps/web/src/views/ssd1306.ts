/**
 * The SSD1306 view: unpacks the model's packed framebuffer (`fb`, 256 numbers of 4 page-major
 * bytes) into one preallocated ImageData per element and redraws the element's canvas. The
 * view applies `invert`, `allOn` and `contrast` itself, so toggling them doesn't need a new fb.
 * Contrast (decided): canvas opacity 0.35 + 0.65 × contrast/255; dark while `on` is false.
 */

import type { VisualState } from '@benchtop/core';

interface OledElement extends HTMLElement {
  imageData: ImageData;
  redraw(): void;
}

/** Lit pixel colour: the white of a white-on-black module. */
const LIT = [0xe6, 0xf2, 0xff, 0xff] as const;

const state = new WeakMap<HTMLElement, { image: ImageData; fb: number[] }>();

export function applySsd1306(el: HTMLElement, visual: VisualState): void {
  const oled = el as OledElement;
  let entry = state.get(el);
  if (entry === undefined) {
    entry = { image: new ImageData(128, 64), fb: new Array<number>(256).fill(0) };
    state.set(el, entry);
    oled.imageData = entry.image;
  }
  if (Array.isArray(visual.fb)) {
    const fb = visual.fb as readonly number[];
    for (let i = 0; i < 256; i++) entry.fb[i] = fb[i] ?? 0;
  }
  const on = visual.on === true;
  const invert = visual.invert === true;
  const allOn = visual.allOn === true;
  const data = entry.image.data;
  for (let y = 0; y < 64; y++) {
    const pageBase = (y >> 3) * 128;
    const bit = y & 7;
    for (let x = 0; x < 128; x++) {
      const i = pageBase + x;
      const byte = (entry.fb[i >> 2] >>> (8 * (i & 3))) & 0xff;
      const lit = on && (allOn || (((byte >> bit) & 1) === 1) !== invert);
      const p = (y * 128 + x) * 4;
      data[p] = LIT[0];
      data[p + 1] = LIT[1];
      data[p + 2] = LIT[2];
      data[p + 3] = lit ? LIT[3] : 0;
    }
  }
  oled.redraw();
  const canvas = oled.shadowRoot?.querySelector('canvas');
  if (canvas) {
    const contrast = typeof visual.contrast === 'number' ? visual.contrast : 0x7f;
    canvas.style.opacity = String(0.35 + (0.65 * contrast) / 255);
    canvas.style.imageRendering = 'pixelated';
  }
}
