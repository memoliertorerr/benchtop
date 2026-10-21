/**
 * The PCB editor's state (BT59), DOM-free: the PCB document as a signal next to the bench's,
 * the PCB selection, the active layer and width, and every edit as a command with undo/redo
 * (200 snapshots, as the bench's). The document follows the bench: `sync(project)` seeds one
 * when there is none and reconciles an existing one (new parts beside the board, gone parts
 * dropped). Autosave writes `{ project, doc }` to storage 500 ms after the last edit; startup
 * reads it back through `parsePcb`. Selection keys: `fp:<part id>`, `tr:<trace id>`, `via:<id>`.
 */

import type { ProjectDoc } from '@benchtop/core';
import { benchEnvParts } from '@benchtop/parts';
import { type Layer, outlineAround, parsePcb, type PcbDoc, type PcbTrace, type PcbVia, type Point, reconcilePcb, seedPcb } from '@benchtop/pcb';
import { signal } from '@preact/signals';
import type { StorageLike } from '../editor/persistence.ts';

export { PCB_AUTOSAVE_KEY } from './store-key.ts';
import { PCB_AUTOSAVE_KEY } from './store-key.ts';
const HISTORY = 200;

export type PcbTool = 'select' | 'route';

export interface PcbStoreOptions {
  storage?: StorageLike | undefined;
  timers?: { set(fn: () => void, ms: number): number; clear(id: number): void };
}

/** The autosaved PCB, if it parses. */
export function loadPcbAutosave(storage: StorageLike | undefined): { project: string; doc: PcbDoc } | undefined {
  try {
    const text = storage?.getItem(PCB_AUTOSAVE_KEY) ?? null;
    if (text === null) return undefined;
    const json = JSON.parse(text) as { project?: unknown; doc?: unknown };
    const parsed = parsePcb(json.doc);
    if (!parsed.ok || typeof json.project !== 'string') return undefined;
    return { project: json.project, doc: parsed.doc };
  } catch {
    return undefined;
  }
}

export function createPcbStore(options: PcbStoreOptions = {}) {
  const saved = loadPcbAutosave(options.storage);
  const doc = signal<PcbDoc | null>(saved?.doc ?? null);
  /** The project name the document belongs to. */
  let projectName = saved?.project ?? '';
  const selection = signal<ReadonlySet<string>>(new Set());
  const tool = signal<PcbTool>('select');
  const layer = signal<Layer>('F');
  const width = signal(0.4);
  const undoStack: PcbDoc[] = [];
  const redoStack: PcbDoc[] = [];
  let saveTimer = -1;

  const save = (): void => {
    if (options.storage === undefined || doc.peek() === null) return;
    try {
      options.storage.setItem(PCB_AUTOSAVE_KEY, JSON.stringify({ project: projectName, doc: doc.peek() }));
    } catch {
      /* storage full or blocked: the PCB lives on until the page closes */
    }
  };
  const scheduleSave = (): void => {
    const timers = options.timers;
    if (timers === undefined) return save();
    if (saveTimer >= 0) timers.clear(saveTimer);
    saveTimer = timers.set(() => {
      saveTimer = -1;
      save();
    }, 500);
  };

  /** Replaces the document as one undoable edit. */
  const commit = (next: PcbDoc): void => {
    const current = doc.peek();
    if (current !== null) {
      undoStack.push(current);
      if (undoStack.length > HISTORY) undoStack.shift();
    }
    redoStack.length = 0;
    doc.value = next;
    scheduleSave();
  };

  const nextId = (prefix: 't' | 'v', taken: readonly { id: string }[]): (() => string) => {
    const used = new Set(taken.map((t) => t.id));
    let n = 1;
    return () => {
      while (used.has(`${prefix}${n}`)) n++;
      const id = `${prefix}${n}`;
      used.add(id);
      return id;
    };
  };

  const store = {
    doc,
    selection,
    tool,
    layer,
    width,

    /** Seeds or reconciles the document for `project` (not undoable: it follows the bench). */
    sync(project: ProjectDoc): void {
      const current = doc.peek();
      const next = current === null || projectName !== project.name ? seedPcb(project, benchEnvParts) : reconcilePcb(current, project, benchEnvParts);
      projectName = project.name;
      if (next !== current) {
        doc.value = next;
        scheduleSave();
      }
    },

    /** Forgets the PCB (a new or opened project); the next sync seeds one. */
    reset(): void {
      doc.value = null;
      projectName = '';
      undoStack.length = 0;
      redoStack.length = 0;
      selection.value = new Set();
    },

    /** Loads a PCB document (Open…, an example's board) for `project`, undoably. */
    load(next: PcbDoc, project: ProjectDoc): void {
      projectName = project.name;
      commit(reconcilePcb(next, project, benchEnvParts));
      selection.value = new Set();
    },

    moveFootprints(parts: readonly string[], dx: number, dy: number): void {
      const current = doc.peek();
      if (current === null || (dx === 0 && dy === 0)) return;
      const set = new Set(parts);
      commit({ ...current, footprints: current.footprints.map((f) => (set.has(f.part) ? { ...f, x: round(f.x + dx), y: round(f.y + dy) } : f)) });
    },

    rotateFootprints(parts: readonly string[]): void {
      const current = doc.peek();
      if (current === null || parts.length === 0) return;
      const set = new Set(parts);
      commit({ ...current, footprints: current.footprints.map((f) => (set.has(f.part) ? { ...f, rotation: ((f.rotation + 90) % 360) as PcbDoc['footprints'][number]['rotation'] } : f)) });
    },

    /** Adds a finished route's traces and vias as one edit. */
    addRoute(traces: readonly Omit<PcbTrace, 'id'>[], vias: readonly Omit<PcbVia, 'id'>[]): void {
      const current = doc.peek();
      if (current === null || (traces.length === 0 && vias.length === 0)) return;
      const tid = nextId('t', current.traces);
      const vid = nextId('v', current.vias);
      commit({ ...current, traces: [...current.traces, ...traces.map((t) => ({ ...t, id: tid() }))], vias: [...current.vias, ...vias.map((v) => ({ ...v, id: vid() }))] });
    },

    /** Deletes the selected traces and vias (footprints follow the bench and stay). */
    deleteSelection(): void {
      const current = doc.peek();
      const sel = selection.peek();
      if (current === null || sel.size === 0) return;
      const traces = current.traces.filter((t) => !sel.has(`tr:${t.id}`));
      const vias = current.vias.filter((v) => !sel.has(`via:${v.id}`));
      if (traces.length === current.traces.length && vias.length === current.vias.length) return;
      commit({ ...current, traces, vias });
      selection.value = new Set([...sel].filter((k) => k.startsWith('fp:')));
    },

    setTraceWidth(id: string, w: number): void {
      const current = doc.peek();
      if (current === null || !(w > 0)) return;
      commit({ ...current, traces: current.traces.map((t) => (t.id === id ? { ...t, width: w } : t)) });
    },

    setOutline(outline: Point[]): void {
      const current = doc.peek();
      if (current === null) return;
      commit({ ...current, outline });
    },

    /** The outline 3 mm around every footprint again. */
    fitOutline(project: ProjectDoc): void {
      const current = doc.peek();
      if (current === null) return;
      commit({ ...current, outline: outlineAround(current.footprints, project, benchEnvParts) });
    },

    setRule(key: keyof PcbDoc['rules'], value: number): void {
      const current = doc.peek();
      if (current === null || !Number.isFinite(value) || value < 0) return;
      commit({ ...current, rules: { ...current.rules, [key]: value } });
    },

    undo(): void {
      const previous = undoStack.pop();
      const current = doc.peek();
      if (previous === undefined || current === null) return;
      redoStack.push(current);
      doc.value = previous;
      scheduleSave();
    },

    redo(): void {
      const next = redoStack.pop();
      const current = doc.peek();
      if (next === undefined || current === null) return;
      undoStack.push(current);
      doc.value = next;
      scheduleSave();
    },

    canUndo: (): boolean => undoStack.length > 0,
    canRedo: (): boolean => redoStack.length > 0,
    /** Writes a pending autosave now (page hide). */
    flush(): void {
      if (saveTimer >= 0 && options.timers !== undefined) {
        options.timers.clear(saveTimer);
        saveTimer = -1;
        save();
      }
    },
  };
  return store;
}

export type PcbStore = ReturnType<typeof createPcbStore>;

const round = (v: number): number => Math.round(v * 1000) / 1000;
