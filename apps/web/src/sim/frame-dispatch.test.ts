import type { VisualState } from '@benchtop/core';
import { TFT_HEIGHT, TFT_PACKED, TFT_WIDTH, unpackPixel } from '@benchtop/parts';
import { describe, expect, it } from 'vitest';
import { FrameDispatcher } from './frame-dispatch.ts';

describe('FrameDispatcher', () => {
  it('updates only the views a frame names', () => {
    const d = new FrameDispatcher();
    const seen: string[] = [];
    d.register('led1', (v) => seen.push(`led1=${v.brightness}`));
    d.register('led2', (v) => seen.push(`led2=${v.brightness}`));
    d.register('btn1', (v) => seen.push(`btn1=${v.pressed}`));
    expect(d.dispatch([['led2', { brightness: 1 }], ['ghost', { x: 1 }]])).toBe(1);
    expect(seen).toEqual(['led2=1']);
    d.dispatch([['btn1', { pressed: true }], ['led1', { brightness: 0.5 }]]);
    expect(seen).toEqual(['led2=1', 'btn1=true', 'led1=0.5']);
  });

  it("gives a view registered later its part's latest state, and stops after unregistering", () => {
    const d = new FrameDispatcher();
    d.dispatch([['led1', { brightness: 0.25 }]]);
    const seen: unknown[] = [];
    const off = d.register('led1', (v) => seen.push(v.brightness));
    expect(seen).toEqual([0.25]);
    off();
    d.dispatch([['led1', { brightness: 1 }]]);
    expect(seen).toEqual([0.25]);
    d.clear();
    d.register('led1', (v) => seen.push(v.brightness));
    expect(seen).toEqual([0.25]);
  });

  it('folds TFT updates into a framebuffer per part, so a view registered late paints everything (BT51)', () => {
    const d = new FrameDispatcher();
    const full = { on: true, invert: false, tftX: 0, tftY: 0, tftW: TFT_WIDTH, tftH: TFT_HEIGHT, tftFull: true, tftPixels: new Array<number>(TFT_PACKED).fill(0) };
    d.dispatch([['tft', full]]);
    // A 2×1 red update at (10, 20), then a 1×1 green one at (0, 0).
    d.dispatch([['tft', { on: true, invert: false, tftX: 10, tftY: 20, tftW: 2, tftH: 1, tftFull: false, tftPixels: [0xf800 + 0xf800 * 65536] }]]);
    d.dispatch([['tft', { on: true, invert: false, tftX: 0, tftY: 0, tftW: 1, tftH: 1, tftFull: false, tftPixels: [0x07e0] }]]);
    const seen: VisualState[] = [];
    d.register('tft', (v) => seen.push(v));
    const frame = seen[0].tftFrame as number[];
    expect([unpackPixel(frame, 20 * TFT_WIDTH + 10), unpackPixel(frame, 20 * TFT_WIDTH + 11), unpackPixel(frame, 0), unpackPixel(frame, 1)]).toEqual([0xf800, 0xf800, 0x07e0, 0]);
    expect(seen[0].tftW).toBe(1); // the latest update rides along
    d.clear();
    d.dispatch([['tft', { on: true, invert: false, tftX: 5, tftY: 5, tftW: 1, tftH: 1, tftFull: false, tftPixels: [1] }]]);
    const after: VisualState[] = [];
    d.register('tft', (v) => after.push(v));
    expect(unpackPixel(after[0].tftFrame as number[], 20 * TFT_WIDTH + 10)).toBe(0); // a new bench starts blank
  });
});
