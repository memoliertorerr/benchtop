/**
 * Saving and opening projects. Autosave writes the document to browser storage 500 ms after the
 * last edit; startup reads it back through parseProject (a corrupt save is ignored with a
 * console warning, never a crash). Export/import go through the same validation. Storage is
 * injected (and every access is in try/catch), so this is tested in Node.
 */

import { parseProject, type ProjectDoc } from '@benchtop/core';

export const AUTOSAVE_KEY = 'benchtop:project:v1';
export const AUTOSAVE_DELAY_MS = 500;

/** The part of the Web Storage API this needs. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The project as a file: pretty JSON with a trailing newline. */
export function serializeProject(doc: ProjectDoc): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** Parses and validates a project file's text. */
export function parseProjectText(text: string): { ok: true; doc: ProjectDoc } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `not JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const result = parseProject(json);
  if (result.ok) return result;
  const shown = result.errors.slice(0, 3).map((e) => `${e.path || '/'} ${e.message}`);
  return { ok: false, error: shown.join('; ') + (result.errors.length > 3 ? ` (+${result.errors.length - 3} more)` : '') };
}

/** The autosaved project, or undefined when there is none or it doesn't validate. */
export function loadAutosave(storage: StorageLike | undefined): ProjectDoc | undefined {
  let text: string | null = null;
  try {
    text = storage?.getItem(AUTOSAVE_KEY) ?? null;
  } catch (error) {
    console.warn('benchtop: could not read the autosave', error);
    return undefined;
  }
  if (text === null) return undefined;
  const result = parseProjectText(text);
  if (result.ok) return result.doc;
  console.warn(`benchtop: ignoring a corrupt autosave (${result.error})`);
  return undefined;
}

/**
 * Debounced writer: call `schedule(doc)` after every edit; the document is written once edits
 * pause for AUTOSAVE_DELAY_MS. `flush()` writes a pending one at once (page hide).
 */
export function createAutosave(
  storage: StorageLike | undefined,
  timers: { set(fn: () => void, ms: number): number; clear(id: number): void },
): { schedule(doc: ProjectDoc): void; flush(): void } {
  let pending: ProjectDoc | null = null;
  let timer = -1;
  const write = (): void => {
    timer = -1;
    if (pending === null) return;
    const doc = pending;
    pending = null;
    try {
      storage?.setItem(AUTOSAVE_KEY, JSON.stringify(doc));
    } catch (error) {
      console.warn('benchtop: autosave failed', error);
    }
  };
  return {
    schedule(doc) {
      pending = doc;
      if (timer !== -1) timers.clear(timer);
      timer = timers.set(write, AUTOSAVE_DELAY_MS);
    },
    flush() {
      if (timer !== -1) timers.clear(timer);
      write();
    },
  };
}
