/**
 * Sketch folders on boards, through the compile bridge: setting the folder (the document keeps
 * a `FirmwareRef { kind: 'sketch', path, fqbn }`), one-shot compiles, Watch (recompile on every
 * save), a status per board, the compile's problems, and handing each good build to the bench —
 * a hot swap of that board's firmware, marked "— reloaded —" in its serial tab. A failed
 * compile keeps the old firmware running. Inline sketches (BT42: the source in the document,
 * edited in the Code tab) compile through the same status and Problems rows with Compile & Run
 * (inline-compile.ts holds the flow).
 */

import type { FirmwareRef } from '@benchtop/core';
import { computed, effect, signal } from '@preact/signals';
import { type BridgeCompileResult, BridgeRefusal, checkBridge, compileInlineSketch, compileSketch, type Watch, watchSketch } from '../sim/bridge-client.ts';
import { type CompileProblemRow, compileProblemRows, rememberFolder } from '../sim/compile-problems.ts';
import { firmwareChanged, firmwareCompiled, run } from '../sim/controller.ts';
import { simRunning, simTime } from '../sim/host.ts';
import { serialBuffer, serialVersion } from '../ui/serial-state.ts';
import { editor, editorMessage } from './app-store.ts';
import { firmwareStore, type StoredFirmware } from './firmware-store.ts';
import { fqbnOf } from './fqbn.ts';
import { compileInline, type InlineRef, sourceHash } from './inline-compile.ts';

export { fqbnOf };

type SketchRef = Extract<FirmwareRef, { kind: 'sketch' }>;

export interface SketchStatus {
  phase: 'idle' | 'compiling' | 'ok' | 'error';
  /** ok: seconds the compile took; error: what went wrong, briefly. */
  detail: string;
  watching: boolean;
  /** The watch stream is open. */
  connected: boolean;
}

const IDLE: SketchStatus = { phase: 'idle', detail: '', watching: false, connected: false };

export const sketchStatus = signal<Readonly<Record<string, SketchStatus>>>({});
/** Each board's latest compile problems. */
export const compileRows = signal<Readonly<Record<string, readonly CompileProblemRow[]>>>({});
export const allCompileRows = computed(() => Object.values(compileRows.value).flat());

/** A board's status (subscribes the caller). */
export function statusOf(board: string): SketchStatus {
  return sketchStatus.value[board] ?? IDLE;
}

function patch(board: string, change: Partial<SketchStatus>): void {
  const all = sketchStatus.peek();
  sketchStatus.value = { ...all, [board]: { ...(all[board] ?? IDLE), ...change } };
}

function setRows(board: string, rows: readonly CompileProblemRow[]): void {
  const all = compileRows.peek();
  if ((all[board]?.length ?? 0) === 0 && rows.length === 0) return;
  compileRows.value = { ...all, [board]: rows };
}


const RECENT_KEY = 'benchtop:sketch-folders:v1';

function readRecent(): string[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((p): p is string => typeof p === 'string').slice(0, 5) : [];
  } catch {
    return [];
  }
}

/** The last five sketch folders used, newest first (localStorage). */
export const recentFolders = signal<readonly string[]>(readRecent());

function remember(path: string): void {
  recentFolders.value = rememberFolder(recentFolders.peek(), path);
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(recentFolders.peek()));
  } catch {
    // storage blocked: the list lives for the session
  }
}

function sketchRef(board: string): SketchRef | undefined {
  const ref = editor.doc.peek().firmware[board];
  return ref?.kind === 'sketch' ? ref : undefined;
}

/** Points a board at a sketch folder (empty input detaches it) and compiles it unless watching. */
export function setSketchFolder(board: string, partType: string, input: string): void {
  const path = input.trim();
  const fqbn = fqbnOf(partType);
  if (fqbn === undefined) return;
  if (path === '') {
    if (sketchRef(board) === undefined) return;
    editor.setFirmware(board, null);
    void firmwareStore.delete(board);
    firmwareChanged();
    setRows(board, []);
    patch(board, { phase: 'idle', detail: '', watching: false });
    return;
  }
  if (!path.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(path)) {
    editorMessage.value = 'The sketch folder must be an absolute path, like /Users/you/Arduino/Blink.';
    return;
  }
  if (path.length > 256) {
    editorMessage.value = 'That sketch path is longer than 256 characters.';
    return;
  }
  const current = sketchRef(board);
  if (current?.path === path && current.fqbn === fqbn) return;
  editor.setFirmware(board, { kind: 'sketch', path, fqbn });
  // The old bytes belong to another program: the board runs nothing until this one compiles.
  void firmwareStore.delete(board);
  firmwareChanged();
  setRows(board, []);
  patch(board, { phase: 'idle', detail: '' });
  remember(path);
  if (!(sketchStatus.peek()[board]?.watching ?? false)) void compileNow(board);
}

/** Compiles a board's sketch folder once. */
export async function compileNow(board: string): Promise<void> {
  const ref = sketchRef(board);
  if (ref === undefined) return;
  patch(board, { phase: 'compiling', detail: '' });
  try {
    applyResult(board, ref.path, await compileSketch(ref.path, ref.fqbn));
  } catch (error) {
    if (sketchRef(board)?.path !== ref.path) return;
    const message = error instanceof BridgeRefusal ? error.message : 'compile bridge not running';
    patch(board, { phase: 'error', detail: message });
    if (error instanceof BridgeRefusal) setRows(board, compileProblemRows(board, ref.path, { ok: false, diagnostics: [], error: message }));
  }
}

export function setWatching(board: string, on: boolean): void {
  patch(board, { watching: on, connected: false });
}

function base64Bytes(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

function storedFrom(ref: SketchRef, result: BridgeCompileResult): StoredFirmware | undefined {
  const name = ref.path.split(/[\\/]/).filter(Boolean).at(-1) ?? 'sketch';
  if (ref.fqbn.startsWith('esp32:')) {
    const bin = result.artifacts.bin;
    return bin === undefined ? undefined : { name: `${name}.ino.bin`, format: 'esp32-bin', bytes: base64Bytes(bin) };
  }
  if (ref.fqbn.startsWith('rp2040:')) {
    const uf2 = result.artifacts.uf2;
    return uf2 === undefined ? undefined : { name: `${name}.ino.uf2`, format: 'uf2', bytes: base64Bytes(uf2) };
  }
  const hex = result.artifacts.hex;
  return hex === undefined ? undefined : { name: `${name}.ino.hex`, format: 'hex', bytes: new TextEncoder().encode(hex) };
}

function applyResult(board: string, path: string, result: BridgeCompileResult): void {
  const ref = sketchRef(board);
  if (ref === undefined || ref.path !== path) return; // the folder changed meanwhile
  setRows(board, compileProblemRows(board, path, result));
  if (!result.ok) {
    const errors = result.diagnostics.filter((d) => d.severity === 'error').length;
    patch(board, { phase: 'error', detail: errors > 0 ? `${errors} error${errors === 1 ? '' : 's'}` : (result.error ?? 'compile failed') });
    return;
  }
  const stored = storedFrom(ref, result);
  if (stored === undefined) {
    patch(board, { phase: 'error', detail: 'the compile produced no firmware' });
    return;
  }
  void firmwareStore.put(board, stored); // the in-memory copy is set before this returns
  if (firmwareCompiled(board)) {
    serialBuffer(board).mark('— reloaded —', simTime.peek());
    serialVersion.value++;
  }
  patch(board, { phase: 'ok', detail: (result.durationMs / 1000).toFixed(1) }); // re-renders with the new name
}

function inlineRef(board: string): InlineRef | undefined {
  const ref = editor.doc.peek().firmware[board];
  return ref?.kind === 'inline' ? ref : undefined;
}

/** Whether the board's stored firmware was built from other source than its inline sketch now. */
export function inlineStale(board: string): boolean {
  const ref = editor.doc.value.firmware[board];
  if (ref?.kind !== 'inline') return false;
  return firmwareStore.get(board)?.source !== sourceHash(ref);
}

/**
 * Compile & Run (BT42): compiles a board's inline sketch through the bridge; a good build goes
 * to the bench (a hot swap when it holds this document, else a reload) and the bench runs; a
 * failed one leaves the old firmware running and its errors in the Problems tab and the editor.
 */
export async function compileAndRun(board: string): Promise<void> {
  const ref = inlineRef(board);
  if (ref === undefined) return;
  patch(board, { phase: 'compiling', detail: '' });
  try {
    const outcome = await compileInline(board, ref, {
      compile: (sketch) => compileInlineSketch(sketch),
      store: (b, firmware) => void firmwareStore.put(b, firmware), // memory is set before this returns
      deliver: (b) => {
        if (firmwareCompiled(b)) {
          serialBuffer(b).mark('— reloaded —', simTime.peek());
          serialVersion.value++;
        }
        if (!simRunning.peek()) run();
      },
    });
    setRows(board, outcome.rows);
    patch(board, { phase: outcome.ok ? 'ok' : 'error', detail: outcome.detail });
  } catch (error) {
    const message = error instanceof BridgeRefusal ? error.message : 'compile bridge not running — start it with npm run bridge';
    patch(board, { phase: 'error', detail: message });
    setRows(board, compileProblemRows(board, '', { ok: false, diagnostics: [], error: message }));
  }
}

const watches = new Map<string, { key: string; watch: Watch }>();

// Keeps one watch per board that has Watch on and a sketch folder; closes the rest. Problems
// of boards that no longer have a sketch folder go away.
effect(() => {
  const firmware = editor.doc.value.firmware;
  const statuses = sketchStatus.value;
  const keyOf = (board: string): string => {
    const ref = firmware[board];
    return ref?.kind === 'sketch' ? `${ref.path}\u0000${ref.fqbn}` : '';
  };
  for (const [board, entry] of watches) {
    if (statuses[board]?.watching === true && keyOf(board) === entry.key) continue;
    entry.watch.close();
    watches.delete(board);
  }
  for (const [board, status] of Object.entries(statuses)) {
    const ref = firmware[board];
    if (!status.watching || watches.has(board) || ref?.kind !== 'sketch') continue;
    const path = ref.path;
    const watch = watchSketch(path, ref.fqbn, {
      onStart: () => patch(board, { phase: 'compiling', detail: '' }),
      onResult: (result) => applyResult(board, path, result),
      onRefused: (message) => {
        patch(board, { phase: 'error', detail: message, watching: false });
        setRows(board, compileProblemRows(board, path, { ok: false, diagnostics: [], error: message }));
      },
      onConnection: (connected) => patch(board, { connected }),
    });
    watches.set(board, { key: keyOf(board), watch });
  }
  for (const board of Object.keys(compileRows.peek())) {
    if (keyOf(board) === '' && firmware[board]?.kind !== 'inline') setRows(board, []);
  }
});

// A project that already names sketch folders: find out now whether the bridge is there.
if (Object.values(editor.doc.peek().firmware).some((ref) => ref.kind === 'sketch')) void checkBridge();
