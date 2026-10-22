/**
 * One generic adapter over @wokwi/elements (MIT). Each part type names its element tag and the
 * module that defines it, imported by deep path on first use — never the package root, which
 * registers all 50 elements (~450 KB). Props and visual keys are mapped onto element
 * properties.
 */

import type { PartInput, PartProps, VisualState } from '@benchtop/core';
import { channelInput } from '@benchtop/parts';
import type { ViewFactory } from './registry.ts';
import { applyIli9341 } from './ili9341.ts';
import { applySsd1306 } from './ssd1306.ts';

interface WokwiSpec {
  tag: string;
  load(): Promise<unknown>;
  props?(props: PartProps): Record<string, unknown>;
  visual?(visual: VisualState): Record<string, unknown>;
  /** For elements a key map can't serve (LCD text and fonts): applies visual state directly. */
  apply?(el: HTMLElement, visual: VisualState): void;
  /** Element events → part input(s), for parts you operate while the bench runs. */
  inputs?: Readonly<Record<string, (el: HTMLElement, event: Event) => PartInput | readonly PartInput[] | null>>;
}

const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

/** Segment brightness → the elements' on/off values (they have no dimming). */
const litValues = (v: unknown): number[] => (Array.isArray(v) ? v.map((b: unknown) => (num(b) > 0.05 ? 1 : 0)) : []);

interface LcdElement {
  cols: number;
  rows: number;
  characters: Uint8Array;
  font: Uint8Array;
  cursor: boolean;
  blink: boolean;
  cursorX: number;
  cursorY: number;
  backlight: boolean;
  requestUpdate(name?: string): void;
}

/** The HD44780 A00 font, loaded with the first LCD (5×8 rows, bit 0 = leftmost pixel). */
let fontA00: Uint8Array | null = null;
const lcdState = new WeakMap<HTMLElement, { chars: Uint8Array; font: Uint8Array | null; cgram: string }>();

/**
 * LCD visual state: characters into a preallocated Uint8Array (blank while the display is
 * off), CGRAM into a per-element copy of the font at codes 0–7 and 8–15 (the HD44780 stores
 * bit 4 as the leftmost pixel; the element's font has it at bit 0).
 */
function applyLcd(el: HTMLElement, visual: VisualState): void {
  const lcd = el as unknown as LcdElement;
  let state = lcdState.get(el);
  if (state === undefined) {
    state = { chars: new Uint8Array(lcd.cols * lcd.rows), font: null, cgram: '' };
    lcdState.set(el, state);
  }
  const displayOn = visual.displayOn === true;
  const chars = Array.isArray(visual.characters) ? (visual.characters as readonly number[]) : [];
  for (let i = 0; i < state.chars.length; i++) state.chars[i] = displayOn ? (chars[i] ?? 0x20) : 0x20;
  lcd.characters = state.chars;
  lcd.requestUpdate('characters');
  const cgram = Array.isArray(visual.cgram) ? (visual.cgram as readonly number[]) : [];
  const key = cgram.join(',');
  if (key !== state.cgram && fontA00 !== null) {
    state.cgram = key;
    state.font ??= fontA00.slice();
    for (let i = 0; i < 64; i++) {
      const row = cgram[i] ?? 0;
      let mirrored = 0;
      for (let bit = 0; bit < 5; bit++) if (row & (1 << (4 - bit))) mirrored |= 1 << bit;
      state.font[i] = mirrored;
      state.font[64 + i] = mirrored;
    }
    lcd.font = state.font;
    lcd.requestUpdate('font');
  }
  lcd.cursor = displayOn && visual.cursor === true;
  lcd.blink = displayOn && visual.blink === true;
  lcd.cursorX = num(visual.cursorX);
  lcd.cursorY = num(visual.cursorY);
  lcd.backlight = visual.backlight === true;
}

async function loadLcd(element: () => Promise<unknown>): Promise<void> {
  const [, font] = await Promise.all([element(), import('@wokwi/elements/dist/esm/lcd1602-font-a00.js')]);
  fontA00 = font.fontA00;
}

const lcdSpec = (tag: string, element: () => Promise<unknown>, pins: 'full' | 'i2c'): WokwiSpec => ({
  tag,
  load: () => loadLcd(element),
  props: (p) => ({ pins, background: String(p.background ?? 'green') }),
  apply: applyLcd,
});

const loadLcd1602 = () => import('@wokwi/elements/dist/esm/lcd1602-element.js');
const loadLcd2004 = () => import('@wokwi/elements/dist/esm/lcd2004-element.js');
const load7Segment = () => import('@wokwi/elements/dist/esm/7segment-element.js');

interface PixelElement extends HTMLElement {
  setPixel(...args: unknown[]): unknown;
}

const pixelCache = new WeakMap<HTMLElement, number[]>();

/**
 * NeoPixel views: the chain's colors (0xRRGGBB) onto the element's pixels, only those that
 * changed. Matrix elements get (row, col) — serpentine rows run backwards — ring elements an
 * index. Colors go in as 0..1 per channel.
 */
function pixelSpec(tag: string, load: () => Promise<unknown>, shape: { rows: number; cols: number } | { pixels: number }): WokwiSpec {
  return {
    tag,
    load,
    props: (p) => ({ ...shape, animation: false, ...('rows' in shape ? { serpentine: p.serpentine === true } : {}) }),
    apply(el, visual) {
      const pixels = Array.isArray(visual.pixels) ? (visual.pixels as readonly number[]) : [];
      let cache = pixelCache.get(el);
      if (cache === undefined) pixelCache.set(el, (cache = new Array<number>(pixels.length).fill(-1)));
      const target = el as PixelElement;
      const serpentine = (el as unknown as { serpentine?: boolean }).serpentine === true;
      for (let i = 0; i < pixels.length; i++) {
        const c = pixels[i] ?? 0;
        if (cache[i] === c) continue;
        cache[i] = c;
        const rgb = { r: ((c >> 16) & 0xff) / 255, g: ((c >> 8) & 0xff) / 255, b: (c & 0xff) / 255 };
        if ('rows' in shape) {
          const row = Math.floor(i / shape.cols);
          const col = i % shape.cols;
          target.setPixel(row, serpentine && row % 2 === 1 ? shape.cols - 1 - col : col, rgb);
        } else {
          target.setPixel(i, rgb);
        }
      }
    },
  };
}

/** An IR remote element's key event as the receivers' input (`ir:<command>`). */
function irKey(event: Event, down: boolean): PartInput | null {
  const code = ((event as CustomEvent<unknown>).detail as { irCode?: unknown } | null)?.irCode;
  return typeof code === 'number' ? { kind: 'key', key: `ir:${code}`, down } : null;
}

/** A keypad element event's key as part input. */
function keypadKey(event: Event, down: boolean): PartInput | null {
  const key = ((event as CustomEvent<unknown>).detail as { key?: unknown } | null)?.key;
  return typeof key === 'string' ? { kind: 'key', key, down } : null;
}

const sevenSegmentSpec = (digits: number): WokwiSpec => ({
  tag: 'wokwi-7segment',
  load: load7Segment,
  props: (p) => ({ digits, colon: p.colon === true, color: String(p.color ?? 'red') }),
  visual: (v) => ({ values: litValues(v.values), colonValue: num(v.colon) > 0.05 }),
});

const SPECS: Readonly<Record<string, WokwiSpec>> = {
  'arduino-uno': {
    tag: 'wokwi-arduino-uno',
    load: () => import('@wokwi/elements/dist/esm/arduino-uno-element.js'),
    visual: (v) => ({ led13: num(v.ledL) > 0.5, ledPower: v.ledPower === true, ledTX: v.ledTx === true, ledRX: v.ledRx === true }),
  },
  'arduino-nano': {
    tag: 'wokwi-arduino-nano',
    load: () => import('@wokwi/elements/dist/esm/arduino-nano-element.js'),
    visual: (v) => ({ led13: num(v.ledL) > 0.5, ledPower: v.ledPower === true, ledTX: v.ledTx === true, ledRX: v.ledRx === true }),
  },
  'arduino-mega': {
    tag: 'wokwi-arduino-mega',
    load: () => import('@wokwi/elements/dist/esm/arduino-mega-element.js'),
    visual: (v) => ({ led13: num(v.ledL) > 0.5, ledPower: v.ledPower === true, ledTX: v.ledTx === true, ledRX: v.ledRx === true }),
  },
  'esp32-devkit-v1': {
    tag: 'wokwi-esp32-devkit-v1',
    load: () => import('@wokwi/elements/dist/esm/esp32-devkit-v1-element.js'),
    visual: (v) => ({ led1: num(v.led1) > 0.5, ledPower: v.ledPower === true }),
  },
  resistor: {
    tag: 'wokwi-resistor',
    load: () => import('@wokwi/elements/dist/esm/resistor-element.js'),
    props: (p) => ({ value: String(p.ohms ?? 220) }),
  },
  led: {
    tag: 'wokwi-led',
    load: () => import('@wokwi/elements/dist/esm/led-element.js'),
    props: (p) => ({ color: String(p.color ?? 'red') }),
    visual: (v) => ({ value: num(v.brightness) > 0, brightness: num(v.brightness) }),
  },
  'rgb-led': {
    tag: 'wokwi-rgb-led',
    load: () => import('@wokwi/elements/dist/esm/rgb-led-element.js'),
    visual: (v) => ({ ledRed: num(v.ledRed), ledGreen: num(v.ledGreen), ledBlue: num(v.ledBlue) }),
  },
  pushbutton: {
    tag: 'wokwi-pushbutton',
    load: () => import('@wokwi/elements/dist/esm/pushbutton-element.js'),
    props: (p) => ({ color: String(p.color ?? 'red') }),
    visual: (v) => ({ pressed: v.pressed === true }),
    inputs: { 'button-press': () => ({ kind: 'press' }), 'button-release': () => ({ kind: 'release' }) },
  },
  'slide-switch': {
    tag: 'wokwi-slide-switch',
    load: () => import('@wokwi/elements/dist/esm/slide-switch-element.js'),
    props: (p) => ({ value: num(p.value) >= 0.5 ? 1 : 0 }),
    visual: (v) => ({ value: num(v.value) }),
    inputs: { input: (el) => ({ kind: 'value', value: num((el as unknown as { value: unknown }).value) }) },
  },
  potentiometer: {
    tag: 'wokwi-potentiometer',
    load: () => import('@wokwi/elements/dist/esm/potentiometer-element.js'),
    props: (p) => ({ value: Math.round(num(p.value) * 1023) }),
    visual: (v) => ({ value: Math.round(num(v.value) * 1023) }),
    inputs: { input: (el) => ({ kind: 'value', value: num((el as unknown as { value: unknown }).value) / 1023 }) },
  },
  buzzer: {
    tag: 'wokwi-buzzer',
    load: () => import('@wokwi/elements/dist/esm/buzzer-element.js'),
    visual: (v) => ({ hasSignal: v.sounding === true || num(v.frequency) > 0 }),
  },
  servo: {
    tag: 'wokwi-servo',
    load: () => import('@wokwi/elements/dist/esm/servo-element.js'),
    visual: (v) => ({ angle: num(v.angle) }),
  },
  'stepper-bipolar': {
    tag: 'wokwi-stepper-motor',
    load: () => import('@wokwi/elements/dist/esm/stepper-motor-element.js'),
    props: () => ({ size: 17, value: '', units: '' }),
    visual: (v) => ({ angle: num(v.angle) % 360 }),
  },
  'neopixel-strip': pixelSpec('wokwi-neopixel-matrix', () => import('@wokwi/elements/dist/esm/neopixel-matrix-element.js'), { rows: 1, cols: 8 }),
  'neopixel-matrix': pixelSpec('wokwi-neopixel-matrix', () => import('@wokwi/elements/dist/esm/neopixel-matrix-element.js'), { rows: 8, cols: 8 }),
  'neopixel-ring': pixelSpec('wokwi-led-ring', () => import('@wokwi/elements/dist/esm/led-ring-element.js'), { pixels: 16 }),
  'relay-ks2e-m-dc5': {
    tag: 'wokwi-ks2e-m-dc5',
    load: () => import('@wokwi/elements/dist/esm/ks2e-m-dc5-element.js'),
    // The element draws no contact state: the view marks it (CSS) while the contacts are on NO.
    apply: (el, v) => {
      el.dataset.contacts = v.contactsNO === true ? 'no' : 'nc';
    },
  },
  lcd1602: lcdSpec('wokwi-lcd1602', loadLcd1602, 'full'),
  lcd2004: lcdSpec('wokwi-lcd2004', loadLcd2004, 'full'),
  'lcd1602-i2c': lcdSpec('wokwi-lcd1602', loadLcd1602, 'i2c'),
  'lcd2004-i2c': lcdSpec('wokwi-lcd2004', loadLcd2004, 'i2c'),
  'seven-segment': sevenSegmentSpec(1),
  'seven-segment-2': sevenSegmentSpec(2),
  'seven-segment-4': sevenSegmentSpec(4),
  'ir-receiver': {
    tag: 'wokwi-ir-receiver',
    load: () => import('@wokwi/elements/dist/esm/ir-receiver-element.js'),
  },
  'ir-remote': {
    tag: 'wokwi-ir-remote',
    load: () => import('@wokwi/elements/dist/esm/ir-remote-element.js'),
    // The canvas routes these to every IR receiver (views/ir-remote.ts).
    inputs: {
      'button-press': (_el, event) => irKey(event, true),
      'button-release': (_el, event) => irKey(event, false),
    },
  },
  'flame-sensor': {
    tag: 'wokwi-flame-sensor',
    load: () => import('@wokwi/elements/dist/esm/flame-sensor-element.js'),
    visual: (v) => ({ ledPower: v.ledPower === true, ledSignal: v.ledSignal === true }),
  },
  'gas-sensor': {
    tag: 'wokwi-gas-sensor',
    load: () => import('@wokwi/elements/dist/esm/gas-sensor-element.js'),
    visual: (v) => ({ ledPower: v.ledPower === true, ledD0: v.ledD0 === true }),
  },
  hx711: {
    tag: 'wokwi-hx711',
    load: () => import('@wokwi/elements/dist/esm/hx711-element.js'),
    props: (p) => ({ type: String(p.type ?? '50kg') }),
  },
  ili9341: {
    tag: 'wokwi-ili9341',
    load: () => import('@wokwi/elements/dist/esm/ili9341-element.js'),
    apply: applyIli9341,
  },
  ssd1306: {
    tag: 'wokwi-ssd1306',
    load: () => import('@wokwi/elements/dist/esm/ssd1306-element.js'),
    apply: applySsd1306,
  },
  'slide-potentiometer': {
    tag: 'wokwi-slide-potentiometer',
    load: () => import('@wokwi/elements/dist/esm/slide-potentiometer-element.js'),
    props: (p) => ({ value: Math.round(num(p.value) * 100) }),
    visual: (v) => ({ value: Math.round(num(v.value) * 100) }),
    inputs: { input: (el) => ({ kind: 'value', value: num((el as unknown as { value: unknown }).value) / 100 }) },
  },
  'analog-joystick': {
    tag: 'wokwi-analog-joystick',
    load: () => import('@wokwi/elements/dist/esm/analog-joystick-element.js'),
    // The element's xValue is +1 to the left; ours is +1 to the right (right reads high).
    visual: (v) => ({ xValue: -num(v.x), yValue: num(v.y), pressed: v.pressed === true }),
    inputs: {
      input: (el) => {
        const j = el as unknown as { xValue: unknown; yValue: unknown };
        return [channelInput('x', -num(j.xValue)), channelInput('y', num(j.yValue))];
      },
      'button-press': () => ({ kind: 'press' }),
      'button-release': () => ({ kind: 'release' }),
    },
  },
  'ky-040': {
    tag: 'wokwi-ky-040',
    load: () => import('@wokwi/elements/dist/esm/ky-040-element.js'),
    inputs: {
      'rotate-cw': () => ({ kind: 'key', key: 'cw', down: true }),
      'rotate-ccw': () => ({ kind: 'key', key: 'ccw', down: true }),
      'button-press': () => ({ kind: 'press' }),
      'button-release': () => ({ kind: 'release' }),
    },
  },
  'membrane-keypad': {
    tag: 'wokwi-membrane-keypad',
    load: () => import('@wokwi/elements/dist/esm/membrane-keypad-element.js'),
    props: () => ({ connector: true }),
    inputs: {
      'button-press': (_el, event) => keypadKey(event, true),
      'button-release': (_el, event) => keypadKey(event, false),
    },
  },
  'dip-switch-8': {
    tag: 'wokwi-dip-switch-8',
    load: () => import('@wokwi/elements/dist/esm/dip-switch-8-element.js'),
    visual: (v) => ({ values: Array.isArray(v.values) ? [...(v.values as readonly number[])] : [] }),
    inputs: {
      'switch-change': (_el, event) => {
        const index = (event as CustomEvent<unknown>).detail;
        return typeof index === 'number' ? { kind: 'key', key: String(index + 1), down: true } : null;
      },
    },
  },
  'tilt-switch': { tag: 'wokwi-tilt-switch', load: () => import('@wokwi/elements/dist/esm/tilt-switch-element.js') },
  'pir-motion-sensor': { tag: 'wokwi-pir-motion-sensor', load: () => import('@wokwi/elements/dist/esm/pir-motion-sensor-element.js') },
  'photoresistor-sensor': {
    tag: 'wokwi-photoresistor-sensor',
    load: () => import('@wokwi/elements/dist/esm/photoresistor-sensor-element.js'),
    visual: (v) => ({ ledDO: v.ledDO === true, ledPower: true }),
  },
  'ntc-temperature-sensor': { tag: 'wokwi-ntc-temperature-sensor', load: () => import('@wokwi/elements/dist/esm/ntc-temperature-sensor-element.js') },
  'small-sound-sensor': {
    tag: 'wokwi-small-sound-sensor',
    load: () => import('@wokwi/elements/dist/esm/small-sound-sensor-element.js'),
    visual: (v) => ({ ledPower: true, ledSignal: v.ledSignal === true }),
  },
  'big-sound-sensor': {
    tag: 'wokwi-big-sound-sensor',
    load: () => import('@wokwi/elements/dist/esm/big-sound-sensor-element.js'),
    visual: (v) => ({ led1: true, led2: v.ledSignal === true }),
  },
  dht22: { tag: 'wokwi-dht22', load: () => import('@wokwi/elements/dist/esm/dht22-element.js') },
  'hc-sr04': { tag: 'wokwi-hc-sr04', load: () => import('@wokwi/elements/dist/esm/hc-sr04-element.js') },
  ds1307: { tag: 'wokwi-ds1307', load: () => import('@wokwi/elements/dist/esm/ds1307-element.js') },
  mpu6050: { tag: 'wokwi-mpu6050', load: () => import('@wokwi/elements/dist/esm/mpu6050-element.js') },
  'microsd-card': { tag: 'wokwi-microsd-card', load: () => import('@wokwi/elements/dist/esm/microsd-card-element.js') },
  'led-bar-graph': {
    tag: 'wokwi-led-bar-graph',
    load: () => import('@wokwi/elements/dist/esm/led-bar-graph-element.js'),
    props: (p) => ({ color: String(p.color ?? 'red') }),
    visual: (v) => ({ values: litValues(v.values) }),
  },
};

/** Part types whose elements you operate while running (they take the pointer then). */
export function isInteractive(type: string): boolean {
  return SPECS[type]?.inputs !== undefined;
}

export function hasWokwiView(type: string): boolean {
  return Object.hasOwn(SPECS, type);
}

function assign(el: HTMLElement, values: Record<string, unknown>): void {
  const target = el as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(values)) {
    if (target[key] !== value) target[key] = value;
  }
}

export const wokwiView: ViewFactory = {
  async create(def, props) {
    const spec = SPECS[def.type];
    if (spec === undefined) throw new Error(`no @wokwi/elements view for ${def.type}`);
    await spec.load();
    const el = document.createElement(spec.tag);
    el.dataset.partType = def.type;
    if (spec.props) assign(el, spec.props(props));
    return el;
  },
  setProps(el, props) {
    const spec = SPECS[el.dataset.partType ?? ''];
    if (spec?.props) assign(el, spec.props(props));
  },
  update(el, visual) {
    const spec = SPECS[el.dataset.partType ?? ''];
    if (spec?.apply) spec.apply(el, visual);
    else if (spec?.visual) assign(el, spec.visual(visual));
  },
  bindInput(el, send) {
    const inputs = SPECS[el.dataset.partType ?? '']?.inputs;
    if (inputs === undefined) return () => {};
    const handlers = Object.entries(inputs).map(([name, toInput]) => {
      const handler = (event: Event): void => {
        const input = toInput(el, event);
        if (input === null) return;
        if (Array.isArray(input)) for (const one of input) send(one);
        else send(input as PartInput);
      };
      el.addEventListener(name, handler);
      return [name, handler] as const;
    });
    return () => {
      for (const [name, handler] of handlers) el.removeEventListener(name, handler);
    };
  },
};
