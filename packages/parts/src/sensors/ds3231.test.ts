import { Bench, type I2cDevice, NS_PER_MS, type ProjectDoc } from '@benchtop/core';
import { FakeMcu, fakeBoard, makeBenchEnv, testDoc } from '@benchtop/core/testing';
import { describe, expect, it } from 'vitest';
import { alarmMatches, ds3231, temperatureRegisters } from './ds3231.ts';

// BT192: the DS3231 on the ZS-042 module against Maxim's datasheet, and its AT24C32, through a fake
// I2C controller on a bench.

const PINS = ['SDA', 'SCL', 'D2'];
const board = fakeBoard('fake-uno', PINS);

function bench(props: Record<string, unknown> = {}) {
  const mcu = new FakeMcu({ pins: PINS, i2c: [{ sda: 'SDA', scl: 'SCL' }] });
  const doc: ProjectDoc = testDoc(
    { uno: 'fake-uno', rtc: 'ds3231' },
    [
      ['uno:SDA', 'rtc:SDA'],
      ['uno:SCL', 'rtc:SCL'],
      ['uno:D2', 'rtc:SQW'],
      ['rtc:VCC', 'uno:5V'],
      ['rtc:GND', 'uno:GND'],
    ],
    { rtc: props as never },
  );
  const b = new Bench(doc, makeBenchEnv([board, ds3231], () => mcu));
  const devices = mcu.i2cControllers[0].attached;
  const rtc = devices.find((d) => d.address === 0x68) as I2cDevice;
  const eeprom = devices.find((d) => d.address === 0x57) as I2cDevice;
  return { bench: b, rtc: regs(rtc), eeprom };
}

function regs(device: I2cDevice) {
  return {
    write(reg: number, ...values: number[]): void {
      expect(device.start(false)).toBe(true);
      device.write(reg);
      for (const v of values) device.write(v);
      device.stop();
    },
    read(reg: number, count: number): number[] {
      expect(device.start(false)).toBe(true);
      device.write(reg);
      device.stop();
      expect(device.start(true)).toBe(true);
      const out: number[] = [];
      for (let i = 0; i < count; i++) out.push(device.read(i < count - 1));
      device.stop();
      return out;
    },
  };
}

const sqw = (b: Bench): number | null => b.pinState('rtc', 'SQW')?.level ?? null;

describe('DS3231 (BT192)', () => {
  it('powers up with control 1Ch, status 88h (OSF, EN32kHz), 0 °C until its first conversion', () => {
    const { bench: b, rtc } = bench({ temperature: 23.3 });
    expect(rtc.read(0x0e, 2)).toEqual([0x1c, 0x8c]); // BSY: converting
    expect(rtc.read(0x11, 2)).toEqual([0, 0]);
    b.runUntil(250 * NS_PER_MS);
    expect(rtc.read(0x0f, 1)).toEqual([0x88]);
    expect(rtc.read(0x11, 2)).toEqual(temperatureRegisters(23.3)); // 23.25
    expect(temperatureRegisters(-0.25)).toEqual([0xff, 0xc0]);
    // OSF clears on a 0, not back on a 1; EN32kHz follows writes.
    rtc.write(0x0f, 0x08);
    expect(rtc.read(0x0f, 1)).toEqual([0x08]);
    rtc.write(0x0f, 0x80);
    expect(rtc.read(0x0f, 1)).toEqual([0x00]);
  });

  it('keeps time from its start, rolling the century over at 2099 → 2100, and wraps its pointer at 12h', () => {
    const { bench: b, rtc } = bench({ start: '2099-12-31T23:59:58' });
    expect(rtc.read(0, 7)).toEqual([0x58, 0x59, 0x23, 5, 0x31, 0x12, 0x99]);
    b.runUntil(2000 * NS_PER_MS + 1);
    expect(rtc.read(0, 7)).toEqual([0x00, 0x00, 0x00, 6, 0x01, 0x81, 0x00]); // century bit set
    const all = rtc.read(0x12, 2);
    expect(all[1]).toBe(0x00); // after 12h, 00h: the seconds
  });

  it('writing the seconds restarts the second; the 1 Hz wave rises half a second later', () => {
    const { bench: b, rtc } = bench();
    b.runUntil(300 * NS_PER_MS);
    rtc.write(0x0e, 0x00); // INTCN 0, RS 00: 1 Hz
    rtc.write(0x00, 0x30);
    const t0 = b.now();
    b.runUntil(t0 + 450 * NS_PER_MS);
    expect(sqw(b)).toBe(0);
    expect(rtc.read(0, 1)).toEqual([0x30]);
    b.runUntil(t0 + 550 * NS_PER_MS);
    expect(sqw(b)).toBe(1);
    b.runUntil(t0 + 1050 * NS_PER_MS);
    expect(sqw(b)).toBe(0);
    expect(rtc.read(0, 1)).toEqual([0x31]);
  });

  it('matches alarms by their masks (Table 2) and pulls INT/SQW low while an enabled flag is set', () => {
    const r = new Uint8Array(19);
    r.set([0x05, 0x30, 0x12, 3, 0x15, 0x06, 0x26]);
    r.set([0x80, 0x80, 0x80, 0x80], 7);
    expect(alarmMatches(r, 1)).toBe(true); // every second
    r[7] = 0x05;
    expect(alarmMatches(r, 1)).toBe(true); // seconds match
    r[7] = 0x06;
    expect(alarmMatches(r, 1)).toBe(false);
    r.set([0x05, 0x30, 0x12, 0x40 | 3], 7);
    expect(alarmMatches(r, 1)).toBe(true); // day 3, 12:30:05
    r[10] = 0x15;
    expect(alarmMatches(r, 1)).toBe(true); // date 15
    r[10] = 0x16;
    expect(alarmMatches(r, 1)).toBe(false);
    r.set([0x80, 0x80, 0x80], 0x0b);
    expect(alarmMatches(r, 2)).toBe(false); // alarm 2: only at 00 seconds
    r[0] = 0;
    expect(alarmMatches(r, 2)).toBe(true);

    const { bench: b, rtc } = bench({ start: '2026-11-10T08:00:00' });
    rtc.write(0x07, 0x03, 0x80, 0x80, 0x80); // alarm 1 when the seconds are 03
    rtc.write(0x0e, 0x05); // INTCN, A1IE
    b.runUntil(2900 * NS_PER_MS);
    expect(rtc.read(0x0f, 1)[0] & 1).toBe(0);
    expect(sqw(b)).toBe(1); // released, the module's pull-up
    b.runUntil(3100 * NS_PER_MS);
    expect(rtc.read(0x0f, 1)[0] & 1).toBe(1);
    expect(sqw(b)).toBe(0);
    rtc.write(0x0f, 0x00);
    expect(sqw(b)).toBe(1);
  });

  it('converts on CONV: CONV and BSY set for the conversion, then the new temperature', () => {
    const { bench: b, rtc } = bench({ temperature: 20 });
    b.runUntil(300 * NS_PER_MS);
    b.input('rtc', { kind: 'key', key: 'set:temperature=-7.6', down: true });
    expect(rtc.read(0x11, 2)).toEqual(temperatureRegisters(20));
    rtc.write(0x0e, 0x1c | 0x20);
    expect([rtc.read(0x0e, 1)[0] & 0x20, rtc.read(0x0f, 1)[0] & 0x04]).toEqual([0x20, 0x04]);
    b.runUntil(b.now() + 210 * NS_PER_MS);
    expect([rtc.read(0x0e, 1)[0] & 0x20, rtc.read(0x0f, 1)[0] & 0x04]).toEqual([0, 0]);
    expect(rtc.read(0x11, 2)).toEqual(temperatureRegisters(-7.5));
  });
});

describe('AT24C32 on the module (BT192)', () => {
  it('writes a page (wrapping inside it) at STOP, NACKs for the 10 ms write cycle, reads sequentially', () => {
    const { bench: b, eeprom } = bench();
    expect(eeprom.start(false)).toBe(true);
    for (const byte of [0x00, 30, 1, 2, 3, 4]) eeprom.write(byte); // 30, 31, then 0, 1 of the same page
    eeprom.stop();
    expect(eeprom.start(false)).toBe(false); // busy
    b.runUntil(b.now() + 10 * NS_PER_MS + 1);
    expect(eeprom.start(false)).toBe(true);
    eeprom.write(0x00);
    eeprom.write(0x00);
    eeprom.stop();
    expect(eeprom.start(true)).toBe(true);
    const page: number[] = [];
    for (let i = 0; i < 33; i++) page.push(eeprom.read(i < 32));
    eeprom.stop();
    expect(page.slice(0, 2)).toEqual([3, 4]);
    expect(page.slice(30, 32)).toEqual([1, 2]);
    expect(page[2]).toBe(0xff);
    expect(page[32]).toBe(0xff); // byte 32: the next page, unwritten
    // A bench reset keeps what it wrote.
    b.reset();
    expect(eeprom.start(false)).toBe(true);
    eeprom.write(0x00);
    eeprom.write(30);
    eeprom.stop();
    expect(eeprom.start(true)).toBe(true);
    expect([eeprom.read(true), eeprom.read(false)]).toEqual([1, 2]);
    eeprom.stop();
  });
});
