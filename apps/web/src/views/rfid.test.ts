import { CATALOG, PART_INPUTS } from '@benchtop/parts';
import { describe, expect, it } from 'vitest';
import { CONTROLS } from './controls.ts';
import { isInteractive, viewFor } from './registry.ts';
import { RFID_VIEW_TYPES, rfidView } from './rfid.ts';

// BT196, BT199: the RC522 has its own drawing, takes the pointer while running (a click puts the
// card on or takes the tag off) and Inspector buttons for the card, the fob and neither.

describe('the RC522 view (BT196, BT199)', () => {
  it('draws the RC522, which is interactive; its header runs along the bottom edge on the 2.54 mm pitch', () => {
    for (const type of RFID_VIEW_TYPES) {
      expect(viewFor(type)).toBe(rfidView);
      expect(isInteractive(type)).toBe(true);
      const def = CATALOG.get(type);
      expect(def, type).toBeDefined();
      const pins = def?.pins ?? [];
      expect(pins.map((p) => p.name)).toEqual(['SDA', 'SCK', 'MOSI', 'MISO', 'IRQ', 'GND', 'RST', '3.3V']);
      for (let i = 1; i < pins.length; i++) expect(pins[i].x - pins[i - 1].x).toBeCloseTo(2.54, 6);
      for (const pin of pins) expect(pin.y).toBeCloseTo((def?.size.h ?? 0) - 2.54, 6);
    }
  });

  it('the Inspector’s buttons send the keys the part takes', () => {
    const keys = PART_INPUTS.rc522?.find((s) => s.kind === 'key');
    const buttons = CONTROLS.rc522 ?? [];
    expect(buttons.map((b) => b.label)).toEqual(['Card on', 'Fob on', 'Take off']);
    for (const button of buttons) {
      expect(button.kind).toBe('button');
      if (button.kind === 'button' && button.input.kind === 'key' && keys?.kind === 'key') expect(keys.keys).toContain(button.input.key);
      else throw new Error(`${button.label} sends no key`);
    }
  });
});
