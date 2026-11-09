import { CATALOG } from '@benchtop/parts';
import { describe, expect, it } from 'vitest';
import { channelLabel, l298nView, MOTOR_VIEW_TYPES, speedLabel } from './motors.ts';
import { viewFor } from './registry.ts';

describe('motor views (BT172)', () => {
  it('draw the catalog’s DC motor', () => {
    for (const type of MOTOR_VIEW_TYPES) {
      expect(CATALOG.get(type), type).toBeDefined();
      expect(viewFor(type)).toBe(viewFor('dc-motor'));
    }
  });

  it('print the speed and the way it turns', () => {
    expect(speedLabel(0)).toBe('stopped');
    expect(speedLabel(0.4)).toBe('stopped');
    expect(speedLabel(9000)).toBe('9000 rpm ▶');
    expect(speedLabel(-1234.4)).toBe('◀ 1234 rpm');
  });

  it('BT173: the L298N’s view, its channels’ status line', () => {
    expect(CATALOG.get('l298n')).toBeDefined();
    expect(viewFor('l298n')).toBe(l298nView);
    expect(channelLabel('A', 0, 0)).toBe('A off');
    expect(channelLabel('A', 1, 2)).toBe('A ▶');
    expect(channelLabel('B', 2, 1)).toBe('B ◀');
    expect(channelLabel('A', 2, 2)).toBe('A brake');
    expect(channelLabel('A', 1, 1)).toBe('A brake');
  });
});
