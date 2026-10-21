import { ProbeRing } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { decimate, edgeAt, type EdgeSource } from './decimate.ts';
import { formatFrequency, formatTime, niceStep } from './units.ts';

/** An edge list from plain arrays (any length, unlike a ProbeRing). */
const edges = (times: number[], levels: number[]): EdgeSource => ({
  first: 0,
  written: times.length,
  timeAt: (i) => times[i],
  levelAt: (i) => levels[i],
});

describe('decimate', () => {
  it('a slow square wave: one segment per level, edges at the right columns', () => {
    const source = edges([0, 100, 200, 300], [0, 1, 0, 1]);
    expect(decimate(source, 0, 400, 40, 400)).toEqual([
      { x0: 0, x1: 10, level: 0 },
      { x0: 10, x1: 20, level: 1 },
      { x0: 20, x1: 30, level: 0 },
      { x0: 30, x1: 40, level: 1 },
    ]);
  });

  it('starts at the first edge, stops at the newest time, and marks dense columns mixed', () => {
    const source = edges([50, 100, 101, 102, 150], [2, 0, 1, 0, 1]);
    expect(decimate(source, 0, 200, 20, 180)).toEqual([
      { x0: 5, x1: 10, level: 2 },
      { x0: 10, x1: 11, level: -1 },
      { x0: 11, x1: 15, level: 0 },
      { x0: 15, x1: 18, level: 1 },
    ]);
    // A window that starts mid-trace picks up the level before it.
    expect(decimate(source, 120, 200, 8, 200)).toEqual([
      { x0: 0, x1: 3, level: 0 },
      { x0: 3, x1: 8, level: 1 },
    ]);
  });

  it('renders a 1 M-edge probe into at most 2 × width segments', () => {
    const n = 1_000_000;
    const times = new Float64Array(n);
    const levels = new Uint8Array(n);
    // Irregular spacing (1–40 ns) so columns hold varying edge counts, some exactly one.
    let t = 0;
    for (let i = 0; i < n; i++) {
      t += 1 + ((i * 7919) % 40);
      times[i] = t;
      levels[i] = i & 1;
    }
    const source: EdgeSource = { first: 0, written: n, timeAt: (i) => times[i], levelAt: (i) => levels[i] };
    for (const width of [300, 1200, 4000]) {
      const start = performance.now();
      const segments = decimate(source, 0, t, width, t);
      const ms = performance.now() - start;
      expect(segments.length).toBeGreaterThan(0);
      expect(segments.length).toBeLessThanOrEqual(2 * width);
      expect(segments.at(-1)?.x1).toBe(width);
      expect(ms).toBeLessThan(200);
    }
    // Zoomed far in, every edge gets its own column.
    const zoomed = decimate(source, times[1000], times[1010], 1000, t);
    expect(zoomed.every((s) => s.level !== -1)).toBe(true);
  });

  it('works on a ProbeRing that overflowed', () => {
    const ring = new ProbeRing(8);
    for (let i = 0; i < 20; i++) ring.push(i * 10, i & 1);
    expect(edgeAt(ring, 5)).toBe(ring.first - 1);
    expect(edgeAt(ring, 125)).toBe(12);
    const segments = decimate(ring, 0, 200, 20, 200);
    expect(segments[0]).toEqual({ x0: 12, x1: 13, level: 0 });
    expect(segments.at(-1)).toEqual({ x0: 19, x1: 20, level: 1 });
  });
});

describe('units', () => {
  it('formats times, frequencies and axis steps', () => {
    expect(formatTime(2_040_816)).toBe('2.041 ms');
    expect(formatTime(104_167)).toBe('104.2 µs');
    expect(formatTime(512)).toBe('512 ns');
    expect(formatTime(1.5e9)).toBe('1.5 s');
    expect(formatTime(0)).toBe('0 s');
    expect(formatFrequency(1e9 / 2_040_816)).toBe('490 Hz');
    expect(formatFrequency(9600)).toBe('9.6 kHz');
    expect(niceStep(10e6, 8)).toBe(2e6);
    expect(niceStep(1000, 10)).toBe(100);
  });
});
