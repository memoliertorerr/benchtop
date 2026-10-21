/**
 * The running app's PCB editor (BT59): the one PCB store (autosaved to localStorage) and the
 * board with its ratsnest and DRC as computed signals. Loaded with the PCB view's chunk (mode.ts
 * holds what the rest of the app needs eagerly). Browser-only; tests use store.ts directly.
 */

import { benchEnvParts } from '@benchtop/parts';
import { connectivity, drc, PcbBoard, ratsnest } from '@benchtop/pcb';
import { computed } from '@preact/signals';
import { editor } from '../editor/app-store.ts';
import type { StorageLike } from '../editor/persistence.ts';
import { onPcbReset } from './mode.ts';
import { createPcbStore } from './store.ts';

function browserStorage(): StorageLike | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export const pcbEditor = createPcbStore({
  storage: browserStorage(),
  timers: { set: (fn, ms) => window.setTimeout(fn, ms), clear: (id) => window.clearTimeout(id) },
});

window.addEventListener('pagehide', () => pcbEditor.flush());
onPcbReset(() => pcbEditor.reset());

/** The PCB with its circuit (the bench on screen), or null before a PCB exists. */
export const pcbBoard = computed(() => {
  const doc = pcbEditor.doc.value;
  return doc === null ? null : new PcbBoard(editor.doc.value, doc, benchEnvParts);
});

/** What's left to route and what DRC finds, for the view and the Problems tab. */
export const pcbCheck = computed(() => {
  const board = pcbBoard.value;
  return board === null ? null : { lines: ratsnest(board, connectivity(board)), result: drc(board) };
});
