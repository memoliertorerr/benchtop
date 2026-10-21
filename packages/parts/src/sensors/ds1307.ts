/**
 * DS1307 real-time clock on I2C at 0x68 (Maxim datasheet). Registers 0x00–0x07 in BCD:
 * seconds (CH bit 7 halts the clock), minutes, hours (bit 6 = 12 h mode, bit 5 = PM there),
 * day 1–7, date, month, year 00–99, control (OUT bit 7, SQWE bit 4, RS1:0); 0x08–0x3F are 56
 * bytes of RAM. The first written byte of a transaction sets the pointer; reads and writes
 * auto-increment and wrap 0x3F → 0x00. A tick every 500 ms (one preallocated callback) toggles
 * the 1 Hz square wave and, every second one while CH=0, advances the clock with full carry
 * (month lengths, leap years 2000–2099, 12/24 h). Writing the seconds register restarts the
 * sub-second phase. SQW: the OUT level when SQWE=0, 1 Hz when SQWE=1 and RS=00; other rates are
 * in the plan's Later list. Props: `start` ('YYYY-MM-DDThh:mm:ss', or 'now') and `halted`.
 * Pins from @wokwi/elements 1.9.2 ds1307-element.
 */

import { type I2cDevice, NS_PER_MS, type PartContext, Strength } from '@benchtop/core';
import { definePart } from '../define.ts';

const bcd = (n: number): number => ((Math.floor(n / 10) & 0x0f) << 4) | (n % 10);
const fromBcd = (b: number): number => ((b >> 4) & 0x0f) * 10 + (b & 0x0f);

/** Days in `month` (1–12) of 20`year` (00–99): leap years are those divisible by 4. */
export function daysInMonth(month: number, year: number): number {
  if (month === 2) return year % 4 === 0 ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/** Advances the time registers 0x00–0x06 by one second, in place (CH is left alone). */
export function advanceSecond(regs: Uint8Array): void {
  const seconds = fromBcd(regs[0] & 0x7f);
  if (seconds < 59) {
    regs[0] = (regs[0] & 0x80) | bcd(seconds + 1);
    return;
  }
  regs[0] &= 0x80;
  const minutes = fromBcd(regs[1] & 0x7f);
  if (minutes < 59) {
    regs[1] = bcd(minutes + 1);
    return;
  }
  regs[1] = 0;
  let nextDay = false;
  if (regs[2] & 0x40) {
    // 12 h mode: 1..12; 11 → 12 flips AM/PM, and 11 PM → 12 AM starts a new day.
    const hour = fromBcd(regs[2] & 0x1f);
    const pm = (regs[2] & 0x20) !== 0;
    if (hour === 11) {
      nextDay = pm;
      regs[2] = 0x40 | (pm ? 0 : 0x20) | bcd(12);
    } else {
      regs[2] = 0x40 | (pm ? 0x20 : 0) | bcd(hour === 12 ? 1 : hour + 1);
    }
  } else {
    const hour = fromBcd(regs[2] & 0x3f);
    if (hour < 23) regs[2] = bcd(hour + 1);
    else {
      regs[2] = 0;
      nextDay = true;
    }
  }
  if (!nextDay) return;
  const day = regs[3] & 0x07;
  regs[3] = day >= 7 || day === 0 ? 1 : day + 1;
  const date = fromBcd(regs[4] & 0x3f);
  const month = fromBcd(regs[5] & 0x1f);
  const year = fromBcd(regs[6]);
  if (date < daysInMonth(month, year)) {
    regs[4] = bcd(date + 1);
    return;
  }
  regs[4] = bcd(1);
  if (month < 12) {
    regs[5] = bcd(month + 1);
    return;
  }
  regs[5] = bcd(1);
  regs[6] = bcd((year + 1) % 100);
}

/** Time registers for an ISO-like 'YYYY-MM-DDThh:mm:ss' (24 h) or 'now'. */
export function startRegisters(start: string, halted: boolean): Uint8Array {
  const regs = new Uint8Array(8);
  let d: { y: number; mo: number; da: number; h: number; mi: number; s: number; dow: number };
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})$/.exec(start.trim());
  if (start.trim() === 'now') {
    const now = new Date();
    d = { y: now.getFullYear(), mo: now.getMonth() + 1, da: now.getDate(), h: now.getHours(), mi: now.getMinutes(), s: now.getSeconds(), dow: now.getDay() + 1 };
  } else if (m !== null) {
    const [y, mo, da, h, mi, s] = m.slice(1).map(Number);
    d = { y, mo, da, h, mi, s, dow: new Date(Date.UTC(y, mo - 1, da)).getUTCDay() + 1 };
  } else {
    throw new Error(`start must be 'YYYY-MM-DDThh:mm:ss' or 'now', got ${start}`);
  }
  if (d.y < 2000 || d.y > 2099 || d.mo < 1 || d.mo > 12 || d.da < 1 || d.da > daysInMonth(d.mo, d.y % 100) || d.h > 23 || d.mi > 59 || d.s > 59) {
    throw new Error(`start is not a time the DS1307 can hold: ${start}`);
  }
  regs[0] = (halted ? 0x80 : 0) | bcd(d.s);
  regs[1] = bcd(d.mi);
  regs[2] = bcd(d.h);
  regs[3] = d.dow;
  regs[4] = bcd(d.da);
  regs[5] = bcd(d.mo);
  regs[6] = bcd(d.y % 100);
  return regs;
}

class Ds1307 implements I2cDevice {
  readonly address = 0x68;
  readonly regs = new Uint8Array(64);
  pointer = 0;
  private pointerNext = false;
  private readonly restart: () => void;

  constructor(restart: () => void) {
    this.restart = restart;
  }

  start(read: boolean): boolean {
    this.pointerNext = !read;
    return true;
  }

  write(byte: number): boolean {
    if (this.pointerNext) {
      this.pointer = byte & 0x3f;
      this.pointerNext = false;
      return true;
    }
    this.regs[this.pointer] = byte;
    if (this.pointer === 0) this.restart();
    this.pointer = (this.pointer + 1) & 0x3f;
    return true;
  }

  read(): number {
    const value = this.regs[this.pointer];
    this.pointer = (this.pointer + 1) & 0x3f;
    return value;
  }

  stop(): void {}
}

function ds1307Model(ctx: PartContext, props: { start: string; halted: boolean }) {
  const sqw = ctx.pin('SQW');
  const initial = startRegisters(props.start, props.halted);
  let half = false;
  let timer = -1;
  const halfTick = (): void => {
    half = !half;
    if (!half && !(rtc.regs[0] & 0x80)) {
      advanceSecond(rtc.regs);
      ctx.invalidate();
    }
    square();
    timer = ctx.schedule(500 * NS_PER_MS, halfTick);
  };
  const restart = (): void => {
    if (timer >= 0) ctx.cancel(timer);
    half = false;
    timer = ctx.schedule(500 * NS_PER_MS, halfTick);
  };
  const rtc = new Ds1307(restart);
  const square = (): void => {
    const control = rtc.regs[7];
    const level = control & 0x10 ? ((control & 0x03) === 0 ? (half ? 0 : 1) : 1) : control & 0x80 ? 1 : 0;
    sqw.drive(level ? 1 : 0, Strength.strong);
  };
  const load = (): void => {
    rtc.regs.fill(0);
    rtc.regs.set(initial);
    rtc.pointer = 0;
    timer = -1;
    restart();
    square();
  };
  load();
  ctx.attachI2c('SDA', 'SCL', rtc);
  const text = (): string => {
    const r = rtc.regs;
    const p = (n: number): string => String(n).padStart(2, '0');
    const hour = r[2] & 0x40 ? `${p(fromBcd(r[2] & 0x1f))}${r[2] & 0x20 ? 'PM' : 'AM'}` : p(fromBcd(r[2] & 0x3f));
    return `20${p(fromBcd(r[6]))}-${p(fromBcd(r[5] & 0x1f))}-${p(fromBcd(r[4] & 0x3f))} ${hour}:${p(fromBcd(r[1] & 0x7f))}:${p(fromBcd(r[0] & 0x7f))}`;
  };
  return {
    visual: () => ({ time: text(), halted: (rtc.regs[0] & 0x80) !== 0 }),
    reset() {
      load();
      ctx.invalidate();
    },
  };
}

export const ds1307 = definePart({
  type: 'ds1307',
  title: 'Real-time clock (DS1307)',
  category: 'sensors',
  size: { w: 25.8, h: 22.212 },
  pins: [
    { name: 'GND', x: 2.514, y: 3.969, role: 'ground' },
    { name: '5V', x: 2.514, y: 6.615, role: 'power' },
    { name: 'SDA', x: 2.514, y: 9.128, role: 'digital' },
    { name: 'SCL', x: 2.514, y: 11.642, role: 'digital' },
    { name: 'SQW', x: 2.514, y: 14.288, role: 'digital' },
  ],
  defaults: { start: '2026-01-01T00:00:00', halted: false },
  createModel: ds1307Model,
});
