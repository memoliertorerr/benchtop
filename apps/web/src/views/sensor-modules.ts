/**
 * BT191: our own drawing of the purple 6-pin BME280/BMP280 breakout (packages/parts
 * sensors/bme280.ts), in mm: the board, its header along the bottom (VCC GND SCL SDA CSB SDO) on the
 * definition's pins, the sensor's metal lid with its vent hole, two mounting holes and the chip's
 * name. Static: the readings show in the Inspector.
 * BT192: the ZS-042 DS3231 module — a blue board, the DS3231 and the AT24C32, the CR2032 holder, the
 * 6-pin header down the left (32K SQW SCL SDA VCC GND) and the 4-pin one on the right, and the
 * clock's time in small print (the visual's `time`).
 */

import type { PartDefinition, PartProps, VisualState } from '@benchtop/core';
import type { ViewFactory } from './registry.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';

function el<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

/** The part types this view draws, with the chip name printed on each. */
export const SENSOR_MODULE_VIEW_TYPES: ReadonlyMap<string, string> = new Map([
  ['bme280', 'BME280'],
  ['bmp280', 'BMP280'],
  ['ds3231', 'DS3231'],
]);

const times = new WeakMap<HTMLElement, SVGTextElement>();

function label(svg: SVGSVGElement, x: number, y: number, text: string, size: number, anchor = 'middle', fill = '#f1ecf8'): SVGTextElement {
  const node = el('text', { x, y, 'font-size': size, fill, 'text-anchor': anchor, 'dominant-baseline': 'central', 'font-family': 'sans-serif' });
  node.textContent = text;
  svg.append(node);
  return node;
}

function drawRtc(svg: SVGSVGElement, def: PartDefinition): SVGTextElement {
  const { w, h } = def.size;
  svg.append(el('rect', { x: 0, y: 0, width: w, height: h, rx: 0.8, fill: '#1d4f91', stroke: '#123461', 'stroke-width': 0.2 }));
  svg.append(el('circle', { cx: w * 0.63, cy: h / 2, r: 9.2, fill: '#2a5ea8', stroke: '#9fb4d9', 'stroke-width': 0.25, 'stroke-dasharray': '0.6 0.4' }));
  label(svg, w * 0.63, h / 2 + 6.4, 'CR2032', 0.9, 'middle', '#9fb4d9');
  svg.append(el('rect', { x: 6, y: 5.5, width: 9.9, height: 6.2, rx: 0.3, fill: '#1c1d20' }));
  label(svg, 10.95, 8.6, 'DS3231', 1.15, 'middle', '#d9dce1');
  svg.append(el('rect', { x: 7.2, y: 14.2, width: 4.9, height: 3.9, rx: 0.2, fill: '#1c1d20' }));
  label(svg, 9.65, 16.15, '24C32', 0.75, 'middle', '#d9dce1');
  for (const pin of def.pins) {
    svg.append(el('rect', { x: pin.x - 0.75, y: pin.y - 0.75, width: 1.5, height: 1.5, fill: '#111', stroke: '#d7b35a', 'stroke-width': 0.25 }));
    const right = pin.x > w / 2;
    label(svg, right ? pin.x - 1.25 : pin.x + 1.25, pin.y, pin.name.replace(/\.2$/, ''), 0.7, right ? 'end' : 'start', '#e8eef8');
  }
  return label(svg, w * 0.63, h / 2, '', 1.0, 'middle', '#ffffff');
}

export const sensorModuleView: ViewFactory = {
  async create(def: PartDefinition, _props: PartProps) {
    const { w, h } = def.size;
    const wrapper = document.createElement('div');
    wrapper.className = 'sensor-module-view';
    const svg = el('svg', { width: `${w}mm`, height: `${h}mm`, viewBox: `0 0 ${w} ${h}`, overflow: 'visible' });
    if (def.type === 'ds3231') {
      times.set(wrapper, drawRtc(svg, def));
      wrapper.append(svg);
      return wrapper;
    }
    svg.append(el('rect', { x: 0, y: 0, width: w, height: h, rx: 0.7, fill: '#6b3fa0', stroke: '#4a2a72', 'stroke-width': 0.2 }));
    for (const cx of [1.6, w - 1.6]) svg.append(el('circle', { cx, cy: 1.6, r: 1.0, fill: '#f4f4f4', stroke: '#d0c2e4', 'stroke-width': 0.2 }));
    const lid = 2.5;
    svg.append(el('rect', { x: w / 2 - lid / 2, y: 2.4, width: lid, height: lid, rx: 0.2, fill: '#c8ccd2', stroke: '#8d939b', 'stroke-width': 0.12 }));
    svg.append(el('circle', { cx: w / 2 - 0.55, cy: 2.4 + 0.65, r: 0.22, fill: '#5e636b' }));
    const name = el('text', { x: w / 2, y: 6.4, 'font-size': 1.1, fill: '#f1ecf8', 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-family': 'sans-serif' });
    name.textContent = SENSOR_MODULE_VIEW_TYPES.get(def.type) ?? def.title;
    svg.append(name);
    for (const pin of def.pins) {
      svg.append(el('circle', { cx: pin.x, cy: pin.y, r: 0.55, fill: '#d7b35a', stroke: '#a8873a', 'stroke-width': 0.15 }));
      const label = el('text', { x: pin.x, y: pin.y - 1.3, 'font-size': 0.62, fill: '#f1ecf8', 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-family': 'sans-serif' });
      label.textContent = pin.name;
      svg.append(label);
    }
    wrapper.append(svg);
    return wrapper;
  },
  setProps(_el: HTMLElement, _props: PartProps) {},
  update(element: HTMLElement, visual: VisualState) {
    const time = times.get(element);
    if (time !== undefined && typeof visual.time === 'string') time.textContent = visual.time;
  },
};
