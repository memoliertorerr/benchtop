/**
 * Our own drawing of the Raspberry Pi Pico (BT61; the element library has none), in mm so it
 * stays crisp at every zoom, laid out after the board's photos and mechanical drawing: the green
 * 21 × 51 mm PCB with castellated pads at the part's pin positions (each labelled with its
 * pinout name, as the back silkscreen is), the micro-USB connector at the top, the green LED
 * (lit by GP25's brightness) and the BOOTSEL button beside it, the RP2040, the flash chip, the
 * crystal and the three SWD pads at the bottom.
 */

import type { PartDefinition, VisualState } from '@benchtop/core';
import type { ViewFactory } from './registry.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';
const PCB = '#1e6e3c';
const LED_OFF = '#3d5c45';

function el<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

function text(x: number, y: number, label: string, size: number, anchor: 'start' | 'end' | 'middle', fill = '#f2f5f2'): SVGTextElement {
  const node = el('text', { x, y, 'font-size': size, fill, 'text-anchor': anchor, 'dominant-baseline': 'central', 'font-family': 'sans-serif' });
  node.textContent = label;
  return node;
}

/** Blends the LED's off color with green by brightness 0..1. */
function ledColor(brightness: number): string {
  const b = Math.max(0, Math.min(1, brightness));
  const mix = (off: number, on: number): number => Math.round(off + (on - off) * b);
  return `rgb(${mix(0x3d, 0x6c)}, ${mix(0x5c, 0xff)}, ${mix(0x45, 0x6a)})`;
}

const leds = new WeakMap<HTMLElement, { led: SVGRectElement; glow: SVGCircleElement }>();

function draw(def: PartDefinition): { svg: SVGSVGElement; led: SVGRectElement; glow: SVGCircleElement } {
  const { w, h } = def.size;
  const svg = el('svg', { width: `${w}mm`, height: `${h}mm`, viewBox: `0 0 ${w} ${h}` });
  svg.append(el('rect', { x: 0.1, y: 0.1, width: w - 0.2, height: h - 0.2, rx: 0.9, fill: PCB, stroke: '#14502b', 'stroke-width': 0.2 }));
  // Micro-USB connector at the top edge.
  svg.append(el('rect', { x: w / 2 - 4, y: 0, width: 8, height: 5.2, rx: 0.5, fill: '#c9ccd1', stroke: '#8e9399', 'stroke-width': 0.2 }));
  svg.append(el('rect', { x: w / 2 - 3, y: 0.2, width: 6, height: 1.6, rx: 0.3, fill: '#5a5e63' }));
  // The LED (with a glow when lit), its label, and BOOTSEL.
  const glow = el('circle', { cx: 5.1, cy: 5.6, r: 1.8, fill: '#6cff6a', opacity: 0 });
  const led = el('rect', { x: 4.45, y: 5.05, width: 1.3, height: 1.1, rx: 0.15, fill: LED_OFF });
  svg.append(glow, led, text(5.1, 7.3, 'LED', 0.85, 'middle'));
  svg.append(el('rect', { x: 13.7, y: 5.2, width: 3.6, height: 3.2, rx: 0.4, fill: '#d6d7d9', stroke: '#9a9ca0', 'stroke-width': 0.15 }));
  svg.append(el('circle', { cx: 15.5, cy: 6.8, r: 1.05, fill: '#f6f6f4', stroke: '#b8b9bb', 'stroke-width': 0.12 }));
  svg.append(text(15.5, 9.3, 'BOOTSEL', 0.8, 'middle'));
  // Flash (SOIC-8) and the 12 MHz crystal.
  svg.append(el('rect', { x: 4.2, y: 12, width: 5, height: 4.2, rx: 0.2, fill: '#1c1d1f' }));
  for (let i = 0; i < 4; i++) {
    svg.append(el('rect', { x: 4.5 + i * 1.25, y: 11.4, width: 0.45, height: 0.6, fill: '#b8b9bb' }));
    svg.append(el('rect', { x: 4.5 + i * 1.25, y: 16.2, width: 0.45, height: 0.6, fill: '#b8b9bb' }));
  }
  svg.append(el('rect', { x: 12.6, y: 12.6, width: 3.2, height: 2.5, rx: 0.3, fill: '#c3c5c8', stroke: '#8e9399', 'stroke-width': 0.15 }));
  // The RP2040 (7 × 7 mm QFN).
  svg.append(el('rect', { x: w / 2 - 3.5, y: 22, width: 7, height: 7, rx: 0.3, fill: '#202124', stroke: '#0e0f10', 'stroke-width': 0.15 }));
  svg.append(text(w / 2, 24.8, 'RP2040', 1.1, 'middle', '#c9cbcf'));
  svg.append(text(w / 2, 26.6, 'RP2-B2', 0.8, 'middle', '#8e9095'));
  svg.append(el('circle', { cx: w / 2 - 2.7, cy: 22.8, r: 0.25, fill: '#55575c' }));
  // Board name and the SWD pads at the bottom edge.
  svg.append(text(w / 2, 35.5, 'Raspberry Pi Pico', 1.0, 'middle'));
  svg.append(text(w / 2, 37.1, '© 2020', 0.75, 'middle'));
  for (const [i, label] of ['SWCLK', 'GND', 'SWDIO'].entries()) {
    const x = w / 2 - 2.54 + i * 2.54;
    svg.append(el('circle', { cx: x, cy: h - 1.6, r: 0.75, fill: '#d9b44a', stroke: '#a8862b', 'stroke-width': 0.15 }));
    svg.append(text(x, h - 3.1, label, 0.55, 'middle'));
  }
  // Castellated pads (half-holes on the edge) and their labels.
  for (const pin of def.pins) {
    if (pin.name === 'TP5') {
      svg.append(el('circle', { cx: pin.x, cy: pin.y, r: 0.45, fill: '#d9b44a', stroke: '#a8862b', 'stroke-width': 0.1 }));
      continue;
    }
    const left = pin.x < w / 2;
    const edge = left ? 0 : w;
    svg.append(el('rect', { x: left ? edge : edge - 2.4, y: pin.y - 0.85, width: 2.4, height: 1.7, rx: 0.3, fill: '#d9b44a', stroke: '#a8862b', 'stroke-width': 0.12 }));
    svg.append(el('circle', { cx: pin.x, cy: pin.y, r: 0.5, fill: '#4d3f17' }));
    const label = pin.name.startsWith('GND') ? 'GND' : pin.name;
    svg.append(text(left ? pin.x + 1.35 : pin.x - 1.35, pin.y, label, 0.78, left ? 'start' : 'end'));
  }
  return { svg, led, glow };
}

export const raspberryPiPicoView: ViewFactory = {
  async create(def) {
    const wrapper = document.createElement('div');
    wrapper.className = 'pico-view';
    const { svg, led, glow } = draw(def);
    wrapper.append(svg);
    leds.set(wrapper, { led, glow });
    return wrapper;
  },
  setProps() {},
  update(el, visual: VisualState) {
    const parts = leds.get(el);
    if (parts === undefined) return;
    const brightness = typeof visual.led === 'number' ? visual.led : 0;
    parts.led.setAttribute('fill', brightness > 0 ? ledColor(brightness) : LED_OFF);
    parts.glow.setAttribute('opacity', String(Math.min(0.55, brightness * 0.55)));
  },
};
