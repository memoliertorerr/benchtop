import { describe, expect, it } from 'vitest';
import { Scheduler } from './scheduler.ts';

describe('Scheduler', () => {
  it('fires callbacks in time order, FIFO for equal times', () => {
    const s = new Scheduler();
    const fired: string[] = [];
    s.schedule(30, () => fired.push('c30'));
    s.schedule(10, () => fired.push('a10'));
    s.schedule(20, () => fired.push('b20-first'));
    s.schedule(20, () => fired.push('b20-second'));
    s.schedule(10, () => fired.push('a10-second'));
    expect(s.nextTime()).toBe(10);
    expect(s.runDue(20)).toBe(4);
    expect(fired).toEqual(['a10', 'a10-second', 'b20-first', 'b20-second']);
    expect(s.nextTime()).toBe(30);
    s.runDue(100);
    expect(fired.at(-1)).toBe('c30');
    expect(s.nextTime()).toBe(Infinity);
  });

  it('never fires cancelled ids, and ignores stale or repeated cancels', () => {
    const s = new Scheduler();
    const fired: number[] = [];
    const a = s.schedule(5, () => fired.push(5));
    const b = s.schedule(6, () => fired.push(6));
    s.cancel(a);
    s.cancel(a);
    expect(s.size).toBe(1);
    expect(s.nextTime()).toBe(6);
    s.runDue(10);
    s.cancel(b); // already fired
    // A recycled entry gets a new id; the old ids still don't touch it.
    const c = s.schedule(20, () => fired.push(20));
    expect(c).not.toBe(a);
    expect(c).not.toBe(b);
    s.cancel(a);
    s.cancel(b);
    s.runDue(20);
    expect(fired).toEqual([6, 20]);
  });

  it('runs timers scheduled by callbacks inside the window, and honors cancels made there', () => {
    const s = new Scheduler();
    const fired: string[] = [];
    let victim = -1;
    s.schedule(1, () => {
      fired.push('one');
      s.schedule(1, () => fired.push('one-again'));
      s.schedule(50, () => fired.push('later'));
      s.cancel(victim);
    });
    victim = s.schedule(2, () => fired.push('victim'));
    s.runDue(10);
    expect(fired).toEqual(['one', 'one-again']);
    expect(s.nextTime()).toBe(50);
  });

  it('grows past its initial capacity and compacts cancelled entries', () => {
    const s = new Scheduler();
    const ids: number[] = [];
    for (let i = 0; i < 5000; i++) ids.push(s.schedule(i, () => {}));
    for (let i = 0; i < 4990; i++) s.cancel(ids[i]);
    expect(s.size).toBe(10);
    expect(s.nextTime()).toBe(4990);
    expect(s.runDue(Infinity)).toBe(10);
    s.schedule(1, () => {});
    s.clear();
    expect(s.size).toBe(0);
    expect(s.nextTime()).toBe(Infinity);
  });
});
