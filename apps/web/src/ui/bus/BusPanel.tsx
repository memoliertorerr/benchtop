/**
 * The Bus tab (BT87): the I2C, SPI and UART transactions the sketch made, decoded in the worker
 * (while this tab is open: `sim.busWatch`) — time, source, and what went over the bus. Filters
 * by bus kind and by source; newest at the bottom, followed unless you scroll up; a row opens
 * into a hex and ASCII dump; Copy puts the shown rows on the clipboard as text.
 */

import { useEffect, useRef, useState } from 'preact/hooks';
import { editorMessage } from '../../editor/app-store.ts';
import { sim } from '../../sim/host.ts';
import type { BusRow } from '../../sim/protocol.ts';
import { asText, busDropped, busKinds, busPending, busRows, busSource, type BusKind, clearBus, rowsText, rowSummary, shownRows, sourcesOf } from './bus-store.ts';

/** Rows drawn (the store keeps more; the newest win). */
const DRAWN = 400;
const KINDS: readonly [BusKind, string][] = [
  ['i2c', 'I2C'],
  ['spi', 'SPI'],
  ['uart', 'UART'],
];

function Dump({ row }: { row: BusRow }) {
  const bytes = row.bus === 'spi' ? row.mosi : row.bytes;
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const chunk = bytes.slice(i, i + 16);
    const hexPart = chunk.map((v) => v.toString(16).padStart(2, '0')).join(' ');
    lines.push(`${i.toString(16).padStart(4, '0')}  ${hexPart.padEnd(47)}  ${asText(chunk).replace(/\\x..|\\[rn]/g, '.')}`);
  }
  return (
    <pre class="bus-dump">
      {row.bus === 'spi' ? 'MOSI\n' : ''}
      {lines.join('\n')}
      {row.bus === 'spi' ? `\nMISO\n${row.miso.map((v) => v.toString(16).padStart(2, '0')).join(' ')}` : ''}
      {row.count > bytes.length ? `\n… ${row.count - bytes.length} more bytes not kept` : ''}
    </pre>
  );
}

export function BusPanel() {
  const list = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const [open, setOpen] = useState<BusRow | null>(null);
  useEffect(() => {
    sim.busWatch(true);
    return () => sim.busWatch(false);
  }, []);
  const rows = busRows.value;
  const pending = busPending.value;
  const kinds = busKinds.value;
  const source = busSource.value;
  const shown = shownRows(rows, pending, kinds, source);
  const drawn = shown.slice(Math.max(0, shown.length - DRAWN));
  /** The open transactions come last in `shown`. */
  const openCount = shownRows([], pending, kinds, source).length;
  const sources = sourcesOf(rows, pending);
  useEffect(() => {
    const el = list.current;
    if (el !== null && follow) el.scrollTop = el.scrollHeight;
  });
  const toggle = (kind: BusKind): void => {
    const next = new Set(kinds);
    if (next.has(kind)) next.delete(kind);
    else next.add(kind);
    busKinds.value = next;
  };
  const copy = (): void => {
    const text = rowsText(shown);
    const done = () => (editorMessage.value = `Copied ${shown.length} bus transactions`);
    navigator.clipboard?.writeText(text).then(done, () => (editorMessage.value = 'Copy failed')) ?? (editorMessage.value = 'Copy failed');
  };
  return (
    <div class="bus">
      <div class="plotter-bar">
        {KINDS.map(([kind, label]) => (
          <label key={kind} class="plotter-pause">
            <input type="checkbox" checked={kinds.has(kind)} onChange={() => toggle(kind)} /> {label}
          </label>
        ))}
        <select class="tool-select" aria-label="Source" value={source} onChange={(e) => (busSource.value = (e.target as HTMLSelectElement).value)}>
          <option value="">All sources</option>
          {sources.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <span class="toolbar-spacer" />
        {busDropped.value > 0 && <span class="muted">{busDropped.value.toLocaleString()} older dropped</span>}
        <label class="plotter-pause">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow((e.target as HTMLInputElement).checked)} /> Follow
        </label>
        <button type="button" class="tool-button" onClick={copy} disabled={shown.length === 0}>
          Copy
        </button>
        <button type="button" class="tool-button" onClick={() => (clearBus(), setOpen(null))}>
          Clear
        </button>
      </div>
      <div
        class="bus-list"
        ref={list}
        onScroll={(e) => {
          const el = e.currentTarget as HTMLDivElement;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
          if (atBottom !== follow) setFollow(atBottom);
        }}
      >
        {shown.length === 0 ? (
          <p class="muted panel-note">No bus traffic yet. Run a sketch that talks I2C, SPI or Serial: each transaction to a part on the bench shows here.</p>
        ) : (
          drawn.map((row, i) => {
            const isPending = i >= drawn.length - openCount;
            return (
              <div key={`${row.label}:${row.t}:${i}`} class={`bus-row bus-${row.bus}${isPending ? ' bus-open' : ''}`}>
                <button type="button" class="bus-line" onClick={() => setOpen(open === row ? null : row)} aria-expanded={open === row}>
                  <span class="bus-time">{(row.t / 1e6).toFixed(3)} ms</span>
                  <span class={`bus-kind bus-kind-${row.bus}`}>{row.bus === 'uart' ? (row.direction === 'rx' ? 'RX' : 'TX') : row.bus.toUpperCase()}</span>
                  <span class="bus-source">{row.label}</span>
                  <span class="bus-summary">{rowSummary(row)}</span>
                </button>
                {open === row && <Dump row={row} />}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
