/**
 * Our own drawing of Espressif's ESP32-S3-DevKitC-1 (BT126; the element library has none), in mm,
 * after the user guide's board photo: the black PCB, the ESP32-S3-WROOM-1 module (the antenna's
 * keep-out at the top, the metal can below it), the two 22-pin headers at the part's pin positions
 * with the silkscreen's names (numbers for GPIOs, G for ground), the RGB LED (a WS2812 on GPIO48 —
 * its color from the board's `pixels[0]` visual state, with a glow when lit), the power LED, the
 * USB-UART bridge, the BOOT and RST buttons, and the two micro-USB ports at the bottom (UART and
 * the S3's own USB).
 */

import type { PartDefinition, VisualState } from '@benchtop/core';
import type { ViewFactory } from './registry.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';
const PCB = '#1d1f23';
const SILK = '#e9ebee';

function el<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

function text(x: number, y: number, label: string, size: number, anchor: 'start' | 'end' | 'middle', fill = SILK, weight = 'normal'): SVGTextElement {
  const node = el('text', { x, y, 'font-size': size, fill, 'text-anchor': anchor, 'dominant-baseline': 'central', 'font-family': 'sans-serif', 'font-weight': weight });
  node.textContent = label;
  return node;
}

/** The silkscreen's name for a header pin: GPIOs by number, ground as G. */
function silk(name: string): string {
  const base = name.replace(/\.\d+$/, '');
  if (base === 'GND') return 'G';
  return base.startsWith('IO') ? base.slice(2) : base;
}

interface LedNodes {
  led: SVGRectElement;
  glow: SVGCircleElement;
}

const leds = new WeakMap<HTMLElement, LedNodes>();

function usbPort(cx: number, y: number, label: string): SVGElement[] {
  return [
    el('rect', { x: cx - 3.9, y, width: 7.8, height: 5.4, rx: 0.5, fill: '#c9ccd1', stroke: '#8e9399', 'stroke-width': 0.2 }),
    el('rect', { x: cx - 2.9, y: y + 3.5, width: 5.8, height: 1.5, rx: 0.3, fill: '#5a5e63' }),
    text(cx, y - 0.9, label, 0.75, 'middle'),
  ];
}

function draw(def: PartDefinition): { svg: SVGSVGElement } & LedNodes {
  const { w, h } = def.size;
  const svg = el('svg', { width: `${w}mm`, height: `${h}mm`, viewBox: `0 0 ${w} ${h}` });
  svg.append(el('rect', { x: 0.1, y: 0.1, width: w - 0.2, height: h - 0.2, rx: 1, fill: PCB, stroke: '#0c0d0f', 'stroke-width': 0.2 }));
  // ESP32-S3-WROOM-1: the antenna's keep-out at the top (its meander trace), the shield can below.
  const mx = 4.4;
  const mw = w - 2 * mx;
  svg.append(el('rect', { x: mx, y: 0.5, width: mw, height: 5.6, rx: 0.3, fill: '#2a2d33' }));
  svg.append(el('path', { d: `M ${mx + 1.4} ${4.6} h 1.8 v -2.8 h 1.8 v 2.8 h 1.8 v -2.8 h 1.8 v 2.8 h 1.8 v -2.8 h 1.8 v 2.8 h 1.6`, fill: 'none', stroke: '#c9a54b', 'stroke-width': 0.35 }));
  svg.append(el('rect', { x: mx, y: 6.3, width: mw, height: 13.6, rx: 0.4, fill: '#c3c6cb', stroke: '#8d9196', 'stroke-width': 0.2 }));
  svg.append(text(w / 2, 10.6, 'ESP32-S3-WROOM-1', 1.05, 'middle', '#3a3d42', 'bold'));
  svg.append(text(w / 2, 12.6, 'ESPRESSIF', 0.9, 'middle', '#55595f'));
  svg.append(text(w / 2, 22, def.title, 0.95, 'middle'));
  // The RGB LED (WS2812, GPIO48) with its glow, and the red power LED.
  const glow = el('circle', { cx: w / 2, cy: 27.4, r: 2.6, fill: '#000', opacity: 0 });
  const led = el('rect', { x: w / 2 - 1.25, y: 26.15, width: 2.5, height: 2.5, rx: 0.3, fill: '#e9e6dc', stroke: '#9c9a92', 'stroke-width': 0.12 });
  svg.append(glow, led, text(w / 2, 29.9, 'RGB IO48', 0.75, 'middle'));
  svg.append(el('rect', { x: w / 2 + 3.6, y: 34.2, width: 1, height: 0.7, rx: 0.1, fill: '#ff3b3b' }));
  svg.append(text(w / 2 + 4.1, 35.5, 'PWR', 0.6, 'middle'));
  // The 3.3 V regulator and the USB-UART bridge (CP2102N).
  svg.append(el('rect', { x: w / 2 - 3.2, y: 33.4, width: 3, height: 2, rx: 0.15, fill: '#121315' }));
  svg.append(el('rect', { x: w / 2 - 2.5, y: 40.5, width: 5, height: 5, rx: 0.2, fill: '#121315' }));
  // BOOT and RST.
  for (const [x, label] of [[w / 2 - 5.6, 'BOOT'], [w / 2 + 5.6, 'RST']] as const) {
    svg.append(el('rect', { x: x - 1.9, y: 48.2, width: 3.8, height: 2.6, rx: 0.3, fill: '#d6d7d9', stroke: '#9a9ca0', 'stroke-width': 0.15 }));
    svg.append(el('circle', { cx: x, cy: 49.5, r: 0.9, fill: '#2b2c2e' }));
    svg.append(text(x, 51.6, label, 0.7, 'middle'));
  }
  // The two micro-USB ports at the bottom edge: USB-UART (UART0) and the S3's own USB.
  svg.append(...usbPort(w / 2 - 5.2, h - 5.4, 'UART'), ...usbPort(w / 2 + 5.2, h - 5.4, 'USB'));
  // Header pins (holes with pads; pin 1 of each header square) and their names toward the middle.
  for (const pin of def.pins) {
    const left = pin.x < w / 2;
    const first = pin.name === '3V3.1' || pin.name === 'GND.2';
    svg.append(el('rect', { x: pin.x - 0.95, y: pin.y - 0.95, width: 1.9, height: 1.9, rx: first ? 0 : 0.95, fill: '#d9b44a', stroke: '#a8862b', 'stroke-width': 0.12 }));
    svg.append(el('circle', { cx: pin.x, cy: pin.y, r: 0.5, fill: '#2b2312' }));
    svg.append(text(left ? pin.x + 1.35 : pin.x - 1.35, pin.y, silk(pin.name), 0.78, left ? 'start' : 'end'));
  }
  return { svg, led, glow };
}

export const esp32S3DevkitC1View: ViewFactory = {
  async create(def) {
    const wrapper = document.createElement('div');
    wrapper.className = 'esp32s3-view';
    const { svg, led, glow } = draw(def);
    wrapper.append(svg);
    leds.set(wrapper, { led, glow });
    return wrapper;
  },
  setProps() {},
  update(el, visual: VisualState) {
    const nodes = leds.get(el);
    const rgb = Array.isArray(visual.pixels) ? visual.pixels[0] : undefined;
    if (nodes === undefined || typeof rgb !== 'number') return;
    const r = (rgb >>> 16) & 0xff;
    const g = (rgb >>> 8) & 0xff;
    const b = rgb & 0xff;
    const peak = Math.max(r, g, b);
    if (peak === 0) {
      nodes.led.setAttribute('fill', '#e9e6dc');
      nodes.glow.setAttribute('opacity', '0');
      return;
    }
    // Scale to full brightness for the color (RGB_BRIGHTNESS is 64 in Arduino), glow by the level.
    const k = 255 / peak;
    const color = `rgb(${Math.round(r * k)}, ${Math.round(g * k)}, ${Math.round(b * k)})`;
    nodes.led.setAttribute('fill', color);
    nodes.glow.setAttribute('fill', color);
    nodes.glow.setAttribute('opacity', String(Math.min(0.6, 0.2 + (peak / 255) * 0.6)));
  },
};
