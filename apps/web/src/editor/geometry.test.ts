import { CATALOG } from '@benchtop/parts';
import { describe, expect, it } from 'vitest';
import { GRID_MM, partBounds, pinWorld, rotateInPart, snapPart } from './geometry.ts';

const led = CATALOG.get('led')!;

describe('geometry', () => {
  it('rotates clockwise about the part center', () => {
    const size = { w: 10, h: 4 };
    expect(rotateInPart(size, { x: 10, y: 2 }, 0)).toEqual({ x: 10, y: 2 });
    expect(rotateInPart(size, { x: 10, y: 2 }, 90)).toEqual({ x: 5, y: 7 }); // right edge → bottom
    expect(rotateInPart(size, { x: 10, y: 2 }, 180)).toEqual({ x: 0, y: 2 });
    expect(rotateInPart(size, { x: 10, y: 2 }, 270)).toEqual({ x: 5, y: -3 });
    expect(partBounds(led, { id: 'l', type: 'led', x: 0, y: 0, rotation: 90, props: {} })).toEqual({
      x: (led.size.w - led.size.h) / 2,
      y: (led.size.h - led.size.w) / 2,
      w: led.size.h,
      h: led.size.w,
    });
  });

  it('snaps a part so its first pin lands on the 0.1" grid, unless Alt is held', () => {
    const at = snapPart(led, 0, { x: 13.1, y: 7.4 }, true);
    const anchor = pinWorld(led, { id: 'l', type: 'led', x: at.x, y: at.y, rotation: 0, props: {} }, led.pins[0]);
    expect(Math.abs(anchor.x / GRID_MM - Math.round(anchor.x / GRID_MM))).toBeLessThan(1e-3);
    expect(Math.abs(anchor.y / GRID_MM - Math.round(anchor.y / GRID_MM))).toBeLessThan(1e-3);
    expect(snapPart(led, 0, { x: 13.1, y: 7.4 }, false)).toEqual({ x: 13.1, y: 7.4 });
    for (const rotation of [90, 180, 270] as const) {
      const p = snapPart(led, rotation, { x: 3.3, y: 4.4 }, true);
      const a = pinWorld(led, { id: 'l', type: 'led', x: p.x, y: p.y, rotation, props: {} }, led.pins[0]);
      expect(Math.abs(a.x / GRID_MM - Math.round(a.x / GRID_MM))).toBeLessThan(1e-3);
      expect(Math.abs(a.y / GRID_MM - Math.round(a.y / GRID_MM))).toBeLessThan(1e-3);
    }
  });
});
