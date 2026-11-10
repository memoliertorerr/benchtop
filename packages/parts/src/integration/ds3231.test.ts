import { avrMcuFactory } from '@benchtop/avr';
import { Bench, type BenchEnv, NS_PER_MS, parseProject, type ProjectDoc, type Wire } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { readFixtureText } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { benchEnvParts } from '../catalog.ts';

// BT192: uno/ds3231 — a ZS-042 module (the DS3231 and its AT24C32) driven with the datasheet's
// registers: setting the time, alarm 1 on INT/SQW into pin 2's interrupt, a forced conversion, the
// EEPROM's page writes with ACK polling, then the 1 Hz square wave.

const env: BenchEnv = { part: benchEnvParts, createMcu: (board) => avrMcuFactory(board) };

function circuit(): ProjectDoc {
  const wires: [string, string][] = [
    ['uno:A4.2', 'rtc:SDA'],
    ['uno:A5.2', 'rtc:SCL'],
    ['uno:2', 'rtc:SQW'],
    ['uno:5V', 'rtc:VCC'],
    ['uno:GND.1', 'rtc:GND'],
  ];
  return {
    format: 1,
    name: 'ds3231 test',
    parts: [
      { id: 'uno', type: 'arduino-uno', x: 0, y: 0, rotation: 0, props: {} },
      { id: 'rtc', type: 'ds3231', x: 100, y: 0, rotation: 0, props: { temperature: 26.4 } },
    ],
    wires: wires.map(([from, to], i): Wire => {
      const [fp, fn] = from.split(':');
      const [tp, tn] = to.split(':');
      return { id: `w${i}`, from: { part: fp, pin: fn }, to: { part: tp, pin: tn }, waypoints: [], color: 'green' };
    }),
    firmware: {},
  };
}

describe('a DS3231 module on an Uno (BT192)', () => {
  it('uno/ds3231: OSF at power-up, the time it set, the alarm at :55 on pin 2, the EEPROM, the 1 Hz wave', () => {
    const parsed = parseProject(circuit());
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    const bench = new Bench(parsed.doc, env);
    bench.attachFirmware('uno', { format: 'hex', text: readFixtureText('fixtures/firmware/uno/ds3231.hex') });
    bench.reset();
    let text = '';
    bench.onSerial('uno', (bytes) => (text += String.fromCharCode(...bytes)));
    bench.runUntil(12_500 * NS_PER_MS);
    const lines = text.split(/\r?\n/);
    expect(lines[0]).toBe('osf 1');
    const temp = /temp (-?[\d.]+) after (\d+) ms/.exec(text);
    expect(Number(temp?.[1])).toBe(26.5); // 26.4 °C in 0.25 °C steps
    expect(Number(temp?.[2])).toBeGreaterThanOrEqual(195); // the conversion's 200 ms
    expect(Number(temp?.[2])).toBeLessThanOrEqual(205);
    const polls = Number(/polls (\d+)/.exec(text)?.[1]);
    expect(polls).toBeGreaterThan(10); // four 10 ms write cycles, each polled
    expect(lines).toContain('eeprom ok');
    for (const t of ['12:34:51', '12:34:54', '12:34:55', '12:34:59', '12:35:00']) expect(lines, t).toContain(t);
    expect(lines).toContain('alarm 12:34:55');
    expect(lines.filter((l) => l.startsWith('alarm '))).toHaveLength(1); // seconds match: once a minute
    const high = Number(/sqw high (\d+) ms/.exec(text)?.[1]);
    // 500 ms high; pulseIn counts loop turns with interrupts on and misses timer0's (≈ 0.5 %), as on a board.
    expect(high).toBeGreaterThanOrEqual(495);
    expect(high).toBeLessThanOrEqual(500);
  }, 60_000);

  it('BT194: uno/rtclib-ds3231 — RTClib sees lost power, keeps the time it set, its alarm 1 and temperature', () => {
    const parsed = parseProject(circuit());
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    const bench = new Bench(parsed.doc, env);
    bench.attachFirmware('uno', { format: 'hex', text: readFixtureText('fixtures/firmware/uno/rtclib-ds3231.hex') });
    bench.reset();
    let text = '';
    bench.onSerial('uno', (bytes) => (text += String.fromCharCode(...bytes)));
    bench.runUntil(7_500 * NS_PER_MS);
    const lines = text.split(/\r?\n/);
    expect(lines[0]).toBe('lost power');
    // Read in setup, before the power-up conversion's 200 ms are over: the datasheet's 0 °C.
    expect(lines).toContain('temp 0.00');
    for (const t of ['2026/11/10 12:34:50 Tue', '2026/11/10 12:34:55 Tue', '2026/11/10 12:34:57 Tue']) expect(lines, t).toContain(t);
    const at = lines.indexOf('2026/11/10 12:34:55 Tue');
    expect(lines.indexOf('alarm')).toBeGreaterThan(at);
    expect(lines.filter((l) => l === 'alarm')).toHaveLength(1);
  }, 60_000);
});
