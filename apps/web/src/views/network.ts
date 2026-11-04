/**
 * Our own drawings of the network parts, in mm. The WiFi access point (BT98): a white home router
 * with two antennas, a power LED and a WiFi LED, its SSID on the front, and — while running — how
 * many stations joined and their addresses (the bench network's visual state: on, ssid, stations,
 * clients; BT101: a third LED, NET, for the real network — dark while `internet` is off, green
 * when on, amber while a connection is out, red after one failed). The HTTP server (BT99): a small dark server box with its hostname, its address and
 * port, a request counter and the last requests (visual state: address, hostname, requests, log).
 * The HTTP client (BT100): a light laptop-like box with the method and URL it sends, the last
 * status (green 2xx, amber others, red an error) and the body's start (visual state: url,
 * method, status, body, sent, busy).
 */

import type { PartDefinition, PartProps, VisualState } from '@benchtop/core';
import type { ViewFactory } from './registry.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';

function el<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

function text(x: number, y: number, label: string, size: number, fill: string, weight = 'normal'): SVGTextElement {
  const node = el('text', { x, y, 'font-size': size, fill, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-family': 'sans-serif', 'font-weight': weight });
  node.textContent = label;
  return node;
}

interface ApNodes {
  ssid: SVGTextElement;
  power: SVGCircleElement;
  wifi: SVGCircleElement;
  internet: SVGCircleElement;
  stations: SVGTextElement;
  clients: SVGTextElement;
  on: boolean;
}

/** BT101: the NET LED per visual `internet` state. */
const INTERNET_COLORS: Readonly<Record<string, string>> = { off: '#2c3a30', on: '#3ddc66', busy: '#f2b84b', error: '#ff5b5b' };

const nodes = new WeakMap<HTMLElement, ApNodes>();

const LED_ON = '#3ddc66';
const LED_OFF = '#2c3a30';

function draw(def: PartDefinition, svg: SVGSVGElement): ApNodes {
  const { w, h } = def.size;
  // Antennas behind the body.
  for (const x of [5, w - 5]) {
    svg.append(el('rect', { x: x - 0.9, y: 0, width: 1.8, height: 9, rx: 0.9, fill: '#2a2d33' }));
    svg.append(el('rect', { x: x - 1.4, y: 7.5, width: 2.8, height: 2, rx: 0.4, fill: '#3a3e45' }));
  }
  svg.append(el('rect', { x: 0.5, y: 8.5, width: w - 1, height: h - 9, rx: 2.4, fill: '#f2f3f5', stroke: '#c5c9cf', 'stroke-width': 0.35 }));
  svg.append(el('rect', { x: 0.5, y: h - 4.2, width: w - 1, height: 3.7, rx: 1.6, fill: '#dfe2e6' }));
  // WiFi arcs.
  const cx = 6.5;
  const cy = 17.4;
  for (const r of [1.6, 3, 4.4]) svg.append(el('path', { d: `M ${cx - r * 0.7} ${cy - r * 0.7} A ${r} ${r} 0 0 1 ${cx + r * 0.7} ${cy - r * 0.7}`, fill: 'none', stroke: '#5a8fd8', 'stroke-width': 0.6, 'stroke-linecap': 'round' }));
  svg.append(el('circle', { cx, cy: cy - 0.2, r: 0.6, fill: '#5a8fd8' }));
  const ssid = text(w / 2 + 2.5, 12.6, '', 2.6, '#2a2d33', 'bold');
  const stations = text(w / 2 + 2.5, 16.4, '', 2, '#5d636c');
  const clients = text(w / 2 + 2.5, 19.1, '', 1.6, '#5d636c');
  svg.append(ssid, stations, clients);
  const internet = el('circle', { cx: w - 8.6, cy: h - 2.35, r: 0.75, fill: LED_OFF });
  const power = el('circle', { cx: w - 6, cy: h - 2.35, r: 0.75, fill: LED_ON });
  const wifi = el('circle', { cx: w - 3.4, cy: h - 2.35, r: 0.75, fill: LED_ON });
  svg.append(internet, power, wifi);
  svg.append(text(w - 8.6, h - 0.9, 'NET', 0.9, '#7a8088'), text(w - 6, h - 0.9, 'PWR', 0.9, '#7a8088'), text(w - 3.4, h - 0.9, 'WiFi', 0.9, '#7a8088'));
  return { ssid, power, wifi, internet, stations, clients, on: true };
}

function showOn(n: ApNodes, on: boolean): void {
  n.on = on;
  n.power.setAttribute('fill', on ? LED_ON : LED_OFF);
  n.wifi.setAttribute('fill', on ? LED_ON : LED_OFF);
}

export const networkView: ViewFactory = {
  async create(def, props) {
    const { w, h } = def.size;
    const wrapper = document.createElement('div');
    wrapper.className = 'network-view';
    const svg = el('svg', { width: `${w}mm`, height: `${h}mm`, viewBox: `0 0 ${w} ${h}`, overflow: 'visible' });
    wrapper.append(svg);
    const n = draw(def, svg);
    nodes.set(wrapper, n);
    this.setProps(wrapper, props);
    return wrapper;
  },
  setProps(el: HTMLElement, props: PartProps) {
    const n = nodes.get(el);
    if (n === undefined) return;
    const ssid = typeof props.ssid === 'string' ? props.ssid : 'benchtop';
    n.ssid.textContent = ssid.length > 16 ? `${ssid.slice(0, 15)}…` : ssid;
    const security = typeof props.security === 'string' ? props.security : 'wpa2';
    n.stations.textContent = security === 'open' ? 'open network' : security.toUpperCase();
    n.clients.textContent = '';
    showOn(n, props.on !== false);
    n.internet.setAttribute('fill', props.internet === true ? (INTERNET_COLORS.on as string) : LED_OFF);
  },
  update(el: HTMLElement, visual: VisualState) {
    const n = nodes.get(el);
    if (n === undefined) return;
    if (typeof visual.on === 'boolean') showOn(n, visual.on);
    if (typeof visual.stations === 'number') n.stations.textContent = n.on ? `${visual.stations} station${visual.stations === 1 ? '' : 's'}` : 'off';
    if (typeof visual.clients === 'string') {
      const first = visual.clients.split('\n')[0] ?? '';
      const more = visual.clients === '' ? 0 : visual.clients.split('\n').length - 1;
      n.clients.textContent = more > 0 ? `${first} +${more}` : first;
    }
    if (typeof visual.internet === 'string') n.internet.setAttribute('fill', INTERNET_COLORS[visual.internet] ?? LED_OFF);
  },
};

interface ServerNodes {
  name: SVGTextElement;
  address: SVGTextElement;
  count: SVGTextElement;
  log: SVGTextElement[];
  activity: SVGCircleElement;
}

const serverNodes = new WeakMap<HTMLElement, ServerNodes>();

function drawServer(def: PartDefinition, svg: SVGSVGElement): ServerNodes {
  const { w, h } = def.size;
  svg.append(el('rect', { x: 0.4, y: 0.4, width: w - 0.8, height: h - 0.8, rx: 1.6, fill: '#22262d', stroke: '#0f1114', 'stroke-width': 0.35 }));
  for (const y of [2.2, 4.2]) svg.append(el('rect', { x: 2, y, width: w - 4, height: 1.2, rx: 0.4, fill: '#30353d' }));
  const activity = el('circle', { cx: w - 3, cy: 2.8, r: 0.6, fill: LED_OFF });
  svg.append(activity);
  const name = text(w / 2, 8, '', 2.4, '#e9edf2', 'bold');
  const address = text(w / 2, 10.8, '', 1.7, '#9aa3ad');
  const count = text(w / 2, 13.2, '', 1.6, '#7f8a96');
  svg.append(name, address, count);
  const log: SVGTextElement[] = [];
  for (let i = 0; i < 3; i++) {
    const line = text(w / 2, 15.6 + i * 1.9, '', 1.45, '#6fd18b');
    line.setAttribute('font-family', 'ui-monospace, monospace');
    log.push(line);
    svg.append(line);
  }
  return { name, address, count, log, activity };
}

export const httpServerView: ViewFactory = {
  async create(def, props) {
    const { w, h } = def.size;
    const wrapper = document.createElement('div');
    wrapper.className = 'network-view';
    const svg = el('svg', { width: `${w}mm`, height: `${h}mm`, viewBox: `0 0 ${w} ${h}`, overflow: 'visible' });
    wrapper.append(svg);
    serverNodes.set(wrapper, drawServer(def, svg));
    this.setProps(wrapper, props);
    return wrapper;
  },
  setProps(el: HTMLElement, props: PartProps) {
    const n = serverNodes.get(el);
    if (n === undefined) return;
    const hostname = typeof props.hostname === 'string' && props.hostname !== '' ? props.hostname : 'HTTP server';
    n.name.textContent = hostname.length > 18 ? `${hostname.slice(0, 17)}…` : hostname;
    const address = typeof props.address === 'string' && props.address !== '' ? props.address : 'auto';
    n.address.textContent = `${address}:${typeof props.port === 'number' ? props.port : 80}`;
    n.count.textContent = '';
    for (const line of n.log) line.textContent = '';
  },
  update(el: HTMLElement, visual: VisualState) {
    const n = serverNodes.get(el);
    if (n === undefined) return;
    if (typeof visual.address === 'string') n.address.textContent = visual.address;
    if (typeof visual.requests === 'number') {
      n.count.textContent = `${visual.requests} request${visual.requests === 1 ? '' : 's'}`;
      n.activity.setAttribute('fill', visual.requests > 0 ? LED_ON : LED_OFF);
    }
    if (typeof visual.log === 'string') {
      const lines = visual.log === '' ? [] : visual.log.split('\n').slice(-n.log.length);
      n.log.forEach((line, i) => (line.textContent = lines[i] ?? ''));
    }
  },
};

interface ClientNodes {
  request: SVGTextElement;
  status: SVGTextElement;
  body: SVGTextElement[];
  count: SVGTextElement;
  activity: SVGCircleElement;
  /** BT117: " · <network>" after the count when the part names its network (a board's soft AP, say). */
  network: string;
}

const clientNodes = new WeakMap<HTMLElement, ClientNodes>();
const BODY_LINES = 3;
const BODY_LINE_CHARS = 26;

function drawClient(def: PartDefinition, svg: SVGSVGElement): ClientNodes {
  const { w, h } = def.size;
  // A screen in a light frame on a thin base: a laptop seen from the front.
  svg.append(el('rect', { x: 0.4, y: 0.4, width: w - 0.8, height: h - 3.4, rx: 1.4, fill: '#d9dde3', stroke: '#9aa1aa', 'stroke-width': 0.3 }));
  svg.append(el('rect', { x: 1.6, y: 1.6, width: w - 3.2, height: h - 5.8, rx: 0.6, fill: '#101418' }));
  svg.append(el('path', { d: `M 0.2 ${h - 2.6} h ${w - 0.4} l -1.6 2.2 h ${-(w - 3.6)} z`, fill: '#c3c8cf', stroke: '#9aa1aa', 'stroke-width': 0.25 }));
  const activity = el('circle', { cx: w - 3, cy: 3, r: 0.55, fill: LED_OFF });
  const request = text(w / 2, 3.4, '', 1.45, '#e9edf2', 'bold');
  const status = text(w / 2, 6.6, '', 2.6, '#7f8a96', 'bold');
  const count = text(w / 2, h - 1.3, '', 1.3, '#4c535c');
  svg.append(activity, request, status, count);
  const body: SVGTextElement[] = [];
  for (let i = 0; i < BODY_LINES; i++) {
    const line = text(w / 2, 9.6 + i * 1.9, '', 1.35, '#b7c0ca');
    line.setAttribute('font-family', 'ui-monospace, monospace');
    body.push(line);
    svg.append(line);
  }
  return { request, status, body, count, activity, network: '' };
}

function shortUrl(url: string): string {
  const bare = url.replace(/^http:\/\//i, '');
  return bare.length > 24 ? `${bare.slice(0, 23)}…` : bare;
}

export const httpClientView: ViewFactory = {
  async create(def, props) {
    const { w, h } = def.size;
    const wrapper = document.createElement('div');
    wrapper.className = 'network-view';
    const svg = el('svg', { width: `${w}mm`, height: `${h}mm`, viewBox: `0 0 ${w} ${h}`, overflow: 'visible' });
    wrapper.append(svg);
    clientNodes.set(wrapper, drawClient(def, svg));
    this.setProps(wrapper, props);
    return wrapper;
  },
  setProps(el: HTMLElement, props: PartProps) {
    const n = clientNodes.get(el);
    if (n === undefined) return;
    const method = typeof props.method === 'string' && props.method !== '' ? props.method.toUpperCase() : 'GET';
    n.request.textContent = `${method} ${shortUrl(typeof props.url === 'string' ? props.url : '')}`;
    n.status.textContent = '—';
    n.status.setAttribute('fill', '#7f8a96');
    for (const line of n.body) line.textContent = '';
    const every = typeof props.interval === 'number' && props.interval > 0 ? `every ${props.interval} ms` : 'press Send';
    const network = typeof props.network === 'string' ? props.network : '';
    n.network = network === '' ? '' : ` · ${network.length > 14 ? `${network.slice(0, 13)}…` : network}`;
    n.count.textContent = `${every}${n.network}`;
  },
  update(el: HTMLElement, visual: VisualState) {
    const n = clientNodes.get(el);
    if (n === undefined) return;
    if (typeof visual.url === 'string') n.request.textContent = `${typeof visual.method === 'string' ? visual.method : 'GET'} ${shortUrl(visual.url)}`;
    if (typeof visual.status === 'string') {
      const code = Number(visual.status);
      n.status.textContent = visual.status === '' ? '—' : visual.status;
      n.status.setAttribute('fill', visual.status === 'error' ? '#ff6b6b' : code >= 200 && code < 300 ? '#6fd18b' : visual.status === '' ? '#7f8a96' : '#f2b84b');
    }
    if (typeof visual.body === 'string') {
      const flat = visual.body.replace(/\s+/g, ' ').trim();
      n.body.forEach((line, i) => (line.textContent = flat.slice(i * BODY_LINE_CHARS, (i + 1) * BODY_LINE_CHARS)));
    }
    if (typeof visual.sent === 'number') n.count.textContent = `${visual.sent} sent${n.network}`;
    if (typeof visual.busy === 'boolean') n.activity.setAttribute('fill', visual.busy ? LED_ON : LED_OFF);
  },
};
