import { describe, expect, it } from 'vitest';
import { patrolAt } from './bodies.ts';
import type { AmbientSpec } from './spec.ts';
import { AIR_HEAT_CAPACITY, saturationPressure, World } from './world.ts';

const AMBIENT: AmbientSpec = {
  temperature: 20,
  humidity: 50,
  light: 0,
  sound: 30,
  gas: 0,
  ventilation: 0,
  mixing: 0.05,
  roomWidth: 4,
  roomDepth: 3,
  layer: 0.3,
  heatLoss: 0,
  scale: 10,
  overlay: 0,
};

const world = (ambient: Partial<AmbientSpec> = {}): World => new World({ ...AMBIENT, ...ambient }, { x0: -3.2, y0: -3.2, x1: 3.2, y1: 3.2 });

describe('World', () => {
  it('sizes its grid from the extent: 64 cells on the longer side, at least 5 cm', () => {
    const w = world();
    expect(w.gas.w).toBe(64);
    expect(w.gas.h).toBe(64);
    expect(w.gas.dx).toBeCloseTo(0.1, 12);
    const small = new World(AMBIENT, { x0: 0, y0: 0, x1: 1, y1: 0.5 });
    expect(small.gas.dx).toBe(0.05);
    expect([small.gas.w, small.gas.h]).toEqual([20, 10]);
  });

  it('turns a leak in L/min into ppm per second in its cell column', () => {
    const w = world();
    w.addSource('leak', 'gas', 0.05, 0.05, { rate: 1 }, true);
    const cell = w.gas.cellOf(0.05 + 3.2, 0.05 + 3.2);
    // 1 L/min into 0.1 × 0.1 × 0.3 m³.
    expect(w.gas.source[cell]).toBeCloseTo((1 / 60_000 / 0.003) * 1e6, 9);
    w.sources[0].on = false;
    w.applySources();
    expect(w.gas.source[cell]).toBe(0);
  });

  it('turns a heater in W into °C per second (ρ·cp = 1200 J/m³K)', () => {
    const w = world();
    w.addSource('heater', 'heat', 0, 0, { watts: 100 }, true);
    const cell = w.heat.cellOf(3.2, 3.2);
    expect(w.heat.source[cell]).toBeCloseTo(100 / (AIR_HEAT_CAPACITY * 0.003), 9);
  });

  it('decays gas at the ventilation rate and lets a fan draw it from within 0.5 m', () => {
    const w = world({ ventilation: 36 }); // k = 0.01/s
    expect(w.gas.decay).toBeCloseTo(0.01, 12);
    w.addSource('fan', 'fan', 0.05, 0.05, { flow: 3 }, true);
    // 0.1 m cells: the disc of radius 0.5 m around (3.25, 3.25) in grid coordinates.
    const inside = [...w.gas.sink].filter((k) => k > 0);
    expect(inside.length).toBe(81); // the lattice points within 5 cells (Gauss's circle count for r = 5)
    const each = 3 / 60 / (inside.length * 0.003);
    for (const k of inside) expect(k).toBeCloseTo(each, 9);
    // Their total draw is the fan's flow over a cell column's volume: 3 m³/min.
    expect(inside.reduce((sum, k) => sum + k * 0.003, 0) * 60).toBeCloseTo(3, 9);
    expect(w.gas.sink[w.gas.cellOf(3.25 + 0.6, 3.25)]).toBe(0);
  });

  it('adds light inverse-square per lamp and flame, over the ambient', () => {
    const w = world({ light: 10 });
    w.addSource('lamp', 'light', 1, 0, { lumens: 800 }, true);
    expect(w.lightAt(0, 0)).toBeCloseTo(10 + 800 / (4 * Math.PI), 9);
    expect(w.lightAt(-1, 0)).toBeCloseTo(10 + 800 / (4 * Math.PI * 4), 9);
    expect(w.lightAt(1, 0)).toBeCloseTo(10 + 800 / (4 * Math.PI * 0.05 ** 2), 6); // r ≥ 5 cm
    w.addSource('candle', 'flame', 0, 1, { strength: 1 }, true);
    expect(w.lightAt(0, 0)).toBeCloseTo(10 + 800 / (4 * Math.PI) + 12 / (4 * Math.PI), 9);
  });

  it('adds sound levels as energies, −6 dB per doubling of distance', () => {
    const w = world({ sound: 30 });
    w.addSource('a', 'sound', 1, 0, { db: 70 }, true);
    w.addSource('b', 'sound', -2, 0, { db: 70 }, true);
    const expected = 10 * Math.log10(10 ** 3 + 10 ** 7 + 10 ** ((70 - 20 * Math.log10(2)) / 10));
    expect(w.soundAt(0, 0)).toBeCloseTo(expected, 9);
    w.sources[0].on = false;
    w.sources[1].on = false;
    expect(w.soundAt(0, 0)).toBeCloseTo(30, 12);
  });

  it('sees flames by infrared inside the cone only, falling off with r²', () => {
    const w = world();
    w.addSource('f', 'flame', 0, -0.4, { strength: 1 }, true);
    const half = Math.PI / 6;
    expect(w.flameAt(0, 0, 0, -1, half, 2)).toBeCloseTo(0.25, 12);
    expect(w.flameAt(0, -0.3, 0, -1, half, 2)).toBe(1); // 10 cm: saturated
    expect(w.flameAt(0, 0, 0, 1, half, 2)).toBe(0); // behind
    expect(w.flameAt(0.4, 0, 0, -1, half, 2)).toBe(0); // 45° off-axis
  });

  it('lowers relative humidity where it is warmer (constant absolute humidity)', () => {
    const w = world();
    w.heat.values.fill(10);
    w.heat.wake();
    expect(w.temperatureAt(0, 0)).toBeCloseTo(30, 12);
    expect(w.humidityAt(0, 0)).toBeCloseTo((50 * saturationPressure(20)) / saturationPressure(30), 9);
    expect(w.humidityAt(0, 0)).toBeCloseTo(27.5, 1);
  });

  it('walks a body along its patrol, pausing at each end, and reports motion in a cone', () => {
    const out = new Float64Array(2);
    const patrol = { x0: 0, y0: 0, x1: 2, y1: 0, speed: 1, pause: 0.5 };
    expect(patrolAt(patrol, 0.25, out)).toBe(0);
    expect([...out]).toEqual([0, 0]);
    expect(patrolAt(patrol, 1.5, out)).toBe(1);
    expect(out[0]).toBeCloseTo(1, 12);
    expect(patrolAt(patrol, 2.75, out)).toBe(0);
    expect(out[0]).toBeCloseTo(2, 12);
    expect(patrolAt(patrol, 3.5, out)).toBe(1);
    expect(out[0]).toBeCloseTo(1.5, 12);
    expect(patrolAt(patrol, 5 + 1.5, out)).toBe(1); // one 5 s cycle later
    expect(out[0]).toBeCloseTo(1, 12);

    const w = world();
    const body = w.addBody('p', { kind: 'circle', x: 0, y: 0, r: 0.2, hw: 0, hh: 0 }, true, { x0: -1, y0: -1, x1: 1, y1: -1, speed: 1, pause: 0 }, true);
    const half = (55 * Math.PI) / 180;
    w.step(1); // at (0, −1), walking
    expect(body.shape.x).toBeCloseTo(0, 12);
    expect(w.motionAt(0, 0, 0, -1, half, 7)).toBe(1);
    expect(w.distanceAt(0, 0, 0, -1, (15 * Math.PI) / 180, 4)).toBeCloseTo(0.8, 12);
    body.on = false;
    w.step(1); // stopped where it was
    expect(body.shape.x).toBeCloseTo(0, 12);
    expect(w.motionAt(0, 0, 0, -1, half, 7)).toBe(0);
    body.on = true;
    w.step(0.5);
    expect(body.shape.x).toBeCloseTo(0.5, 12);
  });

  it('is deterministic', () => {
    const run = (): number[] => {
      const w = world({ ventilation: 2 });
      w.addSource('leak', 'gas', 0.3, -0.2, { rate: 0.5 }, true);
      w.addSource('heater', 'heat', -0.5, 0.4, { watts: 60 }, true);
      for (let i = 0; i < 100; i++) w.step(0.05);
      return [w.gasAt(0, 0), w.temperatureAt(0.1, 0.1), w.gas.total(), w.heat.total()];
    };
    expect(run()).toEqual(run());
  });
});
