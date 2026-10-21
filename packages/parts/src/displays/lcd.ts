/**
 * Character LCDs: LCD1602 (16×2) and LCD2004 (20×4), each wired in parallel (4- or 8-bit, the
 * element's pins="full") or behind a PCF8574 I2C backpack (pins="i2c", prop `address`).
 * Behavior is the shared HD44780 core; the parallel parts latch on E's falling edge, reading
 * RS and D0–D7 from their nets (floating reads 0). Visual state: `characters` (codes in
 * display order, after display shift), `cursor`, `blink`, `cursorX`, `cursorY`, `displayOn`,
 * `backlight` (parallel: A at 1 and K at 0; I2C: P3) and `cgram` (64 row bytes).
 * Pins and sizes from @wokwi/elements 1.9.2 lcd1602-element / lcd2004-element.
 */

import { type NetState, type PartContext, type PartDefinition, type PinDef, Strength, type VisualState } from '@benchtop/core';
import { definePart } from '../define.ts';
import { Hd44780 } from './hd44780.ts';
import { Pcf8574Backpack, parseBackpackAddress } from './pcf8574.ts';

const PARALLEL_X: readonly [string, number][] = [
  ['VSS', 8.467],
  ['VDD', 10.98],
  ['V0', 13.626],
  ['RS', 16.007],
  ['RW', 18.653],
  ['E', 21.167],
  ['D0', 23.68],
  ['D1', 26.326],
  ['D2', 28.84],
  ['D3', 31.353],
  ['D4', 33.867],
  ['D5', 36.38],
  ['D6', 38.894],
  ['D7', 41.407],
  ['A', 44.053],
  ['K', 46.567],
];

const ROLES: Readonly<Record<string, PinDef['role']>> = { VSS: 'ground', VDD: 'power', V0: 'analog', A: 'passive', K: 'passive', GND: 'ground', VCC: 'power' };

function parallelPins(y: number): PinDef[] {
  return PARALLEL_X.map(([name, x]) => ({ name, x, y, role: ROLES[name] ?? 'digital' }));
}

const I2C_PINS: PinDef[] = [
  { name: 'GND', x: 1.058, y: 8.467, role: 'ground' },
  { name: 'VCC', x: 1.058, y: 10.98, role: 'power' },
  { name: 'SDA', x: 1.058, y: 13.494, role: 'digital' },
  { name: 'SCL', x: 1.058, y: 16.007, role: 'digital' },
];

const on = (s: NetState): boolean => s.level === 1 && s.strength >= Strength.weak;

/** The visual-state object of one LCD, updated in place at each frame. */
function lcdVisual(lcd: Hd44780) {
  const characters: number[] = new Array<number>(lcd.cols * lcd.rows).fill(0x20);
  const cgram: number[] = new Array<number>(64).fill(0);
  const visual = { characters, cursor: false, blink: false, cursorX: -1, cursorY: -1, displayOn: false, backlight: false, cgram };
  return (backlight: boolean): VisualState => {
    lcd.characters(characters);
    for (let i = 0; i < 64; i++) cgram[i] = lcd.cgram[i];
    const [x, y] = lcd.cursorPosition();
    visual.cursor = lcd.cursorOn;
    visual.blink = lcd.blinkOn;
    visual.cursorX = x;
    visual.cursorY = y;
    visual.displayOn = lcd.displayOn;
    visual.backlight = backlight;
    return visual;
  };
}

function parallelModel(ctx: PartContext, cols: number, rows: number) {
  const lcd = new Hd44780(cols, rows);
  const rs = ctx.pin('RS');
  const rw = ctx.pin('RW');
  const e = ctx.pin('E');
  const data = ['D0', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7'].map((name) => ctx.pin(name));
  const anode = ctx.pin('A');
  const cathode = ctx.pin('K');
  let eHigh = false;
  let backlight = false;
  const visual = lcdVisual(lcd);
  e.onChange((state) => {
    const high = state.level === 1;
    if (eHigh && !high && rw.read().level !== 1) {
      let bus = 0;
      for (let bit = 0; bit < 8; bit++) if (data[bit].read().level === 1) bus |= 1 << bit;
      const before = lcd.version;
      lcd.latch(rs.read().level === 1, bus);
      if (lcd.version !== before) ctx.invalidate();
    }
    eHigh = high;
  });
  const light = (): void => {
    const now = on(anode.read()) && cathode.read().level === 0;
    if (now !== backlight) {
      backlight = now;
      ctx.invalidate();
    }
  };
  anode.onChange(light);
  cathode.onChange(light);
  return {
    visual: () => visual(backlight),
    reset() {
      lcd.reset();
      eHigh = e.read().level === 1;
      backlight = on(anode.read()) && cathode.read().level === 0;
      ctx.invalidate();
    },
  };
}

function i2cModel(ctx: PartContext, cols: number, rows: number, address: string | number | boolean) {
  const lcd = new Hd44780(cols, rows);
  const backpack = new Pcf8574Backpack(parseBackpackAddress(address), lcd, () => ctx.invalidate());
  ctx.attachI2c('SDA', 'SCL', backpack);
  const visual = lcdVisual(lcd);
  return {
    visual: () => visual(backpack.backlight),
    reset() {
      lcd.reset();
      backpack.reset();
      ctx.invalidate();
    },
  };
}

function parallelLcd(type: string, title: string, cols: number, rows: number, size: { w: number; h: number }, pinY: number): PartDefinition {
  return definePart({
    type,
    title,
    category: 'displays',
    size,
    pins: parallelPins(pinY),
    defaults: { background: 'green' },
    createModel: (ctx) => parallelModel(ctx, cols, rows),
  });
}

function i2cLcd(type: string, title: string, cols: number, rows: number, size: { w: number; h: number }): PartDefinition {
  return definePart({
    type,
    title,
    category: 'displays',
    size,
    pins: I2C_PINS,
    defaults: { address: '0x27', background: 'green' },
    createModel: (ctx, props) => i2cModel(ctx, cols, rows, props.address),
  });
}

const SIZE_1602 = { w: 80, h: 36 };
const SIZE_2004 = { w: 94.05, h: 47.5 };

export const lcd1602 = parallelLcd('lcd1602', 'LCD 16×2', 16, 2, SIZE_1602, 34.652);
export const lcd2004 = parallelLcd('lcd2004', 'LCD 20×4', 20, 4, SIZE_2004, 46.154);
export const lcd1602I2c = i2cLcd('lcd1602-i2c', 'LCD 16×2 (I2C)', 16, 2, SIZE_1602);
export const lcd2004I2c = i2cLcd('lcd2004-i2c', 'LCD 20×4 (I2C)', 20, 4, SIZE_2004);
