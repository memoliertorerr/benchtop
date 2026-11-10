/**
 * BT193: our own drawing of the 1-channel relay module (packages/parts actuators/relay-module.ts), in
 * mm: a blue board, the blue SRD-05VDC-SL-C relay, the input header (VCC GND IN) on the left and the
 * screw terminal (NO COM NC) on the right on the definition's pins, the power LED (lit while powered)
 * and the input LED (lit while the driver is on), and the contacts drawn on NO or NC as the visual's
 * `closed` says.
 */

import type { PartDefinition, PartProps, VisualState } from '@benchtop/core';
import type { ViewFactory } from './registry.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';

function el<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

export const RELAY_MODULE_VIEW_TYPES: ReadonlySet<string> = new Set(['relay-module']);

interface Nodes {
  power: SVGElement;
  input: SVGElement;
  arm: SVGElement;
}
const nodes = new WeakMap<HTMLElement, Nodes>();

export const relayModuleView: ViewFactory = {
  async create(def: PartDefinition, _props: PartProps) {
    const { w, h } = def.size;
    const wrapper = document.createElement('div');
    wrapper.className = 'relay-module-view';
    const svg = el('svg', { width: `${w}mm`, height: `${h}mm`, viewBox: `0 0 ${w} ${h}`, overflow: 'visible' });
    svg.append(el('rect', { x: 0, y: 0, width: w, height: h, rx: 0.8, fill: '#1d4f91', stroke: '#123461', 'stroke-width': 0.2 }));
    svg.append(el('rect', { x: 15, y: 3, width: 19, height: 15.5, rx: 0.6, fill: '#2f6fd6', stroke: '#1b4a9a', 'stroke-width': 0.25 }));
    const name = el('text', { x: 24.5, y: 9, 'font-size': 1.3, fill: '#e8eef8', 'text-anchor': 'middle', 'font-family': 'sans-serif' });
    name.textContent = 'SRD-05VDC-SL-C';
    svg.append(name);
    svg.append(el('rect', { x: 41.5, y: 4.6, width: 8.6, height: 16.2, rx: 0.4, fill: '#2b8a3e', stroke: '#1c5e2a', 'stroke-width': 0.2 }));
    const power = el('circle', { cx: 8, cy: 5, r: 0.9, fill: '#3a1010' });
    const input = el('circle', { cx: 8, cy: 20.4, r: 0.9, fill: '#102a3a' });
    svg.append(power, input);
    // The contact arm from COM, to NO or NC.
    const com = def.pins.find((p) => p.name === 'COM') ?? def.pins[0];
    const arm = el('line', { x1: 37.5, y1: com.y, x2: 39.8, y2: com.y + 3.2, stroke: '#e8eef8', 'stroke-width': 0.45, 'stroke-linecap': 'round' });
    svg.append(el('line', { x1: 36, y1: com.y, x2: 37.5, y2: com.y, stroke: '#e8eef8', 'stroke-width': 0.45 }), arm);
    for (const pin of def.pins) {
      const right = pin.x > w / 2;
      svg.append(right ? el('circle', { cx: pin.x, cy: pin.y, r: 1.4, fill: '#b9bcc2', stroke: '#6c7077', 'stroke-width': 0.25 }) : el('rect', { x: pin.x - 0.75, y: pin.y - 0.75, width: 1.5, height: 1.5, fill: '#111', stroke: '#d7b35a', 'stroke-width': 0.25 }));
      const label = el('text', { x: right ? pin.x - 2.2 : pin.x + 1.3, y: pin.y, 'font-size': 0.8, fill: '#e8eef8', 'text-anchor': right ? 'end' : 'start', 'dominant-baseline': 'central', 'font-family': 'sans-serif' });
      label.textContent = pin.name;
      svg.append(label);
    }
    wrapper.append(svg);
    nodes.set(wrapper, { power, input, arm });
    return wrapper;
  },
  setProps(_el: HTMLElement, _props: PartProps) {},
  update(element: HTMLElement, visual: VisualState) {
    const parts = nodes.get(element);
    if (parts === undefined) return;
    parts.power.setAttribute('fill', visual.powered === true ? '#ff3b2f' : '#3a1010');
    parts.input.setAttribute('fill', visual.on === true ? '#4fb3ff' : '#102a3a');
    const com = 12.7;
    parts.arm.setAttribute('y2', String(visual.closed === true ? com - 3.2 : com + 3.2));
  },
};
