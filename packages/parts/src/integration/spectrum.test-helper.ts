/**
 * Small spectrum tools for the audio tests (BT41), no DSP dependency: a Hann-windowed DFT
 * evaluated at any frequency, the peak within a range (searched on a fine grid), and THD from
 * chosen harmonics.
 */

/** |DFT| of `x` (sampled at `rate`) at `hz`, Hann-windowed, mean removed. */
export function magnitudeAt(x: ArrayLike<number>, rate: number, hz: number): number {
  const n = x.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += x[i];
  mean /= n;
  let re = 0;
  let im = 0;
  const w = (2 * Math.PI * hz) / rate;
  for (let i = 0; i < n; i++) {
    const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    const v = (x[i] - mean) * hann;
    re += v * Math.cos(w * i);
    im -= v * Math.sin(w * i);
  }
  return Math.hypot(re, im);
}

/** The frequency in [lo, hi] with the largest magnitude, on a `step` Hz grid. */
export function peakHz(x: ArrayLike<number>, rate: number, lo: number, hi: number, step = 0.05): number {
  let best = lo;
  let bestMag = -1;
  for (let f = lo; f <= hi; f += step) {
    const m = magnitudeAt(x, rate, f);
    if (m > bestMag) {
      bestMag = m;
      best = f;
    }
  }
  return best;
}

/** The strongest frequency over the whole band [lo, hi] (a coarse 1 Hz scan, then refined). */
export function dominantHz(x: ArrayLike<number>, rate: number, lo: number, hi: number): number {
  const coarse = peakHz(x, rate, lo, hi, 1);
  return peakHz(x, rate, coarse - 2, coarse + 2, 0.02);
}

/**
 * THD: √(Σ A(k·f0)²) / A(f0) over `harmonics`, each amplitude the peak within ±2 Hz of its
 * nominal frequency.
 */
export function thd(x: ArrayLike<number>, rate: number, f0: number, harmonics: readonly number[]): number {
  const amp = (f: number): number => magnitudeAt(x, rate, peakHz(x, rate, f - 2, f + 2, 0.1));
  const fundamental = amp(f0);
  let sum = 0;
  for (const k of harmonics) sum += amp(k * f0) ** 2;
  return Math.sqrt(sum) / fundamental;
}
