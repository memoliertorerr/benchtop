/**
 * Serial output per board, fed by the worker; `serialVersion` ticks on every change. A full load
 * of the bench (a new project, an example, a rebuild from t = 0) empties every board's output, as
 * the plotter's does (BT96: an opened example showed the previous example's lines under the same
 * board id). Reset and hot-swap edits keep it (the firmware reload marks itself).
 */

import { signal } from '@preact/signals';
import { onAnySerial, simLoaded } from '../sim/host.ts';
import { SerialBuffer } from './serial-buffer.ts';

export const serialBuffers = new Map<string, SerialBuffer>();
export const serialVersion = signal(0);

export function serialBuffer(board: string): SerialBuffer {
  let buffer = serialBuffers.get(board);
  if (buffer === undefined) serialBuffers.set(board, (buffer = new SerialBuffer()));
  return buffer;
}

onAnySerial((board, bytes, t) => {
  serialBuffer(board).append(bytes, t);
  serialVersion.value++;
});

/** Empties every board's output (a full load of the bench). */
export function clearAllSerial(): void {
  if (serialBuffers.size === 0) return;
  for (const buffer of serialBuffers.values()) buffer.clear();
  serialVersion.value++;
}

simLoaded.subscribe((loaded) => {
  if (!loaded) clearAllSerial();
});

