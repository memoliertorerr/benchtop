/**
 * Our own drawing of an A4988 carrier (BT53; the element library has none), in mm so it stays
 * crisp at every zoom: the 0.6″ × 0.8″ board, the driver chip with a heat sink outline, the
 * current-limit trimmer, and the two 8-pin headers at the part's pin positions, labelled as the
 * board's silkscreen is. A small dot on the chip lights while the outputs are on.
 */

import type { PartDefinition, VisualState } from '@benchtop/core';
import type { ViewFactory } from './registry.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';

function el<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

function text(x: number, y: number, label: string, size: number, anchor: 'start' | 'end' | 'middle'): SVGTextElement {
  const node = el('text', { x, y, 'font-size': size, fill: '#f2f5f2', 'text-anchor': anchor, 'dominant-baseline': 'central', 'font-family': 'sans-serif' });
  node.textContent = label;
  return node;
}

const indicators = new WeakMap<HTMLElement, SVGCircleElement>();

function draw(def: PartDefinition): { svg: SVGSVGElement; on: SVGCircleElement } {
  const { w, h } = def.size;
  const svg = el('svg', { width: `${w}mm`, height: `${h}mm`, viewBox: `0 0 ${w} ${h}` });
  svg.append(el('rect', { x: 0.15, y: 0.15, width: w - 0.3, height: h - 0.3, rx: 0.8, fill: '#1d6b3a', stroke: '#124726', 'stroke-width': 0.3 }));
  // The driver chip under its heat sink, and the trimmer.
  const cx = w / 2;
  svg.append(el('rect', { x: cx - 2.6, y: 6.4, width: 5.2, height: 5.2, rx: 0.3, fill: '#202326', stroke: '#0e0f10', 'stroke-width': 0.2 }));
  for (let i = 0; i < 4; i++) svg.append(el('rect', { x: cx - 2.2 + i * 1.25, y: 6.8, width: 0.7, height: 4.4, rx: 0.2, fill: '#3a3f44' }));
  const on = el('circle', { cx: cx + 1.9, cy: 11, r: 0.35, fill: '#2a3a2a' });
  svg.append(on, text(cx, 13.2, 'A4988', 1.2, 'middle'));
  svg.append(el('circle', { cx, cy: 3.6, r: 1.5, fill: '#d8d2c0', stroke: '#9f9886', 'stroke-width': 0.2 }));
  svg.append(el('path', { d: `M${cx - 0.9} ${3.6}h1.8M${cx} ${2.7}v1.8`, stroke: '#7a7466', 'stroke-width': 0.35 }));
  // Headers: gold pads and the silkscreen labels inside the board.
  for (const pin of def.pins) {
    svg.append(el('circle', { cx: pin.x, cy: pin.y, r: 0.95, fill: '#d9b44a', stroke: '#a8862b', 'stroke-width': 0.2 }));
    svg.append(el('circle', { cx: pin.x, cy: pin.y, r: 0.4, fill: '#5a4a1e' }));
    const left = pin.x < w / 2;
    const label = pin.name.startsWith('GND') ? 'GND' : pin.name === 'ENABLE' ? 'EN' : pin.name === 'RESET' ? 'RST' : pin.name === 'SLEEP' ? 'SLP' : pin.name;
    svg.append(text(left ? pin.x + 1.35 : pin.x - 1.35, pin.y, label, 0.95, left ? 'start' : 'end'));
  }
  return { svg, on };
}

export const a4988View: ViewFactory = {
  async create(def) {
    const wrapper = document.createElement('div');
    wrapper.className = 'a4988-view';
    const { svg, on } = draw(def);
    wrapper.append(svg);
    indicators.set(wrapper, on);
    return wrapper;
  },
  setProps() {},
  update(el, visual: VisualState) {
    indicators.get(el)?.setAttribute('fill', visual.on === true ? '#52f06a' : '#2a3a2a');
  },
};
