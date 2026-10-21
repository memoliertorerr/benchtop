import { describe, expect, it } from 'vitest';
import { breadboardGeometry, BREADBOARD_SPECS, PITCH } from './breadboard.ts';

const geometry = (type: string) => {
  const spec = BREADBOARD_SPECS.find((s) => s.type === type);
  if (spec === undefined) throw new Error(type);
  return breadboardGeometry(spec.columns, spec.railHoles);
};

describe('breadboard generator', () => {
  it.each([
    ['breadboard', 63, 50, 830],
    ['breadboard-half', 30, 25, 400],
    ['breadboard-mini', 17, 0, 170],
  ] as const)('%s: %i columns, rails of %i, %i holes', (type, columns, railHoles, holes) => {
    const { pins, buses } = geometry(type);
    expect(pins).toHaveLength(holes);
    expect(new Set(pins.map((p) => p.name)).size).toBe(holes);
    const halfColumns = buses.filter((b) => b.length === 5);
    expect(halfColumns).toHaveLength(columns * 2);
    const rails = buses.filter((b) => b.length !== 5);
    expect(rails).toHaveLength(railHoles > 0 ? 4 : 0);
    for (const rail of rails) expect(rail).toHaveLength(railHoles);
    // Every hole is on exactly one bus.
    expect(buses.flat().sort()).toEqual(pins.map((p) => p.name).sort());
  });

  it('uses the Wokwi names and joins each 5-hole half column', () => {
    const { pins, buses } = geometry('breadboard-half');
    expect(buses[0]).toEqual(['1t.a', '1t.b', '1t.c', '1t.d', '1t.e']);
    expect(buses[1]).toEqual(['1b.f', '1b.g', '1b.h', '1b.i', '1b.j']);
    expect(buses).toContainEqual(Array.from({ length: 25 }, (_, i) => `tp.${i + 1}`));
    for (const name of ['30t.e', '30b.j', 'tn.25', 'bp.1', 'bn.13']) expect(pins.some((p) => p.name === name)).toBe(true);
  });

  it('puts every hole on the 2.54 mm grid, with a 3-pitch channel between e and f', () => {
    const { pins, size } = geometry('breadboard');
    for (const pin of pins) {
      expect(Math.abs(pin.x / PITCH - Math.round(pin.x / PITCH))).toBeLessThan(1e-3);
      expect(Math.abs(pin.y / PITCH - Math.round(pin.y / PITCH))).toBeLessThan(1e-3);
      expect(pin.x).toBeGreaterThan(0);
      expect(pin.x).toBeLessThan(size.w);
      expect(pin.y).toBeGreaterThan(0);
      expect(pin.y).toBeLessThan(size.h);
    }
    const at = (name: string) => pins.find((p) => p.name === name)!;
    expect(at('7b.f').y - at('7t.e').y).toBeCloseTo(3 * PITCH, 6);
    expect(at('8t.a').x - at('7t.a').x).toBeCloseTo(PITCH, 6);
    // Rails: groups of five with a one-hole gap.
    expect(at('tp.6').x - at('tp.5').x).toBeCloseTo(2 * PITCH, 6);
    expect(at('tp.5').x - at('tp.4').x).toBeCloseTo(PITCH, 6);
  });
});
