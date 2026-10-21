import { packBytes } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { clearHeatmap, heatmap, heatRgba, onHeatmap, setHeatmap } from './heatmap.ts';

describe('heatmap store', () => {
  it('unpacks the room part’s grid and clears when the overlay is off', () => {
    const seen: (number | null)[] = [];
    const off = onHeatmap((h) => seen.push(h === null ? null : h.bytes[5]));
    const bytes = Uint8Array.from({ length: 12 }, (_, i) => i * 20);
    setHeatmap({ overlay: 1, hmW: 4, hmH: 3, hmX: -100, hmY: 50, hmCell: 6.25, hm: packBytes(bytes) });
    expect(heatmap()).toMatchObject({ field: 1, w: 4, h: 3, x: -100, y: 50, cell: 6.25 });
    expect([...heatmap()!.bytes]).toEqual([...bytes]);
    setHeatmap({ overlay: 0 });
    expect(heatmap()).toBeNull();
    setHeatmap({ dx: 1 }); // not a room state: ignored
    clearHeatmap();
    off();
    expect(seen).toEqual([100, null]);
  });

  it('colours: transparent at 0, opaque from two thirds up, blue to red', () => {
    const out = new Uint8ClampedArray(12);
    heatRgba(0, out, 0);
    heatRgba(64, out, 4);
    heatRgba(255, out, 8);
    expect(out[3]).toBe(0);
    expect(out[7]).toBe(96);
    expect(out[11]).toBe(255);
    expect([out[8], out[9], out[10]]).toEqual([230, 40, 30]);
  });
});
