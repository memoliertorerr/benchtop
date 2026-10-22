/**
 * Our own drawings of the power parts (BT83; the element library has none), in mm so they stay
 * crisp at every zoom. Every terminal, lead end and leg is drawn at the definition's own pin
 * coordinates, so wires meet them by construction:
 * - 9 V block: the large face, the snap terminals (round +, hexagonal −) at the top.
 * - 2 × AA / 4 × AA holders: black holders with alternating cells, red and black leads up top.
 * - LiPo: a silver pouch, its red and black leads into a white connector.
 * - CR2032: the coin in its holder, two legs below.
 * - Bench supply: a case with a seven-segment-style display of its volts (live while running),
 *   the knob, and red / black binding posts.
 * - Ground: the earth symbol on a short lead.
 * - Regulators (BT84): an LM7805 in TO-220 (tab, hole, legs), the blue AMS1117-3.3 breakout
 *   (its power LED lit while OUT is on) and an MCP1700 in TO-92.
 */

import type { PartDefinition, PartProps, VisualState } from '@benchtop/core';
import type { ViewFactory } from './registry.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';

function el<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

function text(x: number, y: number, label: string, size: number, fill: string, weight = 'normal', family = 'sans-serif'): SVGTextElement {
  const node = el('text', { x, y, 'font-size': size, fill, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-family': family, 'font-weight': weight });
  node.textContent = label;
  return node;
}

function frame(def: PartDefinition): { wrapper: HTMLDivElement; svg: SVGSVGElement } {
  const { w, h } = def.size;
  const wrapper = document.createElement('div');
  wrapper.className = 'power-view';
  const svg = el('svg', { width: `${w}mm`, height: `${h}mm`, viewBox: `0 0 ${w} ${h}`, overflow: 'visible' });
  wrapper.append(svg);
  return { wrapper, svg };
}

const pinOf = (def: PartDefinition, name: string): { x: number; y: number } => {
  const pin = def.pins.find((p) => p.name === name);
  if (pin === undefined) throw new Error(`${def.type} has no pin ${name}`);
  return pin;
};

/** A lead: a coloured wire from (x1, y1) to the pin, with a tinned tip. */
function lead(svg: SVGSVGElement, x1: number, y1: number, to: { x: number; y: number }, color: string): void {
  svg.append(el('path', { d: `M ${x1} ${y1} C ${x1} ${(y1 + to.y) / 2}, ${to.x} ${(y1 + to.y) / 2}, ${to.x} ${to.y + 0.8}`, fill: 'none', stroke: color, 'stroke-width': 1.1, 'stroke-linecap': 'round' }));
  svg.append(el('circle', { cx: to.x, cy: to.y, r: 0.55, fill: '#c9ccd1' }));
}

/** A vertical AA cell with its + end up or down. */
function aaCell(svg: SVGSVGElement, x: number, y: number, w: number, h: number, plusUp: boolean): void {
  svg.append(el('rect', { x, y, width: w, height: h, rx: 1.2, fill: '#1d1f23', stroke: '#0e0f11', 'stroke-width': 0.25 }));
  const capY = plusUp ? y : y + h - h * 0.22;
  svg.append(el('rect', { x, y: capY, width: w, height: h * 0.22, rx: 1.2, fill: '#b8792f' }));
  const nubY = plusUp ? y - 0.9 : y + h - 0.2;
  svg.append(el('rect', { x: x + w / 2 - 1.6, y: nubY, width: 3.2, height: 1.1, rx: 0.4, fill: '#c9ccd1' }));
  svg.append(text(x + w / 2, y + h / 2, 'AA 1.5V', 2.2, '#d9dbe0'));
  svg.append(text(x + w / 2, plusUp ? y + h * 0.11 : y + h - h * 0.11, '+', 3.4, '#2a1a08', 'bold'));
}

function drawBattery9v(def: PartDefinition, svg: SVGSVGElement): void {
  const { w, h } = def.size;
  const plus = pinOf(def, '+');
  const minus = pinOf(def, '-');
  svg.append(el('rect', { x: 0.4, y: 5.2, width: w - 0.8, height: h - 5.6, rx: 2, fill: '#2b2f36', stroke: '#15171b', 'stroke-width': 0.3 }));
  svg.append(el('rect', { x: 0.4, y: 5.2, width: w - 0.8, height: 6.2, rx: 2, fill: '#a7abb3' }));
  svg.append(el('rect', { x: 0.4, y: 15, width: w - 0.8, height: 15, fill: '#d8a521' }));
  svg.append(text(w / 2, 22.5, '9V', 9, '#1b1d21', 'bold'));
  svg.append(text(w / 2, 36, 'ALKALINE', 2.6, '#c7cbd2', 'bold'));
  svg.append(text(w / 2, 40, '6LR61', 2.2, '#8f949c'));
  // Snap terminals: a round + stud and a hexagonal − socket.
  svg.append(el('circle', { cx: plus.x, cy: plus.y, r: 2.6, fill: '#d6d9de', stroke: '#7d828a', 'stroke-width': 0.3 }));
  svg.append(el('circle', { cx: plus.x, cy: plus.y, r: 1.4, fill: '#eef0f3' }));
  const hex = Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i;
    return `${(minus.x + 3.1 * Math.cos(a)).toFixed(2)},${(minus.y + 3.1 * Math.sin(a)).toFixed(2)}`;
  }).join(' ');
  svg.append(el('polygon', { points: hex, fill: '#d6d9de', stroke: '#7d828a', 'stroke-width': 0.3 }));
  svg.append(el('circle', { cx: minus.x, cy: minus.y, r: 1.5, fill: '#5c6168' }));
  svg.append(text(plus.x, plus.y + 4.9, '+', 2.8, '#1b1d21', 'bold'));
  svg.append(text(minus.x, minus.y + 4.9, '−', 2.8, '#1b1d21', 'bold'));
}

function drawAaHolder(def: PartDefinition, svg: SVGSVGElement, cells: number): void {
  const { w, h } = def.size;
  const plus = pinOf(def, '+');
  const minus = pinOf(def, '-');
  svg.append(el('rect', { x: 0.4, y: 6, width: w - 0.8, height: h - 6.4, rx: 1.6, fill: '#26282c', stroke: '#111214', 'stroke-width': 0.3 }));
  const pitch = (w - 3) / cells;
  for (let i = 0; i < cells; i++) aaCell(svg, 1.5 + i * pitch + 0.6, 10, pitch - 1.2, h - 14, i % 2 === 0);
  lead(svg, plus.x, 7, plus, '#d83c3c');
  lead(svg, minus.x, 7, minus, '#2a2c30');
  svg.append(text(w / 2, h - 2, `${cells * 1.5} V`, 2.4, '#9aa0a8', 'bold'));
}

function drawLipo(def: PartDefinition, svg: SVGSVGElement): void {
  const { w, h } = def.size;
  const plus = pinOf(def, '+');
  const minus = pinOf(def, '-');
  svg.append(el('rect', { x: 0.6, y: 14, width: w - 1.2, height: h - 14.6, rx: 1.2, fill: '#b9c3cf', stroke: '#7f8a97', 'stroke-width': 0.3 }));
  svg.append(el('rect', { x: 2.4, y: 20, width: w - 4.8, height: 20, rx: 0.8, fill: '#2f6fd8' }));
  svg.append(text(w / 2, 26, 'LiPo 3.7V', 3.6, '#ffffff', 'bold'));
  svg.append(text(w / 2, 31.5, '1000mAh 1S', 2.6, '#dbe6fb'));
  svg.append(text(w / 2, 36, '+ red / − black', 2, '#c3d4f5'));
  // Protection board under yellow tape, the leads out of it into the connector.
  svg.append(el('rect', { x: w / 2 - 7, y: 12, width: 14, height: 4, rx: 0.6, fill: '#e3c242' }));
  lead(svg, plus.x, 13, { x: plus.x, y: 7.2 }, '#d83c3c');
  lead(svg, minus.x, 13, { x: minus.x, y: 7.2 }, '#2a2c30');
  svg.append(el('rect', { x: plus.x - 2.4, y: 0.6, width: minus.x - plus.x + 4.8, height: 7, rx: 0.6, fill: '#f2f0e8', stroke: '#b9b5a8', 'stroke-width': 0.3 }));
  for (const p of [plus, minus]) svg.append(el('circle', { cx: p.x, cy: p.y, r: 0.7, fill: '#c9ccd1', stroke: '#8a8f97', 'stroke-width': 0.2 }));
  svg.append(text(plus.x, plus.y + 2.9, '+', 2.4, '#d83c3c', 'bold'));
  svg.append(text(minus.x, minus.y + 2.9, '−', 2.4, '#2a2c30', 'bold'));
}

function drawCr2032(def: PartDefinition, svg: SVGSVGElement): void {
  const { w } = def.size;
  const plus = pinOf(def, '+');
  const minus = pinOf(def, '-');
  for (const p of [plus, minus]) svg.append(el('rect', { x: p.x - 0.4, y: 22, width: 0.8, height: p.y - 22 + 0.6, fill: '#c9ccd1' }));
  svg.append(el('rect', { x: 0.6, y: 1.2, width: w - 1.2, height: 22.6, rx: 2.2, fill: '#24262a', stroke: '#101113', 'stroke-width': 0.3 }));
  svg.append(el('circle', { cx: w / 2, cy: 11.8, r: 10, fill: '#cfd3d9', stroke: '#8e949c', 'stroke-width': 0.35 }));
  svg.append(el('circle', { cx: w / 2, cy: 11.8, r: 8.6, fill: 'none', stroke: '#b3b8bf', 'stroke-width': 0.3 }));
  svg.append(text(w / 2, 9.6, 'CR2032', 3, '#3d4249', 'bold'));
  svg.append(text(w / 2, 14, '3V  +', 2.6, '#3d4249'));
  svg.append(el('rect', { x: w / 2 - 3, y: 0.8, width: 6, height: 3.2, rx: 0.5, fill: '#b9bec5' }));
}

const supplyDisplays = new WeakMap<HTMLElement, SVGTextElement>();

function drawBenchSupply(def: PartDefinition, svg: SVGSVGElement, wrapper: HTMLElement): void {
  const { w, h } = def.size;
  const plus = pinOf(def, '+');
  const minus = pinOf(def, '-');
  svg.append(el('rect', { x: 0.5, y: 0.5, width: w - 1, height: h - 1, rx: 2, fill: '#3b4652', stroke: '#1e252c', 'stroke-width': 0.35 }));
  svg.append(el('rect', { x: 2.5, y: 2.5, width: w - 5, height: h - 5, rx: 1.4, fill: '#2a323b' }));
  svg.append(text(15, 6.2, 'DC POWER SUPPLY', 2.2, '#c8d0d9', 'bold'));
  // The display.
  svg.append(el('rect', { x: 5, y: 9, width: 30, height: 13, rx: 0.8, fill: '#0d1a12', stroke: '#06100a', 'stroke-width': 0.3 }));
  const display = text(20, 15.6, '5.00', 8.2, '#4ce07a', 'bold', 'ui-monospace, monospace');
  svg.append(display);
  svg.append(text(32.4, 18.8, 'V', 2.6, '#4ce07a', 'bold'));
  supplyDisplays.set(wrapper, display);
  // The knob.
  svg.append(el('circle', { cx: 49, cy: 15.5, r: 7, fill: '#1c2228', stroke: '#11161b', 'stroke-width': 0.4 }));
  svg.append(el('circle', { cx: 49, cy: 15.5, r: 5.4, fill: '#454f5a' }));
  svg.append(el('line', { x1: 49, y1: 15.5, x2: 49, y2: 10.6, stroke: '#e8edf2', 'stroke-width': 0.8, 'stroke-linecap': 'round' }));
  svg.append(text(49, 25, 'VOLTAGE  0–30 V', 1.9, '#9fb0c1'));
  // Binding posts.
  for (const [p, color, label] of [
    [plus, '#d83c3c', '+'],
    [minus, '#26282c', '−'],
  ] as const) {
    svg.append(el('circle', { cx: p.x, cy: p.y, r: 3.4, fill: color, stroke: '#0f1114', 'stroke-width': 0.35 }));
    svg.append(el('circle', { cx: p.x, cy: p.y, r: 1.3, fill: '#d9dce1' }));
    svg.append(text(p.x, p.y - 5.4, label, 3.2, '#e8edf2', 'bold'));
  }
  svg.append(text(12, 37.5, 'OUTPUT', 2.4, '#9fb0c1', 'bold'));
}

function drawGround(def: PartDefinition, svg: SVGSVGElement): void {
  const pin = pinOf(def, 'GND');
  const { w } = def.size;
  svg.append(el('line', { x1: pin.x, y1: pin.y, x2: pin.x, y2: 3.6, stroke: '#2a2c30', 'stroke-width': 0.6 }));
  for (const [y, half] of [
    [3.8, 3.2],
    [5.2, 2.1],
    [6.6, 1],
  ] as const) {
    svg.append(el('line', { x1: w / 2 - half, y1: y, x2: w / 2 + half, y2: y, stroke: '#2a2c30', 'stroke-width': 0.6, 'stroke-linecap': 'round' }));
  }
  svg.append(el('circle', { cx: pin.x, cy: pin.y, r: 0.55, fill: '#c9ccd1' }));
}

/** Straight legs from a package's bottom edge (y0) down to its pins. */
function legs(def: PartDefinition, svg: SVGSVGElement, y0: number, width: number): void {
  for (const pin of def.pins) {
    svg.append(el('rect', { x: pin.x - width / 2, y: y0, width, height: pin.y - y0 + 0.4, fill: '#c9ccd1', stroke: '#8a8f97', 'stroke-width': 0.12 }));
  }
}

function drawLm7805(def: PartDefinition, svg: SVGSVGElement): void {
  const { w } = def.size;
  // The tab: tinned copper with its mounting hole.
  svg.append(el('rect', { x: 0.2, y: 0.2, width: w - 0.4, height: 7.4, rx: 0.4, fill: '#c7cbd1', stroke: '#8c9199', 'stroke-width': 0.25 }));
  svg.append(el('circle', { cx: w / 2, cy: 3.4, r: 1.8, fill: '#f4f5f6', stroke: '#8c9199', 'stroke-width': 0.25 }));
  svg.append(el('rect', { x: 0.2, y: 7.2, width: w - 0.4, height: 9.2, rx: 0.5, fill: '#25272b', stroke: '#111214', 'stroke-width': 0.25 }));
  svg.append(text(w / 2, 10.4, 'L7805', 2.3, '#d9dce1', 'bold'));
  svg.append(text(w / 2, 13.4, 'CV', 1.8, '#9aa0a8'));
  legs(def, svg, 16.4, 0.9);
  for (const pin of def.pins) svg.append(text(pin.x, 19, pin.name === 'GND' ? 'G' : pin.name === 'IN' ? 'I' : 'O', 1.6, '#555a62', 'bold'));
}

const ams1117Leds = new WeakMap<HTMLElement, SVGCircleElement>();

function drawAms1117(def: PartDefinition, svg: SVGSVGElement, wrapper: HTMLElement): void {
  const { w, h } = def.size;
  svg.append(el('rect', { x: 0.2, y: 0.2, width: w - 0.4, height: h - 0.4, rx: 0.8, fill: '#1f5fbf', stroke: '#123d7d', 'stroke-width': 0.25 }));
  // SOT-223 with its tab, two capacitors, the power LED.
  svg.append(el('rect', { x: w / 2 - 3.3, y: 1.6, width: 6.6, height: 2.4, fill: '#b7bcc3' }));
  svg.append(el('rect', { x: w / 2 - 3.3, y: 3.6, width: 6.6, height: 3.6, rx: 0.3, fill: '#2a2c30' }));
  svg.append(text(w / 2, 5.4, 'AMS1117', 1.15, '#d9dce1', 'bold'));
  for (const x of [1.6, w - 3.4]) svg.append(el('rect', { x, y: 8.4, width: 1.8, height: 1.2, rx: 0.2, fill: '#c9a46b' }));
  const led = el('circle', { cx: w / 2, cy: 9, r: 0.65, fill: '#3a1d1d' });
  svg.append(led);
  ams1117Leds.set(wrapper, led);
  svg.append(text(w / 2, 11.2, '3.3V', 1.5, '#e8eefb', 'bold'));
  for (const pin of def.pins) {
    svg.append(el('rect', { x: pin.x - 0.95, y: pin.y - 0.95, width: 1.9, height: 1.9, fill: '#1a1b1e' }));
    svg.append(el('circle', { cx: pin.x, cy: pin.y, r: 0.45, fill: '#d9b54a' }));
    svg.append(text(pin.x, pin.y - 2, pin.name, 1, '#e8eefb', 'bold'));
  }
}

function drawMcp1700(def: PartDefinition, svg: SVGSVGElement): void {
  const { w } = def.size;
  // TO-92: the flat face toward us, the rounded back as the top arc.
  svg.append(el('path', { d: `M 0.5 7 L 0.5 3.4 A ${w / 2 - 0.5} 3.2 0 0 1 ${w - 0.5} 3.4 L ${w - 0.5} 7 Z`, fill: '#25272b', stroke: '#111214', 'stroke-width': 0.25 }));
  svg.append(text(w / 2, 4.4, 'MCP', 1.5, '#d9dce1', 'bold'));
  svg.append(text(w / 2, 6, '1700', 1.4, '#d9dce1'));
  legs(def, svg, 7, 0.5);
}

export const POWER_VIEW_TYPES: ReadonlySet<string> = new Set([
  'battery-9v',
  'battery-2aa',
  'battery-4aa',
  'battery-lipo',
  'battery-cr2032',
  'bench-supply',
  'ground',
  'lm7805',
  'ams1117-3v3',
  'mcp1700-3v3',
]);

function showVolts(wrapper: HTMLElement, volts: number): void {
  const display = supplyDisplays.get(wrapper);
  if (display !== undefined) display.textContent = volts.toFixed(2);
}

export const powerView: ViewFactory = {
  async create(def) {
    const { wrapper, svg } = frame(def);
    switch (def.type) {
      case 'battery-9v':
        drawBattery9v(def, svg);
        break;
      case 'battery-2aa':
        drawAaHolder(def, svg, 2);
        break;
      case 'battery-4aa':
        drawAaHolder(def, svg, 4);
        break;
      case 'battery-lipo':
        drawLipo(def, svg);
        break;
      case 'battery-cr2032':
        drawCr2032(def, svg);
        break;
      case 'bench-supply':
        drawBenchSupply(def, svg, wrapper);
        break;
      case 'ground':
        drawGround(def, svg);
        break;
      case 'lm7805':
        drawLm7805(def, svg);
        break;
      case 'ams1117-3v3':
        drawAms1117(def, svg, wrapper);
        break;
      case 'mcp1700-3v3':
        drawMcp1700(def, svg);
        break;
    }
    return wrapper;
  },
  setProps(el: HTMLElement, props: PartProps) {
    if (typeof props.volts === 'number') showVolts(el, Math.min(30, Math.max(0, props.volts)));
  },
  update(el: HTMLElement, visual: VisualState) {
    if (typeof visual.volts === 'number') showVolts(el, visual.volts);
    const led = ams1117Leds.get(el);
    if (led !== undefined) led.setAttribute('fill', visual.on === true ? '#ff3b3b' : '#3a1d1d');
  },
};
