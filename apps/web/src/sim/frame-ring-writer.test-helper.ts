/**
 * A worker thread for frame-ring.test.ts: writes states into a shared frame ring as fast as it
 * can while the test's thread reads, so torn reads would show up as inconsistent states. Each
 * state is self-checking: every element of `a` equals `n`, and `s` is `n % 97` x's long.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { FrameRingWriter } from './frame-ring.ts';

const { buffer, parts, count } = workerData as { buffer: SharedArrayBuffer; parts: string[]; count: number };
const writer = new FrameRingWriter(buffer, parts);
const a: number[] = new Array<number>(300).fill(0);
for (let n = 1; n <= count; n++) {
  a.fill(n);
  for (const part of parts) writer.write(part, { n, a, s: 'x'.repeat(n % 97) });
}
parentPort?.postMessage('done');
