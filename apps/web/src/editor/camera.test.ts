import { describe, expect, it } from 'vitest';
import { DEFAULT_ZOOM, MAX_ZOOM, MIN_ZOOM, pan, PX_PER_MM, screenToWorld, worldToScreen, zoomAt } from './camera.ts';

describe('camera', () => {
  it('maps world ↔ screen and back within 1e-9 mm', () => {
    const cameras = [
      { x: 0, y: 0, zoom: 1 },
      { x: 123.4, y: -56.7, zoom: DEFAULT_ZOOM },
      { x: -1000, y: 333, zoom: 0.25 },
      { x: 7.7, y: 8.8, zoom: 7.9 },
    ];
    for (const camera of cameras) {
      for (const world of [{ x: 0, y: 0 }, { x: 2.54, y: -12.7 }, { x: 1234.567, y: 89.01 }]) {
        const back = screenToWorld(camera, worldToScreen(camera, world));
        expect(Math.abs(back.x - world.x)).toBeLessThan(1e-9);
        expect(Math.abs(back.y - world.y)).toBeLessThan(1e-9);
      }
    }
    // 1 mm is 3.7795 px at zoom 1 (96 dpi).
    expect(worldToScreen({ x: 0, y: 0, zoom: 1 }, { x: 1, y: 0 }).x).toBeCloseTo(PX_PER_MM, 12);
  });

  it('zooms about the cursor, keeping the point under it fixed', () => {
    const camera = { x: 40, y: -20, zoom: 2 };
    const cursor = { x: 311, y: 207 };
    const before = screenToWorld(camera, cursor);
    for (const factor of [1.1, 0.5, 3]) {
      const zoomed = zoomAt(camera, cursor, factor);
      const after = screenToWorld(zoomed, cursor);
      expect(Math.abs(after.x - before.x)).toBeLessThan(1e-9);
      expect(Math.abs(after.y - before.y)).toBeLessThan(1e-9);
    }
  });

  it('clamps zoom to 0.25×–8×', () => {
    expect(zoomAt({ x: 0, y: 0, zoom: 2 }, { x: 0, y: 0 }, 100).zoom).toBe(MAX_ZOOM);
    expect(zoomAt({ x: 0, y: 0, zoom: 2 }, { x: 0, y: 0 }, 0.001).zoom).toBe(MIN_ZOOM);
    const atMax = { x: 5, y: 5, zoom: MAX_ZOOM };
    expect(zoomAt(atMax, { x: 50, y: 50 }, 2)).toBe(atMax);
    expect(pan({ x: 1, y: 2, zoom: 3 }, 10, -5)).toEqual({ x: 11, y: -3, zoom: 3 });
  });
});
