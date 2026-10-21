/**
 * Linear solver for one island's nodal equations: G·v = i, by Gaussian elimination with partial
 * pivoting, in scratch preallocated for up to MAX_NODES unknowns. No allocation per solve.
 *
 * The matrix is stored densely (row stride n) but eliminated sparsely: each pivot row's nonzero
 * columns are listed once and only those are updated, and rows with nothing in the pivot column
 * are skipped. With the layer's node order — fewest neighbors first (AnalogLayer) — the islands
 * circuits make (stars of LED branches on one pin, ladders, dividers) eliminate without fill-in,
 * so a solve costs about n² instead of n³: 100 LEDs with their resistors on one pin are a
 * 101-node star.
 */

export const MAX_NODES = 256;

export class DenseSolver {
  private readonly g = new Float64Array(MAX_NODES * MAX_NODES);
  private readonly rhs = new Float64Array(MAX_NODES);
  /** The solution of the last successful `solve()`. */
  readonly x = new Float64Array(MAX_NODES);
  /** Nonzero columns of the current pivot row (scratch). */
  private readonly cols = new Int32Array(MAX_NODES);
  private n = 0;

  /** Starts an n×n system with `gmin` siemens from every node to ground. */
  reset(n: number, gmin: number): void {
    if (n > MAX_NODES) throw new RangeError(`island of ${n} nodes exceeds ${MAX_NODES}`);
    this.n = n;
    this.g.fill(0, 0, n * n);
    this.rhs.fill(0, 0, n);
    for (let i = 0; i < n; i++) this.g[i * n + i] = gmin;
  }

  /** A conductance between unknown nodes `a` and `b` (−1 = a fixed node, handled by `toFixed`). */
  conductance(a: number, b: number, g: number): void {
    const m = this.g;
    const n = this.n;
    if (a >= 0) m[a * n + a] += g;
    if (b >= 0) m[b * n + b] += g;
    if (a >= 0 && b >= 0) {
      m[a * n + b] -= g;
      m[b * n + a] -= g;
    }
  }

  /** A conductance `g` from unknown node `a` to a fixed voltage `volts`. */
  toFixed(a: number, g: number, volts: number): void {
    this.g[a * this.n + a] += g;
    this.rhs[a] += g * volts;
  }

  /** A current `amps` injected into node `a` (−1 ignored). */
  current(a: number, amps: number): void {
    if (a >= 0) this.rhs[a] += amps;
  }

  /** Solves in place; false when the system is singular. */
  solve(): boolean {
    const n = this.n;
    const m = this.g;
    const r = this.rhs;
    const cols = this.cols;
    for (let col = 0; col < n; col++) {
      let pivot = col;
      let best = Math.abs(m[col * n + col]);
      for (let row = col + 1; row < n; row++) {
        const v = Math.abs(m[row * n + col]);
        if (v > best) {
          best = v;
          pivot = row;
        }
      }
      if (best < 1e-300) return false;
      if (pivot !== col) {
        for (let k = col; k < n; k++) {
          const t = m[col * n + k];
          m[col * n + k] = m[pivot * n + k];
          m[pivot * n + k] = t;
        }
        const t = r[col];
        r[col] = r[pivot];
        r[pivot] = t;
      }
      const base = col * n;
      let count = 0;
      for (let k = col + 1; k < n; k++) if (m[base + k] !== 0) cols[count++] = k;
      const diag = m[base + col];
      for (let row = col + 1; row < n; row++) {
        const at = row * n;
        const f = m[at + col] / diag;
        if (f === 0) continue;
        m[at + col] = 0;
        for (let j = 0; j < count; j++) {
          const k = cols[j];
          m[at + k] -= f * m[base + k];
        }
        r[row] -= f * r[col];
      }
    }
    for (let row = n - 1; row >= 0; row--) {
      const base = row * n;
      let sum = r[row];
      for (let k = row + 1; k < n; k++) {
        const a = m[base + k];
        if (a !== 0) sum -= a * this.x[k];
      }
      this.x[row] = sum / m[base + row];
    }
    return true;
  }
}
