import { avrMcuFactory } from '@benchtop/avr';
import { Bench, type BenchEnv, NS_PER_MS, parseProject, type PartInstance, type ProjectDoc, type Wire } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { readFixtureText } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { analogSpecFor } from '../analog-specs.ts';
import { benchEnvParts } from '../catalog.ts';

// BT193: uno/shift-in (two chained 74HC165s, bit-banged and on SPI, a button on one input) and
// uno/relay-module (a 1-channel module switching two lamps, after a pulse too short to move it).

const env: BenchEnv = { part: benchEnvParts, createMcu: (board) => avrMcuFactory(board) };

function circuit(parts: Omit<PartInstance, 'x' | 'y' | 'rotation'>[], wires: [string, string][]): ProjectDoc {
  return {
    format: 1,
    name: 'shift-in test',
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

/** D1–D7 of a 165 tied to the rails as `byte`'s bits (D0 left to the caller when `skipD0`). */
function rails(id: string, byte: number, skipD0 = false): [string, string][] {
  const out: [string, string][] = [];
  for (let n = skipD0 ? 1 : 0; n < 8; n++) out.push([`${id}:D${n}`, (byte >> n) & 1 ? 'uno:5V' : 'uno:GND.1']);
  return out;
}

describe('74HC165s and a relay module on an Uno (BT193)', () => {
  it('uno/shift-in: 16 inputs bit-banged and on SPI, a button on the near D0 read as it is pressed', () => {
    const wires: [string, string][] = [
      ['uno:8', 'near:PL'],
      ['uno:10', 'near:CE'],
      ['uno:13', 'near:CP'],
      ['uno:12', 'near:Q7'],
      ['far:Q7', 'near:DS'],
      ['uno:8', 'far:PL'],
      ['uno:10', 'far:CE'],
      ['uno:13', 'far:CP'],
      ['far:DS', 'uno:GND.1'],
      ...rails('near', 0xa4, true),
      ...rails('far', 0x3c),
      ['near:D0', 'btn:1.l'],
      ['btn:2.l', 'uno:5V'],
      ['near:D0', 'pd:1'],
      ['pd:2', 'uno:GND.1'],
    ];
    for (const id of ['near', 'far']) wires.push([`${id}:VCC`, 'uno:5V'], [`${id}:GND`, 'uno:GND.1']);
    const { bench, serial } = load(
      circuit(
        [
          { id: 'far', type: '74hc165', props: {} },
          { id: 'near', type: '74hc165', props: {} },
          { id: 'btn', type: 'pushbutton', props: {} },
          { id: 'pd', type: 'resistor', props: { ohms: 10000 } },
        ],
        wires,
      ),
      'shift-in',
    );
    bench.runUntil(100 * NS_PER_MS);
    expect(serial()).toContain('soft A43C');
    expect(serial()).toContain('spi A43C');
    bench.input('btn', { kind: 'press' });
    bench.runUntil(200 * NS_PER_MS);
    expect(serial()).toContain('in A53C');
    bench.input('btn', { kind: 'release' });
    bench.runUntil(300 * NS_PER_MS);
    expect(serial().trimEnd().endsWith('in A43C')).toBe(true);
    expect(bench.problems().filter((p) => p.code === 'spi-unattached')).toEqual([]);
  });

  it('uno/relay-module: a 3 ms blip moves nothing; then the lamps change over each 500 ms', () => {
    const { bench, serial, visual } = load(
      circuit(
        [
          { id: 'k', type: 'relay-module', props: {} },
          { id: 'rno', type: 'resistor', props: { ohms: 220 } },
          { id: 'lno', type: 'led', props: { color: 'green' } },
          { id: 'rnc', type: 'resistor', props: { ohms: 220 } },
          { id: 'lnc', type: 'led', props: { color: 'red' } },
        ],
        [
          ['uno:7', 'k:IN'],
          ['uno:5V', 'k:VCC'],
          ['uno:GND.1', 'k:GND'],
          ['uno:5V', 'k:COM'],
          ['k:NO', 'rno:1'],
          ['rno:2', 'lno:A'],
          ['lno:C', 'uno:GND.1'],
          ['k:NC', 'rnc:1'],
          ['rnc:2', 'lnc:A'],
          ['lnc:C', 'uno:GND.1'],
        ],
      ),
      'relay-module',
    );
    const lit = (id: string): boolean => Number(visual(id).brightness ?? 0) > 0.5;
    for (let ms = 10; ms <= 190; ms += 10) {
      bench.runUntil(ms * NS_PER_MS);
      expect(visual('k').closed, `${ms} ms`).toBe(false);
    }
    expect(serial()).toContain('blip');
    expect(lit('lnc')).toBe(true);
    bench.runUntil(450 * NS_PER_MS);
    expect(serial()).toContain('on');
    expect([visual('k').closed, lit('lno'), lit('lnc')]).toEqual([true, true, false]);
    bench.runUntil(950 * NS_PER_MS);
    expect(serial()).toContain('off');
    expect([visual('k').closed, lit('lno'), lit('lnc')]).toEqual([false, false, true]);
  });
});
