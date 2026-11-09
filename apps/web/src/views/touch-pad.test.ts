import { CATALOG } from '@benchtop/parts';
import { describe, expect, it } from 'vitest';
import { CONTROLS } from './controls.ts';
import { isInteractive, viewFor } from './registry.ts';
import { TOUCH_PAD_VIEW_TYPES, touchPadView } from './touch-pad.ts';

// BT157: the touch pad has its own drawing, takes the pointer while running (a finger), and a
// Contact slider whose prop the part reads.

describe('the touch pad view (BT157)', () => {
  it('draws the touch pad, which is interactive; its pin lies on the drawing’s edge', () => {
    expect(viewFor('touch-pad')).toBe(touchPadView);
    expect(isInteractive('touch-pad')).toBe(true);
    expect(isInteractive('pushbutton')).toBe(true); // the element library's still are
    expect(isInteractive('led')).toBe(false);
    for (const type of TOUCH_PAD_VIEW_TYPES) {
      const def = CATALOG.get(type);
      expect(def, type).toBeDefined();
      const pad = def?.pins.find((p) => p.name === 'PAD');
      expect(pad?.y).toBe(def?.size.h);
      expect(pad?.x).toBeGreaterThan(0);
      expect(pad?.x).toBeLessThan(def?.size.w ?? 0);
    }
  });

  it('the Contact slider edits a prop the part has, within its 0–1 input range', () => {
    const [slider] = CONTROLS['touch-pad'] ?? [];
    expect(slider).toMatchObject({ kind: 'slider', prop: 'contact', min: 0, max: 1 });
    expect(CATALOG.get('touch-pad')?.defaults.contact).toBe(0);
  });
});
