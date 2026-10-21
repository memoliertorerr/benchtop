import { describe, expect, it } from 'vitest';
import { PROBE_CAPACITY, ProbeRing } from './ring.ts';

describe('ProbeRing', () => {
  it('holds 2^17 edges; on overflow keeps the newest in order and counts the dropped ones', () => {
    const ring = new ProbeRing();
    expect(ring.capacity).toBe(131_072);
    const total = PROBE_CAPACITY + 1000;
    for (let i = 0; i < total; i++) ring.push(i * 10, i & 1);
    expect(ring.size).toBe(PROBE_CAPACITY);
    expect(ring.dropped).toBe(1000);
    expect(ring.first).toBe(1000);
    for (let k = ring.first; k < ring.written; k += 997) {
      expect(ring.timeAt(k)).toBe(k * 10);
      expect(ring.levelAt(k)).toBe(k & 1);
    }
    const all = ring.read(0);
    expect(all.from).toBe(1000);
    expect(all.lost).toBe(1000);
    expect(all.times.length).toBe(PROBE_CAPACITY);
    expect(all.times[0]).toBe(10_000);
    expect(all.times[PROBE_CAPACITY - 1]).toBe((total - 1) * 10);
    expect(Array.from(all.times.subarray(1, 50)).every((t, i) => t > all.times[i])).toBe(true);
  });

  it('reads incrementally, capping at the newest `max` edges', () => {
    const ring = new ProbeRing(16);
    for (let i = 0; i < 10; i++) ring.push(i, i % 4);
    const first = ring.read(0, 4);
    expect([first.from, Array.from(first.times), first.lost]).toEqual([6, [6, 7, 8, 9], 6]);
    ring.push(10, 2);
    const next = ring.read(first.from + first.times.length);
    expect([next.from, Array.from(next.times), Array.from(next.levels), next.lost]).toEqual([10, [10], [2], 0]);
    expect(ring.read(11).times.length).toBe(0);
  });

  it('after 1 M records still holds the same typed-array instances', () => {
    const ring = new ProbeRing();
    const { times, levels } = ring;
    for (let i = 0; i < 1_000_000; i++) ring.push(i, i & 1);
    expect(ring.times).toBe(times);
    expect(ring.levels).toBe(levels);
    expect(ring.dropped).toBe(1_000_000 - PROBE_CAPACITY);
    expect(ring.timeAt(ring.written - 1)).toBe(999_999);
  });
});
