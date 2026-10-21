import { describe, expect, it } from 'vitest';
import type { PartInstance, ProjectDoc } from '../contracts/project.ts';
import { NS_PER_MS, NS_PER_S } from '../contracts/time.ts';
import { bench, doc, type Logged, logs, part } from './env.test-helper.ts';
import { ENV_PERIOD_NS } from './runtime.ts';

/** Room at the origin, a leak 20 mm (0.2 m in the room) left of a sensor. */
const gasDoc = (log: string, extra: PartInstance[] = []): ProjectDoc =>
  doc([part('room1', 'room', 0, 0), part('leak1', 'leak', 100, 100), part('s1', 'sensor', 120, 100, { log }), ...extra]);

const values = (log: string): { t: number; v: number }[] =>
  (logs.get(log) ?? []).filter((e) => e.input.kind === 'value').map((e) => ({ t: e.t, v: (e.input as { value: number }).value }));

describe('the environment on a bench', () => {
  it('does nothing without an ambient part', () => {
    const b = bench(doc([part('leak1', 'leak', 100, 100), part('s1', 'sensor', 120, 100, { log: 'none' })]));
    b.runUntil(NS_PER_S);
    expect(b.hasEnvironment).toBe(false);
    expect(logs.get('none')).toEqual([]);
  });

  it('feeds a sensor the ambient at reset, then the leak as it spreads, every 50 ms', () => {
    const b = bench(gasDoc('gas'));
    expect(b.hasEnvironment).toBe(true);
    b.runUntil(3 * NS_PER_S);
    const v = values('gas');
    expect(v[v.length - 1].v).toBeGreaterThan(v[1]?.v ?? 0);
    // The reset's sample comes first, at t = 0, with the ambient baseline.
    const all = values('gas');
    const first = all.find((e) => e.t === 0);
    expect(first?.v).toBeCloseTo(400, 6);
    for (const e of v) expect(e.t % ENV_PERIOD_NS).toBe(0);
    // Rising: each delivered value is above the one before.
    const after = v.filter((e) => e.t > 0);
    for (let i = 1; i < after.length; i++) expect(after[i].v).toBeGreaterThan(after[i - 1].v);
    expect(b.envSample('s1', 'gas')).toBeCloseTo(after[after.length - 1].v, 0);
    // The channel delivery: temperature stays at the ambient, so it was sent once per reset.
    const temps = (logs.get('gas') ?? []).filter((e) => e.input.kind === 'key');
    expect(temps.length).toBeGreaterThan(0);
    for (const e of temps) {
      expect(e.t).toBe(0);
      expect(e.input).toEqual({ kind: 'key', key: 'set:temperature=20', down: true });
    }
  });

  it('sends nothing while the value moves less than the epsilon', () => {
    const b = bench(doc([part('room1', 'room', 0, 0), part('s1', 'sensor', 120, 100, { log: 'quiet' })]));
    b.runUntil(2 * NS_PER_S);
    const v = values('quiet');
    expect(v.length).toBeGreaterThan(0);
    expect(v.filter((e) => e.t > 0)).toEqual([]);
  });

  it('routes inputs to sources: switching the leak off stops the rise', () => {
    const b = bench(gasDoc('off'));
    b.runUntil(NS_PER_S);
    b.input('leak1', { kind: 'key', key: 'set:on=0', down: true });
    const at = b.envSample('s1', 'gas') ?? 0;
    b.runUntil(4 * NS_PER_S);
    // No ventilation: the gas spreads out, so near the leak it falls, never rises.
    expect(b.envSample('s1', 'gas') ?? Infinity).toBeLessThan(at + 1);
    b.input('leak1', { kind: 'key', key: 'set:rate=20', down: true });
    b.input('leak1', { kind: 'press' });
    b.runUntil(5 * NS_PER_S);
    expect(b.envSample('s1', 'gas') ?? 0).toBeGreaterThan(at);
  });

  it('puts the world back on reset', () => {
    const b = bench(gasDoc('reset'));
    b.runUntil(2 * NS_PER_S);
    expect(b.envSample('s1', 'gas') ?? 0).toBeGreaterThan(450);
    b.reset();
    expect(b.envSample('s1', 'gas')).toBeCloseTo(400, 9);
    const v = values('reset');
    expect(v[v.length - 1]).toEqual({ t: 0, v: 400 });
  });

  it('is deterministic: two runs give identical inputs at identical times', () => {
    const run = (log: string): Logged[] => {
      const b = bench(gasDoc(log, [part('w1', 'walker', 60, 160), part('p1', 'pir', 100, 200, { log: `${log}-pir` })]));
      b.runUntil(3 * NS_PER_S);
      return [...(logs.get(log) ?? []), ...(logs.get(`${log}-pir`) ?? [])];
    };
    expect(run('det-a')).toEqual(run('det-b'));
  });

  it('runs a source from its control input while it is wired', () => {
    const heaterAt = (wired: boolean, log: string): number => {
      const parts = [part('room1', 'room', 0, 0), part('h1', 'heater', 100, 100), part('v1', 'supply', 0, 200), part('s1', 'sensor', 110, 100, { log })];
      const wires: ProjectDoc['wires'] = wired ? [{ id: 'w1', from: { part: 'v1', pin: 'V' }, to: { part: 'h1', pin: 'IN' }, waypoints: [], color: 'red' }] : [];
      const b = bench(doc(parts, wires));
      // An unwired control input is normal for a source: no "unwired part" note.
      expect(b.problems().some((p) => p.code === 'unwired-part' && p.parts.includes('h1'))).toBe(false);
      b.runUntil(2 * NS_PER_S);
      // A press can't override a wired control.
      b.input('h1', { kind: 'release' });
      b.runUntil(3 * NS_PER_S);
      return b.envSample('s1', 'temperature') ?? 0;
    };
    expect(heaterAt(false, 'h-off')).toBeCloseTo(20, 9);
    expect(heaterAt(true, 'h-on')).toBeGreaterThan(21);
  });

  it('walks a person past a PIR: presses while they walk in view, and their offset in the frames', () => {
    // The person patrols 200 bench mm (2 m) right from x = 60; the PIR 0.5 m below their path faces up.
    const b = bench(doc([part('room1', 'room', 0, 0), part('w1', 'walker', 60, 100), part('p1', 'pir', 160, 150, { log: 'pir' })]));
    b.collectFrame();
    b.runUntil(1500 * NS_PER_MS);
    const presses = (logs.get('pir') ?? []).filter((e) => e.input.kind === 'press');
    expect(presses.length).toBeGreaterThan(5);
    const frame = b.collectFrame();
    const walker = frame.parts.find(([id]) => id === 'w1')?.[1];
    expect(walker?.dx).toBeCloseTo(150, 6); // 1.5 m walked = 150 bench mm at scale 10
    expect(walker?.dy).toBe(0);
    // The ambient part carries the heatmap (overlay 1 = gas) at most every 250 ms.
    const room = frame.parts.find(([id]) => id === 'room1')?.[1];
    expect(room?.overlay).toBe(1);
    expect(Array.isArray(room?.hm)).toBe(true);
  });

  it('warns about a second ambient part and uses the first', () => {
    const b = bench(doc([part('room1', 'room', 0, 0), part('room2', 'room', 50, 0)]));
    expect(b.problems().some((p) => p.code === 'environment-duplicate' && p.parts.includes('room2'))).toBe(true);
  });
});
