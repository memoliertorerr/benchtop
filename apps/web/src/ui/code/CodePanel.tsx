/**
 * The Code tab (BT42): a board's inline sketch — the files as tabs, the editor, Compile & Run.
 * The board is the selected one, else the first on the bench (a menu picks another). A board
 * without firmware starts from a template (blink on the Uno, serial hello on the ESP32) that
 * becomes its sketch at the first edit; a board running a dropped file or a sketch folder can
 * switch to writing its sketch here.
 *
 * Typing goes into a draft that reaches the document 400 ms after the last key (and on save,
 * file switch, blur and compile), as one coalesced undo step per run of edits; the document's
 * autosave keeps it across reloads, and export carries it. Compiling needs the bridge
 * (`npm run bridge`); without it the editor still edits and saves, and Compile says how to start
 * it.
 */

import { type FirmwareRef, SKETCH_FILE_PATTERN } from '@benchtop/core';
import { CATALOG } from '@benchtop/parts';
import { signal } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';
import { editor, editorMessage } from '../../editor/app-store.ts';
import { firmwareStore } from '../../editor/firmware-store.ts';
import { type InlineRef, templateRef } from '../../editor/inline-compile.ts';
import { openedExample, resetExample } from '../../examples/index.ts';
import { compileAndRun, compileRows, fqbnOf, inlineStale, statusOf } from '../../editor/sketch-actions.ts';
import { CodeEditor, type LineMark } from './CodeEditor.tsx';

const COMMIT_MS = 400;

/** Unsaved text per board and file ("board\0file"), until it reaches the document. */
const drafts = signal<ReadonlyMap<string, string>>(new Map());
/** The open file per board. */
const openFiles = signal<ReadonlyMap<string, string>>(new Map());
let commitTimer = 0;

const key = (board: string, file: string): string => `${board}\u0000${file}`;

/** The board's inline sketch, or the template it would start from. */
function sketchOf(ref: FirmwareRef | undefined, fqbn: string): { ref: InlineRef; started: boolean } {
  return ref?.kind === 'inline' ? { ref, started: true } : { ref: templateRef(fqbn), started: false };
}

/** Writes a board's drafts into the document (one coalesced edit). */
function commitDrafts(board: string, fqbn: string): void {
  window.clearTimeout(commitTimer);
  const pending = [...drafts.peek()].filter(([k]) => k.startsWith(`${board}\u0000`));
  if (pending.length === 0) return;
  const current = editor.doc.peek().firmware[board];
  if (current !== undefined && current.kind !== 'inline') return; // switched away meanwhile
  const { ref } = sketchOf(current, fqbn);
  const files = { ...ref.files };
  for (const [k, text] of pending) files[k.slice(board.length + 1)] = text;
  editor.editSketch(board, { ...ref, files });
  const rest = new Map(drafts.peek());
  for (const [k] of pending) rest.delete(k);
  drafts.value = rest;
}

/** Problems rows of this board's last compile that point into `file`, as editor marks. */
function marksFor(board: string, file: string): LineMark[] {
  const rows = compileRows.value[board] ?? [];
  const marks: LineMark[] = [];
  for (const row of rows) {
    const match = /^(.+):(\d+):(\d+)$/.exec(row.location);
    if (match === null || match[1] !== file) continue;
    marks.push({ line: Number(match[2]), severity: row.severity, message: row.message });
  }
  return marks;
}

export function CodePanel() {
  const doc = editor.doc.value;
  const selection = editor.selection.value;
  const [chosen, setChosen] = useState<string | null>(null);
  const [reveal, setReveal] = useState<{ line: number; nonce: number } | undefined>(undefined);
  const boards = doc.parts.filter((p) => CATALOG.get(p.type)?.board !== undefined);
  const board = boards.find((b) => b.id === chosen) ?? boards.find((b) => selection.has(b.id)) ?? boards[0];

  // Leaving the tab or the page: nothing typed is lost.
  useEffect(() => {
    const flush = (): void => {
      for (const b of editor.doc.peek().parts) {
        const fqbn = fqbnOf(b.type);
        if (fqbn !== undefined) commitDrafts(b.id, fqbn);
      }
    };
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, []);

  if (board === undefined) return <p class="muted panel-note">Add a board to the bench to write its sketch.</p>;
  const fqbn = fqbnOf(board.type) as string;
  const ref = doc.firmware[board.id];

  if (ref !== undefined && ref.kind !== 'inline') {
    const what = ref.kind === 'file' ? `the file ${ref.name}` : `the sketch folder ${ref.path}`;
    return (
      <div class="code-panel code-elsewhere">
        <BoardPicker boards={boards.map((b) => b.id)} board={board.id} onPick={setChosen} />
        <p class="panel-note">
          {board.id} runs {what}. Write its sketch here instead? The old firmware keeps running until the first Compile &amp; Run.
        </p>
        <button type="button" class="tool-button" onClick={() => editor.setFirmware(board.id, templateRef(fqbn))}>
          Write a sketch here
        </button>
      </div>
    );
  }

  const { ref: sketch, started } = sketchOf(ref, fqbn);
  const names = [sketch.main, ...Object.keys(sketch.files).filter((n) => n !== sketch.main).sort()];
  const open = openFiles.value.get(board.id);
  const file = open !== undefined && names.includes(open) ? open : sketch.main;
  const text = drafts.value.get(key(board.id, file)) ?? sketch.files[file] ?? '';
  const status = statusOf(board.id);
  const unsaved = [...drafts.value.keys()].some((k) => k.startsWith(`${board.id}\u0000`));
  const stale = started && firmwareStore.get(board.id) !== undefined && inlineStale(board.id);
  const marks = marksFor(board.id, file);

  const edit = (next: string): void => {
    drafts.value = new Map(drafts.peek()).set(key(board.id, file), next);
    window.clearTimeout(commitTimer);
    commitTimer = window.setTimeout(() => commitDrafts(board.id, fqbn), COMMIT_MS);
  };
  const save = (): void => {
    commitDrafts(board.id, fqbn);
    if (editor.doc.peek().firmware[board.id] === undefined) editor.setFirmware(board.id, sketch);
    editorMessage.value = `Saved ${board.id}'s sketch in the project.`;
  };
  const compile = (): void => {
    save();
    void compileAndRun(board.id);
  };
  const pick = (name: string): void => {
    commitDrafts(board.id, fqbn);
    openFiles.value = new Map(openFiles.peek()).set(board.id, name);
  };
  const addFile = (): void => {
    const name = window.prompt('New file (a .h, .hpp, .cpp, .c or .ino name):', 'helpers.h')?.trim();
    if (name === undefined || name === '') return;
    if (!SKETCH_FILE_PATTERN.test(name)) {
      editorMessage.value = `"${name}" isn't a file name a sketch can have (letters, digits, _ . - and a .h/.hpp/.cpp/.c/.ino ending).`;
      return;
    }
    if (names.includes(name)) {
      editorMessage.value = `${name} already exists.`;
      return;
    }
    commitDrafts(board.id, fqbn);
    const base = editor.doc.peek().firmware[board.id];
    const current = base?.kind === 'inline' ? base : sketch;
    editor.setFirmware(board.id, { ...current, files: { ...current.files, [name]: '' } });
    openFiles.value = new Map(openFiles.peek()).set(board.id, name);
  };
  const removeFile = (name: string): void => {
    if (!window.confirm(`Delete ${name} from the sketch? (Undo brings it back.)`)) return;
    commitDrafts(board.id, fqbn);
    const base = editor.doc.peek().firmware[board.id];
    if (base?.kind !== 'inline') return;
    const files = { ...base.files };
    delete files[name];
    editor.setFirmware(board.id, { ...base, files });
  };

  const firstError = marks.find((m) => m.severity === 'error') ?? marks[0];
  return (
    <div class="code-panel">
      <div class="code-bar">
        <BoardPicker boards={boards.map((b) => b.id)} board={board.id} onPick={setChosen} />
        <div class="code-files" role="tablist" aria-label="Sketch files">
          {names.map((name) => (
            <span key={name} class={`code-file${name === file ? ' active' : ''}`}>
              <button type="button" role="tab" aria-selected={name === file} onClick={() => pick(name)}>
                {name}
                {drafts.value.has(key(board.id, name)) ? ' •' : ''}
              </button>
              {name !== sketch.main && (
                <button type="button" class="code-file-close" title={`Delete ${name}`} aria-label={`Delete ${name}`} onClick={() => removeFile(name)}>
                  ×
                </button>
              )}
            </span>
          ))}
          <button type="button" class="code-file-add" title="New file" aria-label="New file" onClick={addFile}>
            +
          </button>
        </div>
        <span class="toolbar-spacer" />
        {openedExample.value !== null && openedExample.value.title === doc.name && (
          <button
            type="button"
            class="tool-button"
            title="Put this example's circuit and code back as they were (undoable)"
            onClick={() => {
              if (window.confirm(`Reset the ${doc.name} example? Your changes to its circuit and code go (Undo brings them back).`)) resetExample();
            }}
          >
            Reset example
          </button>
        )}
        <span class={`code-status ${status.phase}`}>
          {status.phase === 'compiling'
            ? 'Compiling…'
            : status.phase === 'error'
              ? status.detail
              : status.phase === 'ok'
                ? `Compiled in ${status.detail} s${stale ? ' — edited since' : ''}`
                : !started
                  ? 'Template — edit or compile to start'
                  : unsaved
                    ? 'Editing…'
                    : stale
                      ? 'Not compiled since the last edit'
                      : 'Saved in the project'}
        </span>
        <button type="button" class="tool-button primary" disabled={status.phase === 'compiling'} title="Compile & Run (⌘/Ctrl-Enter)" onClick={compile}>
          Compile &amp; Run
        </button>
      </div>
      <CodeEditor
        key={`${board.id}\u0000${file}`}
        text={text}
        onText={edit}
        onSave={save}
        onCompile={compile}
        marks={marks}
        reveal={reveal}
        label={`${board.id}: ${file}`}
      />
      {firstError !== undefined && (
        <button type="button" class={`code-problem ${firstError.severity}`} onClick={() => setReveal({ line: firstError.line, nonce: Date.now() })}>
          {file}:{firstError.line} — {firstError.message}
        </button>
      )}
    </div>
  );
}

function BoardPicker({ boards, board, onPick }: { boards: readonly string[]; board: string; onPick: (id: string) => void }) {
  if (boards.length < 2) return <span class="code-board">{board}</span>;
  return (
    <select class="tool-select" aria-label="Board" value={board} onChange={(event) => onPick((event.target as HTMLSelectElement).value)}>
      {boards.map((id) => (
        <option key={id} value={id}>
          {id}
        </option>
      ))}
    </select>
  );
}

