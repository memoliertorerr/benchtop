import { CATALOG } from '@benchtop/parts';
import { describe, expect, it } from 'vitest';
import { IC_VIEW_TYPES } from './ics.ts';
import { viewFor } from './registry.ts';

describe('DIP chip views (BT184)', () => {
  it('draw the catalog’s DIP chips, their pins two rows 7.62 mm apart at 2.54 mm', () => {
    for (const type of IC_VIEW_TYPES.keys()) {
      const def = CATALOG.get(type);
      expect(def, type).toBeDefined();
      expect(viewFor(type)).toBe(viewFor('74hc595'));
      const rows = [...new Set(def?.pins.map((p) => p.y))].sort((a, b) => a - b);
      expect(rows).toHaveLength(2);
      expect(rows[1] - rows[0]).toBeCloseTo(7.62, 6);
      for (const pin of def?.pins ?? []) expect(((pin.x - 1.27) / 2.54) % 1).toBeCloseTo(0, 6);
    }
  });
});
