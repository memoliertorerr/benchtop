/**
 * Our own drawing of the touch pad (BT157; packages/parts inputs/touch-pad.ts — no element draws
 * one), in mm: a small green board with a round gold electrode, its trace down to the PAD pin at
 * the bottom edge (the definition's own pin position, so wires meet it), and TOUCH in the
 * silkscreen. A fingertip shade over the electrode follows the `contact` visual state (0–1). While
 * the bench runs, holding the pointer on the pad is a finger on it: press on pointer down, release
 * on pointer up or cancel; the Inspector's Contact slider sets a partial touch.
 */

import type { PartDefinition, PartInput, VisualState } from '@benchtop/core';
import type { ViewFactory } from './registry.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';

function el<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

const fingers = new WeakMap<HTMLElement, SVGCircleElement>();

/** The part types this view draws. */
export const TOUCH_PAD_VIEW_TYPES: ReadonlySet<string> = new Set(['touch-pad']);

export const touchPadView: ViewFactory = {
  async create(def: PartDefinition) {
    const { w, h } = def.size;
    const pin = def.pins.find((p) => p.name === 'PAD') ?? { x: w / 2, y: h };
    const wrapper = document.createElement('div');
    wrapper.className = 'touch-pad-view';
    const svg = el('svg', { width: `${w}mm`, height: `${h}mm`, viewBox: `0 0 ${w} ${h}`, overflow: 'visible' });
    const cx = w / 2;
    const cy = w / 2;
    const r = w / 2 - 2.2;
    svg.append(el('rect', { x: 0.3, y: 0.3, width: w - 0.6, height: h - 1.2, rx: 1.4, fill: '#1f6b3a', stroke: '#14482a', 'stroke-width': 0.3 }));
    svg.append(el('path', { d: `M ${cx} ${cy + r} L ${pin.x} ${pin.y - 0.8}`, stroke: '#c9a23a', 'stroke-width': 0.8 }));
    svg.append(el('circle', { cx, cy, r: r + 0.6, fill: 'none', stroke: '#9c7a22', 'stroke-width': 0.25 }));
    svg.append(el('circle', { cx, cy, r, fill: '#d6ad45', stroke: '#b8902f', 'stroke-width': 0.3 }));
    svg.append(el('circle', { cx: cx - r * 0.35, cy: cy - r * 0.35, r: r * 0.28, fill: '#f0d27a', opacity: 0.55 }));
    const finger = el('circle', { cx, cy, r: r * 0.85, fill: '#e2a989', 'fill-opacity': 0, stroke: '#b97a5e', 'stroke-opacity': 0, 'stroke-width': 0.3 });
    svg.append(finger);
    const label = el('text', { x: cx, y: h - 3.6, 'font-size': 1.6, fill: '#e9ebee', 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-family': 'sans-serif', 'font-weight': 'bold' });
    label.textContent = 'TOUCH';
    svg.append(label);
    svg.append(el('circle', { cx: pin.x, cy: pin.y, r: 0.7, fill: '#c9ccd1', stroke: '#8a8d92', 'stroke-width': 0.2 }));
    wrapper.append(svg);
    fingers.set(wrapper, finger);
    return wrapper;
  },
  setProps() {},
  update(el: HTMLElement, visual: VisualState) {
    const finger = fingers.get(el);
    if (finger === undefined) return;
    const contact = typeof visual.contact === 'number' ? Math.min(1, Math.max(0, visual.contact)) : 0;
    finger.setAttribute('fill-opacity', String(0.75 * contact));
    finger.setAttribute('stroke-opacity', String(contact > 0 ? 0.8 : 0));
  },
  bindInput(el: HTMLElement, send: (input: PartInput) => void) {
    let down = false;
    const press = (event: PointerEvent): void => {
      if (event.button !== 0) return;
      down = true;
      el.setPointerCapture?.(event.pointerId);
      send({ kind: 'press' });
    };
    const release = (): void => {
      if (!down) return;
      down = false;
      send({ kind: 'release' });
    };
    el.addEventListener('pointerdown', press);
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    return () => {
      el.removeEventListener('pointerdown', press);
      el.removeEventListener('pointerup', release);
      el.removeEventListener('pointercancel', release);
    };
  },
};
