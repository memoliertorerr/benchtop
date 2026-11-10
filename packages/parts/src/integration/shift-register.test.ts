import { avrMcuFactory } from '@benchtop/avr';
import { Bench, type BenchEnv, NS_PER_MS, parseProject, type PartInstance, type ProjectDoc, type Wire } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { readFixtureText } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { analogSpecFor } from '../analog-specs.ts';
import { benchEnvParts } from '../catalog.ts';

// BT184: 74HC595s on an Uno — uno/shift-register (a shiftOut counter on eight LEDs) and
// uno/shift-chain (two chained 595s: shiftOut, hardware SPI reading the chain back, LSB-first SPI).

const env: BenchEnv = { part: benchEnvParts, createMcu: (board) => avrMcuFactory(board) };

function circuit(parts: Omit<PartInstance, 'x' | 'y' | 'rotation'>[], wires: [string, string][]): ProjectDoc {
  return {
    format: 1,
    name: '595 test',
    parts: [{ id: 'uno', type: 'arduino-uno', x: 0, y: 0, rotation: 0, props: {} }, ...parts.map((p, i) => ({ ...p, x: 100 + i * 30, y: 0, rotation: 0 as const }))],
    wires: wires.map(([from, to], i): Wire => {
      const [fp, fn] = from.split(':');
      const [tp, tn] = to.split(':');
      return { id: `w${i}`, from: { part: fp, pin: fn }, to: { part: tp, pin: tn }, waypoints: [], color: 'green' };
    }),
    firmware: {},
  };
}

function load(doc: ProjectDoc, firmware: string) {
  const parsed = parseProject(doc);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const bench = new Bench(parsed.doc, env, { analogSpecFor });
  bench.attachFirmware('uno', { format: 'hex', text: readFixtureText(`fixtures/firmware/uno/${firmware}.hex`) });
  bench.reset();
  let serial = '';
  bench.onSerial('uno', (bytes) => (serial += String.fromCharCode(...bytes)));
  const seen = new Map<string, Record<string, unknown>>();
  const visual = (id: string): Record<string, unknown> => {
    for (const [part, state] of bench.collectFrame().parts) seen.set(part, state as Record<string, unknown>);
    return seen.get(id) ?? {};
  };
  return { bench, serial: () => serial, visual };
}

/** Q0–Q7 as a byte; null while any is released. */
function outputs(bench: Bench, id: string): number | null {
  let q = 0;
  for (let n = 0; n < 8; n++) {
    const s = bench.pinState(id, `Q${n}`);
    if (s === undefined || s.level === null) return null;
    q |= s.level << n;
  }
  return q;
}

const power = (id: string): [string, string][] => [
  [`${id}:VCC`, 'uno:5V'],
  [`${id}:GND`, 'uno:GND.1'],
  [`${id}:MR`, 'uno:5V'],
  [`${id}:OE`, 'uno:GND.1'],
];

describe('74HC595s on an Uno (BT184)', () => {
  it('uno/shift-register: each count shiftOut latches is on Q0–Q7, and lights its LEDs', () => {
    const leds: Omit<PartInstance, 'x' | 'y' | 'rotation'>[] = [];
    const wires: [string, string][] = [['uno:11', 'sr:DS'], ['uno:12', 'sr:SHCP'], ['uno:8', 'sr:STCP'], ...power('sr')];
    for (let n = 0; n < 8; n++) {
      leds.push({ id: `led${n}`, type: 'led', props: { color: 'red' } }, { id: `r${n}`, type: 'resistor', props: { ohms: 220 } });
      wires.push([`sr:Q${n}`, `r${n}:1`], [`r${n}:2`, `led${n}:A`], [`led${n}:C`, 'uno:GND.1']);
    }
    const { bench, serial, visual } = load(circuit([{ id: 'sr', type: '74hc595', props: {} }, ...leds], wires), 'shift-register');
    const checked: number[] = [];
    for (let ms = 150; ms <= 1950; ms += 100) {
      bench.runUntil(ms * NS_PER_MS);
      const printed = [...serial().matchAll(/q=(\d+)/g)].map((m) => Number(m[1]));
      const last = printed[printed.length - 1];
      expect(outputs(bench, 'sr'), `${ms} ms`).toBe(last);
      checked.push(last);
      // An output that is high lights its LED (through 220 Ω at 5 V); 50 ms after the latch it
      // has been lit, or dark, the whole time since.
      for (let n = 0; n < 8; n++) {
        const brightness = Number(visual(`led${n}`).brightness ?? 0);
        if ((last >> n) & 1) expect(brightness, `${ms} ms Q${n}`).toBeGreaterThan(0.5);
        else expect(brightness, `${ms} ms Q${n}`).toBeLessThan(0.05);
      }
    }
    expect(checked.length).toBe(19);
    expect(checked[checked.length - 1]).toBeGreaterThanOrEqual(18);
    expect(new Set(checked).size).toBe(checked.length); // a new count every 100 ms
  });

  it('uno/shift-chain: bit-banged, hardware SPI read back on MISO, and LSB first', () => {
    const wires: [string, string][] = [
      ['uno:11', 'near:DS'],
      ['uno:13', 'near:SHCP'],
      ['uno:10', 'near:STCP'],
      ['near:Q7S', 'far:DS'],
      ['uno:13', 'far:SHCP'],
      ['uno:10', 'far:STCP'],
      ['far:Q7S', 'uno:12'],
      ...power('near'),
      ...power('far'),
    ];
    const { bench, serial } = load(
      circuit(
        [
          { id: 'far', type: '74hc595', props: {} },
          { id: 'near', type: '74hc595', props: {} },
        ],
        wires,
      ),
      'shift-chain',
    );
    bench.runUntil(300 * NS_PER_MS);
    expect(serial()).toContain('soft A5C3');
    expect([outputs(bench, 'far'), outputs(bench, 'near')]).toEqual([0xa5, 0xc3]);
    bench.runUntil(800 * NS_PER_MS);
    expect(serial()).toContain('spi 5A3C back A5C3');
    expect([outputs(bench, 'far'), outputs(bench, 'near')]).toEqual([0x5a, 0x3c]);
    bench.runUntil(1300 * NS_PER_MS);
    expect(serial()).toContain('lsb 0180');
    expect([outputs(bench, 'far'), outputs(bench, 'near')]).toEqual([0x80, 0x01]);
    expect(bench.problems().filter((p) => p.code === 'spi-unattached')).toEqual([]);
  });
});
