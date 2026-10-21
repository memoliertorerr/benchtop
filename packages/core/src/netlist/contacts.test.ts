import { describe, expect, it } from 'vitest';
import type { PartInstance, ProjectDoc } from '../contracts/project.ts';
import { CONTACT_MM, findContacts, type PartGeometry } from './contacts.ts';
import { buildNetlist, type PartPinsSource } from './netlist.ts';

const P = 2.54;

/** A 10-column strip of holes, 5 rows per column (each column one bus), holes on the grid. */
const strip: PartGeometry = {
  size: { w: 11 * P, h: 6 * P },
  pins: Array.from({ length: 10 }, (_, c) => Array.from({ length: 5 }, (_, r) => ({ name: `${c + 1}${'abcde'[r]}`, x: (c + 1) * P, y: (r + 1) * P }))).flat(),
};
/** A 2-pin part (an LED), legs 2.54 mm apart, 5 × 8 mm body. */
const led: PartGeometry = {
  size: { w: 5, h: 8 },
  pins: [
    { name: 'A', x: 1.23, y: 7 },
    { name: 'C', x: 1.23 + P, y: 7 },
  ],
};
const GEOMETRY: Record<string, PartGeometry> = { strip, led };
const geometry = (type: string) => GEOMETRY[type];

const source: PartPinsSource = {
  pins: (type) => GEOMETRY[type]?.pins.map((p) => p.name),
  buses: (type) => (type === 'strip' ? Array.from({ length: 10 }, (_, c) => 'abcde'.split('').map((r) => `${c + 1}${r}`)) : []),
  geometry,
};

const part = (id: string, type: string, x: number, y: number, rotation: PartInstance['rotation'] = 0): PartInstance => ({
  id,
  type,
  x,
  y,
  rotation,
  props: {},
});
const doc = (parts: PartInstance[], wires: ProjectDoc['wires'] = []): ProjectDoc => ({ format: 1, name: 't', parts, wires, firmware: {} });

/** Places the LED so leg A is (dx, dy) off hole `3b`, and leg C near `4b`. */
const ledAt = (dx: number, dy: number, rotation: PartInstance['rotation'] = 0) => part('led1', 'led', 3 * P - 1.23 + dx, 2 * P - 7 + dy, rotation);

describe('findContacts', () => {
  it('joins an LED whose legs sit within 0.4 mm of two holes to those columns', () => {
    const d = doc([part('bb', 'strip', 0, 0), ledAt(0.25, -0.2)]);
    expect(findContacts(d, geometry)).toEqual([
      { a: { part: 'bb', pin: '3b' }, b: { part: 'led1', pin: 'A' } },
      { a: { part: 'bb', pin: '4b' }, b: { part: 'led1', pin: 'C' } },
    ]);
    const n = buildNetlist(d, source);
    expect(n.netOf('led1', 'A')).toBe(n.netOf('bb', '3e'));
    expect(n.netOf('led1', 'C')).toBe(n.netOf('bb', '4a'));
    expect(n.netOf('led1', 'A')).not.toBe(n.netOf('led1', 'C'));
  });

  it("doesn't join legs 1 mm away from the holes", () => {
    const d = doc([part('bb', 'strip', 0, 0), ledAt(1, 0)]);
    expect(findContacts(d, geometry)).toEqual([]);
    expect(1).toBeGreaterThan(CONTACT_MM);
    const n = buildNetlist(d, source);
    expect(n.pinsOfNet(n.netOf('led1', 'A'))).toEqual([{ part: 'led1', pin: 'A' }]);
  });

  it('uses rotation about the part center', () => {
    // Rotated 90°, the legs line up vertically, A above C, one row apart in one column.
    const rotated = part('led1', 'led', 0, 0, 90);
    // A's offset after 90° about the center (2.5, 4): (cx - dy, cy + dx) with (dx, dy) = (-1.27, 3).
    const a = { x: 2.5 - 3, y: 4 - 1.27 };
    const target = { x: 5 * P, y: 2 * P };
    rotated.x = target.x - a.x;
    rotated.y = target.y - a.y;
    const contacts = findContacts(doc([part('bb', 'strip', 0, 0), rotated]), geometry);
    expect(contacts).toEqual([
      { a: { part: 'bb', pin: '5b' }, b: { part: 'led1', pin: 'A' } },
      { a: { part: 'bb', pin: '5c' }, b: { part: 'led1', pin: 'C' } },
    ]);
  });

  it('merges nets exactly like wires to the same holes', () => {
    const inserted = buildNetlist(doc([part('bb', 'strip', 0, 0), ledAt(0.1, 0.1)]), source);
    const wired = buildNetlist(
      doc(
        [part('bb', 'strip', 0, 0), part('led1', 'led', 100, 100)],
        [
          { id: 'w1', from: { part: 'led1', pin: 'A' }, to: { part: 'bb', pin: '3b' }, waypoints: [], color: 'green' },
          { id: 'w2', from: { part: 'led1', pin: 'C' }, to: { part: 'bb', pin: '4b' }, waypoints: [], color: 'green' },
        ],
      ),
      source,
    );
    expect(inserted.netCount).toBe(wired.netCount);
    const pins = [...strip.pins.map((p) => ['bb', p.name]), ['led1', 'A'], ['led1', 'C']] as const;
    for (const [p1, n1] of pins) {
      for (const [p2, n2] of pins) {
        expect(inserted.netOf(p1, n1) === inserted.netOf(p2, n2)).toBe(wired.netOf(p1, n1) === wired.netOf(p2, n2));
      }
    }
  });

  it('resolves contacts for a 2,000-part bench in under 100 ms', () => {
    // 100 full-size breadboard-like boards (830 holes each) and 1,900 two-leg parts on them.
    const board: PartGeometry = {
      size: { w: 64 * P, h: 20 * P },
      pins: Array.from({ length: 63 }, (_, c) => Array.from({ length: 13 }, (_, r) => ({ name: `${c}.${r}`, x: (c + 1) * P, y: (r + 1) * P }))).flat().slice(0, 830),
    };
    const types: Record<string, PartGeometry> = { board, led };
    const parts: PartInstance[] = [];
    for (let i = 0; i < 100; i++) parts.push(part(`b${i}`, 'board', (i % 10) * 70 * P, Math.floor(i / 10) * 22 * P));
    for (let i = 0; i < 1900; i++) {
      const b = parts[i % 100];
      const col = 1 + ((i * 7) % 60);
      const row = 1 + (Math.floor(i / 100) % 12);
      parts.push(part(`l${i}`, 'led', b.x + col * P - 1.23, b.y + row * P - 7));
    }
    const d = doc(parts);
    // Best of 5: vitest runs test files in parallel, and a busy machine says nothing about the code.
    let ms = Number.POSITIVE_INFINITY;
    let contacts = findContacts(d, (t) => types[t]);
    for (let run = 0; run < 5; run++) {
      const start = performance.now();
      contacts = findContacts(d, (t) => types[t]);
      ms = Math.min(ms, performance.now() - start);
    }
    console.info(`contacts: 2000 parts (${100 * 830 + 1900 * 2} pins), ${contacts.length} contacts in ${ms.toFixed(1)} ms (best of 5)`);
    expect(contacts.length).toBeGreaterThan(3000);
    expect(ms).toBeLessThan(100);
  });
});
