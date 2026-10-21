/**
 * Our own breadboard drawing (the element library has none), generated from the part
 * definition's holes so it always matches the netlist: a cream body with a soft bevel, square
 * dark holes, the center channel, red (+) and blue (−) rail stripes, row letters and column
 * numbers. All in mm, so it stays crisp at every zoom.
 */

import type { PartDefinition } from '@benchtop/core';
import type { ViewFactory } from './registry.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';
const HOLE = 1.0;
const RED = '#d4433b';
const BLUE = '#3b6fd4';
let instances = 0;

function el<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

function text(x: number, y: number, label: string, size: number, fill: string): SVGTextElement {
  const node = el('text', { x, y, 'font-size': size, fill, 'text-anchor': 'middle', 'dominant-baseline': 'central' });
  node.textContent = label;
  return node;
}

export function drawBreadboard(def: PartDefinition): SVGSVGElement {
  const { w, h } = def.size;
  const id = `bb${++instances}`;
  const svg = el('svg', { width: `${w}mm`, height: `${h}mm`, viewBox: `0 0 ${w} ${h}`, class: 'breadboard-svg' });

  const defs = el('defs', {});
  const body = el('linearGradient', { id: `${id}-body`, x1: 0, y1: 0, x2: 0, y2: 1 });
  body.append(el('stop', { offset: 0, 'stop-color': '#faf7f0' }), el('stop', { offset: 1, 'stop-color': '#ebe5d6' }));
  defs.append(body);
  svg.append(defs);
  svg.append(el('rect', { x: 0.15, y: 0.15, width: w - 0.3, height: h - 0.3, rx: 1.2, fill: `url(#${id}-body)`, stroke: '#d3cbb6', 'stroke-width': 0.3 }));
  // Bevel: a highlight along the top edge, a shade along the bottom.
  svg.append(el('path', { d: `M1.2 0.55 H${w - 1.2}`, stroke: '#fffdf8', 'stroke-width': 0.35, 'stroke-linecap': 'round' }));
  svg.append(el('path', { d: `M1.2 ${h - 0.55} H${w - 1.2}`, stroke: '#d8d0bc', 'stroke-width': 0.35, 'stroke-linecap': 'round' }));

  const holes = new Map<string, { x: number; y: number }>();
  for (const pin of def.pins) holes.set(pin.name, { x: pin.x, y: pin.y });
  const rowY = (row: string): number | undefined => {
    for (const [name, p] of holes) if (name.endsWith(`.${row}`) && /^\d+[tb]\./.test(name)) return p.y;
    return undefined;
  };
  const e = rowY('e');
  const f = rowY('f');
  if (e !== undefined && f !== undefined) {
    const top = e + 1.7;
    const bottom = f - 1.7;
    svg.append(el('rect', { x: 0.9, y: top, width: w - 1.8, height: bottom - top, rx: 0.6, fill: '#e7e0cf' }));
    svg.append(el('path', { d: `M1.4 ${(top + bottom) / 2} H${w - 1.4}`, stroke: '#d6ceb9', 'stroke-width': 0.25 }));
  }

  // Rail stripes: + red on the outer rows, − blue on the inner ones.
  for (const [rail, color, side] of [
    ['tp', RED, -1],
    ['tn', BLUE, 1],
    ['bn', BLUE, -1],
    ['bp', RED, 1],
  ] as const) {
    const xs: number[] = [];
    let y = 0;
    for (const [name, p] of holes) {
      if (name.startsWith(`${rail}.`)) {
        xs.push(p.x);
        y = p.y;
      }
    }
    if (xs.length === 0) continue;
    const ly = y + side * 1.55;
    svg.append(el('path', { d: `M${Math.min(...xs) - 1.6} ${ly} H${Math.max(...xs) + 1.6}`, stroke: color, 'stroke-width': 0.3, opacity: 0.85 }));
    // + / − marks at the rail ends, where the board has room for them.
    const sign = rail.endsWith('p') ? '+' : '−';
    if (Math.min(...xs) - 2.6 > 0.9) svg.append(text(Math.min(...xs) - 2.6, y, sign, 1.7, color));
    if (Math.max(...xs) + 2.6 < w - 0.9) svg.append(text(Math.max(...xs) + 2.6, y, sign, 1.7, color));
  }

  const g = el('g', { fill: '#34322d', stroke: '#c9c1ac', 'stroke-width': 0.14 });
  for (const p of holes.values()) {
    g.append(el('rect', { x: p.x - HOLE / 2, y: p.y - HOLE / 2, width: HOLE, height: HOLE, rx: 0.14 }));
  }
  svg.append(g);

  // Row letters on both sides, column numbers above a and below j.
  const labels = el('g', { 'font-family': 'ui-sans-serif, system-ui, sans-serif', 'font-weight': 600 });
  const firstColX = holes.get('1t.a')?.x;
  const lastCol = Math.max(...def.pins.map((p) => Number.parseInt(p.name, 10)).filter((n) => !Number.isNaN(n)));
  const lastColX = holes.get(`${lastCol}t.a`)?.x;
  for (const row of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']) {
    const y = rowY(row);
    if (y === undefined || firstColX === undefined || lastColX === undefined) continue;
    labels.append(text(firstColX - 1.9, y, row, 1.25, '#a49d8c'), text(lastColX + 1.9, y, row, 1.25, '#a49d8c'));
  }
  const a = rowY('a');
  const j = rowY('j');
  if (a !== undefined && j !== undefined && a >= 4) {
    for (let col = 1; col <= lastCol; col++) {
      if (col !== 1 && col % 5 !== 0) continue;
      const x = holes.get(`${col}t.a`)?.x;
      if (x === undefined) continue;
      labels.append(text(x, a - 1.8, String(col), 1.15, '#a49d8c'), text(x, j + 1.8, String(col), 1.15, '#a49d8c'));
    }
  }
  svg.append(labels);
  return svg;
}

export const breadboardView: ViewFactory = {
  async create(def) {
    const wrapper = document.createElement('div');
    wrapper.className = 'breadboard-view';
    wrapper.append(drawBreadboard(def));
    return wrapper;
  },
  setProps() {},
  update() {},
};
