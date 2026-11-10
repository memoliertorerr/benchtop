/**
 * BT185: our own drawings of the MAX7219 modules (packages/parts displays/max7219.ts), in mm, the
 * headers on the definitions' own pins — the input (VCC GND DIN CS CLK) down the right end, the
 * output (VCC GND DOUT CS CLK) down the left:
 * - `max7219-matrix`, `max7219-matrix-4`: a blue board under one or four black 8×8 matrices of
 *   round red dots, chip 0 the rightmost (data enters on the right);
 * - `max7219-7seg-8`: a blue board under two black 4-digit blocks, digit 0 the rightmost.
 * A lit dot's or segment's opacity follows the chip's `level` (0.4 + 0.6 × √level), so a dim
 * display is still plainly lit. Pure helpers (`dotOpacity`, `matrixDots`) are tested in Node.
 */

import type { PartDefinition, PartProps, VisualState } from '@benchtop/core';
import type { ViewFactory } from './registry.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';

function el<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

/** The part types this view draws, with their chip count. */
export const MAX7219_VIEW_TYPES: ReadonlyMap<string, number> = new Map([
  ['max7219-matrix', 1],
  ['max7219-matrix-4', 4],
  ['max7219-7seg-8', 1],
]);

const LIT = '#ff3b2f';
const DARK_DOT = '#3a1010';
const DARK_SEGMENT = '#2a1414';
/** Where the board's header strips end: the matrices and digits sit between them. */
const EDGE = 2.54;

/** A lit dot's opacity at a chip's level (0 = dark). */
export function dotOpacity(level: number): number {
  return level <= 0 ? 0 : 0.4 + 0.6 * Math.sqrt(Math.min(1, level));
}

/**
 * Which dots are lit, left to right and top to bottom across the module: chip 0 is the rightmost
 * matrix, digit d its row d, D7 the leftmost column. Returns 0/1 per dot (count × 64).
 */
export function matrixDots(rows: readonly number[], count: number): number[] {
  const out = new Array<number>(count * 64).fill(0);
  const width = count * 8;
  for (let chip = 0; chip < count; chip++) {
    const x0 = (count - 1 - chip) * 8;
    for (let row = 0; row < 8; row++) {
      const byte = rows[chip * 8 + row] ?? 0;
      for (let col = 0; col < 8; col++) out[row * width + x0 + col] = (byte >> (7 - col)) & 1;
    }
  }
  return out;
}

interface Nodes {
  /** Matrices: one circle per dot, row-major across the module. 7-segment: 8 per digit (A–G, DP), left to right. */
  lights: SVGElement[];
}
const nodes = new WeakMap<HTMLElement, Nodes>();

function drawBoard(svg: SVGSVGElement, def: PartDefinition): void {
  const { w, h } = def.size;
  svg.append(el('rect', { x: 0, y: 0, width: w, height: h, rx: 0.8, fill: '#1d4f91', stroke: '#123461', 'stroke-width': 0.2 }));
  for (const pin of def.pins) {
    svg.append(el('rect', { x: pin.x - 0.75, y: pin.y - 0.75, width: 1.5, height: 1.5, fill: '#111', stroke: '#d7b35a', 'stroke-width': 0.25 }));
    const right = pin.x > w / 2;
    const label = el('text', { x: right ? pin.x - 1.2 : pin.x + 1.2, y: pin.y, 'font-size': 0.75, fill: '#e8eef8', 'text-anchor': right ? 'end' : 'start', 'dominant-baseline': 'central', 'font-family': 'sans-serif' });
    label.textContent = pin.name.replace(/\.2$/, '');
    svg.append(label);
  }
}

function drawMatrices(svg: SVGSVGElement, def: PartDefinition, count: number): SVGElement[] {
  const { w, h } = def.size;
  const inner = w - 2 * (EDGE + 1.6);
  const size = Math.min(inner / count, h - 1);
  const x0 = (w - size * count) / 2;
  const y0 = (h - size) / 2;
  const pitch = size / 8;
  const lights: SVGElement[] = [];
  for (let m = 0; m < count; m++) svg.append(el('rect', { x: x0 + m * size + 0.15, y: y0, width: size - 0.3, height: size, rx: 0.3, fill: '#141416' }));
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < count * 8; col++) {
      const cx = x0 + (col + 0.5) * pitch;
      const cy = y0 + (row + 0.5) * pitch;
      svg.append(el('circle', { cx, cy, r: pitch * 0.36, fill: DARK_DOT }));
      const dot = el('circle', { cx, cy, r: pitch * 0.36, fill: LIT, opacity: 0 });
      svg.append(dot);
      lights.push(dot);
    }
  }
  return lights;
}

/** Segment outlines of one digit, A–G then DP, in a 6 × 10 box at (x, y). */
export function segmentShapes(x: number, y: number): { d: string }[] {
  const t = 0.9; // stroke width of a segment
  const s = 0.4; // italic slant over the height
  const at = (px: number, py: number): string => `${(x + px + s * (1 - py / 10)).toFixed(3)} ${(y + py).toFixed(3)}`;
  const horizontal = (py: number): string => `M ${at(1, py)} L ${at(1.5, py - t / 2)} L ${at(4.5, py - t / 2)} L ${at(5, py)} L ${at(4.5, py + t / 2)} L ${at(1.5, py + t / 2)} Z`;
  const vertical = (px: number, top: number, bottom: number): string =>
    `M ${at(px, top)} L ${at(px + t / 2, top + 0.5)} L ${at(px + t / 2, bottom - 0.5)} L ${at(px, bottom)} L ${at(px - t / 2, bottom - 0.5)} L ${at(px - t / 2, top + 0.5)} Z`;
  return [
    { d: horizontal(0.6) }, // A
    { d: vertical(5.2, 0.8, 4.9) }, // B
    { d: vertical(5.2, 5.1, 9.2) }, // C
    { d: horizontal(9.4) }, // D
    { d: vertical(0.8, 5.1, 9.2) }, // E
    { d: vertical(0.8, 0.8, 4.9) }, // F
    { d: horizontal(5) }, // G
  ];
}

function drawDigits(svg: SVGSVGElement, def: PartDefinition): SVGElement[] {
  const { w, h } = def.size;
  const blockW = (w - 2 * (EDGE + 2.2) - 1.2) / 2;
  const blockH = h - 2.4;
  const y0 = 1.2;
  const lights: SVGElement[] = [];
  for (let b = 0; b < 2; b++) {
    const bx = EDGE + 2.2 + b * (blockW + 1.2);
    svg.append(el('rect', { x: bx, y: y0, width: blockW, height: blockH, rx: 0.3, fill: '#161618' }));
    const digitW = blockW / 4;
    for (let d = 0; d < 4; d++) {
      const scale = Math.min((digitW - 1.4) / 6.6, (blockH - 2) / 10);
      const gx = bx + d * digitW + (digitW - 6.6 * scale) / 2;
      const gy = y0 + (blockH - 10 * scale) / 2;
      const group = el('g', { transform: `translate(${gx} ${gy}) scale(${scale})` });
      for (const shape of segmentShapes(0, 0)) {
        group.append(el('path', { d: shape.d, fill: DARK_SEGMENT }));
        const lit = el('path', { d: shape.d, fill: LIT, opacity: 0 });
        group.append(lit);
        lights.push(lit);
      }
      group.append(el('circle', { cx: 6.3, cy: 9.4, r: 0.55, fill: DARK_SEGMENT }));
      const dp = el('circle', { cx: 6.3, cy: 9.4, r: 0.55, fill: LIT, opacity: 0 });
      group.append(dp);
      lights.push(dp);
      svg.append(group);
    }
  }
  return lights;
}

export const max7219View: ViewFactory = {
  async create(def: PartDefinition, _props: PartProps) {
    const { w, h } = def.size;
    const wrapper = document.createElement('div');
    wrapper.className = 'max7219-view';
    wrapper.dataset.type = def.type;
    const svg = el('svg', { width: `${w}mm`, height: `${h}mm`, viewBox: `0 0 ${w} ${h}`, overflow: 'visible' });
    drawBoard(svg, def);
    const lights = def.type === 'max7219-7seg-8' ? drawDigits(svg, def) : drawMatrices(svg, def, MAX7219_VIEW_TYPES.get(def.type) ?? 1);
    wrapper.append(svg);
    nodes.set(wrapper, { lights });
    return wrapper;
  },
  setProps(_el: HTMLElement, _props: PartProps) {},
  update(element: HTMLElement, visual: VisualState) {
    const parts = nodes.get(element);
    if (parts === undefined) return;
    const level = Array.isArray(visual.level) ? (visual.level as number[]) : [];
    if (element.dataset.type === 'max7219-7seg-8') {
      const segments = Array.isArray(visual.segments) ? (visual.segments as number[]) : [];
      const opacity = String(dotOpacity(level[0] ?? 0));
      for (let d = 0; d < 8; d++) for (let s = 0; s < 8; s++) parts.lights[d * 8 + s].setAttribute('opacity', ((segments[d] ?? 0) >> s) & 1 ? opacity : '0');
      return;
    }
    const count = MAX7219_VIEW_TYPES.get(element.dataset.type ?? '') ?? 1;
    const dots = matrixDots(Array.isArray(visual.rows) ? (visual.rows as number[]) : [], count);
    const width = count * 8;
    for (let i = 0; i < dots.length; i++) {
      const chip = count - 1 - Math.floor((i % width) / 8);
      parts.lights[i].setAttribute('opacity', dots[i] === 1 ? String(dotOpacity(level[chip] ?? 0)) : '0');
    }
  },
};
