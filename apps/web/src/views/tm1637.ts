/**
 * BT186: our own drawing of the TM1637 4-digit module (packages/parts displays/tm1637.ts), in mm:
 * a blue board, its header down the left end (CLK, DIO, VCC, GND) on the definition's pins, and a
 * black 0.36″ 4-digit block with the clock colon between digits 2 and 3. Lit segments and the colon
 * follow the visual's `segments`, `colon` and `level` (opacity 0.4 + 0.6 × √level, as the MAX7219's).
 */

import type { PartDefinition, PartProps, VisualState } from '@benchtop/core';
import { dotOpacity, segmentShapes } from './max7219.ts';
import type { ViewFactory } from './registry.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';
const LIT = '#ff3b2f';
const DARK = '#2a1414';

function el<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

export const TM1637_VIEW_TYPES: ReadonlySet<string> = new Set(['tm1637-4digit']);

interface Nodes {
  /** 7 per digit (A–G), left to right. */
  segments: SVGElement[];
  colon: SVGElement[];
}
const nodes = new WeakMap<HTMLElement, Nodes>();

export const tm1637View: ViewFactory = {
  async create(def: PartDefinition, _props: PartProps) {
    const { w, h } = def.size;
    const wrapper = document.createElement('div');
    wrapper.className = 'tm1637-view';
    const svg = el('svg', { width: `${w}mm`, height: `${h}mm`, viewBox: `0 0 ${w} ${h}`, overflow: 'visible' });
    svg.append(el('rect', { x: 0, y: 0, width: w, height: h, rx: 0.8, fill: '#1d4f91', stroke: '#123461', 'stroke-width': 0.2 }));
    for (const pin of def.pins) {
      svg.append(el('rect', { x: pin.x - 0.75, y: pin.y - 0.75, width: 1.5, height: 1.5, fill: '#111', stroke: '#d7b35a', 'stroke-width': 0.25 }));
      const label = el('text', { x: pin.x + 1.3, y: pin.y, 'font-size': 0.75, fill: '#e8eef8', 'dominant-baseline': 'central', 'font-family': 'sans-serif' });
      label.textContent = pin.name;
      svg.append(label);
    }
    for (const [cx, cy] of [
      [w - 2.2, 2.2],
      [w - 2.2, h - 2.2],
    ]) svg.append(el('circle', { cx, cy, r: 1.1, fill: '#f4f4f4', stroke: '#c9c9c9', 'stroke-width': 0.2 }));
    const x0 = 6.5;
    const blockW = w - x0 - 4.2;
    const blockH = h - 6;
    const y0 = 3;
    svg.append(el('rect', { x: x0, y: y0, width: blockW, height: blockH, rx: 0.4, fill: '#161618' }));
    const digitW = (blockW - 2) / 4;
    const scale = Math.min((digitW - 1.6) / 6.6, (blockH - 2.4) / 10);
    const segments: SVGElement[] = [];
    for (let d = 0; d < 4; d++) {
      const gx = x0 + 1 + d * digitW + (d >= 2 ? 0.6 : 0) + (digitW - 0.6 - 6.6 * scale) / 2;
      const gy = y0 + (blockH - 10 * scale) / 2;
      const group = el('g', { transform: `translate(${gx} ${gy}) scale(${scale})` });
      for (const shape of segmentShapes(0, 0)) {
        group.append(el('path', { d: shape.d, fill: DARK }));
        const lit = el('path', { d: shape.d, fill: LIT, opacity: 0 });
        group.append(lit);
        segments.push(lit);
      }
      svg.append(group);
    }
    const cx = x0 + 1 + 2 * digitW + 0.3;
    const colon: SVGElement[] = [];
    for (const cy of [y0 + blockH * 0.36, y0 + blockH * 0.64]) {
      svg.append(el('circle', { cx, cy, r: 0.55, fill: DARK }));
      const dot = el('circle', { cx, cy, r: 0.55, fill: LIT, opacity: 0 });
      svg.append(dot);
      colon.push(dot);
    }
    wrapper.append(svg);
    nodes.set(wrapper, { segments, colon });
    return wrapper;
  },
  setProps(_el: HTMLElement, _props: PartProps) {},
  update(element: HTMLElement, visual: VisualState) {
    const parts = nodes.get(element);
    if (parts === undefined) return;
    const level = typeof visual.level === 'number' ? visual.level : 0;
    const bits = Array.isArray(visual.segments) ? (visual.segments as number[]) : [];
    const opacity = String(dotOpacity(level));
    for (let d = 0; d < 4; d++) for (let s = 0; s < 7; s++) parts.segments[d * 7 + s].setAttribute('opacity', ((bits[d] ?? 0) >> s) & 1 ? opacity : '0');
    const colon = typeof visual.colon === 'number' && visual.colon > 0 ? opacity : '0';
    for (const dot of parts.colon) dot.setAttribute('opacity', colon);
  },
};
