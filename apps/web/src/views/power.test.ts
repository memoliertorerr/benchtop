import { CATALOG } from '@benchtop/parts';
import { describe, expect, it } from 'vitest';
import { POWER_VIEW_TYPES } from './power.ts';

// BT83: every power part has its own drawing (power.ts draws each terminal at the definition's
// pin, so the two can't drift apart).

describe('power part views', () => {
  it('draws every part in the Power category', () => {
    const power = [...CATALOG.values()].filter((d) => d.category === 'power').map((d) => d.type);
    expect(power.length).toBeGreaterThanOrEqual(7);
    for (const type of power) expect(POWER_VIEW_TYPES.has(type), type).toBe(true);
    for (const type of POWER_VIEW_TYPES) expect(CATALOG.get(type)?.category, type).toBe('power');
  });

  it('every power part has its terminals inside or at the edge of its drawing', () => {
    for (const type of POWER_VIEW_TYPES) {
      const def = CATALOG.get(type)!;
      for (const pin of def.pins) {
        expect(pin.x, `${type}:${pin.name}`).toBeGreaterThanOrEqual(0);
        expect(pin.x, `${type}:${pin.name}`).toBeLessThanOrEqual(def.size.w);
        expect(pin.y, `${type}:${pin.name}`).toBeGreaterThanOrEqual(0);
        expect(pin.y, `${type}:${pin.name}`).toBeLessThanOrEqual(def.size.h);
      }
    }
  });
});
