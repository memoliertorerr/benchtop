/**
 * Run controls for the UI: load the current document (with each board's stored firmware) into
 * the worker when it changed, run at the chosen speed, pause, reset. An edit that changes the
 * circuit while a bench is loaded (running or paused) reaches the worker as an `edit` (BT79,
 * debounced 150 ms): it rebuilds the bench keeping time, the boards running and unchanged parts'
 * state. A cosmetic edit (BT77: a wire's color or waypoints, moving a part whose pins touch
 * nothing new) leaves the bench alone — `benchSignature` tells them apart. Editing an inline
 * sketch's code (BT42) is not a bench edit either: the worker runs the compiled bytes, so only
 * Compile & Run reaches it. New firmware bytes under the same document still reload.
 */

import { benchSignature, type FirmwareImage, type ProjectDoc } from '@benchtop/core';
import { CATALOG, envSpecFor } from '@benchtop/parts';
import { effect, signal } from '@preact/signals';
import { editor } from '../editor/app-store.ts';
import { firmwareStore, toImage } from '../editor/firmware-store.ts';
import { editorNetlist } from '../editor/wiring.ts';
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
/** What the debounce timer will do: rebuild with carry-over, or load afresh (which wins). */
let pending: 'edit' | 'reload' | null = null;

/** Each board's stored bytes: a dropped file, or a sketch folder's latest successful compile. */
function firmwareImages(doc: ProjectDoc): Record<string, FirmwareImage> {
  const images: Record<string, FirmwareImage> = {};
  for (const board of Object.keys(doc.firmware)) {
    const stored = firmwareStore.get(board);
    if (stored !== undefined) images[board] = toImage(stored);
  }
  return images;
}

/** BT74: each board's compiler ELF, for the debugger, when its stored image isn't the ELF. */
function debugElfs(doc: ProjectDoc): Record<string, Uint8Array> {
  const elfs: Record<string, Uint8Array> = {};
  for (const board of Object.keys(doc.firmware)) {
    const elf = firmwareStore.get(board)?.debugElf;
    if (elf !== undefined) elfs[board] = elf;
  }
  return elfs;
}

const signatures = new WeakMap<ProjectDoc, string>();

/** What the bench depends on in `doc` (BT77), computed once per document object. */
function signatureOf(doc: ProjectDoc): string {
  let signature = signatures.get(doc);
  if (signature === undefined) {
    signature = benchSignature(doc, editorNetlist(doc), { envSpecFor, defaults: (type) => CATALOG.get(type)?.defaults });
    signatures.set(doc, signature);
  }
  return signature;
}

/**
 * The same bench: equal signatures — the same parts and props, nets, firmware refs (an inline
 * sketch by its FQBN) and, with an environment, the positions it uses.
 */
export function sameBench(a: ProjectDoc, b: ProjectDoc): boolean {
  return a === b || signatureOf(a) === signatureOf(b);
}

function stale(): boolean {
  return !simLoaded.value || loadedDoc === null || !sameBench(loadedDoc, editor.doc.value) || loadedFirmwareVersion !== firmwareVersion;
}

function load(): void {
  const doc = editor.doc.value;
  testRecording.value = false; // a new bench ends any recording
  liveViews.clear();
  sim.load(doc, firmwareImages(doc), debugElfs(doc));
  loadedDoc = doc;
  loadedFirmwareVersion = firmwareVersion;
}

/** BT79: the document as it is now, rebuilt in the worker with carry-over. */
function edit(): void {
  const doc = editor.doc.value;
  testRecording.value = false; // a recording runs on one document
  sim.edit(doc, firmwareImages(doc), debugElfs(doc));
  loadedDoc = doc;
}

export function run(): void {
  flushPending();
  if (stale()) load();
  sim.run(speed.value);
}

export function pause(): void {
  sim.pause();
}

/** Starts recording a test: (re)loads if needed, resets to t = 0 and runs, logging every input. */
export function recordTest(): void {
  flushPending();
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
  flushPending();
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
  if (simRunning.peek()) schedule('reload');
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
    sim.setFirmware(board, toImage(stored), stored.debugElf);
    loadedFirmwareVersion = firmwareVersion;
    return true;
  }
  if (simRunning.peek()) {
    schedule('reload');
    return true;
  }
  return false;
}

function schedule(kind: 'edit' | 'reload'): void {
  if (pending !== 'reload') pending = kind;
  window.clearTimeout(reloadTimer);
  reloadTimer = window.setTimeout(flushPending, 150);
}

/** Does what the debounce timer would, now (a run or reset must not overtake an edit). */
function flushPending(): void {
  window.clearTimeout(reloadTimer);
  const kind = pending;
  pending = null;
  if (kind === 'reload') {
    if (!simRunning.peek()) return; // stale: the next run loads
    load();
    sim.run(speed.value);
  } else if (kind === 'edit') {
    if (!simLoaded.peek() || loadedDoc === null || sameBench(loadedDoc, editor.doc.peek())) return;
    if (loadedFirmwareVersion !== firmwareVersion) {
      // New bytes under the same refs: only a fresh load takes them.
      const running = simRunning.peek();
      load();
      if (running) sim.run(speed.value);
      return;
    }
    edit();
  }
}

// Edits that change the circuit reach a loaded bench as hot edits (running or paused); cosmetic
// and code edits don't touch it (the controller just holds the newer document).
effect(() => {
  const doc = editor.doc.value;
  if (loadedDoc === null || doc === loadedDoc) return;
  if (sameBench(loadedDoc, doc)) loadedDoc = doc;
  else if (simLoaded.peek()) schedule('edit');
});
