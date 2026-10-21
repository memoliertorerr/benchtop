/**
 * Our own drawing of a 28BYJ-48 motor on a ULN2003 driver board (the element library has
 * none), in mm so it stays crisp at every zoom: the Ø28 mm motor with its shaft pointer above,
 * the ~36×32 mm green board below with its four phase LEDs (A–D, lit while their coil is
 * energized) and the IN1–IN4 / + / − header at the part's pin positions.
 */

import type { PartDefinition, VisualState } from '@benchtop/core';
import type { ViewFactory } from './registry.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';

function el<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

function text(x: number, y: number, label: string, size: number, fill: string): SVGTextElement {
  const node = el('text', { x, y, 'font-size': size, fill, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-family': 'sans-serif' });
  node.textContent = label;
  return node;
}

const parts = new WeakMap<HTMLElement, { shaft: SVGGElement; leds: SVGCircleElement[] }>();

function draw(def: PartDefinition): { svg: SVGSVGElement; shaft: SVGGElement; leds: SVGCircleElement[] } {
  const { w, h } = def.size;
  const svg = el('svg', { width: `${w}mm`, height: `${h}mm`, viewBox: `0 0 ${w} ${h}` });
  const cx = w / 2;
  const cy = 15;
  // Motor: mounting ears, the can, the gearbox cap and the shaft with a pointer.
  svg.append(el('rect', { x: cx - 17.5, y: cy - 2.2, width: 35, height: 4.4, rx: 2.2, fill: '#c9ccd1', stroke: '#9aa0a8', 'stroke-width': 0.25 }));
  svg.append(el('circle', { cx: cx - 15.5, cy, r: 1.1, fill: '#4b5058' }), el('circle', { cx: cx + 15.5, cy, r: 1.1, fill: '#4b5058' }));
  svg.append(el('circle', { cx, cy, r: 14, fill: '#d7dade', stroke: '#9aa0a8', 'stroke-width': 0.35 }));
  svg.append(el('circle', { cx, cy, r: 12.3, fill: 'none', stroke: '#b9bec6', 'stroke-width': 0.3 }));
  svg.append(el('circle', { cx, cy: cy - 6, r: 4.6, fill: '#c3c7cd', stroke: '#9aa0a8', 'stroke-width': 0.3 }));
  svg.append(el('rect', { x: cx - 3, y: cy + 11.2, width: 6, height: 4.2, rx: 0.6, fill: '#2f6fd8' }));
  const shaft = el('g', { transform: `rotate(0 ${cx} ${cy - 6})` });
  shaft.append(el('circle', { cx, cy: cy - 6, r: 2.5, fill: '#e8c34a', stroke: '#b8932a', 'stroke-width': 0.25 }));
  shaft.append(el('rect', { x: cx - 0.6, y: cy - 6 - 6.5, width: 1.2, height: 6.5, rx: 0.5, fill: '#d83c3c' }));
  svg.append(shaft);
  // Wires from the motor to the board's connector.
  ['#2f6fd8', '#e9842c', '#e5c12a', '#d83c3c', '#e3a1c4'].forEach((color, i) => {
    svg.append(el('path', { d: `M${cx - 3 + i * 1.5} ${cy + 15.2} V${33.5}`, stroke: color, 'stroke-width': 0.6 }));
  });
  // Driver board.
  svg.append(el('rect', { x: 0.3, y: 32, width: w - 0.6, height: h - 32.3, rx: 1.2, fill: '#1f7a46', stroke: '#145a33', 'stroke-width': 0.3 }));
  svg.append(el('rect', { x: cx - 5, y: 33.4, width: 10, height: 3.2, rx: 0.4, fill: '#f2f2f2', stroke: '#c8c8c8', 'stroke-width': 0.2 }));
  svg.append(el('rect', { x: 4, y: 40, width: 12, height: 6, rx: 0.4, fill: '#222', stroke: '#111', 'stroke-width': 0.2 }));
  svg.append(text(10, 43, 'ULN2003', 1.6, '#ddd'));
  const leds: SVGCircleElement[] = [];
  ['A', 'B', 'C', 'D'].forEach((label, i) => {
    const x = 21 + i * 3.4;
    const led = el('circle', { cx: x, cy: 42, r: 1.1, fill: '#5a1f1f', stroke: '#2b0f0f', 'stroke-width': 0.2 });
    leds.push(led);
    svg.append(led, text(x, 45.2, label, 1.5, '#e6efe9'));
  });
  // Header: one gold pad per pin, labelled.
  for (const pin of def.pins) {
    svg.append(el('rect', { x: pin.x - 1.1, y: pin.y - 1.1, width: 2.2, height: 2.2, rx: 0.3, fill: '#d9b44a', stroke: '#a8862b', 'stroke-width': 0.2 }));
    svg.append(text(pin.x, pin.y - 2.8, pin.name === 'VCC' ? '+' : pin.name === 'GND' ? '−' : pin.name, 1.4, '#e6efe9'));
  }
  return { svg, shaft, leds };
}

export const stepper28byj48View: ViewFactory = {
  async create(def) {
    const wrapper = document.createElement('div');
    wrapper.className = 'stepper-28byj48-view';
    const { svg, shaft, leds } = draw(def);
    wrapper.append(svg);
    parts.set(wrapper, { shaft, leds });
    return wrapper;
  },
  setProps() {},
  update(el, visual: VisualState) {
    const view = parts.get(el);
    if (view === undefined) return;
    const angle = typeof visual.angle === 'number' ? visual.angle : 0;
    const box = view.shaft.firstElementChild as SVGCircleElement;
    view.shaft.setAttribute('transform', `rotate(${angle} ${box.getAttribute('cx')} ${box.getAttribute('cy')})`);
    const coils = Array.isArray(visual.coils) ? (visual.coils as readonly number[]) : [];
    view.leds.forEach((led, i) => led.setAttribute('fill', coils[i] === 1 ? '#ff4040' : '#5a1f1f'));
  },
};
