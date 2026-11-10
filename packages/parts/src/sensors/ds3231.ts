/**
 * BT192: the DS3231 real-time clock (Maxim's datasheet, 19-5170) on the common ZS-042 module
 * (`ds3231`: 32K, SQW, SCL, SDA, VCC, GND, and SCL/SDA/VCC/GND passed through), with the module's
 * AT24C32 EEPROM on the same bus.
 *
 * The DS3231 at 0x68, registers 00h–12h (Figure 1; the pointer wraps 12h → 00h): time and date in BCD
 * with 12/24 h and the century bit (bit 7 of the month, toggled when the year wraps 99 → 00); alarm 1
 * (07h–0Ah) and alarm 2 (0Bh–0Dh) with their mask bits and DY/DT (Table 2 — once a second/minute up to
 * a day or date match; alarm 2 only at 00 seconds), tested on each second's update and setting A1F/A2F;
 * control 0Eh (power-up 1Ch: INTCN, RS2:RS1; A1IE, A2IE, CONV, BBSQW, EOSC); status 0Fh (power-up 88h:
 * OSF and EN32kHz; OSF, A2F and A1F only clear); aging 10h (kept; it trims the oscillator, which is
 * the bench's clock here); temperature 11h–12h in 0.25 °C steps, 0 °C at power-up, converted at
 * power-up, every 64 s and on CONV (BSY and CONV set for the conversion, 200 ms, the datasheet's
 * maximum). Writing the seconds restarts the second. Time runs from the `start` prop on the bench
 * clock (the coin cell keeps it; I2C needs VCC at 2.3 V or more).
 *
 * INT/SQW is open drain: with INTCN set it is low while an enabled alarm's flag is set; with INTCN
 * clear it is the 1 Hz square wave (high for the half second after each second's update) or, at
 * RS ≠ 00, a 1.024–8.192 kHz square wave that isn't drawn as edges (released; the visual names it). 32K
 * is open drain too, its 32.768 kHz likewise not drawn. The module pulls SQW and 32K up to VCC.
 *
 * The AT24C32 (`At24c32`, Atmel's datasheet): 4 KB at 0x57 (the module's A0–A2 jumpers open; prop
 * `eeprom` 0x50–0x57), two address bytes (12 bits used), 32-byte page writes (the address wraps inside
 * the page) committed at STOP, then a 10 ms write cycle (its maximum) during which it NACKs its
 * address — ACK polling works; sequential reads wrap at 4 KB. Its bytes survive a bench reset.
 *
 * Visual: `time`, `temperature` (the register's), `alarm1`/`alarm2` (flags), `int` (INT/SQW pulled low).
 */

import { type I2cDevice, NS_PER_MS, type PartContext, type PartInput, type PartProps, Strength } from '@benchtop/core';
import { definePart } from '../define.ts';
import { readChannelInput } from '../shared/channel-input.ts';
import { advanceSecond, startRegisters } from './ds1307.ts';

const fromBcd = (b: number): number => ((b >> 4) & 0x0f) * 10 + (b & 0x0f);
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Bits a write keeps, per register 00h–12h (the temperature registers are read-only). */
const WRITABLE = [0x7f, 0x7f, 0x7f, 0x07, 0x3f, 0x9f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x08, 0xff, 0x00, 0x00] as const;
export const DS3231_CONVERT_NS = 200 * NS_PER_MS;
const AUTO_CONVERT_NS = 64_000 * NS_PER_MS;

/** The 10-bit temperature code (0.25 °C, two's complement) as registers 11h, 12h. */
export function temperatureRegisters(celsius: number): [number, number] {
  const code = Math.round(clamp(celsius, -40, 85) * 4) & 0x3ff;
  return [(code >> 2) & 0xff, (code & 3) << 6];
}

/** Does alarm 1 (registers 07h–0Ah) or alarm 2 (0Bh–0Dh) match the time in `r`? */
export function alarmMatches(r: Uint8Array, which: 1 | 2): boolean {
  const base = which === 1 ? 7 : 0x0b;
  const sec = which === 1 ? r[7] : 0x80;
  const min = r[base + (which === 1 ? 1 : 0)];
  const hour = r[base + (which === 1 ? 2 : 1)];
  const dd = r[base + (which === 1 ? 3 : 2)];
  if (which === 2 && (r[0] & 0x7f) !== 0) return false; // alarm 2 is tested at 00 seconds
  const secOk = (sec & 0x80) !== 0 || (sec & 0x7f) === (r[0] & 0x7f);
  const minOk = (min & 0x80) !== 0 || (min & 0x7f) === (r[1] & 0x7f);
  const hourOk = (hour & 0x80) !== 0 || (hour & 0x7f) === (r[2] & 0x7f);
  const ddOk = (dd & 0x80) !== 0 || (dd & 0x40 ? (dd & 0x0f) === (r[3] & 0x07) : (dd & 0x3f) === (r[4] & 0x3f));
  return secOk && minOk && hourOk && ddOk;
}

/** The AT24C32 4 KB I2C EEPROM. */
export class At24c32 implements I2cDevice {
  readonly bytes = new Uint8Array(4096).fill(0xff);
  address: number;
  private readonly now: () => number;
  private busyUntil = -1;
  private pointer = 0;
  /** Bytes received this write: 0 and 1 are the address. */
  private index = 0;
  private reading = false;
  private readonly page = new Uint8Array(32);
  private readonly dirty = new Uint8Array(32);
  private pageBase = 0;
  private wrote = false;
  powered = true;

  constructor(address: number, now: () => number) {
    this.address = address;
    this.now = now;
  }

  get busy(): boolean {
    return this.now() < this.busyUntil;
  }

  /** A bench reset: time starts again, and no write cycle is under way (the bytes stay). */
  reset(): void {
    this.busyUntil = -1;
    this.index = 0;
    this.wrote = false;
  }

  start(read: boolean): boolean {
    if (!this.powered || this.busy) return false;
    this.reading = read;
    if (!read) {
      this.index = 0;
      this.wrote = false;
    }
    return true;
  }

  write(byte: number): boolean {
    if (this.index === 0) this.pointer = (byte & 0x0f) << 8;
    else if (this.index === 1) {
      this.pointer |= byte;
      this.pageBase = this.pointer & ~31;
      this.page.set(this.bytes.subarray(this.pageBase, this.pageBase + 32));
      this.dirty.fill(0);
    } else {
      const offset = this.pointer & 31;
      this.page[offset] = byte;
      this.dirty[offset] = 1;
      this.wrote = true;
      this.pointer = this.pageBase | ((offset + 1) & 31); // rolls over inside the page
    }
    this.index++;
    return true;
  }

  read(): number {
    const v = this.bytes[this.pointer];
    this.pointer = (this.pointer + 1) & 0xfff;
    return v;
  }

  stop(): void {
    if (this.reading || !this.wrote) return;
    for (let i = 0; i < 32; i++) if (this.dirty[i]) this.bytes[this.pageBase + i] = this.page[i];
    this.wrote = false;
    this.busyUntil = this.now() + 10 * NS_PER_MS;
  }
}

function ds3231Model(ctx: PartContext, props: PartProps) {
  const sqw = ctx.pin('SQW');
  const k32 = ctx.pin('32K');
  const vcc = ctx.pin('VCC');
  const gnd = ctx.pin('GND');
  const regs = new Uint8Array(19);
  const initial = startRegisters(String(props.start), false);
  let temperature = clamp(Number(props.temperature), -40, 85);
  let powered = false;
  let half = false;
  let tick = -1;
  let convertTimer = -1;
  let autoTimer = -1;
  let pointer = 0;
  let pointerNext = false;
  const visual = { time: '', temperature: 0, alarm1: false, alarm2: false, int: false, square: '' };
  const eeprom = new At24c32(clamp(Number(props.eeprom), 0x50, 0x57), () => ctx.now());

  const text = (): string => {
    const p = (n: number): string => String(n).padStart(2, '0');
    const century = regs[5] & 0x80 ? 21 : 20;
    const hour = regs[2] & 0x40 ? `${p(fromBcd(regs[2] & 0x1f))}${regs[2] & 0x20 ? 'PM' : 'AM'}` : p(fromBcd(regs[2] & 0x3f));
    return `${century}${p(fromBcd(regs[6]))}-${p(fromBcd(regs[5] & 0x1f))}-${p(fromBcd(regs[4] & 0x3f))} ${hour}:${p(fromBcd(regs[1] & 0x7f))}:${p(fromBcd(regs[0] & 0x7f))}`;
  };
  /** INT/SQW, 32K and the visual from the registers. */
  const outputs = (): void => {
    const control = regs[0x0e];
    const status = regs[0x0f];
    const intcn = (control & 0x04) !== 0;
    const asserted = intcn && (((status & 1) !== 0 && (control & 1) !== 0) || ((status & 2) !== 0 && (control & 2) !== 0));
    const rs = (control >> 3) & 3;
    let low = false;
    if (intcn) low = asserted;
    else if (rs === 0) low = !half; // 1 Hz: high for the half second after each update
    if (low) sqw.drive(0, Strength.strong);
    else if (powered) sqw.driveVolts(vcc.read().volts, Strength.weak);
    else sqw.release();
    if (powered) k32.driveVolts(vcc.read().volts, Strength.weak);
    else k32.release();
    visual.int = asserted;
    visual.alarm1 = (status & 1) !== 0;
    visual.alarm2 = (status & 2) !== 0;
    visual.square = intcn ? '' : ['1 Hz', '1.024 kHz', '4.096 kHz', '8.192 kHz'][rs];
    visual.time = text();
    visual.temperature = (((regs[0x11] << 24) >> 24) * 4 + (regs[0x12] >> 6)) / 4;
    ctx.invalidate();
  };

  const finishConversion = (): void => {
    convertTimer = -1;
    const [msb, lsb] = temperatureRegisters(temperature);
    regs[0x11] = msb;
    regs[0x12] = lsb;
    regs[0x0e] &= ~0x20; // CONV
    regs[0x0f] &= ~0x04; // BSY
    outputs();
  };
  const convert = (): void => {
    if (convertTimer >= 0) return;
    regs[0x0f] |= 0x04;
    convertTimer = ctx.schedule(DS3231_CONVERT_NS, finishConversion);
  };
  const autoConvert = (): void => {
    convert();
    autoTimer = ctx.schedule(AUTO_CONVERT_NS, autoConvert);
  };

  /** Every half second: the 1 Hz wave rises half a second after the update, and the next update falls with it. */
  const halfTick = (): void => {
    half = !half;
    if (!half) {
      const century = regs[5] & 0x80;
      const year = regs[6];
      advanceSecond(regs);
      regs[5] = (regs[5] & 0x1f) | (year === 0x99 && regs[6] === 0 ? century ^ 0x80 : century);
      if (alarmMatches(regs, 1)) regs[0x0f] |= 0x01;
      if (alarmMatches(regs, 2)) regs[0x0f] |= 0x02;
    }
    outputs();
    tick = ctx.schedule(500 * NS_PER_MS, halfTick);
  };
  const restartSecond = (): void => {
    if (tick >= 0) ctx.cancel(tick);
    half = false;
    tick = ctx.schedule(500 * NS_PER_MS, halfTick);
  };

  const rtc: I2cDevice = {
    address: 0x68,
    start(read: boolean): boolean {
      if (!powered) return false;
      pointerNext = !read;
      return true;
    },
    write(byte: number): boolean {
      if (pointerNext) {
        pointer = byte > 0x12 ? 0 : byte;
        pointerNext = false;
        return true;
      }
      if (pointer === 0x0f) {
        // OSF, A2F and A1F can only be cleared; EN32kHz is written; BSY isn't.
        regs[0x0f] = (regs[0x0f] & byte & 0x83) | (byte & 0x08) | (regs[0x0f] & 0x04);
      } else {
        regs[pointer] = byte & WRITABLE[pointer];
        if (pointer === 0) restartSecond();
        if (pointer === 0x0e && byte & 0x20) {
          regs[0x0e] |= 0x20;
          convert();
        }
      }
      pointer = pointer >= 0x12 ? 0 : pointer + 1;
      outputs();
      return true;
    },
    read(): number {
      const v = regs[pointer];
      pointer = pointer >= 0x12 ? 0 : pointer + 1;
      return v;
    },
    stop() {},
  };
  ctx.attachI2c('SDA', 'SCL', rtc);
  ctx.attachI2c('SDA', 'SCL', eeprom);

  const powerOn = (): void => {
    // Only a first power-up (the coin cell keeps the rest): the time from `start`.
    regs.fill(0);
    regs.set(initial.subarray(0, 7));
    regs[0x0e] = 0x1c;
    regs[0x0f] = 0x88;
    if (autoTimer >= 0) ctx.cancel(autoTimer);
    if (convertTimer >= 0) ctx.cancel(convertTimer);
    convertTimer = -1;
    restartSecond();
    autoConvert(); // at power-up, then every 64 s
  };
  const checkPower = (): void => {
    const v = vcc.read();
    const g = gnd.read();
    powered = v.level === 1 && g.level === 0 && v.volts - g.volts >= 2.3;
    eeprom.powered = powered;
    outputs();
  };
  vcc.onChange(checkPower);
  gnd.onChange(checkPower);
  powerOn();
  checkPower();

  return {
    input(event: PartInput) {
      const channel = readChannelInput(event);
      if (channel?.channel !== 'temperature') return;
      temperature = clamp(channel.value, -40, 85);
    },
    visual: () => visual,
    reset() {
      temperature = clamp(Number(props.temperature), -40, 85);
      tick = -1;
      autoTimer = -1;
      convertTimer = -1;
      pointer = 0;
      eeprom.reset();
      powerOn();
      checkPower();
    },
  };
}

const HEADER = ['32K', 'SQW', 'SCL', 'SDA', 'VCC', 'GND'] as const;
const PASS = ['SCL.2', 'SDA.2', 'VCC.2', 'GND.2'] as const;
const W = 38.1;
const H = 22.86;

export const ds3231 = definePart({
  type: 'ds3231',
  title: 'Real-time clock (DS3231, ZS-042 module)',
  category: 'sensors',
  size: { w: W, h: H },
  pins: [
    ...HEADER.map((name, i) => ({
      name,
      x: 1.27,
      y: H / 2 - 2.5 * 2.54 + i * 2.54,
      role: name === 'VCC' ? ('power' as const) : name === 'GND' ? ('ground' as const) : ('digital' as const),
    })),
    ...PASS.map((name, i) => ({
      name,
      x: W - 1.27,
      y: H / 2 - 1.5 * 2.54 + i * 2.54,
      role: name === 'VCC.2' ? ('power' as const) : name === 'GND.2' ? ('ground' as const) : ('digital' as const),
    })),
  ],
  buses: [
    ['SCL', 'SCL.2'],
    ['SDA', 'SDA.2'],
    ['VCC', 'VCC.2'],
    ['GND', 'GND.2'],
  ],
  defaults: { start: '2026-01-01T00:00:00', temperature: 24, eeprom: 0x57 },
  createModel: (ctx, props) => ds3231Model(ctx, props as PartProps),
});
