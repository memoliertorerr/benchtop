/** SI formatting for the logic analyzer's axis and readout. Pure; tested in Node. */

const TIME_UNITS: [number, string][] = [
  [1e9, 's'],
  [1e6, 'ms'],
  [1e3, 'µs'],
  [1, 'ns'],
];

const trim = (value: number, digits: number): string => {
  const text = value.toPrecision(digits);
  return text.includes('e') ? String(Number(text)) : text.replace(/\.?0+$/, '');
};

/** A duration or time in ns as "2.041 ms", "104.2 µs", "0 s". */
export function formatTime(ns: number, digits = 4): string {
  if (ns === 0) return '0 s';
  const abs = Math.abs(ns);
  const [scale, unit] = TIME_UNITS.find(([s]) => abs >= s) ?? TIME_UNITS[TIME_UNITS.length - 1];
  return `${trim(ns / scale, digits)} ${unit}`;
}

/** A frequency as "490 Hz", "9.6 kHz", "1.25 MHz". */
export function formatFrequency(hz: number, digits = 4): string {
  if (!Number.isFinite(hz)) return '—';
  const abs = Math.abs(hz);
  if (abs >= 1e6) return `${trim(hz / 1e6, digits)} MHz`;
  if (abs >= 1e3) return `${trim(hz / 1e3, digits)} kHz`;
  return `${trim(hz, digits)} Hz`;
}

/** A 1/2/5 × 10^n step so that `span` holds about `count` steps. */
export function niceStep(span: number, count: number): number {
  const raw = span / Math.max(1, count);
  const power = 10 ** Math.floor(Math.log10(raw));
  const unit = raw / power;
  return (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10) * power;
}
