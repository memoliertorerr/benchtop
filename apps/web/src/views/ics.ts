/**
 * BT184: our own drawing of DIP chips (@wokwi/elements has none): a black epoxy body between the
 * two rows of legs, the notch and pin 1's dot on the left, the chip's name across the middle and
 * each pin's name beside its leg, so a wire can be placed without the datasheet. The legs end on
 * the definition's pin positions. Drawn from the definition alone: a chip has no visual state to
 * show (its outputs light whatever they drive).
 */

import type { PartDefinition, PartProps, VisualState } from '@benchtop/core';
import type { ViewFactory } from './registry.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';

function el<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

/** The DIP part types, with the name printed on each. */
export const IC_VIEW_TYPES: ReadonlyMap<string, string> = new Map([['74hc595', '74HC595']]);

/** A pin name as printed: an active-low input (MR, OE) gets its bar. */
const ACTIVE_LOW: Readonly<Record<string, ReadonlySet<string>>> = { '74hc595': new Set(['MR', 'OE']) };

function drawDip(svg: SVGSVGElement, def: PartDefinition): void {
  const { w } = def.size;
  const top = Math.min(...def.pins.map((p) => p.y));
  const bottom = Math.max(...def.pins.map((p) => p.y));
  const bodyTop = top + 0.75;
  const bodyBottom = bottom - 0.75;
  for (const pin of def.pins) {
    const toward = pin.y === top ? bodyTop : bodyBottom;
    const y = Math.min(pin.y, toward);
    svg.append(el('rect', { x: pin.x - 0.5, y, width: 1, height: Math.abs(toward - pin.y) + 0.2, fill: '#b9bcc2', stroke: '#8a8d92', 'stroke-width': 0.1 }));
  }
  svg.append(el('rect', { x: 0.15, y: bodyTop, width: w - 0.3, height: bodyBottom - bodyTop, rx: 0.4, fill: '#222326', stroke: '#0f1012', 'stroke-width': 0.2 }));
  const mid = (bodyTop + bodyBottom) / 2;
  svg.append(el('path', { d: `M 0.15 ${mid - 0.9} A 0.9 0.9 0 0 1 0.15 ${mid + 0.9} Z`, fill: '#0c0c0e' }));
  svg.append(el('circle', { cx: def.pins[0].x, cy: bodyBottom - 0.75, r: 0.32, fill: '#3a3b3f' }));
  const name = el('text', { x: w / 2, y: mid, 'font-size': 1.35, fill: '#d9dce1', 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-family': 'sans-serif', 'letter-spacing': 0.05 });
  name.textContent = IC_VIEW_TYPES.get(def.type) ?? def.title;
  svg.append(name);
  const low = ACTIVE_LOW[def.type];
  for (const pin of def.pins) {
    const atTop = pin.y === top;
    const label = el('text', { x: pin.x, y: atTop ? bodyTop + 0.75 : bodyBottom - 0.75, 'font-size': 0.62, fill: '#9ea3ab', 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-family': 'sans-serif' });
    label.textContent = pin.name;
    if (low?.has(pin.name) === true) label.setAttribute('text-decoration', 'overline');
    svg.append(label);
  }
}

export const icView: ViewFactory = {
  async create(def: PartDefinition, _props: PartProps) {
    const { w, h } = def.size;
    const wrapper = document.createElement('div');
    wrapper.className = 'ic-view';
    wrapper.dataset.type = def.type;
    const svg = el('svg', { width: `${w}mm`, height: `${h}mm`, viewBox: `0 0 ${w} ${h}`, overflow: 'visible' });
    drawDip(svg, def);
    wrapper.append(svg);
    return wrapper;
  },
  setProps(_el: HTMLElement, _props: PartProps) {},
  update(_el: HTMLElement, _visual: VisualState) {},
};
