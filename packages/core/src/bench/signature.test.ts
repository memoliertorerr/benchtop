import { describe, expect, it } from 'vitest';
import type { PartProps } from '../contracts/part.ts';
import type { PartInstance, ProjectDoc, Wire } from '../contracts/project.ts';
import type { EnvSpecFor } from '../env/spec.ts';
import type { PartGeometry } from '../netlist/contacts.ts';
import { buildNetlist, type PartPinsSource } from '../netlist/netlist.ts';
import { benchSignature } from './signature.ts';

// BT77: which edits change the bench.

const P = 2.54;
/** A 10-column strip of holes, 5 per column (each column one bus). */
const strip: PartGeometry = {
  size: { w: 11 * P, h: 6 * P },
  pins: Array.from({ length: 10 }, (_, c) => Array.from({ length: 5 }, (_, r) => ({ name: `${c + 1}${'abcde'[r]}`, x: (c + 1) * P, y: (r + 1) * P }))).flat(),
};
const led: PartGeometry = {
  size: { w: 5, h: 8 },
  pins: [
    { name: 'A', x: 1.23, y: 7 },
    { name: 'C', x: 1.23 + P, y: 7 },
  ],
};
const board: PartGeometry = { size: { w: 20, h: 10 }, pins: [{ name: '13', x: 2, y: 2 }, { name: 'GND', x: 4, y: 2 }] };
const blank: PartGeometry = { size: { w: 10, h: 10 }, pins: [] };
const GEOMETRY: Record<string, PartGeometry> = { strip, led, board, room: blank, heater: blank, thermo: led };
const source: PartPinsSource = {
  pins: (type) => GEOMETRY[type]?.pins.map((p) => p.name),
  buses: (type) => (type === 'strip' ? Array.from({ length: 10 }, (_, c) => 'abcde'.split('').map((r) => `${c + 1}${r}`)) : []),
  geometry: (type) => GEOMETRY[type],
};
const envSpecFor: EnvSpecFor = (type) =>
  type === 'room'
    ? { role: 'ambient', ambient: {} as never }
    : type === 'heater'
      ? { role: 'source', source: {} as never }
      : type === 'thermo'
        ? { role: 'sensor', samples: [] }
        : undefined;

const part = (id: string, type: string, x: number, y: number, props: PartProps = {}): PartInstance => ({ id, type, x, y, rotation: 0, props });
const wire = (id: string, a: string, b: string, color = 'green'): Wire => {
  const [ap, aq] = a.split(':');
  const [bp, bq] = b.split(':');
  return { id, from: { part: ap, pin: aq }, to: { part: bp, pin: bq }, waypoints: [], color };
};

/** A board, a strip and an LED off the strip (far away), wired 13 → LED A, GND → LED C. */
function base(): ProjectDoc {
  return {
    format: 1,
    name: 't',
    parts: [part('uno', 'board', 0, 40), part('bb', 'strip', 0, 0), part('led1', 'led', 60, 60, { color: 'red' })],
    wires: [wire('w1', 'uno:13', 'led1:A'), wire('w2', 'uno:GND', 'led1:C', 'black')],
    firmware: { uno: { kind: 'file', name: 'blink.hex', format: 'hex' } },
  };
}

const sig = (doc: ProjectDoc): string => benchSignature(doc, buildNetlist(doc, source), { envSpecFor });
const edit = (f: (doc: ProjectDoc) => void): ProjectDoc => {
  const doc = structuredClone(base());
  f(doc);
  return doc;
};

describe('benchSignature', () => {
  const before = sig(base());

  it('ignores cosmetic edits', () => {
    expect(sig(edit((d) => (d.wires[0].color = 'blue')))).toBe(before);
    expect(sig(edit((d) => d.wires[0].waypoints.push({ x: 10, y: 10 })))).toBe(before);
    expect(sig(edit((d) => ((d.parts[2].x = 80), (d.parts[2].y = 90))))).toBe(before); // still touches nothing
    expect(sig(edit((d) => (d.parts[2].rotation = 90)))).toBe(before);
    expect(sig(edit((d) => d.parts.reverse()))).toBe(before); // paint order
    expect(sig(edit((d) => (d.name = 'renamed')))).toBe(before);
    expect(sig(edit((d) => (d.wires = [d.wires[1], { ...d.wires[0], from: d.wires[0].to, to: d.wires[0].from, id: 'w9' }])))).toBe(before); // same nets
    expect(sig(edit((d) => (d.firmware.uno = { kind: 'inline', fqbn: 'arduino:avr:uno', files: { 'a.ino': 'x' }, main: 'a.ino' })))).toBe(
      sig(edit((d) => (d.firmware.uno = { kind: 'inline', fqbn: 'arduino:avr:uno', files: { 'a.ino': 'y' }, main: 'a.ino' }))),
    ); // inline code reaches the bench through a compile
  });

  it('sees electrical edits', () => {
    expect(sig(edit((d) => (d.parts[2].props.color = 'green')))).not.toBe(before);
    expect(sig(edit((d) => (d.wires[0].to.pin = 'C')))).not.toBe(before);
    expect(sig(edit((d) => d.wires.pop()))).not.toBe(before);
    expect(sig(edit((d) => d.parts.push(part('led2', 'led', 100, 100))))).not.toBe(before);
    expect(sig(edit((d) => (d.parts[2].type = 'thermo')))).not.toBe(before);
    expect(sig(edit((d) => (d.firmware.uno = { kind: 'file', name: 'fade.hex', format: 'hex' })))).not.toBe(before);
    expect(sig(edit((d) => delete d.firmware.uno))).not.toBe(before);
    // the LED's legs dropped into holes 3b and 4b: contacts join it to two columns
    expect(sig(edit((d) => ((d.parts[2].x = 3 * P - 1.23), (d.parts[2].y = 2 * P - 7))))).not.toBe(before);
  });

  it('places environment parts only when the document has an environment', () => {
    const noRoom = edit((d) => d.parts.push(part('heat', 'heater', 100, 100)));
    expect(sig(edit((d) => d.parts.push(part('heat', 'heater', 150, 120))))).toBe(sig(noRoom));
    const room = edit((d) => d.parts.push(part('room', 'room', -50, -50), part('heat', 'heater', 100, 100)));
    const moved = edit((d) => d.parts.push(part('room', 'room', -50, -50), part('heat', 'heater', 150, 120)));
    expect(sig(moved)).not.toBe(sig(room));
    // a part the environment doesn't know still moves freely
    expect(sig(edit((d) => (d.parts.push(part('room', 'room', -50, -50), part('heat', 'heater', 100, 100)), (d.parts[2].x = 70))))).toBe(sig(room));
  });
});
