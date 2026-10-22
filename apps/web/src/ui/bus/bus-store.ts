/**
 * The Bus tab's data (BT87): the transactions the worker decoded (frames carry them while the
 * tab is open — `sim.busWatch`), kept up to MAX_ROWS (the oldest drop and are counted), the ones
 * still open, and the tab's filters. Pure enough to test in Node: `applyChunk` takes what a frame
 * carries.
 */

import { signal } from '@preact/signals';
import { onFrame } from '../../sim/host.ts';
import type { BusChunk, BusRow } from '../../sim/protocol.ts';

/** Rows kept (a TFT can make thousands of SPI frames a second). */
export const MAX_ROWS = 2000;

export type BusKind = BusRow['bus'];

export const busRows = signal<readonly BusRow[]>([]);
export const busPending = signal<readonly BusRow[]>([]);
/** Rows dropped from the front (MAX_ROWS) plus records the worker's log overwrote. */
export const busDropped = signal(0);
export const busKinds = signal<ReadonlySet<BusKind>>(new Set<BusKind>(['i2c', 'spi', 'uart']));
/** Only this source's rows ('' = every source). */
export const busSource = signal('');

export function applyChunk(chunk: BusChunk): void {
  let rows = chunk.restart ? [] : busRows.peek();
  let dropped = chunk.restart ? 0 : busDropped.peek();
  if (chunk.rows.length > 0) rows = [...rows, ...chunk.rows];
  if (rows.length > MAX_ROWS) {
    dropped += rows.length - MAX_ROWS;
    rows = rows.slice(rows.length - MAX_ROWS);
  }
  busRows.value = rows;
  busPending.value = chunk.pending;
  busDropped.value = dropped + chunk.lost;
}

export function clearBus(): void {
  busRows.value = [];
  busPending.value = [];
  busDropped.value = 0;
}

/** The rows the filters let through (completed, then the open ones). */
export function shownRows(rows: readonly BusRow[], pending: readonly BusRow[], kinds: ReadonlySet<BusKind>, source: string): BusRow[] {
  const keep = (row: BusRow): boolean => kinds.has(row.bus) && (source === '' || row.label === source);
  return [...rows.filter(keep), ...pending.filter(keep)];
}

/** Every source seen, for the filter's list. */
export function sourcesOf(rows: readonly BusRow[], pending: readonly BusRow[]): string[] {
  return [...new Set([...rows, ...pending].map((r) => r.label))].sort();
}

const hex = (bytes: readonly number[]): string => bytes.map((v) => v.toString(16).padStart(2, '0')).join(' ');

/** A UART burst as text: printable ASCII, escapes for the rest. */
export function asText(bytes: readonly number[]): string {
  return bytes.map((v) => (v >= 0x20 && v < 0x7f ? String.fromCharCode(v) : v === 10 ? '\\n' : v === 13 ? '\\r' : `\\x${v.toString(16).padStart(2, '0')}`)).join('');
}

/** What a row says after its time and source: "W 0x27 08 0c", "MOSI 2a 00 / MISO ff ff", "\"hello\\r\\n\"". */
export function rowSummary(row: BusRow, maxBytes = 24): string {
  const more = (shown: number): string => (row.count > shown ? ` … (${row.count} bytes)` : '');
  if (row.bus === 'i2c') {
    const address = row.address < 0 ? '?' : `0x${row.address.toString(16).padStart(2, '0')}`;
    const bytes = row.bytes.slice(0, maxBytes);
    const nack = row.ack ? '' : ' NACK';
    const dataNacks = row.read ? 0 : row.acks.filter((a) => !a).length;
    return `${row.read ? 'R' : 'W'} ${address}${nack}  ${hex(bytes)}${more(bytes.length)}${dataNacks > 0 ? `  (${dataNacks} NACK)` : ''}`;
  }
  if (row.bus === 'spi') {
    const mosi = row.mosi.slice(0, maxBytes);
    return `MOSI ${hex(mosi)}${more(mosi.length)}  /  MISO ${hex(row.miso.slice(0, maxBytes))}${row.framed ? '' : '  (no CS)'}`;
  }
  const bytes = row.bytes.slice(0, maxBytes * 4);
  return `${row.direction === 'rx' ? '←' : '→'} "${asText(bytes)}"${more(bytes.length)}`;
}

/** One line per row, for the clipboard. */
export function rowsText(rows: readonly BusRow[]): string {
  return rows.map((row) => `${(row.t / 1e6).toFixed(3)} ms\t${row.label}\t${rowSummary(row, Number.POSITIVE_INFINITY)}`).join('\n');
}

onFrame((frame) => {
  if (frame.bus !== undefined) applyChunk(frame.bus);
});
