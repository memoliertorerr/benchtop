/**
 * Our own drawings of the motor parts @wokwi/elements has none of (BT172), in mm, legs ending on the
 * definitions' own pin positions:
 * - `dc-motor`: a 130-size motor seen from the side — its black end bell with the two terminal tabs
 *   (+ red, − black), the silver can, a brass bushing and the shaft, ending in a hub seen face-on
 *   that turns with the visual `angle`; above ≈ 300 rpm the hub blurs (a frame can't follow it) and
 *   the can prints the speed and the way it turns;
 * - BT173: `l298n` (`l298nView`), the red module — see its comment below.
 */

import type { PartDefinition, PartProps, VisualState } from '@benchtop/core';
import type { ViewFactory } from './registry.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';

function el<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

/** The part types these views draw (BT173: and the L298N's, `l298nView`). */
export const MOTOR_VIEW_TYPES: ReadonlySet<string> = new Set(['dc-motor']);

/** Above this (rpm) the hub is a blur. */
export const BLUR_RPM = 300;

interface Nodes {
  hub: SVGGElement;
  blur: SVGCircleElement;
  marks: SVGGElement;
  label: SVGTextElement;
  cx: number;
  cy: number;
}
const nodes = new WeakMap<HTMLElement, Nodes>();

/** "9000 rpm ▶" (forward), "◀ 1200 rpm" (backward), "stopped". */
export function speedLabel(rpm: number): string {
  const n = Math.round(Math.abs(rpm));
  if (n === 0) return 'stopped';
  return rpm > 0 ? `${n} rpm ▶` : `◀ ${n} rpm`;
}

export const motorView: ViewFactory = {
  async create(def: PartDefinition) {
    const { w, h } = def.size;
    const wrapper = document.createElement('div');
    wrapper.className = 'motor-view';
    const svg = el('svg', { width: `${w}mm`, height: `${h}mm`, viewBox: `0 0 ${w} ${h}`, overflow: 'visible' });
    const defs = el('defs', {});
    const grad = el('linearGradient', { id: 'dc-motor-can', x1: 0, y1: 0, x2: 0, y2: 1 });
    grad.append(el('stop', { offset: '0', 'stop-color': '#e3e6ea' }), el('stop', { offset: '0.45', 'stop-color': '#b9bec5' }), el('stop', { offset: '1', 'stop-color': '#858b93' }));
    defs.append(grad);
    svg.append(defs);
    const top = 1.0;
    const bottom = h - 1.0;
    // Terminal tabs on the end bell, ending at the pins.
    const plus = def.pins.find((p) => p.name === '+') ?? def.pins[0];
    const minus = def.pins.find((p) => p.name === '-') ?? def.pins[1];
    svg.append(el('rect', { x: 2.6, y: top + 0.6, width: 3.6, height: bottom - top - 1.2, rx: 0.8, fill: '#2a2b2e', stroke: '#141516', 'stroke-width': 0.2 }));
    for (const [pin, color] of [
      [plus, '#d33a2c'],
      [minus, '#1d1d1f'],
    ] as const) {
      svg.append(el('rect', { x: pin.x - 0.6, y: pin.y - 0.7, width: 3.2, height: 1.4, rx: 0.2, fill: '#c9a24a', stroke: '#8f7330', 'stroke-width': 0.15 }));
      svg.append(el('circle', { cx: pin.x + 1.4, cy: pin.y, r: 0.35, fill: color }));
    }
    // The can.
    svg.append(el('rect', { x: 6.0, y: top, width: 16.4, height: bottom - top, rx: 1.6, fill: 'url(#dc-motor-can)', stroke: '#6f757d', 'stroke-width': 0.25 }));
    svg.append(el('line', { x1: 7.2, y1: top + 1.2, x2: 21.2, y2: top + 1.2, stroke: '#ffffff', 'stroke-width': 0.35, opacity: 0.55 }));
    const label = el('text', { x: 14.2, y: h / 2 + 0.2, 'font-size': 1.5, fill: '#2b2f35', 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-family': 'sans-serif', 'font-weight': 'bold' });
    label.textContent = 'stopped';
    svg.append(label);
    // Bushing, shaft and the hub at its end.
    const cy = h / 2;
    svg.append(el('rect', { x: 22.4, y: cy - 1.4, width: 1.2, height: 2.8, rx: 0.3, fill: '#c79a3b', stroke: '#8f6d24', 'stroke-width': 0.15 }));
    svg.append(el('rect', { x: 23.6, y: cy - 0.4, width: 1.4, height: 0.8, fill: '#a9acb1' }));
    const cx = w - 2.4;
    const hub = el('g', {});
    hub.append(el('circle', { cx, cy, r: 2.2, fill: '#f2c230', stroke: '#b38a12', 'stroke-width': 0.2 }));
    const marks = el('g', {});
    marks.append(el('line', { x1: cx, y1: cy - 2.0, x2: cx, y2: cy + 2.0, stroke: '#7a5b06', 'stroke-width': 0.55, 'stroke-linecap': 'round' }));
    marks.append(el('circle', { cx, cy: cy - 1.4, r: 0.45, fill: '#d33a2c' }));
    hub.append(marks);
    const blur = el('circle', { cx, cy, r: 1.7, fill: 'none', stroke: '#7a5b06', 'stroke-width': 0.9, opacity: 0, 'stroke-dasharray': '0.4 0.3' });
    hub.append(blur);
    hub.append(el('circle', { cx, cy, r: 0.35, fill: '#a9acb1' }));
    svg.append(hub);
    wrapper.append(svg);
    nodes.set(wrapper, { hub, blur, marks, label, cx, cy });
    return wrapper;
  },
  setProps(_el: HTMLElement, _props: PartProps) {},
  update(el: HTMLElement, visual: VisualState) {
    const n = nodes.get(el);
    if (n === undefined) return;
    const rpm = typeof visual.rpm === 'number' ? visual.rpm : 0;
    const angle = typeof visual.angle === 'number' ? visual.angle % 360 : 0;
    const fast = Math.abs(rpm) > BLUR_RPM;
    n.marks.setAttribute('transform', `rotate(${angle.toFixed(1)} ${n.cx} ${n.cy})`);
    n.marks.setAttribute('opacity', fast ? '0.15' : '1');
    n.blur.setAttribute('opacity', fast ? '0.7' : '0');
    n.label.textContent = speedLabel(rpm);
  },
};

interface L298Nodes {
  power: SVGCircleElement;
  status: [SVGTextElement, SVGTextElement];
  jumpers: [SVGRectElement, SVGRectElement, SVGRectElement];
}
const l298Nodes = new WeakMap<HTMLElement, L298Nodes>();

/** A channel's state for the board's status line: its two outputs (0 off, 1 high, 2 low). */
export function channelLabel(name: string, a: number, b: number): string {
  if (a === 0 && b === 0) return `${name} off`;
  if (a === b) return `${name} brake`;
  return a === 1 ? `${name} ▶` : `${name} ◀`;
}

/**
 * BT173: the L298N module — a red board, the L298 under its black finned heatsink, blue screw
 * terminals for the outputs (left A, right B) and power (+12V, GND, +5V), the header ENA IN1–IN4
 * ENB with the jumper caps the props say are on (ENA, ENB, and the 5 V regulator's), a power LED and
 * a status line per channel (▶, ◀, brake, off) printed on the board.
 */
export const l298nView: ViewFactory = {
  async create(def: PartDefinition, props: PartProps) {
    const { w, h } = def.size;
    const wrapper = document.createElement('div');
    wrapper.className = 'l298n-view';
    const svg = el('svg', { width: `${w}mm`, height: `${h}mm`, viewBox: `0 0 ${w} ${h}`, overflow: 'visible' });
    const pin = (name: string) => def.pins.find((p) => p.name === name) ?? { x: 0, y: 0 };
    svg.append(el('rect', { x: 0.3, y: 0.3, width: w - 0.6, height: h - 0.6, rx: 1.2, fill: '#b8231f', stroke: '#7d1512', 'stroke-width': 0.3 }));
    for (const [x, y] of [
      [2.2, 2.2],
      [w - 2.2, 2.2],
      [2.2, h - 2.2],
      [w - 2.2, h - 2.2],
    ]) svg.append(el('circle', { cx: x, cy: y, r: 1.3, fill: '#2a1210', stroke: '#d9b25a', 'stroke-width': 0.3 }));
    // Heatsink with fins, the chip's label under it.
    svg.append(el('rect', { x: 11, y: 2.5, width: 21, height: 13, rx: 0.6, fill: '#202124', stroke: '#0d0d0e', 'stroke-width': 0.3 }));
    for (let x = 12.4; x < 31.5; x += 2.1) svg.append(el('rect', { x, y: 2.9, width: 1.0, height: 12.2, fill: '#34363a' }));
    const chip = el('text', { x: w / 2, y: 17.6, 'font-size': 1.6, fill: '#f3e7e6', 'text-anchor': 'middle', 'font-family': 'sans-serif', 'font-weight': 'bold' });
    chip.textContent = 'L298N';
    svg.append(chip);
    // Screw terminals: the outputs on the sides, power along the bottom.
    const block = (x: number, y: number, width: number, height: number): void => {
      svg.append(el('rect', { x, y, width, height, rx: 0.4, fill: '#1f6fd1', stroke: '#124a8e', 'stroke-width': 0.25 }));
    };
    block(0.6, pin('OUT1').y - 2.4, 4.4, 9.9);
    block(w - 5.0, pin('OUT3').y - 2.4, 4.4, 9.9);
    block(pin('+12V').x - 2.4, h - 5.0, 12.9, 4.4);
    const screw = (x: number, y: number): void => {
      svg.append(el('circle', { cx: x, cy: y, r: 1.0, fill: '#c9ccd1', stroke: '#7d8187', 'stroke-width': 0.2 }));
      svg.append(el('line', { x1: x - 0.7, y1: y, x2: x + 0.7, y2: y, stroke: '#5f6368', 'stroke-width': 0.3 }));
    };
    for (const name of ['OUT1', 'OUT2', 'OUT3', 'OUT4', '+12V', 'GND', '+5V']) screw(pin(name).x, pin(name).y);
    // The header and its labels.
    for (const name of ['ENA', 'IN1', 'IN2', 'IN3', 'IN4', 'ENB']) {
      const p = pin(name);
      svg.append(el('rect', { x: p.x - 0.9, y: p.y - 0.9, width: 1.8, height: 1.8, fill: '#151515' }));
      svg.append(el('circle', { cx: p.x, cy: p.y, r: 0.4, fill: '#d9b25a' }));
    }
    const labels: [string, number, number, string][] = [
      ['OUT1', pin('OUT1').x + 3.2, pin('OUT1').y, 'start'],
      ['OUT2', pin('OUT2').x + 3.2, pin('OUT2').y, 'start'],
      ['OUT3', pin('OUT3').x - 3.2, pin('OUT3').y, 'end'],
      ['OUT4', pin('OUT4').x - 3.2, pin('OUT4').y, 'end'],
      ['12V', pin('+12V').x, h - 6.3, 'middle'],
      ['GND', pin('GND').x, h - 6.3, 'middle'],
      ['5V', pin('+5V').x, h - 6.3, 'middle'],
      ['ENA', pin('ENA').x, h - 6.3, 'middle'],
      ['IN1', pin('IN1').x, h - 4.4, 'middle'],
      ['IN2', pin('IN2').x, h - 6.3, 'middle'],
      ['IN3', pin('IN3').x, h - 4.4, 'middle'],
      ['IN4', pin('IN4').x, h - 6.3, 'middle'],
      ['ENB', pin('ENB').x, h - 4.4, 'middle'],
    ];
    for (const [text, x, y, anchor] of labels) {
      const t = el('text', { x, y, 'font-size': 1.05, fill: '#f3e7e6', 'text-anchor': anchor, 'dominant-baseline': 'central', 'font-family': 'sans-serif' });
      t.textContent = text;
      svg.append(t);
    }
    // Jumper caps: ENA, ENB (over their pins and the 5 V beside them), the regulator's by +5V.
    const cap = (x: number, y: number): SVGRectElement => {
      const r = el('rect', { x: x - 1.0, y: y - 3.4, width: 2.0, height: 3.0, rx: 0.3, fill: '#1b1b1b', stroke: '#444', 'stroke-width': 0.2 });
      svg.append(r);
      return r;
    };
    const jumpers: [SVGRectElement, SVGRectElement, SVGRectElement] = [cap(pin('ENA').x, pin('ENA').y), cap(pin('ENB').x, pin('ENB').y), cap(pin('+5V').x + 3.4, h - 9.0)];
    // Power LED and the channels' status.
    const power = el('circle', { cx: w - 8.5, cy: 25.5, r: 1.0, fill: '#3a1d1d', stroke: '#2a1210', 'stroke-width': 0.2 });
    svg.append(power);
    const status = (x: number): SVGTextElement => {
      const t = el('text', { x, y: 25.5, 'font-size': 1.5, fill: '#f3e7e6', 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-family': 'sans-serif', 'font-weight': 'bold' });
      t.textContent = '';
      svg.append(t);
      return t;
    };
    const st: [SVGTextElement, SVGTextElement] = [status(12), status(26)];
    wrapper.append(svg);
    l298Nodes.set(wrapper, { power, status: st, jumpers });
    l298nView.setProps(wrapper, { ...def.defaults, ...props });
    return wrapper;
  },
  setProps(el: HTMLElement, props: PartProps) {
    const n = l298Nodes.get(el);
    if (n === undefined) return;
    n.jumpers[0].setAttribute('opacity', props.enaJumper === false ? '0' : '1');
    n.jumpers[1].setAttribute('opacity', props.enbJumper === false ? '0' : '1');
    n.jumpers[2].setAttribute('opacity', props.regulator === false ? '0' : '1');
  },
  update(el: HTMLElement, visual: VisualState) {
    const n = l298Nodes.get(el);
    if (n === undefined) return;
    n.power.setAttribute('fill', visual.powered === true ? '#ff3b30' : '#3a1d1d');
    const outs = Array.isArray(visual.outs) ? (visual.outs as number[]) : [0, 0, 0, 0];
    n.status[0].textContent = channelLabel('A', outs[0] ?? 0, outs[1] ?? 0);
    n.status[1].textContent = channelLabel('B', outs[2] ?? 0, outs[3] ?? 0);
  },
};
