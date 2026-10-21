/**
 * A `benchtop test` worker thread (BT48): receives spec file paths, runs each in this thread and
 * posts its result back. Started by suite.ts; plain Node type stripping like the rest of the CLI.
 */

import { parentPort } from 'node:worker_threads';
import { nodeIo } from './node-io.ts';
import { runSpecFile } from './suite.ts';

parentPort?.on('message', (file: string) => {
  parentPort?.postMessage(runSpecFile(file, nodeIo));
});
