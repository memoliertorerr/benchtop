/**
 * A scalar field on a W×H grid of square cells (BT54): gas (ppm above the ambient baseline) or
 * heat (°C above the ambient). Each step diffuses with the 5-point Laplacian (explicit, closed
 * Neumann edges: no flux leaves the room), adds the sources and decays toward 0. Substeps keep
 * D·dt/dx² ≤ 0.2 (the explicit scheme's limit is 0.25). Decay is applied as exp(−k·h) per
 * substep, so a uniform field decays at exactly e^(−k·t). Preallocated, double buffered; a
 * step allocates nothing.
 */

/** The explicit scheme's step limit used: D·h/dx² ≤ STABILITY. */
export const STABILITY = 0.2;

export class FieldGrid {
  readonly w: number;
  readonly h: number;
  /** Cell size, m. */
  readonly dx: number;
  private cur: Float64Array;
  private next: Float64Array;
  /** Added per second, per cell (field units / s). */
  readonly source: Float64Array;
  /** Extra decay rate per cell (1/s) on top of the uniform one (a fan's extraction). */
  readonly sink: Float64Array;
  /** Per-cell decay factor of the current step (scratch). */
  private readonly factor: Float64Array;
  /** Uniform decay rate, 1/s. */
  decay = 0;
  /** Diffusion coefficient, m²/s. */
  diffusion = 0;
  /** Nothing in it and nothing feeding it: steps are skipped. */
  private idle = true;

  constructor(w: number, h: number, dx: number) {
    if (!(w >= 1 && h >= 1 && Number.isInteger(w) && Number.isInteger(h))) throw new RangeError(`bad grid size ${w}×${h}`);
    if (!(dx > 0)) throw new RangeError(`bad cell size ${dx}`);
    this.w = w;
    this.h = h;
    this.dx = dx;
    this.cur = new Float64Array(w * h);
    this.next = new Float64Array(w * h);
    this.source = new Float64Array(w * h);
    this.sink = new Float64Array(w * h);
    this.factor = new Float64Array(w * h);
  }

  /** The field's values (row-major, y down). Valid until the next step. */
  get values(): Float64Array {
    return this.cur;
  }

  clear(): void {
    this.cur.fill(0);
    this.next.fill(0);
    this.idle = true;
  }

  /** Marks the grid as needing steps (a source or sink changed). */
  wake(): void {
    this.idle = false;
  }

  /** Sum of every cell (for conservation checks). */
  total(): number {
    let sum = 0;
    const cur = this.cur;
    for (let i = 0; i < cur.length; i++) sum += cur[i];
    return sum;
  }

  /** Substeps one step of `dt` seconds takes. */
  substeps(dt: number): number {
    if (!(this.diffusion > 0)) return 1;
    const limit = (STABILITY * this.dx * this.dx) / this.diffusion;
    return Math.max(1, Math.ceil(dt / limit));
  }

  /** Advances the field by `dt` seconds. */
  step(dt: number): void {
    if (!(dt > 0) || this.idle) return;
    const n = this.substeps(dt);
    const hs = dt / n;
    const r = (this.diffusion * hs) / (this.dx * this.dx);
    const keep = Math.exp(-this.decay * hs);
    // Per-cell decay factors only where a sink is (a fan); elsewhere the scalar `keep`.
    const sink = this.sink;
    const factor = this.factor;
    let sinks = false;
    for (let i = 0; i < sink.length; i++) {
      if (sink[i] > 0) {
        factor[i] = keep * Math.exp(-sink[i] * hs);
        sinks = true;
      } else factor[i] = keep;
    }
    let nonzero = false;
    for (let s = 0; s < n; s++) {
      nonzero = sinks ? this.substep(r, hs, keep, factor) : this.substep(r, hs, keep, null);
      const swap = this.cur;
      this.cur = this.next;
      this.next = swap;
    }
    // A field that is all zero with nothing feeding it stays zero: skip it until woken.
    if (!nonzero && !this.fed()) this.idle = true;
  }

  /** One explicit substep from `cur` into `next`; true when any cell is nonzero. */
  private substep(r: number, hs: number, keep: number, factor: Float64Array | null): boolean {
    const { w, h } = this;
    const cur = this.cur;
    const next = this.next;
    const source = this.source;
    let nonzero = false;
    const c4 = 1 - 4 * r;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      const interior = y > 0 && y < h - 1;
      for (let x = 0; x < w; x++) {
        const i = row + x;
        const c = cur[i];
        let v: number;
        if (interior && x > 0 && x < w - 1) {
          v = c * c4 + r * (cur[i - 1] + cur[i + 1] + cur[i - w] + cur[i + w]);
        } else {
          // Closed walls: a missing neighbour mirrors the cell (no flux leaves the room).
          const left = x > 0 ? cur[i - 1] : c;
          const right = x < w - 1 ? cur[i + 1] : c;
          const up = y > 0 ? cur[i - w] : c;
          const down = y < h - 1 ? cur[i + w] : c;
          v = c + r * (left + right + up + down - 4 * c);
        }
        v = (v + source[i] * hs) * (factor === null ? keep : factor[i]);
        next[i] = v;
        if (v !== 0) nonzero = true;
      }
    }
    return nonzero;
  }

  /** Bilinear sample at (x, y) metres from the grid's top-left corner (cell centres at (i+0.5)·dx). */
  sample(x: number, y: number): number {
    const { w, h, dx } = this;
    const fx = Math.min(w - 1, Math.max(0, x / dx - 0.5));
    const fy = Math.min(h - 1, Math.max(0, y / dx - 0.5));
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(w - 1, x0 + 1);
    const y1 = Math.min(h - 1, y0 + 1);
    const tx = fx - x0;
    const ty = fy - y0;
    const cur = this.cur;
    const top = cur[y0 * w + x0] * (1 - tx) + cur[y0 * w + x1] * tx;
    const bottom = cur[y1 * w + x0] * (1 - tx) + cur[y1 * w + x1] * tx;
    return top * (1 - ty) + bottom * ty;
  }

  /** The cell index holding (x, y) metres from the top-left corner, clamped to the grid. */
  cellOf(x: number, y: number): number {
    const cx = Math.min(this.w - 1, Math.max(0, Math.floor(x / this.dx)));
    const cy = Math.min(this.h - 1, Math.max(0, Math.floor(y / this.dx)));
    return cy * this.w + cx;
  }

  private fed(): boolean {
    const source = this.source;
    for (let i = 0; i < source.length; i++) if (source[i] !== 0) return true;
    return false;
  }
}
