import { Bench, NS_PER_MS, parseProject, PORT_GROUPS, type ProjectDoc } from '@benchtop/core';
import { FakeMcu } from '@benchtop/core/testing';
import { describe, expect, it } from 'vitest';
import { analogSpecFor } from '../analog-specs.ts';
import { benchEnvParts } from '../catalog.ts';

// AVR per-port current on real boards, resistors and LEDs with the analog layer: a scripted MCU
// sets the pins, so no firmware is involved. A red LED behind 220 Ω carries 12.5 mA at 5 V.

/**
 * A board and one 220 Ω + red LED branch per header: sourcing ones go pin → resistor → LED → GND
 * (the pin drives 1), sinking ones 5V → resistor → LED → pin (the pin drives 0).
 */
function ledBench(board: 'arduino-uno' | 'arduino-mega', headers: readonly string[], direction: 'source' | 'sink') {
  const id = board === 'arduino-uno' ? 'uno' : 'mega';
  const def = benchEnvParts(board)!;
  const pinMap = def.board!.pinMap;
  const doc: ProjectDoc = {
    format: 1,
    name: 'port current',
    parts: [{ id, type: board, x: 0, y: 0, rotation: 0, props: {} }],
    wires: [],
    firmware: {},
  };
  const wire = (from: string, to: string): void => {
    const [fp, fn] = from.split(':');
    const [tp, tn] = to.split(':');
    doc.wires.push({ id: `w${doc.wires.length}`, from: { part: fp, pin: fn }, to: { part: tp, pin: tn }, waypoints: [], color: 'green' });
  };
  headers.forEach((header, i) => {
    doc.parts.push({ id: `r${i}`, type: 'resistor', x: 150 + i * 40, y: 0, rotation: 0, props: { ohms: 220 } });
    doc.parts.push({ id: `led${i}`, type: 'led', x: 150 + i * 40, y: 60, rotation: 0, props: { color: 'red' } });
    if (direction === 'source') {
      wire(`${id}:${header}`, `r${i}:1`);
      wire(`r${i}:2`, `led${i}:A`);
      wire(`led${i}:C`, `${id}:GND.1`);
    } else {
      wire(`${id}:5V`, `r${i}:1`);
      wire(`r${i}:2`, `led${i}:A`);
      wire(`led${i}:C`, `${id}:${header}`);
    }
  });
  const parsed = parseProject(doc);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const level = direction === 'source' ? 1 : 0;
  const mcu = new FakeMcu({
    kind: def.board!.mcu,
    pins: [...new Set(Object.values(pinMap))],
    script: headers.map((header) => ({ cycle: 16, pin: pinMap[header], mode: 'output' as const, level })),
  });
  const bench = new Bench(parsed.doc, { part: benchEnvParts, createMcu: () => mcu }, { analogSpecFor });
  bench.runUntil(50 * NS_PER_MS);
  return bench;
}

const analogHeaders = (n: number) => Array.from({ length: n }, (_, a) => `A${a}`);

describe('port-overcurrent on real boards', () => {
  it('ten LEDs on Mega A0–A9 (all in the F0–F7, K0–K7 group, 100 mA) warn at ~125 mA; three do not', () => {
    const ten = ledBench('arduino-mega', analogHeaders(10), 'source');
    expect(ten.problems()).toEqual([
      {
        severity: 'warning',
        code: 'port-overcurrent',
        message: expect.stringMatching(
          /^mega pins A0, A1, A2, A3, A4, A5, A6, A7, A8, A9 source about 12[4-6] mA together; the ATmega2560's pin group F0–F7, K0–K7 may source at most 100 mA\.$/,
        ),
        parts: ['mega', 'r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9'],
      },
    ]);
    expect(ledBench('arduino-mega', analogHeaders(3), 'source').problems()).toEqual([]);
  });

  it("on an Uno, nine LEDs sinking into D5–D13 pass its 100 mA sink limit; ten sourcing from D0–D4, A0–A4 stay under 150 mA", () => {
    const nine = ['5', '6', '7', '8', '9', '10', '11', '12', '13'];
    // Nothing else: the build-time solve, with the pins still inputs, settles each LED dark (GOFF).
    const sinking = ledBench('arduino-uno', nine, 'sink').problems();
    expect(sinking).toEqual([
      expect.objectContaining({
        severity: 'warning',
        code: 'port-overcurrent',
        message: expect.stringMatching(/^uno pins 5, 6, 7, 8, 9, 10, 11, 12, 13 sink about 11[1-3] mA together; the ATmega328P's pin group B0–B5, D5–D7 may sink at most 100 mA\.$/),
      }),
    ]);
    expect(ledBench('arduino-uno', ['0', '1', '2', '3', '4', ...analogHeaders(5)], 'source').problems()).toEqual([]);
  });

  it("every digital pin of the Uno, Nano and Mega is in exactly one source and one sink group", () => {
    for (const board of ['arduino-uno', 'arduino-nano', 'arduino-mega']) {
      const spec = benchEnvParts(board)!.board!;
      const groups = PORT_GROUPS[spec.mcu];
      for (const [header, pin] of Object.entries(spec.pinMap)) {
        if (pin === 'ADC6' || pin === 'ADC7') continue; // the Nano's analog-only A6/A7
        expect(groups.source.filter((g) => g.pins.includes(pin)), `${board} ${header} source`).toHaveLength(1);
        expect(groups.sink.filter((g) => g.pins.includes(pin)), `${board} ${header} sink`).toHaveLength(1);
      }
    }
  });
});
