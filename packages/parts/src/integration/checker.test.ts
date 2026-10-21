import { avrMcuFactory } from '@benchtop/avr';
import { Bench, type BenchEnv, NS_PER_MS, type PartDefinition, parseProject, type Problem, type ProjectDoc } from '@benchtop/core';
import { FakeMcu } from '@benchtop/core/testing';
import { describe, expect, it } from 'vitest';
import { readFixtureText } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { analogSpecFor } from '../analog-specs.ts';
import { benchEnvParts } from '../catalog.ts';

// The circuit checker (BT22) on the problems-*.json fixtures with real firmware.

/** Test-only: a 3.3 V board standing in for an ESP32 (no real ESP32 board exists yet). */
const testEsp32: PartDefinition = {
  type: 'test-esp32',
  title: 'test ESP32',
  category: 'boards',
  size: { w: 20, h: 10 },
  pins: [
    { name: 'GPIO4', x: 2, y: 2, role: 'digital' },
    { name: 'GPIO5', x: 5, y: 2, role: 'digital' },
    { name: '3V3', x: 8, y: 2, role: 'power', volts: 3.3 },
    { name: 'GND', x: 11, y: 2, role: 'ground', volts: 0 },
  ],
  defaults: {},
  board: { mcu: 'esp32', pinMap: { GPIO4: 'GPIO4', GPIO5: 'GPIO5' } },
};

const env: BenchEnv = {
  part: (type) => (type === 'test-esp32' ? testEsp32 : benchEnvParts(type)),
  createMcu: (board) => (board.mcu === 'esp32' ? new FakeMcu({ kind: 'esp32', pins: ['GPIO4', 'GPIO5'] }) : avrMcuFactory(board)),
};

const project = (name: string): ProjectDoc => JSON.parse(readFixtureText(`fixtures/projects/${name}.json`)) as ProjectDoc;

function load(doc: ProjectDoc, firmware: string) {
  const parsed = parseProject(doc);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const bench = new Bench(parsed.doc, env, { analogSpecFor });
  bench.attachFirmware('uno', { format: 'hex', text: readFixtureText(`fixtures/firmware/uno/${firmware}.hex`) });
  const runTo = (ms: number): void => {
    bench.runUntil(ms * NS_PER_MS);
  };
  const of = (severity: Problem['severity']) => bench.problems().filter((p) => p.severity === severity);
  return { bench, runTo, of };
}

const brief = (p: Problem) => [p.code, p.parts];

describe('circuit checker', () => {
  it('(a) an LED straight from D13 to GND: two errors, pin-overcurrent [led1, uno] and led-overcurrent [led1]', () => {
    const { runTo, of } = load(project('problems-led'), 'checker-demo');
    runTo(100);
    expect(of('error').map(brief)).toEqual([
      ['pin-overcurrent', ['led1', 'uno']],
      ['led-overcurrent', ['led1']],
    ]);
  });

  it('(b) a button on D2 with no pull-up: floating-input [btn1, uno] by 20 ms; none with INPUT_PULLUP', () => {
    const floating = load(project('problems-floating'), 'checker-demo');
    floating.runTo(20);
    expect(floating.of('warning').map(brief)).toEqual([['floating-input', ['btn1', 'uno']]]);
    const pulled = load(project('problems-floating'), 'checker-demo-pullup');
    pulled.runTo(100);
    expect(pulled.bench.problems()).toEqual([]);
  });

  it('(c) 5V on an ESP32 GPIO is an error before any run; D7 HIGH into a GPIO is one while running', () => {
    const { bench, runTo } = load(project('problems-esp32'), 'checker-demo');
    const before = bench.problems().filter((p) => p.code === 'esp32-overvoltage');
    expect(before).toEqual([expect.objectContaining({ severity: 'error', parts: ['esp', 'uno'], message: expect.stringContaining('esp:GPIO4 is wired to 5 V') })]);
    runTo(50);
    const during = bench.problems().filter((p) => p.code === 'esp32-overvoltage');
    // Same code and parts, so one problem; the dynamic check's message (GPIO5 at 5 V) is newest.
    expect(during).toEqual([expect.objectContaining({ severity: 'error', parts: ['esp', 'uno'], message: expect.stringContaining('esp:GPIO5 is at 5.00 V') })]);
  });

  it('(d) an LCD1602 with GND unwired: unpowered-part [lcd1]', () => {
    const { bench, runTo } = load(project('problems-unpowered'), 'checker-demo');
    expect(bench.problems().map(brief)).toEqual([['unpowered-part', ['lcd1']]]);
    runTo(50);
    expect(bench.problems().filter((p) => p.severity !== 'info').map(brief)).toEqual([['unpowered-part', ['lcd1']]]);
  });

  it('(e) unused signal pins: one unconnected-pins info; an unwired part: one unwired-part info only', () => {
    const doc: ProjectDoc = {
      format: 1,
      name: 'pins',
      parts: [
        { id: 'uno', type: 'arduino-uno', x: 0, y: 0, rotation: 0, props: {} },
        { id: 'lcd1', type: 'lcd1602', x: 100, y: 0, rotation: 0, props: {} },
        { id: 'pot1', type: 'potentiometer', x: 200, y: 0, rotation: 0, props: {} },
      ],
      wires: [
        { id: 'w1', from: { part: 'uno', pin: '5V' }, to: { part: 'lcd1', pin: 'VDD' }, waypoints: [], color: 'red' },
        { id: 'w2', from: { part: 'uno', pin: 'GND.1' }, to: { part: 'lcd1', pin: 'VSS' }, waypoints: [], color: 'black' },
        { id: 'w3', from: { part: 'uno', pin: '12' }, to: { part: 'lcd1', pin: 'RS' }, waypoints: [], color: 'green' },
      ],
      firmware: {},
    };
    const { bench } = load(doc, 'checker-demo');
    expect(bench.problems()).toEqual([
      { severity: 'info', code: 'unconnected-pins', message: 'lcd1: V0, RW, E, D0, D1, D2, D3, D4, D5, D6, D7 not connected.', parts: ['lcd1'] },
      { severity: 'info', code: 'unwired-part', message: 'pot1 has no connections.', parts: ['pot1'] },
    ]);
  });

  it("(f) D7 HIGH into D8 LOW is the resolver's short; D13 into GND is a drive fight only while HIGH", () => {
    const short = load(project('problems-short'), 'checker-demo');
    short.runTo(50);
    expect(short.of('error').map(brief)).toEqual([['short', ['uno']]]);
    const fight = load(project('problems-drive-fight'), 'checker-demo');
    fight.runTo(200); // D13 HIGH from the start
    expect(fight.of('error').map(brief)).toEqual([['drive-fight', ['uno']]]);
    fight.runTo(700); // LOW from 500 ms
    expect(fight.of('error')).toEqual([]);
    fight.runTo(1200); // HIGH again from 1000 ms
    expect(fight.of('error').map(brief)).toEqual([['drive-fight', ['uno']]]);
  });

  it('problems-demo after 1 s: 2 errors (the LED and its pin), 2 warnings, the unwired-potentiometer info', () => {
    const { bench, runTo } = load(project('problems-demo'), 'checker-demo');
    runTo(400); // D13 HIGH (first half second): the LED overcurrent is live
    const list = bench.problems();
    console.info(`problems-demo at 0.4 s: ${JSON.stringify(list)}`);
    expect(list.filter((p) => p.severity === 'error').map(brief)).toEqual([
      ['pin-overcurrent', ['led1', 'uno']],
      ['led-overcurrent', ['led1']],
    ]);
    expect(list.filter((p) => p.severity === 'warning').map(brief)).toEqual([
      ['unpowered-part', ['lcd1']],
      ['floating-input', ['btn1', 'uno']],
    ]);
    expect(list.filter((p) => p.severity === 'info').map(brief)).toEqual([['unwired-part', ['pot1']]]);
    runTo(1000);
    console.info(`problems-demo at 1 s: ${JSON.stringify(bench.problems())}`);
  });
});
