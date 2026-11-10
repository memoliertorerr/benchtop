/**
 * Our own drawings of the passive parts @wokwi/elements has none of (BT167), in mm, legs ending on
 * the definitions' own pin positions so wires meet them:
 * - `capacitor`: an orange ceramic disc on two legs, its EIA value code printed on it (104 = 100 nF);
 * - `capacitor-electrolytic`: a blue can with its minus stripe on the `-` side and the value up
 *   its side; a red glow while the `reversed` visual says it is in backwards;
 * - `diode`: an axial body between its leads, the band at the cathode (C): orange glass for a
 *   1N4148, black epoxy with a grey band for a 1N4007;
 * - BT169: `npn-transistor` / `pnp-transistor` as a black TO-92 (its model printed on the flat face,
 *   the legs labelled E B C) and `n-mosfet` / `p-mosfet` as a TO-220 (a metal tab with its hole,
 *   legs G D S);
 * - BT187: `ds18b20` as the same TO-92, "DS18B20" on its face, legs GND DQ VDD.
 */

import type { PartDefinition, PartProps, VisualState } from '@benchtop/core';
import type { ViewFactory } from './registry.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';
const LEAD = '#a9acb1';

function el<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

/** The part types these views draw. */
export const PASSIVE_VIEW_TYPES: ReadonlySet<string> = new Set(['capacitor', 'capacitor-electrolytic', 'diode', 'npn-transistor', 'pnp-transistor', 'n-mosfet', 'p-mosfet', 'ds18b20']);
const TO92_TYPES: ReadonlySet<string> = new Set(['npn-transistor', 'pnp-transistor', 'ds18b20']);
const TO220_TYPES: ReadonlySet<string> = new Set(['n-mosfet', 'p-mosfet']);

/** 1e-7 → "104": two digits and the number of zeros, in pF (below 10 pF: "4p7"). */
export function eiaCode(farads: number): string {
  const pf = farads * 1e12;
  if (!(pf > 0) || !Number.isFinite(pf)) return '?';
  if (pf < 10) return Number(pf.toPrecision(2)).toString().replace('.', 'p');
  const zeros = Math.floor(Math.log10(pf)) - 1;
  const digits = Math.round(pf / 10 ** zeros);
  return digits >= 100 ? `${Math.round(digits / 10)}${zeros + 1}` : `${digits}${zeros}`;
}

/** 1e-5 → "10µF", 4.7e-4 → "470µF", 2.2e-3 → "2200µF" (as printed on a can). */
export function canLabel(farads: number): string {
  const uf = farads * 1e6;
  if (!(uf > 0) || !Number.isFinite(uf)) return '?';
  return `${Number(uf.toPrecision(3))}µF`;
}

interface Parts {
  label?: SVGTextElement;
  glow?: SVGRectElement;
  body?: SVGRectElement;
  band?: SVGRectElement;
}
const nodes = new WeakMap<HTMLElement, Parts>();

function leg(x1: number, y1: number, x2: number, y2: number): SVGLineElement {
  return el('line', { x1, y1, x2, y2, stroke: LEAD, 'stroke-width': 0.45, 'stroke-linecap': 'round' });
}

function drawCeramic(svg: SVGSVGElement, def: PartDefinition, parts: Parts): void {
  const { w } = def.size;
  const [p1, p2] = def.pins;
  const cx = w / 2;
  const cy = 2.6;
  const r = 2.35;
  svg.append(leg(p1.x, p1.y, p1.x, cy + r * 0.6));
  svg.append(leg(p2.x, p2.y, p2.x, cy + r * 0.6));
  svg.append(el('circle', { cx, cy, r, fill: '#d9822b', stroke: '#a55c17', 'stroke-width': 0.25 }));
  svg.append(el('ellipse', { cx: cx - r * 0.35, cy: cy - r * 0.4, rx: r * 0.45, ry: r * 0.25, fill: '#f2b56b', opacity: 0.6 }));
  const label = el('text', { x: cx, y: cy + 0.1, 'font-size': 1.5, fill: '#3b2205', 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-family': 'sans-serif', 'font-weight': 'bold' });
  svg.append(label);
  parts.label = label;
}

function drawElectrolytic(svg: SVGSVGElement, def: PartDefinition, parts: Parts): void {
  const { w } = def.size;
  const plus = def.pins.find((p) => p.name === '+') ?? def.pins[0];
  const minus = def.pins.find((p) => p.name === '-') ?? def.pins[1];
  const top = 0.4;
  const bottom = 8.3;
  const x0 = 0.35;
  const x1 = w - 0.35;
  svg.append(leg(plus.x, plus.y, plus.x, bottom - 0.2));
  svg.append(leg(minus.x, minus.y, minus.x, bottom - 0.2));
  const glow = el('rect', { x: x0 - 0.35, y: top - 0.35, width: x1 - x0 + 0.7, height: bottom - top + 0.7, rx: 1.4, fill: 'none', stroke: '#ff3b30', 'stroke-width': 0.6, opacity: 0 });
  svg.append(glow);
  svg.append(el('rect', { x: x0, y: top, width: x1 - x0, height: bottom - top, rx: 1.1, fill: '#1f4fa3', stroke: '#14336b', 'stroke-width': 0.25 }));
  // The minus stripe on the `-` lead's side, with its dashes.
  const stripeX = minus.x > plus.x ? x1 - 1.6 : x0 + 0.2;
  svg.append(el('rect', { x: stripeX, y: top + 0.8, width: 1.4, height: bottom - top - 1.4, fill: '#9fb4d9' }));
  for (let y = top + 1.6; y < bottom - 1.2; y += 1.6) svg.append(el('line', { x1: stripeX + 0.35, y1: y, x2: stripeX + 1.05, y2: y, stroke: '#1f4fa3', 'stroke-width': 0.35 }));
  svg.append(el('rect', { x: x0, y: top, width: x1 - x0, height: 0.9, rx: 0.45, fill: '#c7ccd3', stroke: '#8d939b', 'stroke-width': 0.15 }));
  svg.append(el('rect', { x: x0 + 0.5, y: top + 1.1, width: 0.5, height: bottom - top - 1.8, fill: '#ffffff', opacity: 0.18 }));
  const midX = minus.x > plus.x ? (x0 + stripeX) / 2 + 0.2 : (stripeX + 1.4 + x1) / 2;
  const label = el('text', { x: midX, y: (top + bottom) / 2, 'font-size': 1.15, fill: '#e8eef8', 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-family': 'sans-serif', transform: `rotate(-90 ${midX} ${(top + bottom) / 2})` });
  svg.append(label);
  parts.label = label;
  parts.glow = glow;
}

function drawDiode(svg: SVGSVGElement, def: PartDefinition, parts: Parts): void {
  const { w } = def.size;
  const a = def.pins.find((p) => p.name === 'A') ?? def.pins[0];
  const c = def.pins.find((p) => p.name === 'C') ?? def.pins[1];
  const y = a.y;
  const bodyW = 3.9;
  const x0 = (w - bodyW) / 2;
  svg.append(leg(a.x, y, c.x, y));
  const body = el('rect', { x: x0, y: y - 0.95, width: bodyW, height: 1.9, rx: 0.8, stroke: '#0000004d', 'stroke-width': 0.15 });
  svg.append(body);
  const bandX = c.x > a.x ? x0 + bodyW - 1.0 : x0 + 0.45;
  const band = el('rect', { x: bandX, y: y - 0.95, width: 0.55, height: 1.9 });
  svg.append(band);
  parts.body = body;
  parts.band = band;
}

/** Small grey letters naming each leg, just below the body. */
function legLabels(svg: SVGSVGElement, def: PartDefinition, y: number): void {
  for (const pin of def.pins) {
    const t = el('text', { x: pin.x, y, 'font-size': 0.95, fill: '#7b8088', 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-family': 'sans-serif' });
    t.textContent = pin.name;
    svg.append(t);
  }
}

function drawTo92(svg: SVGSVGElement, def: PartDefinition, parts: Parts): void {
  const { w } = def.size;
  const bottom = 6.3;
  for (const pin of def.pins) svg.append(leg(pin.x, pin.y, pin.x, bottom - 0.2));
  svg.append(el('path', { d: `M 0.75 ${bottom} L 0.75 2.6 A ${w / 2 - 0.75} 2.3 0 0 1 ${w - 0.75} 2.6 L ${w - 0.75} ${bottom} Z`, fill: '#232427', stroke: '#0f1012', 'stroke-width': 0.2 }));
  svg.append(el('rect', { x: 1.2, y: 1.6, width: 0.45, height: bottom - 2.2, fill: '#ffffff', opacity: 0.12 }));
  const label = el('text', { x: w / 2, y: 4.4, 'font-size': 0.95, fill: '#d9dce1', 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-family': 'sans-serif' });
  svg.append(label);
  parts.label = label;
  legLabels(svg, def, bottom + 1.1);
}

function drawTo220(svg: SVGSVGElement, def: PartDefinition, parts: Parts): void {
  const { w } = def.size;
  const tabBottom = 6.6;
  const bottom = 15.0;
  for (const pin of def.pins) svg.append(el('line', { x1: pin.x, y1: pin.y, x2: pin.x, y2: bottom - 0.2, stroke: LEAD, 'stroke-width': 0.75, 'stroke-linecap': 'round' }));
  svg.append(el('rect', { x: 0.55, y: 0.3, width: w - 1.1, height: tabBottom, rx: 0.4, fill: '#c3c7cd', stroke: '#8d939b', 'stroke-width': 0.2 }));
  svg.append(el('circle', { cx: w / 2, cy: 3.0, r: 1.6, fill: '#5e636b', stroke: '#8d939b', 'stroke-width': 0.2 }));
  svg.append(el('rect', { x: 0.55, y: tabBottom - 0.6, width: w - 1.1, height: bottom - tabBottom + 0.6, rx: 0.4, fill: '#1e1f22', stroke: '#0f1012', 'stroke-width': 0.2 }));
  const label = el('text', { x: w / 2, y: (tabBottom + bottom) / 2, 'font-size': 1.15, fill: '#d9dce1', 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-family': 'sans-serif' });
  svg.append(label);
  parts.label = label;
  legLabels(svg, def, bottom + 1.2);
}

function applyProps(el: HTMLElement, props: PartProps): void {
  const parts = nodes.get(el);
  if (parts === undefined) return;
  const type = el.dataset.type;
  if (type === 'capacitor' && parts.label !== undefined) parts.label.textContent = eiaCode(Number(props.farads));
  if (type === 'capacitor-electrolytic' && parts.label !== undefined) parts.label.textContent = canLabel(Number(props.farads));
  if ((TO92_TYPES.has(type ?? '') || TO220_TYPES.has(type ?? '')) && parts.label !== undefined) parts.label.textContent = type === 'ds18b20' ? 'DS18B20' : String(props.model);
  if (type === 'diode' && parts.body !== undefined && parts.band !== undefined) {
    const glass = props.model !== '1N4007';
    parts.body.setAttribute('fill', glass ? '#e8a25a' : '#26272b');
    parts.body.setAttribute('fill-opacity', glass ? '0.85' : '1');
    parts.band.setAttribute('fill', glass ? '#1d1d1f' : '#b9bec6');
  }
}

export const passiveView: ViewFactory = {
  async create(def: PartDefinition, props: PartProps) {
    const { w, h } = def.size;
    const wrapper = document.createElement('div');
    wrapper.className = 'passive-view';
    wrapper.dataset.type = def.type;
    const svg = el('svg', { width: `${w}mm`, height: `${h}mm`, viewBox: `0 0 ${w} ${h}`, overflow: 'visible' });
    const parts: Parts = {};
    if (def.type === 'capacitor') drawCeramic(svg, def, parts);
    else if (def.type === 'capacitor-electrolytic') drawElectrolytic(svg, def, parts);
    else if (TO92_TYPES.has(def.type)) drawTo92(svg, def, parts);
    else if (TO220_TYPES.has(def.type)) drawTo220(svg, def, parts);
    else drawDiode(svg, def, parts);
    for (const pin of def.pins) svg.append(el('circle', { cx: pin.x, cy: pin.y, r: 0.35, fill: '#c9ccd1', stroke: '#8a8d92', 'stroke-width': 0.15 }));
    wrapper.append(svg);
    nodes.set(wrapper, parts);
    applyProps(wrapper, { ...def.defaults, ...props });
    return wrapper;
  },
  setProps(el: HTMLElement, props: PartProps) {
    applyProps(el, props);
  },
  update(el: HTMLElement, visual: VisualState) {
    const glow = nodes.get(el)?.glow;
    if (glow !== undefined) glow.setAttribute('opacity', visual.reversed === true ? '0.9' : '0');
  },
};
