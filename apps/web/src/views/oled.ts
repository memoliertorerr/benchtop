/**
 * Our own drawings of the OLED modules @wokwi/elements has none of (BT181; packages/parts
 * displays/oled-modules.ts), in mm, pins on the definitions' own positions:
 * - `ssd1306-128x32`: the 0.91″ module — a blue board, its header down the left end (GND, VCC,
 *   SCL, SDA), the glass with its 22.4 × 5.6 mm active area;
 * - `ssd1306-spi`: the 0.96″ 7-pin module — a blue board, its header along the top (GND, VCC, D0,
 *   D1, RES, DC, CS), four mounting holes, the glass with its 21.7 × 10.9 mm active area;
 * - BT182: `sh1106`: the 1.3″ module — the same with VCC, GND, SCL, SDA and a 29.4 × 14.7 mm area.
 * The pixels are a canvas (128 × the glass's rows) in a foreignObject over the active area — the
 * image export turns it into an <image> of its pixels. `paintOled` unpacks a model's `fb` the
 * way the element view (`views/ssd1306.ts`) does: `on`, `invert`, `allOn` applied here, contrast as
 * the canvas's opacity (0.35 + 0.65 × contrast/255).
 */

import type { PartDefinition, VisualState } from '@benchtop/core';
import type { ViewFactory } from './registry.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';

function el<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

/** The part types this view draws. */
export const OLED_VIEW_TYPES: ReadonlySet<string> = new Set(['ssd1306-128x32', 'ssd1306-spi', 'sh1106']);

/** Lit pixel colour: the white of a white-on-black module. */
const LIT = [0xe6, 0xf2, 0xff] as const;

/**
 * Unpacks a packed `fb` (rows × 4 numbers, 4 page-major bytes each) into `data` (128 × rows RGBA):
 * lit pixels white, the rest transparent; dark while `on` is false.
 */
export function paintOled(data: Uint8ClampedArray, fb: readonly number[], rows: number, on: boolean, invert: boolean, allOn: boolean): void {
  for (let y = 0; y < rows; y++) {
    const pageBase = (y >> 3) * 128;
    const bit = y & 7;
    for (let x = 0; x < 128; x++) {
      const i = pageBase + x;
      const byte = ((fb[i >> 2] ?? 0) >>> (8 * (i & 3))) & 0xff;
      const lit = on && (allOn || (((byte >> bit) & 1) === 1) !== invert);
      const p = (y * 128 + x) * 4;
      data[p] = LIT[0];
      data[p + 1] = LIT[1];
      data[p + 2] = LIT[2];
      data[p + 3] = lit ? 0xff : 0;
    }
  }
}

/** The canvas opacity for an SSD1306 contrast (0–255). */
export function oledOpacity(contrast: unknown): number {
  return 0.35 + (0.65 * (typeof contrast === 'number' ? contrast : 0x7f)) / 255;
}

interface Screen {
  canvas: HTMLCanvasElement;
  image: ImageData;
  fb: number[];
  rows: number;
}
const screens = new WeakMap<HTMLElement, Screen>();

/** A module's layout: the glass and its active area, in mm. */
interface Layout {
  rows: 32 | 64;
  glass: { x: number; y: number; w: number; h: number };
  active: { x: number; y: number; w: number; h: number };
  labelBelow: boolean;
  holes: boolean;
}

function layoutOf(def: PartDefinition): Layout {
  const { w, h } = def.size;
  if (def.type === 'ssd1306-128x32') {
    const glass = { x: 5.2, y: 0.6, w: w - 5.8, h: h - 1.2 };
    const active = { x: glass.x + (glass.w - 22.4) / 2 + 1.2, y: (h - 5.6) / 2, w: 22.4, h: 5.6 };
    return { rows: 32, glass, active, labelBelow: false, holes: false };
  }
  if (def.type === 'sh1106') {
    const glass = { x: 0.45, y: 5.2, w: w - 0.9, h: 23.4 };
    const active = { x: (w - 29.42) / 2, y: glass.y + 3.2, w: 29.42, h: 14.7 };
    return { rows: 64, glass, active, labelBelow: true, holes: true };
  }
  const glass = { x: 0.3, y: 5.6, w: w - 0.6, h: 19.3 };
  const active = { x: (w - 21.74) / 2, y: glass.y + 2.4, w: 21.74, h: 10.86 };
  return { rows: 64, glass, active, labelBelow: true, holes: true };
}

export const oledView: ViewFactory = {
  async create(def: PartDefinition) {
    const { w, h } = def.size;
    const layout = layoutOf(def);
    const wrapper = document.createElement('div');
    wrapper.className = 'oled-view';
    const svg = el('svg', { width: `${w}mm`, height: `${h}mm`, viewBox: `0 0 ${w} ${h}`, overflow: 'visible' });
    svg.append(el('rect', { x: 0.15, y: 0.15, width: w - 0.3, height: h - 0.3, rx: 0.8, fill: '#1c4c9c', stroke: '#123671', 'stroke-width': 0.3 }));
    if (layout.holes) {
      for (const [cx, cy] of [
        [2, 2],
        [w - 2, 2],
        [2, h - 2],
        [w - 2, h - 2],
      ]) {
        svg.append(el('circle', { cx, cy, r: 1.1, fill: '#d7b45a' }));
        svg.append(el('circle', { cx, cy, r: 0.75, fill: '#0e1a33' }));
      }
    }
    const g = layout.glass;
    svg.append(el('rect', { x: g.x, y: g.y, width: g.w, height: g.h, rx: 0.4, fill: '#0b0d10', stroke: '#3a3f47', 'stroke-width': 0.2 }));
    // The ribbon to the glass (the 0.91″'s at its left end, the 0.96″'s at its bottom).
    if (layout.labelBelow) svg.append(el('rect', { x: w / 2 - 5, y: g.y + g.h - 0.3, width: 10, height: h - g.y - g.h - 0.2, fill: '#c8a24a', opacity: 0.85 }));
    else svg.append(el('rect', { x: g.x - 0.2, y: h / 2 - 3, width: 1.4, height: 6, fill: '#c8a24a', opacity: 0.85 }));
    const a = layout.active;
    svg.append(el('rect', { x: a.x - 0.25, y: a.y - 0.25, width: a.w + 0.5, height: a.h + 0.5, fill: '#05070a' }));
    for (const pin of def.pins) {
      svg.append(el('circle', { cx: pin.x, cy: pin.y, r: 0.75, fill: '#d7b45a', stroke: '#a3842f', 'stroke-width': 0.15 }));
      svg.append(el('circle', { cx: pin.x, cy: pin.y, r: 0.4, fill: '#20232a' }));
      const label = el('text', {
        x: layout.labelBelow ? pin.x : pin.x + 1.3,
        y: layout.labelBelow ? pin.y + 2.3 : pin.y,
        'font-size': layout.labelBelow ? 1.05 : 0.95,
        fill: '#e9ebee',
        'text-anchor': layout.labelBelow ? 'middle' : 'start',
        'dominant-baseline': 'central',
        'font-family': 'sans-serif',
      });
      label.textContent = pin.name;
      svg.append(label);
    }
    const object = el('foreignObject', { x: a.x, y: a.y, width: a.w, height: a.h });
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = layout.rows;
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    canvas.style.imageRendering = 'pixelated';
    canvas.style.opacity = String(oledOpacity(undefined));
    object.append(canvas);
    svg.append(object);
    wrapper.append(svg);
    screens.set(wrapper, { canvas, image: new ImageData(128, layout.rows), fb: new Array<number>(layout.rows * 4).fill(0), rows: layout.rows });
    return wrapper;
  },
  setProps() {},
  update(el: HTMLElement, visual: VisualState) {
    const screen = screens.get(el);
    if (screen === undefined) return;
    if (Array.isArray(visual.fb)) {
      const fb = visual.fb as readonly number[];
      for (let i = 0; i < screen.fb.length; i++) screen.fb[i] = fb[i] ?? 0;
    }
    paintOled(screen.image.data, screen.fb, screen.rows, visual.on === true, visual.invert === true, visual.allOn === true);
    screen.canvas.getContext('2d')?.putImageData(screen.image, 0, 0);
    screen.canvas.style.opacity = String(oledOpacity(visual.contrast));
  },
};
