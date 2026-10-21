import { describe, expect, it } from 'vitest';
import { FieldGrid, STABILITY } from './grid.ts';

/** Modified Bessel function I0 (Abramowitz & Stegun 9.8.1, |x| ≤ 3.75). */
function besselI0(x: number): number {
  const t = (x / 3.75) ** 2;
  return 1 + t * (3.5156229 + t * (3.0899424 + t * (1.2067492 + t * (0.2659732 + t * (0.0360768 + t * 0.0045813)))));
}

/** Modified Bessel function K0 (A&S 9.8.5 for x ≤ 2, 9.8.6 above). */
function besselK0(x: number): number {
  if (x <= 2) {
    const t = (x / 2) ** 2;
    return -Math.log(x / 2) * besselI0(x) - 0.57721566 + t * (0.4227842 + t * (0.23069756 + t * (0.0348859 + t * (0.00262698 + t * (0.0001075 + t * 0.0000074)))));
  }
  const t = 2 / x;
  return (Math.exp(-x) / Math.sqrt(x)) * (1.25331414 + t * (-0.07832358 + t * (0.02189568 + t * (-0.01062446 + t * (0.00587872 + t * (-0.0025154 + t * 0.00053208))))));
}

function blob(grid: FieldGrid): void {
  const v = grid.values;
  const cx = Math.floor(grid.w / 2);
  const cy = Math.floor(grid.h / 2);
  for (let y = cy - 2; y <= cy + 2; y++) for (let x = cx - 3; x <= cx + 1; x++) v[y * grid.w + x] = 1000 + 17 * x - 5 * y;
  grid.wake();
}

describe('FieldGrid', () => {
  it('conserves its total exactly with no decay and no sources', () => {
    const grid = new FieldGrid(32, 24, 0.1);
    grid.diffusion = 0.05;
    blob(grid);
    const before = grid.total();
    for (let i = 0; i < 10_000; i++) grid.step(0.05);
    expect(Math.abs(grid.total() - before) / before).toBeLessThan(1e-9);
    // It spread: the corners hold some now.
    expect(grid.values[0]).toBeGreaterThan(0);
  });

  it('decays a uniform field at exactly e^(−k·t)', () => {
    const grid = new FieldGrid(16, 16, 0.1);
    grid.diffusion = 0.05;
    grid.decay = 0.1;
    grid.values.fill(100);
    grid.wake();
    for (let i = 0; i < 200; i++) grid.step(0.05); // 10 s
    const expected = 100 * Math.exp(-1);
    for (const v of grid.values) expect(Math.abs(v - expected) / expected).toBeLessThan(1e-12);
  });

  it('spreads symmetrically from a central source', () => {
    const grid = new FieldGrid(31, 31, 0.1);
    grid.diffusion = 0.05;
    grid.decay = 0.01;
    grid.source[15 * 31 + 15] = 100;
    grid.wake();
    for (let i = 0; i < 400; i++) grid.step(0.05);
    const v = grid.values;
    for (let y = 0; y < 31; y++) {
      for (let x = 0; x < 31; x++) {
        const a = v[y * 31 + x];
        for (const b of [v[y * 31 + (30 - x)], v[(30 - y) * 31 + x], v[x * 31 + y]]) expect(Math.abs(a - b)).toBeLessThanOrEqual(1e-12 * Math.max(1, Math.abs(a)));
      }
    }
  });

  it('matches the analytic steady state of a point source with decay (C ∝ K0(r/L))', () => {
    // D = k = 0.05 → L = √(D/k) = 1 m; a 8.1 m room so the walls barely matter.
    const n = 81;
    const grid = new FieldGrid(n, n, 0.1);
    grid.diffusion = 0.05;
    grid.decay = 0.05;
    const c = Math.floor(n / 2);
    grid.source[c * n + c] = 50;
    grid.wake();
    for (let i = 0; i < 6000; i++) grid.step(0.05); // 300 s = 15 decay times
    const at = (cells: number): number => grid.values[c * n + c + cells];
    const ratio = at(5) / at(15); // r = 0.5 m and 1.5 m
    const expected = besselK0(0.5) / besselK0(1.5);
    expect(Math.abs(ratio - expected) / expected).toBeLessThan(0.1);
    // Steady: another 10 s changes nothing measurable.
    const before = at(5);
    for (let i = 0; i < 200; i++) grid.step(0.05);
    expect(Math.abs(at(5) - before) / before).toBeLessThan(1e-6);
  });

  it('keeps every substep inside the explicit scheme’s limit', () => {
    const grid = new FieldGrid(8, 8, 0.05);
    for (const d of [0.001, 0.02, 0.05, 0.5]) {
      grid.diffusion = d;
      for (const dt of [0.001, 0.05, 0.5]) {
        const n = grid.substeps(dt);
        expect((d * (dt / n)) / (grid.dx * grid.dx)).toBeLessThanOrEqual(STABILITY + 1e-12);
      }
    }
  });

  it('samples bilinearly between cell centres and clamps outside', () => {
    const grid = new FieldGrid(2, 1, 1);
    grid.values[0] = 10;
    grid.values[1] = 20;
    expect(grid.sample(0.5, 0.5)).toBe(10);
    expect(grid.sample(1, 0.5)).toBe(15);
    expect(grid.sample(1.5, 0.5)).toBe(20);
    expect(grid.sample(-3, 7)).toBe(10);
    expect(grid.cellOf(1.2, 0.3)).toBe(1);
  });

  it('skips steps while empty and unfed, and wakes when fed', () => {
    const grid = new FieldGrid(4, 4, 0.1);
    grid.diffusion = 0.05;
    grid.step(1);
    expect(grid.total()).toBe(0);
    grid.source[5] = 1;
    grid.wake();
    grid.step(1);
    expect(grid.total()).toBeCloseTo(1, 12);
  });
});
