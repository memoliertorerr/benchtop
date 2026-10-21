/**
 * IEEE 1364 four-state Value Change Dump writer for probe recordings: $date, $version Benchtop,
 * $timescale 1ns, one 1-bit wire per probe in scope `bench` (ids from printable ASCII 33–126,
 * names sanitized: uno:13 → uno_13), $dumpvars with the initial values, then #<ns> stamps with
 * 0/1/z/x changes in time order.
 */

import { LEVEL_X, LEVEL_Z } from './ring.ts';

export interface VcdSignal {
  name: string;
  /** Edge times (ns, ascending) and levels (0, 1, 2 = z, 3 = x); the first edge is the initial value. */
  times: ArrayLike<number>;
  levels: ArrayLike<number>;
}

const VALUE = ['0', '1', 'z', 'x'];

/** The VCD identifier of signal `index`: printable ASCII 33–126, more characters as needed. */
export function vcdId(index: number): string {
  let id = '';
  let n = index;
  do {
    id += String.fromCharCode(33 + (n % 94));
    n = Math.floor(n / 94) - 1;
  } while (n >= 0);
  return id;
}

export function vcdName(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, '_') || 'signal';
}

export function writeVcd(signals: readonly VcdSignal[], date: string): string {
  const out: string[] = [];
  out.push(`$date ${date} $end`, '$version Benchtop $end', '$timescale 1ns $end', '$scope module bench $end');
  signals.forEach((s, i) => out.push(`$var wire 1 ${vcdId(i)} ${vcdName(s.name)} $end`));
  out.push('$upscope $end', '$enddefinitions $end', '$dumpvars');
  signals.forEach((s, i) => out.push(`${s.levels.length > 0 ? VALUE[s.levels[0]] ?? 'x' : 'x'}${vcdId(i)}`));
  out.push('$end');
  // Merge every signal's later edges by time.
  const next = signals.map(() => 1);
  for (;;) {
    let t = Number.POSITIVE_INFINITY;
    signals.forEach((s, i) => {
      if (next[i] < s.times.length && s.times[next[i]] < t) t = s.times[next[i]];
    });
    if (t === Number.POSITIVE_INFINITY) break;
    out.push(`#${Math.round(t)}`);
    signals.forEach((s, i) => {
      while (next[i] < s.times.length && s.times[next[i]] === t) {
        const level = s.levels[next[i]];
        out.push(`${level === LEVEL_Z ? 'z' : level === LEVEL_X ? 'x' : VALUE[level] ?? 'x'}${vcdId(i)}`);
        next[i]++;
      }
    });
  }
  return `${out.join('\n')}\n`;
}
