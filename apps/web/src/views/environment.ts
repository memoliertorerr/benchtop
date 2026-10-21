/**
 * Views of the environment parts (BT55): our own small top-down drawings in mm, crisp at every
 * zoom. The room badge shows the ambient conditions and hands the worker's heatmap to the
 * canvas overlay (editor/heatmap.ts); sources light up while on; a person or an object moves by
 * the offset in its visual state (bench mm in the part's own frame) and is drawn at its room
 * size (`sizeW`/`sizeH`, which differ from the part's box when the room's scale isn't 10).
 */

import type { PartDefinition, PartProps, VisualState } from '@benchtop/core';
import { setHeatmap } from '../editor/heatmap.ts';
import type { ViewFactory } from './registry.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';

function el<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

function label(x: number, y: number, text: string, size: number, fill = '#1f2a33', weight = 'normal'): SVGTextElement {
  const node = el('text', { x, y, 'font-size': size, fill, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-family': 'sans-serif', 'font-weight': weight });
  node.textContent = text;
  return node;
}

/** Gold pads for a part's pins (the IN/GND control pair). */
function pads(svg: SVGSVGElement, def: PartDefinition): void {
  for (const pin of def.pins) {
    svg.append(el('rect', { x: pin.x - 0.8, y: pin.y - 2.2, width: 1.6, height: 2.2, fill: '#d9b44a', stroke: '#a8862b', 'stroke-width': 0.15 }));
    svg.append(label(pin.x, pin.y - 3.1, pin.name, 1, '#3a3f44'));
  }
}

interface Drawn {
  svg: SVGSVGElement;
  /** Shown while the source is on. */
  glow?: SVGElement;
  /** Room badge text lines. */
  lines?: SVGTextElement[];
}

const drawn = new WeakMap<HTMLElement, Drawn>();

function base(def: PartDefinition): SVGSVGElement {
  const { w, h } = def.size;
  // Pins sit on the bottom edge; leave room below for them.
  return el('svg', { width: `${w}mm`, height: `${h}mm`, viewBox: `0 0 ${w} ${h}`, overflow: 'visible' });
}

function drawRoom(def: PartDefinition): Drawn {
  const svg = base(def);
  const { w, h } = def.size;
  svg.append(el('rect', { x: 0.2, y: 0.2, width: w - 0.4, height: h - 0.4, rx: 2, fill: '#eef4f8', stroke: '#7d98ab', 'stroke-width': 0.4 }));
  // A house outline.
  svg.append(el('path', { d: 'M3 9 L7.5 4.5 L12 9 V15 H3 Z', fill: 'none', stroke: '#4d6b80', 'stroke-width': 0.6, 'stroke-linejoin': 'round' }));
  svg.append(el('rect', { x: 6.3, y: 11, width: 2.4, height: 4, fill: '#4d6b80' }));
  const lines = [label(21, 6, '', 2.2, '#1f2a33', 'bold'), label(21, 10.5, '', 2), label(21, 14.5, '', 2)];
  svg.append(...lines);
  return { svg, lines };
}

function drawLeak(def: PartDefinition): Drawn {
  const svg = base(def);
  const c = def.size.w / 2;
  const glow = el('g', { opacity: 0 });
  for (const [r, o] of [
    [6.6, 0.18],
    [5, 0.28],
  ] as const)
    glow.append(el('circle', { cx: c, cy: c, r, fill: '#9bd36a', opacity: o }));
  svg.append(glow);
  svg.append(el('circle', { cx: c, cy: c, r: 4.2, fill: '#c8d2d8', stroke: '#6f7f88', 'stroke-width': 0.4 }));
  svg.append(el('circle', { cx: c, cy: c, r: 1.6, fill: '#7d8b93' }));
  svg.append(el('rect', { x: c - 0.5, y: c - 4.6, width: 1, height: 3, fill: '#d23b3b' }));
  svg.append(label(c, c + 5.7, 'GAS', 1.6, '#3d4a52', 'bold'));
  return { svg, glow };
}

function drawHeater(def: PartDefinition): Drawn {
  const svg = base(def);
  const { w, h } = def.size;
  svg.append(el('rect', { x: 0.3, y: 0.3, width: w - 0.6, height: h - 3, rx: 1.2, fill: '#e9e4dc', stroke: '#8a7f70', 'stroke-width': 0.4 }));
  const glow = el('g', { opacity: 0 });
  for (let i = 0; i < 6; i++) glow.append(el('rect', { x: 2.4 + i * 2.7, y: 1.8, width: 1.4, height: h - 6, rx: 0.5, fill: '#ff6a2a' }));
  svg.append(glow);
  for (let i = 0; i < 6; i++) svg.append(el('rect', { x: 2.4 + i * 2.7, y: 1.8, width: 1.4, height: h - 6, rx: 0.5, fill: 'none', stroke: '#8a7f70', 'stroke-width': 0.25 }));
  pads(svg, def);
  return { svg, glow };
}

function drawFlame(def: PartDefinition): Drawn {
  const svg = base(def);
  const c = def.size.w / 2;
  svg.append(el('circle', { cx: c, cy: c, r: 3.6, fill: '#f6f0dc', stroke: '#c9bd94', 'stroke-width': 0.3 }));
  const glow = el('g', { opacity: 0 });
  glow.append(el('circle', { cx: c, cy: c, r: 4.9, fill: '#ffb347', opacity: 0.25 }));
  glow.append(el('path', { d: `M${c} ${c - 3} C${c + 2.2} ${c - 0.4} ${c + 1.4} ${c + 1.8} ${c} ${c + 1.8} C${c - 1.4} ${c + 1.8} ${c - 2.2} ${c - 0.4} ${c} ${c - 3} Z`, fill: '#ff9d1c' }));
  glow.append(el('circle', { cx: c, cy: c + 0.4, r: 0.7, fill: '#fff3b0' }));
  svg.append(glow);
  svg.append(el('circle', { cx: c, cy: c + 0.4, r: 0.25, fill: '#333' }));
  return { svg, glow };
}

function drawLamp(def: PartDefinition): Drawn {
  const svg = base(def);
  const c = def.size.w / 2;
  const cy = c - 1.2;
  const glow = el('g', { opacity: 0 });
  glow.append(el('circle', { cx: c, cy, r: 6.4, fill: '#ffe066', opacity: 0.3 }));
  glow.append(el('circle', { cx: c, cy, r: 4.3, fill: '#fff2a8' }));
  svg.append(glow);
  svg.append(el('circle', { cx: c, cy, r: 4.3, fill: 'none', stroke: '#8c8466', 'stroke-width': 0.4 }));
  svg.append(el('path', { d: `M${c - 1.6} ${cy + 0.6} q0.8 -2 1.6 0 q0.8 2 1.6 0`, fill: 'none', stroke: '#8c8466', 'stroke-width': 0.3 }));
  pads(svg, def);
  return { svg, glow };
}

function drawSound(def: PartDefinition): Drawn {
  const svg = base(def);
  const c = def.size.w / 2;
  svg.append(el('circle', { cx: c, cy: c, r: 4.6, fill: '#2f3337', stroke: '#15181a', 'stroke-width': 0.3 }));
  svg.append(el('circle', { cx: c, cy: c, r: 2.6, fill: '#4a5056' }));
  svg.append(el('circle', { cx: c, cy: c, r: 0.9, fill: '#7d858c' }));
  const glow = el('g', { opacity: 0, fill: 'none', stroke: '#3f8fd8', 'stroke-width': 0.45 });
  for (const r of [5.6, 6.6]) glow.append(el('circle', { cx: c, cy: c, r }));
  svg.append(glow);
  return { svg, glow };
}

function drawFan(def: PartDefinition): Drawn {
  const svg = base(def);
  const c = def.size.w / 2;
  const cy = c - 1.3;
  svg.append(el('rect', { x: 0.3, y: 0.3, width: def.size.w - 0.6, height: def.size.h - 3, rx: 1.5, fill: '#dfe5e8', stroke: '#6f7f88', 'stroke-width': 0.4 }));
  svg.append(el('circle', { cx: c, cy, r: 5.4, fill: '#f6f8f9', stroke: '#6f7f88', 'stroke-width': 0.3 }));
  const rotor = el('g', { class: 'fan-rotor', style: `transform-origin: ${c}px ${cy}px` });
  for (let i = 0; i < 3; i++) rotor.append(el('path', { d: `M${c} ${cy} q3 -1.5 4.6 0.6 q-2.3 1.2 -4.6 -0.6 Z`, fill: '#5b7383', transform: `rotate(${i * 120} ${c} ${cy})` }));
  rotor.append(el('circle', { cx: c, cy, r: 0.9, fill: '#33434d' }));
  svg.append(rotor);
  pads(svg, def);
  return { svg, glow: rotor };
}

function drawPerson(def: PartDefinition): Drawn {
  const svg = base(def);
  const c = def.size.w / 2;
  const s = def.size.w / 40;
  svg.append(el('ellipse', { cx: c, cy: c, rx: 15 * s, ry: 7.5 * s, fill: '#4e79a7', stroke: '#2f4d6d', 'stroke-width': 0.6 }));
  svg.append(el('circle', { cx: c, cy: c, r: 6 * s, fill: '#e8c39e', stroke: '#9c7b5b', 'stroke-width': 0.5 }));
  svg.append(el('path', { d: `M${c - 4 * s} ${c - 2 * s} q${4 * s} ${-6 * s} ${8 * s} 0`, fill: '#5a3d2b' }));
  // A nose mark: which way the person faces (up, like a sensor's cone).
  svg.append(el('circle', { cx: c, cy: c - 6.3 * s, r: 1.1 * s, fill: '#d9ac85' }));
  return { svg };
}

function drawObject(def: PartDefinition): Drawn {
  const svg = base(def);
  const { w, h } = def.size;
  svg.append(el('rect', { x: 0.3, y: 0.3, width: w - 0.6, height: h - 0.6, rx: 0.8, fill: '#c9a46b', stroke: '#8a6a3a', 'stroke-width': 0.5 }));
  svg.append(el('path', { d: `M${w / 2} 0.3 V${h - 0.3}`, stroke: '#a88350', 'stroke-width': 1.6 }));
  svg.append(el('path', { d: `M2 2 L${w - 2} ${h - 2} M${w - 2} 2 L2 ${h - 2}`, stroke: '#a88350', 'stroke-width': 0.25, opacity: 0.6 }));
  return { svg };
}

const DRAW: Readonly<Record<string, (def: PartDefinition) => Drawn>> = {
  environment: drawRoom,
  'gas-leak': drawLeak,
  heater: drawHeater,
  flame: drawFlame,
  lamp: drawLamp,
  'sound-source': drawSound,
  fan: drawFan,
  person: drawPerson,
  object: drawObject,
};

export const ENVIRONMENT_VIEW_TYPES: ReadonlySet<string> = new Set(Object.keys(DRAW));

const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const roundTo = (v: number, digits: number): string => String(Number(v.toFixed(digits)));

export const environmentView: ViewFactory = {
  async create(def, props) {
    const wrapper = document.createElement('div');
    wrapper.className = `environment-view env-${def.type}`;
    const d = (DRAW[def.type] ?? drawObject)(def);
    wrapper.append(d.svg);
    drawn.set(wrapper, d);
    this.setProps(wrapper, props);
    wrapper.dataset.w = String(def.size.w);
    wrapper.dataset.h = String(def.size.h);
    return wrapper;
  },
  setProps(wrapper, props: PartProps) {
    const d = drawn.get(wrapper);
    if (d === undefined) return;
    if (d.lines !== undefined) {
      const [title, climate, extra] = d.lines;
      title.textContent = `Room ${roundTo(num(props.roomWidth, 4), 1)} × ${roundTo(num(props.roomDepth, 3), 1)} m`;
      climate.textContent = `${roundTo(num(props.temperature, 22), 1)} °C · ${roundTo(num(props.humidity, 45), 0)} %`;
      extra.textContent = props.overlay !== undefined && props.overlay !== 'off' ? `map: ${String(props.overlay)}` : `${roundTo(num(props.light, 300), 0)} lux`;
    }
    // Stopped, a source shows its initial state.
    if (d.glow !== undefined && typeof props.on === 'boolean') show(wrapper, d, props.on);
  },
  update(wrapper, visual: VisualState) {
    const d = drawn.get(wrapper);
    if (d === undefined) return;
    if (d.lines !== undefined) {
      setHeatmap(visual);
      return;
    }
    if (typeof visual.on === 'boolean') show(wrapper, d, visual.on);
    if (typeof visual.dx === 'number' && typeof visual.dy === 'number') {
      const w = Number(wrapper.dataset.w);
      const h = Number(wrapper.dataset.h);
      const sx = typeof visual.sizeW === 'number' && w > 0 ? visual.sizeW / w : 1;
      const sy = typeof visual.sizeH === 'number' && h > 0 ? visual.sizeH / h : 1;
      wrapper.style.transform = `translate(${visual.dx}mm, ${visual.dy}mm) scale(${sx}, ${sy})`;
      wrapper.classList.toggle('walking', visual.walking === true);
    }
  },
};

function show(wrapper: HTMLElement, d: Drawn, on: boolean): void {
  wrapper.classList.toggle('on', on);
  if (d.glow !== undefined && !d.glow.classList.contains('fan-rotor')) d.glow.setAttribute('opacity', on ? '1' : '0');
}
