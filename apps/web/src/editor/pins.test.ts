import type { ProjectDoc } from '@benchtop/core';
import { CATALOG } from '@benchtop/parts';
import { describe, expect, it } from 'vitest';
import { hitPin, pinPosition, pinSpots } from './pins.ts';

// The resistor is 15.645 × 3 mm with pins '1' at (0, 1.495) and '2' at (15.557, 1.495), so its
// center is (7.8225, 1.5). Placed at (10, 20), clockwise rotation about the center gives, by hand:
//   0°:   1 → (10, 21.495)                 2 → (25.557, 21.495)
//   90°:  1 → (10 + 7.8225 + 0.005, 20 + 1.5 − 7.8225) = (17.8275, 13.6775)
//         2 → (17.8275, 20 + 1.5 + 7.7345) = (17.8275, 29.2345)
//   180°: 1 → (10 + 15.645, 20 + 1.505) = (25.645, 21.505)   2 → (10.088, 21.505)
//   270°: 1 → (10 + 7.8225 − 0.005, 20 + 1.5 + 7.8225) = (17.8175, 29.3225)
//         2 → (17.8175, 20 + 1.5 − 7.7345) = (17.8175, 13.7655)
const EXPECTED = {
  0: [
    [10, 21.495],
    [25.557, 21.495],
  ],
  90: [
    [17.8275, 13.6775],
    [17.8275, 29.2345],
  ],
  180: [
    [25.645, 21.505],
    [10.088, 21.505],
  ],
  270: [
    [17.8175, 29.3225],
    [17.8175, 13.7655],
  ],
} as const;

const resistorAt = (rotation: 0 | 90 | 180 | 270): ProjectDoc => ({
  format: 1,
  name: 't',
  parts: [{ id: 'r1', type: 'resistor', x: 10, y: 20, rotation, props: {} }],
  wires: [],
  firmware: {},
});

describe('pin positions', () => {
  it.each([0, 90, 180, 270] as const)('match hand-computed values at %i°', (rotation) => {
    const spots = pinSpots(resistorAt(rotation));
    expect(spots.map((s) => s.pin)).toEqual(['1', '2']);
    spots.forEach((spot, i) => {
      expect(spot.x).toBeCloseTo(EXPECTED[rotation][i][0], 9);
      expect(spot.y).toBeCloseTo(EXPECTED[rotation][i][1], 9);
    });
    const two = pinPosition(resistorAt(rotation), { part: 'r1', pin: '2' })!;
    expect(two.x).toBeCloseTo(EXPECTED[rotation][1][0], 9);
  });

  it('hit-tests the nearest pin within a radius', () => {
    const doc: ProjectDoc = {
      ...resistorAt(0),
      parts: [...resistorAt(0).parts, { id: 'uno', type: 'arduino-uno', x: 100, y: 0, rotation: 0, props: {} }],
    };
    const spots = pinSpots(doc);
    expect(spots).toHaveLength(2 + CATALOG.get('arduino-uno')!.pins.length);
    expect(hitPin(spots, { x: 10.3, y: 21.3 }, 0.8)).toMatchObject({ part: 'r1', pin: '1', role: 'passive' });
    expect(hitPin(spots, { x: 11, y: 21.495 }, 0.8)).toBeUndefined();
    expect(hitPin(spots, { x: 133.1, y: 2.4 }, 0.8)).toMatchObject({ part: 'uno', pin: '13', role: 'digital' });
    expect(pinPosition(doc, { part: 'uno', pin: 'nope' })).toBeUndefined();
  });
});
