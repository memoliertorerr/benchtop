import { describe, expect, it } from 'vitest';
import { distanceToPolyline, orthogonalPath, pathData } from './routing.ts';

describe('routing', () => {
  it('fills a diagonal step with one corner, horizontal-first on a tie', () => {
    expect(orthogonalPath([{ x: 0, y: 0 }, { x: 10, y: 5 }])).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 5 },
    ]);
  });

  it('picks the route with fewer bends given how the wire arrived', () => {
    // Arriving vertically at (0, 10): vertical-first to (10, 15) bends once, horizontal-first twice.
    expect(orthogonalPath([{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 10, y: 15 }])).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 15 },
      { x: 10, y: 15 },
    ]);
    // Arriving horizontally: horizontal-first keeps going straight.
    expect(orthogonalPath([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 15 }])).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 15 },
    ]);
  });

  it('drops repeated and collinear points', () => {
    expect(orthogonalPath([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 5, y: 0 }, { x: 9, y: 0 }])).toEqual([
      { x: 0, y: 0 },
      { x: 9, y: 0 },
    ]);
  });

  it('rounds corners with a 1 mm radius', () => {
    expect(pathData([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }])).toBe('M0 0 L9 0 Q10 0 10 1 L10 5');
    expect(pathData([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 5 }])).toBe('M0 0 L0.5 0 Q1 0 1 0.5 L1 5');
  });

  it('measures the distance from a point to a polyline', () => {
    const line = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }];
    expect(distanceToPolyline({ x: 5, y: 3 }, line)).toBe(3);
    expect(distanceToPolyline({ x: 12, y: 5 }, line)).toBe(2);
    expect(distanceToPolyline({ x: -3, y: -4 }, line)).toBe(5);
    expect(distanceToPolyline({ x: 1, y: 1 }, [{ x: 1, y: 2 }])).toBe(1);
  });
});
