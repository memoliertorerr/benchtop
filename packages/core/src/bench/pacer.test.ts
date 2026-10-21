import { describe, expect, it } from 'vitest';
import { NS_PER_MS } from '../contracts/time.ts';
import { MAX_CATCH_UP_MS, RealtimePacer } from './pacer.ts';

describe('RealtimePacer', () => {
  it('targets speed × elapsed wall time', () => {
    const realTime = new RealtimePacer(1);
    realTime.start(0);
    expect(realTime.target(100, 0)).toBe(100 * NS_PER_MS);

    const slow = new RealtimePacer(0.1);
    slow.start(0);
    expect(slow.target(100, 0)).toBe(10 * NS_PER_MS);
  });

  it('at speed Infinity lets the caller run its whole budget', () => {
    const max = new RealtimePacer(Infinity);
    max.start(0);
    expect(max.target(16, 5 * NS_PER_MS)).toBe(Infinity);
  });

  it('never targets behind the simulation, and forgives more than 100 ms of debt', () => {
    const p = new RealtimePacer(1);
    p.start(1000);
    expect(p.target(1010, 50 * NS_PER_MS)).toBe(60 * NS_PER_MS); // anchored at 50 ms, 10 ms in
    expect(p.target(1010, 80 * NS_PER_MS)).toBe(80 * NS_PER_MS); // ahead of wall time: run nothing
    // The tab was suspended for 10 s: catch up at most 100 ms, then continue in real time.
    const resumed = p.target(11_010, 80 * NS_PER_MS);
    expect(resumed).toBe((80 + MAX_CATCH_UP_MS) * NS_PER_MS);
    expect(p.target(11_026, resumed)).toBe(resumed + 16 * NS_PER_MS);
  });

  it('changes speed from the latest call on', () => {
    const p = new RealtimePacer(1);
    p.start(0);
    expect(p.target(100, 0)).toBe(100 * NS_PER_MS);
    p.setSpeed(10);
    expect(p.target(110, 100 * NS_PER_MS)).toBe(200 * NS_PER_MS);
    expect(() => p.setSpeed(0)).toThrow(RangeError);
  });

  it('reports the real-time ratio over the last second', () => {
    const p = new RealtimePacer(1);
    p.start(0);
    expect(p.ratio()).toBe(0);
    // The simulation only manages half speed for 2 s, then full speed for 1 s.
    let sim = 0;
    for (let wall = 0; wall <= 2000; wall += 16) {
      p.target(wall, sim);
      sim += 8 * NS_PER_MS;
    }
    expect(p.ratio()).toBeCloseTo(0.5, 2);
    for (let wall = 2016; wall <= 3200; wall += 16) {
      p.target(wall, sim);
      sim += 16 * NS_PER_MS;
    }
    expect(p.ratio()).toBeCloseTo(1, 2);
  });
});
