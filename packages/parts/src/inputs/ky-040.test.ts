import { Bench, NS_PER_MS, type ProjectDoc, Strength } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { benchEnvParts } from '../catalog.ts';

/** A bench holding only an encoder; records CLK/DT changes sampled every 10 µs. */
function encoder() {
  const doc: ProjectDoc = { format: 1, name: 'enc', parts: [{ id: 'enc', type: 'ky-040', x: 0, y: 0, rotation: 0, props: {} }], wires: [], firmware: {} };
  const bench = new Bench(doc, { part: benchEnvParts, createMcu: () => undefined });
  const edges: string[] = [];
  const level = (pin: string) => bench.pinState('enc', pin)!;
  let last = { CLK: 1, DT: 1 };
  const sample = (): void => {
    for (const pin of ['CLK', 'DT'] as const) {
      const now = level(pin).level ?? -1;
      if (now !== last[pin]) edges.push(`${(bench.now() / 1e6).toFixed(2)} ${pin} ${now}`);
      last = { ...last, [pin]: now };
    }
  };
  /** Samples now, then after every 10 µs up to `ms` (timers due at t run before the sample at t). */
  const run = (ms: number): void => {
    sample();
    const end = bench.now() + ms * NS_PER_MS;
    while (bench.now() < end) {
      bench.runUntil(bench.now() + 10_000);
      sample();
    }
  };
  return { bench, edges, run, level };
}

describe('KY-040', () => {
  it('rests with CLK and DT pulled up (weak 1)', () => {
    const { level } = encoder();
    expect(level('CLK')).toMatchObject({ level: 1, strength: Strength.weak });
    expect(level('DT')).toMatchObject({ level: 1, strength: Strength.weak });
  });

  it('one CW detent: CLK falls, DT falls, CLK rises, DT rises, 1 ms apart', () => {
    const { bench, edges, run } = encoder();
    bench.input('enc', { kind: 'key', key: 'cw', down: true });
    run(5);
    expect(edges).toEqual(['0.00 CLK 0', '1.00 DT 0', '2.00 CLK 1', '3.00 DT 1']);
  });

  it('one CCW detent mirrors it, and closed contacts are strong 0', () => {
    const { bench, edges, run, level } = encoder();
    bench.input('enc', { kind: 'key', key: 'ccw', down: true });
    run(0.5);
    expect(level('DT')).toMatchObject({ level: 0, strength: Strength.strong });
    run(4.5);
    expect(edges).toEqual(['0.00 DT 0', '1.00 CLK 0', '2.00 DT 1', '3.00 CLK 1']);
  });

  it('queues detents back to back', () => {
    const { bench, edges, run } = encoder();
    for (const key of ['cw', 'cw', 'ccw']) bench.input('enc', { kind: 'key', key, down: true });
    run(14);
    expect(edges).toHaveLength(12);
    expect(edges[4]).toBe('4.00 CLK 0');
    expect(edges[8]).toBe('8.00 DT 0');
  });
});
