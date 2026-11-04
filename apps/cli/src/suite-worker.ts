/**
 * A `benchtop test` worker thread (BT48): receives spec file paths, runs each in this thread and
 * posts its result back. Started by suite.ts; plain Node type stripping like the rest of the CLI.
 */

import { parentPort, workerData } from 'node:worker_threads';
import type { AllowEntry } from '@benchtop/core';
import { nodeIo } from './node-io.ts';
import { runSpecFile } from './suite.ts';

// BT101: the --network list the suite was started with.
const network = ((workerData as { network?: AllowEntry[] } | null)?.network ?? []);
const io = network.length > 0 ? { ...nodeIo, network } : nodeIo;

parentPort?.on('message', (file: string) => {
  parentPort?.postMessage(runSpecFile(file, io));
});
