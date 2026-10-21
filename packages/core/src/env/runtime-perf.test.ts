import { describe, expect, it } from 'vitest';
import { NS_PER_S } from '../contracts/time.ts';
import { bench, doc, part } from './env.test-helper.ts';

// BT54: the environment's cost per simulated second (a wall-clock budget: in vitest.config.ts's QUIET group).

describe('the environment on a bench', () => {
  it('costs little: 20 sensors around a leak and a heater on a 64×64 grid', () => {
    const parts = [part('room1', 'room', 0, 0), part('leak1', 'leak', 100, 100), part('h1', 'heater', 200, 300)];
    for (let i = 0; i < 20; i++) parts.push(part(`s${i}`, 'sensor', 50 + (i % 5) * 60, 50 + Math.floor(i / 5) * 80, { log: `perf${i}` }));
    const b = bench(doc(parts, []));
    b.input('h1', { kind: 'press' });
    const start = performance.now();
    b.runUntil(10 * NS_PER_S);
    const perSecond = (performance.now() - start) / 10;
    console.info(`environment: ${perSecond.toFixed(3)} ms of wall time per simulated second (20 sensors, 64×64 grid)`);
    expect(perSecond).toBeLessThan(20);
  });
});
