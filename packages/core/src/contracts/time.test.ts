import { describe, expect, it } from 'vitest';
import { cyclesToNanos, nanosToCycles, NS_PER_MS } from './time.ts';

describe('time conversions', () => {
  it('converts 16 MHz cycles to nanoseconds', () => {
    expect(cyclesToNanos(16_000, 16_000_000)).toBe(NS_PER_MS);
  });

  it('rounds nanoseconds down to whole cycles', () => {
    // 240 MHz: one cycle is 4.1666… ns, so 10 ns holds 2 whole cycles.
    expect(nanosToCycles(10, 240_000_000)).toBe(2);
    expect(nanosToCycles(NS_PER_MS, 16_000_000)).toBe(16_000);
  });
});
