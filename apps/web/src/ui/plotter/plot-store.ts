/**
 * Serial plotter data (BT44): every board's serial output, parsed line by line (parse.ts) as it
 * arrives — whether or not the Plotter tab is open — into series of (simulated time, value)
 * points: the last 10 s, at most 4,096 points a series, in preallocated rings. A chunk's lines
 * are spread evenly between the previous chunk's time and its own (serial bytes reach the UI in
 * batches). A new run (time going back) starts the plot over.
 */

import { signal } from '@preact/signals';
import { onAnySerial, simLoaded } from '../../sim/host.ts';
import { LineSplitter, parseLine } from './parse.ts';

export const WINDOW_MS = 10_000;
const CAPACITY = 4096;

export class Series {
  readonly t = new Float64Array(CAPACITY);
  readonly v = new Float64Array(CAPACITY);
  /** Points written in all (the newest is at (count − 1) % CAPACITY). */
  count = 0;

  push(t: number, v: number): void {
    const i = this.count % CAPACITY;
    this.t[i] = t;
    this.v[i] = v;
    this.count++;
  }

  /** Calls `fn` for each kept point at or after `from` (ms), oldest first. */
  forEach(from: number, fn: (t: number, v: number) => void): void {
    const n = Math.min(this.count, CAPACITY);
    for (let k = this.count - n; k < this.count; k++) {
      const i = k % CAPACITY;
      if (this.t[i] >= from) fn(this.t[i], this.v[i]);
    }
  }
}

interface BoardPlot {
  splitter: LineSplitter;
  series: Map<string, Series>;
  lastT: number;
}

const boards = new Map<string, BoardPlot>();
/** Bumped (at most once per animation frame) when points arrive. */
export const plotVersion = signal(0);
let pending = false;

function bump(): void {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    plotVersion.value++;
  });
}

/** A board's series by label (live objects: read them, don't keep them past a clear). */
export function seriesOf(board: string): ReadonlyMap<string, Series> {
  return boards.get(board)?.series ?? new Map();
}

/** The newest point's time (ms) over a board's series, or 0. */
export function latestTime(board: string): number {
  return boards.get(board)?.lastT ?? 0;
}

export function clearPlots(): void {
  boards.clear();
  plotVersion.value++;
}

/** Feeds a board's serial text that arrived at simulated time `ms` (exported for tests). */
export function feed(board: string, text: string, ms: number): void {
  let plot = boards.get(board);
  if (plot === undefined || ms < plot.lastT) boards.set(board, (plot = { splitter: new LineSplitter(), series: new Map(), lastT: ms }));
  const lines = plot.splitter.push(text);
  const from = plot.lastT;
  lines.forEach((line, i) => {
    const t = from + ((ms - from) * (i + 1)) / lines.length;
    for (const { label, value } of parseLine(line)) {
      let series = plot.series.get(label);
      if (series === undefined) {
        if (plot.series.size >= 16) continue; // a runaway of labels stays bounded
        plot.series.set(label, (series = new Series()));
      }
      series.push(t, value);
    }
  });
  plot.lastT = ms;
  if (lines.length > 0) bump();
}

onAnySerial((board, bytes, t) => feed(board, String.fromCharCode(...bytes), t / 1e6));
simLoaded.subscribe((loaded) => {
  if (!loaded) clearPlots();
});
