/**
 * BT167: values with SI prefixes in the Inspector — a part's `ohms` and `farads` show as 4.7 kΩ or
 * 100 nF and take what people type: 4.7k, 4k7, 4R7, 100n, 100nF, 0.1u, 10 µF, 1e-7.
 */

/** The props shown with SI prefixes, and their units. */
export const SI_UNITS: Readonly<Record<string, string>> = { ohms: 'Ω', farads: 'F' };

const PREFIXES: readonly (readonly [number, string])[] = [
  [1e9, 'G'],
  [1e6, 'M'],
  [1e3, 'k'],
  [1, ''],
  [1e-3, 'm'],
  [1e-6, 'µ'],
  [1e-9, 'n'],
  [1e-12, 'p'],
];

const SCALE: Readonly<Record<string, number>> = { G: 1e9, M: 1e6, k: 1e3, K: 1e3, R: 1, m: 1e-3, u: 1e-6, µ: 1e-6, μ: 1e-6, n: 1e-9, p: 1e-12 };

/** 4700 → "4.7 kΩ", 1e-7 → "100 nF" (three significant digits). */
export function formatSi(value: number, unit: string): string {
  if (!Number.isFinite(value)) return String(value);
  if (value === 0) return `0 ${unit}`;
  const abs = Math.abs(value);
  for (const [scale, prefix] of PREFIXES) {
    if (abs >= scale * 0.9995) return `${Number((value / scale).toPrecision(3))} ${prefix}${unit}`;
  }
  return `${Number((value / 1e-12).toPrecision(3))} p${unit}`;
}

/** What a person typed, in base units (ohms, farads); NaN when it isn't a value. */
export function parseSi(text: string, unit: string): number {
  let t = text.trim().replace(/\s+/g, '');
  if (unit === 'Ω') t = t.replace(/(Ω|ohms?)$/i, '');
  else if (unit === 'F') t = t.replace(/F$/, '');
  if (/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) return Number(t);
  // 4.7k, 100n, and the schematic habit of the prefix as the point: 4k7, 4R7, 2u2.
  const m = /^(\d+(?:\.\d*)?|\.\d+)([GMkKRmuµμnp])(\d*)$/.exec(t);
  if (m === null) return Number.NaN;
  const [, whole, prefix, fraction] = m;
  if (fraction !== '' && whole.includes('.')) return Number.NaN;
  if (prefix === 'R' && unit !== 'Ω') return Number.NaN;
  return Number(fraction === '' ? whole : `${whole}.${fraction}`) * SCALE[prefix];
}
