/**
 * BT196: our own drawing of the RC522 module (packages/parts rfid/rc522.ts), in mm: the blue
 * 40 × 60 mm board, the antenna coil's copper tracks around its upper part (brighter, with a faint
 * glow, while the field is on), the MFRC522 and its crystal, the power LED (lit while powered) and
 * the 8-pin header on the definition's pins. BT197: a card or the key fob drawn on the antenna
 * while the visual's `card` names one, with its UID. BT199: clicking it while running puts the card
 * on, or takes the tag off.
 */

import type { PartDefinition, PartInput, PartProps, VisualState } from '@benchtop/core';
import type { ViewFactory } from './registry.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';

function el<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

function text(x: number, y: number, size: number, content: string, attrs: Record<string, string | number> = {}): SVGTextElement {
  const node = el('text', { x, y, 'font-size': size, fill: '#e8eef8', 'text-anchor': 'middle', 'font-family': 'sans-serif', ...attrs });
  node.textContent = content;
  return node;
}

export const RFID_VIEW_TYPES: ReadonlySet<string> = new Set(['rc522']);

const COPPER = '#c9a04a';
const COPPER_LIT = '#ffd27a';

interface Nodes {
  power: SVGElement;
  coil: SVGElement[];
  glow: SVGElement;
  card: SVGGElement;
  fob: SVGGElement;
  cardUid: SVGTextElement;
  fobUid: SVGTextElement;
  cardKind: SVGTextElement;
  /** What lies on the reader, as last drawn. */
  tag: string;
}
const nodes = new WeakMap<HTMLElement, Nodes>();

/** The card (ISO ID-1, 54 × 85.6 mm) lying on the antenna, over the board's top edge. */
function cardGroup(w: number): { group: SVGGElement; uid: SVGTextElement; kind: SVGTextElement } {
  const group = el('g', { visibility: 'hidden', 'pointer-events': 'none' });
  const x = (w - 54) / 2;
  const y = -40;
  group.append(el('rect', { x: x + 0.8, y: y + 1.2, width: 54, height: 85.6, rx: 3.2, fill: '#000', opacity: 0.25 }));
  group.append(el('rect', { x, y, width: 54, height: 85.6, rx: 3.2, fill: '#f6f7f9', stroke: '#c9ccd2', 'stroke-width': 0.3, opacity: 0.94 }));
  // The inlay's coil, faintly through the plastic.
  group.append(el('rect', { x: x + 6, y: y + 8, width: 42, height: 66, rx: 2, fill: 'none', stroke: '#d8c8a0', 'stroke-width': 0.4, opacity: 0.6 }));
  const kind = text(x + 27, y + 14, 3, 'MIFARE Classic 1K', { fill: '#5a6270' });
  const uid = text(x + 27, y + 76, 3.2, '', { fill: '#2a2f38', 'font-family': 'ui-monospace, monospace' });
  group.append(kind, uid);
  return { group, uid, kind };
}

/** The blue key fob that comes with the module, on the antenna. */
function fobGroup(w: number): { group: SVGGElement; uid: SVGTextElement } {
  const group = el('g', { visibility: 'hidden', 'pointer-events': 'none' });
  const cx = w / 2;
  group.append(el('path', { d: `M ${cx - 14} 16 Q ${cx - 14} 2 ${cx} 0 Q ${cx + 14} 2 ${cx + 14} 16 L ${cx + 14} 30 Q ${cx + 14} 40 ${cx} 40 Q ${cx - 14} 40 ${cx - 14} 30 Z`, fill: '#000', opacity: 0.25, transform: 'translate(0.8 1.2)' }));
  group.append(el('path', { d: `M ${cx - 14} 16 Q ${cx - 14} 2 ${cx} 0 Q ${cx + 14} 2 ${cx + 14} 16 L ${cx + 14} 30 Q ${cx + 14} 40 ${cx} 40 Q ${cx - 14} 40 ${cx - 14} 30 Z`, fill: '#2a64c8', stroke: '#173f86', 'stroke-width': 0.4, opacity: 0.95 }));
  group.append(el('circle', { cx, cy: 6.5, r: 2.6, fill: '#1d4f91', stroke: '#173f86', 'stroke-width': 0.4 }));
  const uid = text(cx, 28, 2.6, '', { 'font-family': 'ui-monospace, monospace' });
  group.append(uid);
  return { group, uid };
}

export const rfidView: ViewFactory = {
  async create(def: PartDefinition, _props: PartProps) {
    const { w, h } = def.size;
    const wrapper = document.createElement('div');
    wrapper.className = 'rfid-view';
    const svg = el('svg', { width: `${w}mm`, height: `${h}mm`, viewBox: `0 0 ${w} ${h}`, overflow: 'visible' });
    svg.append(el('rect', { x: 0, y: 0, width: w, height: h, rx: 1, fill: '#1c4f9c', stroke: '#123a73', 'stroke-width': 0.25 }));
    for (const [cx, cy] of [
      [3.2, 3.2],
      [w - 3.2, 3.2],
      [3.2, h - 12],
      [w - 3.2, h - 12],
    ])
      svg.append(el('circle', { cx, cy, r: 1.6, fill: '#f2f2f2', stroke: '#b9bcc2', 'stroke-width': 0.3 }));
    // The antenna: four turns of copper around the upper part.
    const glow = el('rect', { x: 4, y: 4, width: w - 8, height: 34, rx: 3, fill: '#7fd1ff', opacity: 0 });
    svg.append(glow);
    const coil: SVGElement[] = [];
    for (let i = 0; i < 4; i++) {
      const inset = 6.5 + i * 1.3;
      const turn = el('rect', { x: inset, y: inset, width: w - 2 * inset, height: 34 - 2 * (inset - 4), rx: 2.5, fill: 'none', stroke: COPPER, 'stroke-width': 0.5 });
      coil.push(turn);
      svg.append(turn);
    }
    svg.append(text(w / 2, 22, 2.4, 'RFID-RC522', { fill: '#dbe6f5' }));
    // The chip, its crystal, the LED.
    svg.append(el('rect', { x: w / 2 - 3, y: 41, width: 6, height: 6, rx: 0.3, fill: '#16181c', stroke: '#2c2f36', 'stroke-width': 0.2 }));
    svg.append(text(w / 2, 44.6, 0.9, 'MFRC522', { fill: '#8a8f98' }));
    svg.append(el('rect', { x: w / 2 + 6, y: 42, width: 6.5, height: 2.6, rx: 1.3, fill: '#c6c9cf', stroke: '#8e9299', 'stroke-width': 0.2 }));
    svg.append(text(w / 2 + 9.25, 46.6, 0.9, '27.12 MHz', { fill: '#dbe6f5' }));
    const power = el('circle', { cx: 6, cy: 44, r: 0.9, fill: '#3a1010' });
    svg.append(power, text(6, 46.6, 0.9, 'PWR', { fill: '#dbe6f5' }));
    for (const pin of def.pins) {
      svg.append(el('rect', { x: pin.x - 0.75, y: pin.y - 0.75, width: 1.5, height: 1.5, fill: '#111', stroke: '#d7b35a', 'stroke-width': 0.25 }));
      svg.append(text(pin.x, pin.y - 1.4, 0.8, pin.name, { 'text-anchor': 'start', transform: `rotate(-90 ${pin.x} ${pin.y - 1.4})`, 'dominant-baseline': 'central' }));
    }
    const card = cardGroup(w);
    const fob = fobGroup(w);
    svg.append(card.group, fob.group);
    wrapper.append(svg);
    nodes.set(wrapper, { power, coil, glow, card: card.group, fob: fob.group, cardUid: card.uid, fobUid: fob.uid, cardKind: card.kind, tag: '' });
    return wrapper;
  },
  setProps(_el: HTMLElement, _props: PartProps) {},
  update(element: HTMLElement, visual: VisualState) {
    const parts = nodes.get(element);
    if (parts === undefined) return;
    parts.power.setAttribute('fill', visual.powered === true ? '#ff3b2f' : '#3a1010');
    const field = visual.field === true;
    for (const turn of parts.coil) turn.setAttribute('stroke', field ? COPPER_LIT : COPPER);
    parts.glow.setAttribute('opacity', field ? '0.12' : '0');
    const card = typeof visual.card === 'string' ? visual.card : '';
    parts.tag = card;
    const uid = typeof visual.uid === 'string' ? visual.uid : '';
    parts.card.setAttribute('visibility', card === 'card' ? 'visible' : 'hidden');
    parts.fob.setAttribute('visibility', card === 'fob' ? 'visible' : 'hidden');
    parts.cardUid.textContent = card === 'card' ? uid : '';
    parts.fobUid.textContent = card === 'fob' ? uid : '';
    parts.cardKind.textContent = visual.kind === 'ntag213' ? 'NTAG213' : 'MIFARE Classic 1K';
  },
  /** BT199: a click puts the card on the reader, or takes the tag that lies there off. */
  bindInput(el: HTMLElement, send: (input: PartInput) => void) {
    const click = (event: PointerEvent): void => {
      if (event.button !== 0) return;
      send(nodes.get(el)?.tag === '' ? { kind: 'press' } : { kind: 'release' });
    };
    el.addEventListener('pointerdown', click);
    return () => el.removeEventListener('pointerdown', click);
  },
};
