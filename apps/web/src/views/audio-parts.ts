/**
 * Our own drawings of the BT41 audio parts (the element library has neither), in mm so they
 * stay crisp at every zoom:
 * - Speaker: a round speaker in a square frame, its cone rippling while it plays, the + / −
 *   leads at the part's pins.
 * - Microphone: a MAX4466-style blue board with the electret capsule, the gain trimmer, a level
 *   bar (the model's RMS level), a dot lit while it listens, and the OUT / GND / VCC header.
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

function frame(def: PartDefinition, className: string): { wrapper: HTMLDivElement; svg: SVGSVGElement } {
  const { w, h } = def.size;
  const wrapper = document.createElement('div');
  wrapper.className = className;
  const svg = el('svg', { width: `${w}mm`, height: `${h}mm`, viewBox: `0 0 ${w} ${h}` });
  wrapper.append(svg);
  return { wrapper, svg };
}

const speakers = new WeakMap<HTMLElement, SVGGElement>();

export const speakerView: ViewFactory = {
  async create(def) {
    const { wrapper, svg } = frame(def, 'speaker-view');
    const { w } = def.size;
    const cx = w / 2;
    const cy = 9.6;
    svg.append(el('rect', { x: 0.6, y: 0.6, width: w - 1.2, height: 18.4, rx: 1.6, fill: '#26292e', stroke: '#141518', 'stroke-width': 0.3 }));
    for (const [x, y] of [
      [2.4, 2.4],
      [w - 2.4, 2.4],
      [2.4, 17.2],
      [w - 2.4, 17.2],
    ]) {
      svg.append(el('circle', { cx: x, cy: y, r: 0.7, fill: '#8d939b' }));
    }
    svg.append(el('circle', { cx, cy, r: 8.3, fill: '#34383e', stroke: '#4a4f57', 'stroke-width': 0.4 }));
    const cone = el('g', { class: 'speaker-cone' });
    cone.append(el('circle', { cx, cy, r: 6.6, fill: '#1c1e22' }));
    cone.append(el('circle', { cx, cy, r: 5, fill: 'none', stroke: '#2d3036', 'stroke-width': 0.35 }));
    cone.append(el('circle', { cx, cy, r: 3.3, fill: 'none', stroke: '#2d3036', 'stroke-width': 0.35 }));
    cone.append(el('circle', { cx, cy, r: 2, fill: '#3a3e45', stroke: '#50555d', 'stroke-width': 0.3 }));
    svg.append(cone);
    // Leads down to the pins, with + / − marks.
    for (const pin of def.pins) {
      svg.append(el('rect', { x: pin.x - 0.35, y: 18.8, width: 0.7, height: pin.y - 18.8 + 0.5, fill: '#b8bcc2' }));
      svg.append(text(pin.x + (pin.name === '1' ? -1.6 : 1.6), 20.6, pin.name === '1' ? '+' : '−', 1.8, '#d8dbe0'));
    }
    speakers.set(wrapper, cone);
    return wrapper;
  },
  setProps() {},
  update(el, visual: VisualState) {
    speakers.get(el)?.classList.toggle('playing', visual.playing === true);
  },
};

const mics = new WeakMap<HTMLElement, { bar: SVGRectElement; dot: SVGCircleElement; width: number }>();

export const microphoneView: ViewFactory = {
  async create(def) {
    const { wrapper, svg } = frame(def, 'microphone-view');
    const { w } = def.size;
    svg.append(el('rect', { x: 0.3, y: 0.3, width: w - 0.6, height: 17.2, rx: 1, fill: '#1d5fb8', stroke: '#13427f', 'stroke-width': 0.3 }));
    // Electret capsule.
    svg.append(el('circle', { cx: w / 2, cy: 5.4, r: 4.2, fill: '#c9ccd1', stroke: '#8d939b', 'stroke-width': 0.3 }));
    svg.append(el('circle', { cx: w / 2, cy: 5.4, r: 3.2, fill: '#2a2c30' }));
    for (let i = -2; i <= 2; i++) svg.append(el('rect', { x: w / 2 - 2.4, y: 5.4 + i * 0.9 - 0.15, width: 4.8, height: 0.3, fill: '#4a4d53' }));
    // Gain trimmer.
    svg.append(el('rect', { x: 1.2, y: 9.8, width: 3, height: 3, rx: 0.3, fill: '#2f6fd8', stroke: '#0f3c7e', 'stroke-width': 0.2 }));
    svg.append(el('circle', { cx: 2.7, cy: 11.3, r: 0.9, fill: '#e5e7ea' }));
    // Level bar and the listening dot.
    const left = 5.2;
    const width = w - left - 1.4;
    svg.append(el('rect', { x: left, y: 10.6, width, height: 1.4, rx: 0.4, fill: '#0f3c7e' }));
    const bar = el('rect', { x: left, y: 10.6, width: 0, height: 1.4, rx: 0.4, fill: '#7ef0a8' });
    svg.append(bar);
    const dot = el('circle', { cx: w - 1.6, cy: 1.7, r: 0.7, fill: '#3a1414', stroke: '#0f3c7e', 'stroke-width': 0.15 });
    svg.append(dot);
    svg.append(text(w / 2, 13.6, 'MAX4466', 1.3, '#cfe0f7'));
    for (const pin of def.pins) {
      svg.append(el('circle', { cx: pin.x, cy: pin.y, r: 0.85, fill: '#d9b44a', stroke: '#a8862b', 'stroke-width': 0.2 }));
      svg.append(text(pin.x, 15.6, pin.name, 1.05, '#e6efe9'));
    }
    mics.set(wrapper, { bar, dot, width });
    return wrapper;
  },
  setProps() {},
  update(el, visual: VisualState) {
    const view = mics.get(el);
    if (view === undefined) return;
    const level = typeof visual.level === 'number' ? Math.min(1, Math.max(0, visual.level)) : 0;
    view.bar.setAttribute('width', String(view.width * level));
    view.dot.setAttribute('fill', visual.listening === true ? '#ff4d4d' : '#3a1414');
  },
};
