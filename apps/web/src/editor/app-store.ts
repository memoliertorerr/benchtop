/**
 * The running app's editor: one store, restored from the autosave at startup and saved 500 ms
 * after every edit (and when the page is hidden). Browser-only; tests use store.ts directly.
 */

import { emptyProject } from '@benchtop/core';
import { effect, signal } from '@preact/signals';
import { createAutosave, loadAutosave, type StorageLike } from './persistence.ts';
import { createEditorStore } from './store.ts';

function browserStorage(): StorageLike | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined; // storage blocked (privacy settings): run without autosave
  }
}

const storage = browserStorage();

export const editor = createEditorStore(loadAutosave(storage) ?? emptyProject('Untitled'));

/** A short note for the status bar (import errors and the like). */
export const editorMessage = signal<string | null>(null);

const autosave = createAutosave(storage, {
  set: (fn, ms) => window.setTimeout(fn, ms),
  clear: (id) => window.clearTimeout(id),
});

let restored = true;
effect(() => {
  const doc = editor.doc.value;
  if (restored) {
    restored = false; // don't rewrite what was just loaded
    return;
  }
  autosave.schedule(doc);
});
window.addEventListener('pagehide', () => autosave.flush());
