import { describe, expect, it } from 'vitest';
import { nearestInCone, pointInCone, rayHit, type Shape } from './cone.ts';

const box = (x: number, y: number, w: number, h: number): Shape => ({ kind: 'box', x, y, r: 0, hw: w / 2, hh: h / 2 });
const circle = (x: number, y: number, r: number): Shape => ({ kind: 'circle', x, y, r, hw: 0, hh: 0 });
const HALF = (15 * Math.PI) / 180;
/** Apex at the origin facing up (−y), a 30° cone, 4 m. */
const query = (shape: Shape): number => nearestInCone(shape, 0, 0, 0, -1, HALF, 4);

describe('cone queries', () => {
  it('finds a box straight ahead at its near face', () => {
    expect(query(box(0, -2, 0.4, 0.2))).toBeCloseTo(1.9, 12);
  });

  it('finds a box only the cone’s edge reaches, on the edge ray', () => {
    // Its nearest point (0.55, −2) is 15.4° off-axis; the 15° edge ray meets its left face.
    expect(query(box(0.75, -2.5, 0.4, 1))).toBeCloseTo(0.55 / Math.sin(HALF), 12);
  });

  it('misses a box just outside the cone', () => {
    expect(query(box(1, -2, 0.6, 0.2))).toBe(Infinity);
  });

  it('sees the nearer of two boxes in line', () => {
    const near = query(box(0, -1.5, 0.4, 0.2));
    const far = query(box(0, -3, 0.4, 0.2));
    expect(Math.min(near, far)).toBeCloseTo(1.4, 12);
  });

  it('finds a person (a circle) ahead and ignores one behind or beyond range', () => {
    expect(query(circle(0, -1, 0.2))).toBeCloseTo(0.8, 12);
    expect(query(circle(0, 1, 0.2))).toBe(Infinity);
    expect(query(circle(0, -5, 0.2))).toBe(Infinity);
  });

  it('reports 0 when the apex is inside the shape', () => {
    expect(query(box(0, 0, 1, 1))).toBe(0);
    expect(query(circle(0.1, 0, 0.5))).toBe(0);
  });

  it('casts rays against circles and boxes', () => {
    expect(rayHit(circle(3, 0, 1), 0, 0, 1, 0)).toBeCloseTo(2, 12);
    expect(rayHit(box(3, 0, 2, 2), 0, 0, 1, 0)).toBeCloseTo(2, 12);
    expect(rayHit(box(3, 5, 2, 2), 0, 0, 1, 0)).toBe(Infinity);
    expect(rayHit(box(-3, 0, 2, 2), 0, 0, 1, 0)).toBe(Infinity);
  });

  it('tests points against the cone', () => {
    expect(pointInCone(0, -1, 0, 0, 0, -1, HALF, 4)).toBe(true);
    expect(pointInCone(0.25, -1, 0, 0, 0, -1, HALF, 4)).toBe(true); // 14.0°
    expect(pointInCone(0.3, -1, 0, 0, 0, -1, HALF, 4)).toBe(false); // 16.7°
    expect(pointInCone(0, -5, 0, 0, 0, -1, HALF, 4)).toBe(false);
  });
});
