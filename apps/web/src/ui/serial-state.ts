/** Serial output per board, fed by the worker; `serialVersion` ticks on every change. */

import { signal } from '@preact/signals';
import { onAnySerial } from '../sim/host.ts';
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
