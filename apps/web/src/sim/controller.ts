/**
 * Run controls for the UI: load the current document (with each board's stored firmware) into
 * the worker when it changed, run at the chosen speed, pause, reset. Any edit while running
 * pauses, reloads the bench (same firmware) and resumes — simple and correct; smarter hot-swap
 * is in the plan's Later list. Editing an inline sketch's code (BT42) is not a bench edit: the
 * worker runs the compiled bytes, so only Compile & Run reaches it.
 */

import type { FirmwareImage, ProjectDoc } from '@benchtop/core';
import { effect, signal } from '@preact/signals';
import { editor } from '../editor/app-store.ts';
import { firmwareStore, toImage } from '../editor/firmware-store.ts';
import { sim, simLoaded, simRunning } from './host.ts';
import { liveViews } from './live-views.ts';

export const SPEEDS = [
  { value: 0.1, label: '0.1×' },
  { value: 1, label: '1×' },
  { value: 10, label: '10×' },
  { value: Number.POSITIVE_INFINITY, label: 'Max' },
] as const;

export const speed = signal<number>(1);

/** BT50: whether a test is being recorded (Stop posts it; the dialog takes it from `simRecorded`). */
export const testRecording = signal(false);

let loadedDoc: ProjectDoc | null = null;
let firmwareVersion = 0;
let loadedFirmwareVersion = -1;
let reloadTimer = -1;

/** Each board's stored bytes: a dropped file, or a sketch folder's latest successful compile. */
function firmwareImages(doc: ProjectDoc): Record<string, FirmwareImage> {
  const images: Record<string, FirmwareImage> = {};
  for (const board of Object.keys(doc.firmware)) {
    const stored = firmwareStore.get(board);
    if (stored !== undefined) images[board] = toImage(stored);
  }
  return images;
}

/** The same bench: the same parts and wires, and firmware refs equal but for inline sources. */
export function sameBench(a: ProjectDoc, b: ProjectDoc): boolean {
  if (a === b) return true;
  if (a.parts !== b.parts || a.wires !== b.wires) return false;
  const boards = Object.keys(a.firmware);
  if (boards.length !== Object.keys(b.firmware).length) return false;
  return boards.every((board) => {
    const x = a.firmware[board];
    const y = b.firmware[board];
    if (y === undefined) return false;
    if (x.kind === 'inline' && y.kind === 'inline') return x.fqbn === y.fqbn;
    return JSON.stringify(x) === JSON.stringify(y);
  });
}

function stale(): boolean {
  return !simLoaded.value || loadedDoc === null || !sameBench(loadedDoc, editor.doc.value) || loadedFirmwareVersion !== firmwareVersion;
}

function load(): void {
  const doc = editor.doc.value;
  testRecording.value = false; // a new bench ends any recording
  liveViews.clear();
  sim.load(doc, firmwareImages(doc));
  loadedDoc = doc;
  loadedFirmwareVersion = firmwareVersion;
}

export function run(): void {
  if (stale()) load();
  sim.run(speed.value);
}

export function pause(): void {
  sim.pause();
}

/** Starts recording a test: (re)loads if needed, resets to t = 0 and runs, logging every input. */
export function recordTest(): void {
  if (stale()) load();
  sim.recordStart();
  sim.run(speed.value);
  testRecording.value = true;
}

/** Ends the recording (the worker pauses on the next whole millisecond and posts it). */
export function stopRecording(): void {
  sim.recordStop();
  testRecording.value = false;
}

/** The project the worker last loaded: what a recording ran on. */
export function loadedProject(): ProjectDoc | null {
  return loadedDoc;
}

export function reset(): void {
  testRecording.value = false; // the worker's reset ends a recording
  if (stale()) load();
  else sim.reset();
}

export function setSpeed(value: number): void {
  speed.value = value;
  if (simRunning.value) sim.run(value);
}

/** Call after a board's firmware bytes changed (the document may not have). */
export function firmwareChanged(): void {
  firmwareVersion++;
  if (simRunning.peek()) scheduleReload();
}

/**
 * Call after a board's stored firmware was replaced by a fresh compile. When the worker holds
 * the current document and every other board's firmware, only that board is swapped (its MCU
 * restarts, the rest of the bench carries on); otherwise it is an ordinary firmware change.
 * Returns true when the bytes reached a loaded bench (swapped now, or reloading because running).
 */
export function firmwareCompiled(board: string): boolean {
  const current = simLoaded.peek() && loadedDoc !== null && sameBench(loadedDoc, editor.doc.peek()) && loadedFirmwareVersion === firmwareVersion;
  const stored = firmwareStore.get(board);
  firmwareVersion++;
  if (current && stored !== undefined) {
    sim.setFirmware(board, toImage(stored));
    loadedFirmwareVersion = firmwareVersion;
    return true;
  }
  if (simRunning.peek()) {
    scheduleReload();
    return true;
  }
  return false;
}

function scheduleReload(): void {
  window.clearTimeout(reloadTimer);
  reloadTimer = window.setTimeout(() => {
    if (!simRunning.peek()) return;
    load();
    sim.run(speed.value);
  }, 150);
}

// Edits while running reload the bench and keep running; code edits don't touch the bench.
effect(() => {
  const doc = editor.doc.value;
  if (loadedDoc === null || doc === loadedDoc) return;
  if (sameBench(loadedDoc, doc)) loadedDoc = doc;
  else if (simRunning.peek()) scheduleReload();
});
