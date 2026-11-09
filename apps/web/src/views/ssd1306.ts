/**
 * The SSD1306 view: unpacks the model's packed framebuffer (`fb`, 256 numbers of 4 page-major
 * bytes) into one preallocated ImageData per element and redraws the element's canvas. The
 * view applies `invert`, `allOn` and `contrast` itself, so toggling them doesn't need a new fb.
 * Contrast (decided): canvas opacity 0.35 + 0.65 × contrast/255; dark while `on` is false. BT181:
 * the unpacking is `paintOled`, which our own OLED modules' view (`oled.ts`) shares.
 */

import type { VisualState } from '@benchtop/core';
import { oledOpacity, paintOled } from './oled.ts';

interface OledElement extends HTMLElement {
  imageData: ImageData;
  redraw(): void;
}

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
  paintOled(entry.image.data, entry.fb, 64, visual.on === true, visual.invert === true, visual.allOn === true);
  oled.redraw();
  const canvas = oled.shadowRoot?.querySelector('canvas');
  if (canvas) {
    canvas.style.opacity = String(oledOpacity(visual.contrast));
    canvas.style.imageRendering = 'pixelated';
  }
}
