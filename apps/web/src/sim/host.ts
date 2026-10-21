/**
 * The UI side of the simulation worker: a typed client (load, setFirmware, run, pause, reset,
 * step, input, serialSend, probes, debugger commands), signals for status, stats and problems,
 * and listener APIs for frames, serial bytes and debugger messages. Frames go straight to
 * listeners (the part views), never through Preact state, so a running circuit doesn't
 * re-render the component tree 60 times a second.
 *
 * Part visual state reaches `onVisuals` listeners from two places with the same meaning: the
 * `parts` of frame messages, and — when the worker sent a frame ring (BT40, cross-origin
 * isolated) — the ring's changed slots, read once per animation frame.
 */

import type { FirmwareImage, MemorySpace, Nanos, PartInput, PinRef, Problem, ProjectDoc, VisualState } from '@benchtop/core';
import { signal } from '@preact/signals';
import { FrameRingReader } from './frame-ring.ts';
import { type FrameStats, type FromSim, PROTOCOL_VERSION, type RecordedTest, type ToSim } from './protocol.ts';

export type SimStatus = 'starting' | 'ready' | 'error';
export type SimFrame = Extract<FromSim, { type: 'frame' }>;
/** Debugger messages from the worker. */
export type SimDebugMessage = Extract<FromSim, { type: 'debugInfo' | 'debugStopped' | 'debugMemory' }>;

export const simStatus = signal<SimStatus>('starting');
/** The latest error the worker reported (cleared by the next successful load). */
export const simError = signal<string | null>(null);
export const simLoaded = signal(false);
export const simRunning = signal(false);
/** Simulated time of the latest frame, ns. */
export const simTime = signal<Nanos>(0);
export const simStats = signal<FrameStats>({ ratio: 0, mhz: {} });
export const simProblems = signal<readonly Problem[]>([]);
/** The last finished test recording (BT50), until the UI takes it. */
export const simRecorded = signal<RecordedTest | null>(null);

const frameListeners = new Set<(frame: SimFrame) => void>();
const visualListeners = new Set<(parts: readonly (readonly [string, VisualState])[]) => void>();
const debugListeners = new Set<(message: SimDebugMessage) => void>();
const serialListeners = new Map<string, Set<(bytes: Uint8Array) => void>>();
const anySerialListeners = new Set<(board: string, bytes: Uint8Array, t: Nanos) => void>();
let worker: Worker | null = null;
let ring: FrameRingReader | null = null;
let ringFrame = 0;

/** Starts the simulation worker once and performs the protocol handshake. */
export function startSimHost(): void {
  if (worker) return;
  worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'sim' });
  worker.onmessage = (event: MessageEvent<FromSim>) => receive(event.data);
  worker.onerror = (event) => {
    simStatus.value = 'error';
    simError.value = event.message;
  };
  send({ type: 'hello', protocol: PROTOCOL_VERSION });
}

/**
 * Called with every frame message (time, stats, probes; its `parts` are only the states that
 * didn't go through the frame ring — use onVisuals for part state). Returns an unsubscribe function.
 */
export function onFrame(listener: (frame: SimFrame) => void): () => void {
  frameListeners.add(listener);
  return () => frameListeners.delete(listener);
}

/**
 * Called with part visual states as they change (from frames and from the frame ring), in
 * arrival order: the latest call for a part is its current state. Returns an unsubscribe function.
 */
export function onVisuals(listener: (parts: readonly (readonly [string, VisualState])[]) => void): () => void {
  visualListeners.add(listener);
  return () => visualListeners.delete(listener);
}

function emitVisuals(parts: readonly (readonly [string, VisualState])[]): void {
  if (parts.length === 0) return;
  for (const listener of visualListeners) listener(parts);
}

/** Reads the frame ring's changed slots once per animation frame (only while the page shows). */
function readRing(): void {
  ringFrame = 0;
  if (ring === null) return;
  emitVisuals(ring.drain());
  ringFrame = requestAnimationFrame(readRing);
}

/** Called with every debugger message (info, stops, memory). Returns an unsubscribe function. */
export function onDebug(listener: (message: SimDebugMessage) => void): () => void {
  debugListeners.add(listener);
  return () => debugListeners.delete(listener);
}

/** Called with each batch of bytes a board's UART 0 sent. Returns an unsubscribe function. */
export function onSerial(board: string, listener: (bytes: Uint8Array) => void): () => void {
  let listeners = serialListeners.get(board);
  if (listeners === undefined) serialListeners.set(board, (listeners = new Set()));
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Called with every board's serial bytes and their simulated time. Returns an unsubscribe function. */
export function onAnySerial(listener: (board: string, bytes: Uint8Array, t: Nanos) => void): () => void {
  anySerialListeners.add(listener);
  return () => anySerialListeners.delete(listener);
}

/** Commands for the worker. The firmware bytes are copied, so the caller keeps its own. */
export const sim = {
  load(doc: ProjectDoc, firmware: Record<string, FirmwareImage>): void {
    simLoaded.value = false;
    simRunning.value = false;
    send({ type: 'load', doc, firmware });
  },
  /** Swaps one board's firmware on the loaded bench (load + reset of that board only). */
  setFirmware(board: string, image: FirmwareImage): void {
    send({ type: 'setFirmware', board, image });
  },
  run(speed: number): void {
    send({ type: 'run', speed });
  },
  pause(): void {
    send({ type: 'pause' });
  },
  reset(): void {
    send({ type: 'reset' });
  },
  step(ns: Nanos): void {
    send({ type: 'step', ns });
  },
  input(part: string, event: PartInput): void {
    send({ type: 'input', part, event });
  },
  addProbe(key: string, pin: PinRef): void {
    send({ type: 'addProbe', key, pin });
  },
  removeProbe(key: string): void {
    send({ type: 'removeProbe', key });
  },
  debugPause(): void {
    send({ type: 'debugPause' });
  },
  debugStep(board: string): void {
    send({ type: 'debugStep', board });
  },
  debugStepOver(board: string): void {
    send({ type: 'debugStepOver', board });
  },
  debugSetBreakpoints(board: string, specs: string[]): void {
    send({ type: 'debugSetBreakpoints', board, specs });
  },
  debugReadMemory(board: string, space: MemorySpace, addr: number, len: number): void {
    send({ type: 'debugReadMemory', board, space, addr, len });
  },
  /** Microphone samples for a microphone part (BT41); the buffer is transferred. */
  audioIn(part: string, samples: Float32Array): void {
    send({ type: 'audioIn', part, samples }, [samples.buffer]);
  },
  serialSend(board: string, bytes: Uint8Array): void {
    const copy = bytes.slice();
    send({ type: 'serialSend', board, bytes: copy }, [copy.buffer]);
  },
  /** BT50: reset and start recording inputs; `recordStop` ends it (a `recorded` message). */
  recordStart(): void {
    send({ type: 'recordStart' });
  },
  recordStop(): void {
    send({ type: 'recordStop' });
  },
};

function receive(message: FromSim): void {
  switch (message.type) {
    case 'ready':
      simStatus.value = 'ready';
      return;
    case 'loaded':
      simLoaded.value = true;
      simError.value = null;
      simProblems.value = message.problems;
      return;
    case 'frameRing':
      ring = new FrameRingReader(message.buffer, message.parts);
      if (ringFrame === 0) ringFrame = requestAnimationFrame(readRing);
      return;
    case 'frame':
      simTime.value = message.t;
      simStats.value = message.stats;
      simRunning.value = message.running;
      emitVisuals(message.parts);
      for (const listener of frameListeners) listener(message);
      return;
    case 'serial':
      for (const listener of serialListeners.get(message.board) ?? []) listener(message.bytes);
      for (const listener of anySerialListeners) listener(message.board, message.bytes, message.t);
      return;
    case 'problems':
      simProblems.value = message.list;
      return;
    case 'recorded':
      simRecorded.value = message.test;
      return;
    case 'debugInfo':
    case 'debugStopped':
    case 'debugMemory':
      for (const listener of debugListeners) listener(message);
      return;
    case 'error':
      if (simStatus.value === 'starting') simStatus.value = 'error';
      simRunning.value = false;
      simError.value = message.message;
      return;
  }
}

function send(message: ToSim, transfer: Transferable[] = []): void {
  worker?.postMessage(message, transfer);
}
