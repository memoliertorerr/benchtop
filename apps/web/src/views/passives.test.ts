import { CATALOG } from '@benchtop/parts';
import { describe, expect, it } from 'vitest';
import { canLabel, eiaCode, PASSIVE_VIEW_TYPES } from './passives.ts';
import { viewFor } from './registry.ts';

describe('passive part views (BT167)', () => {
  it('draw the catalog’s capacitors, diode and (BT169) transistors', () => {
    expect(PASSIVE_VIEW_TYPES.size).toBe(7);
    for (const type of PASSIVE_VIEW_TYPES) {
      expect(CATALOG.get(type), type).toBeDefined();
      expect(viewFor(type)).toBe(viewFor('capacitor'));
    }
  });

  it('print a ceramic’s EIA code and an electrolytic’s µF', () => {
    expect(eiaCode(100e-9)).toBe('104');
    expect(eiaCode(10e-9)).toBe('103');
    expect(eiaCode(22e-12)).toBe('220');
    expect(eiaCode(4.7e-9)).toBe('472');
    expect(eiaCode(1e-6)).toBe('105');
    expect(eiaCode(4.7e-12)).toBe('4p7');
    expect(canLabel(10e-6)).toBe('10µF');
    expect(canLabel(470e-6)).toBe('470µF');
    expect(canLabel(2.2e-3)).toBe('2200µF');
  });
});
