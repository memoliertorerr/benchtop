/**
 * The editor's state: the project document and the selection, as signals, plus every edit as
 * a command. Undo/redo keep whole-document snapshots (structuredClone), at most 200. Edits never
 * mutate a published document: each command builds the next one, so views can compare by
 * identity. Pure apart from the signals, so it is tested in Node.
 */

import {
  emptyProject,
  type FirmwareRef,
  type PartDefinition,
  type PartInstance,
  type PinRef,
  type ProjectDoc,
  type Wire,
} from '@benchtop/core';
import { CATALOG } from '@benchtop/parts';
import { type Signal, signal } from '@preact/signals';
import type { Point } from './camera.ts';
import { snapPart } from './geometry.ts';

export const MAX_UNDO = 200;

/** Short id prefixes per part type; anything else uses the type's letters. */
const ID_PREFIX: Readonly<Record<string, string>> = {
  'arduino-uno': 'uno',
  'arduino-nano': 'nano',
  'arduino-mega': 'mega',
  breadboard: 'bb',
  'breadboard-half': 'bb',
  'breadboard-mini': 'bb',
  resistor: 'r',
  led: 'led',
  'rgb-led': 'rgb',
  pushbutton: 'btn',
  'slide-switch': 'sw',
  potentiometer: 'pot',
  buzzer: 'bz',
  lcd1602: 'lcd',
  lcd2004: 'lcd',
  'lcd1602-i2c': 'lcd',
  'lcd2004-i2c': 'lcd',
  'seven-segment': 'seg',
  'seven-segment-2': 'seg',
  'seven-segment-4': 'seg',
  'led-bar-graph': 'bar',
  ssd1306: 'oled',
  'slide-potentiometer': 'pot',
  'analog-joystick': 'joy',
  'ky-040': 'enc',
  'membrane-keypad': 'pad',
  'dip-switch-8': 'dip',
  'tilt-switch': 'tilt',
  'pir-motion-sensor': 'pir',
  'photoresistor-sensor': 'ldr',
  'ntc-temperature-sensor': 'ntc',
  'small-sound-sensor': 'snd',
  'big-sound-sensor': 'snd',
  dht22: 'dht',
  'hc-sr04': 'sonar',
  ds1307: 'rtc',
  mpu6050: 'imu',
  servo: 'servo',
  'stepper-28byj48': 'motor',
  'stepper-bipolar': 'motor',
  'neopixel-strip': 'strip',
  'neopixel-ring': 'ring',
  'neopixel-matrix': 'matrix',
  'relay-ks2e-m-dc5': 'relay',
};

export interface EditorStore {
  readonly doc: Signal<ProjectDoc>;
  /** Selected part ids. */
  readonly selection: Signal<ReadonlySet<string>>;
  /** The selected wire's id (wires and parts are never selected together). */
  readonly selectedWire: Signal<string | null>;
  canUndo(): boolean;
  canRedo(): boolean;
  /** Places a part of `type` with its top-left at `at` (snapped unless `snap` is false). Returns its id. */
  addPart(type: string, at: Point, snap?: boolean): string;
  /** Moves parts by (dx, dy) mm; with `snap`, each lands with its first pin on the grid. */
  moveParts(ids: readonly string[], dx: number, dy: number, snap?: boolean): void;
  /** Rotates parts 90° clockwise about their centers. */
  rotateParts(ids: readonly string[]): void;
  /** Deletes the selected wire, or the selected parts and every wire touching them. */
  deleteSelection(): void;
  /** Adds a wire between two pins through `waypoints` (mm). Returns its id. */
  addWire(from: PinRef, to: PinRef, waypoints: readonly Point[], color: string): string;
  updateWire(id: string, patch: { waypoints?: readonly Point[]; color?: string }): void;
  deleteWire(id: string): void;
  selectWire(id: string | null): void;
  setProp(id: string, key: string, value: string | number | boolean): void;
  /** Sets (or with null removes) a board's firmware reference. */
  setFirmware(board: string, ref: FirmwareRef | null): void;
  /**
   * Sets a board's inline sketch source (BT42) — an edit of its code. Consecutive edits of the
   * same board's code are one undo step until another kind of edit comes between.
   */
  editSketch(board: string, ref: Extract<FirmwareRef, { kind: 'inline' }>): void;
  select(ids: Iterable<string>): void;
  undo(): void;
  redo(): void;
  /** Replaces the whole document (open, import, example) as one undoable edit. */
  replaceDoc(doc: ProjectDoc): void;
}

export function createEditorStore(
  initial: ProjectDoc = emptyProject('Untitled'),
  definitions: ReadonlyMap<string, PartDefinition> = CATALOG,
): EditorStore {
  const doc = signal<ProjectDoc>(initial);
  const selection = signal<ReadonlySet<string>>(new Set());
  const selectedWire = signal<string | null>(null);
  const undoStack: ProjectDoc[] = [];
  let redoStack: ProjectDoc[] = [];
  /** The board whose code the last edit changed (coalescing editSketch), or null. */
  let codeEdit: string | null = null;

  /** Applies an edit: snapshot the current document for undo, publish the next one. */
  const commit = (next: ProjectDoc): void => {
    undoStack.push(structuredClone(doc.value));
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    redoStack = [];
    codeEdit = null;
    doc.value = next;
  };

  const keepSelection = (next: ProjectDoc): void => {
    const ids = new Set(next.parts.map((p) => p.id));
    const kept = [...selection.value].filter((id) => ids.has(id));
    if (kept.length !== selection.value.size) selection.value = new Set(kept);
    if (selectedWire.value !== null && !next.wires.some((w) => w.id === selectedWire.value)) selectedWire.value = null;
  };

  const definition = (type: string): PartDefinition => {
    const def = definitions.get(type);
    if (def === undefined) throw new Error(`unknown part type "${type}"`);
    return def;
  };

  const nextId = (type: string): string => {
    const prefix = ID_PREFIX[type] ?? (type.replace(/[^a-z0-9]/g, '').slice(0, 24) || 'part');
    const taken = new Set(doc.value.parts.map((p) => p.id));
    for (let n = 1; ; n++) if (!taken.has(`${prefix}${n}`)) return `${prefix}${n}`;
  };

  const nextWireId = (): string => {
    const taken = new Set(doc.value.wires.map((w) => w.id));
    for (let n = 1; ; n++) if (!taken.has(`w${n}`)) return `w${n}`;
  };

  const store: EditorStore = {
    doc,
    selection,
    selectedWire,
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,

    addPart(type, at, snap = true) {
      const def = definition(type);
      const id = nextId(type);
      const position = snapPart(def, 0, at, snap);
      const part: PartInstance = { id, type, x: position.x, y: position.y, rotation: 0, props: {} };
      commit({ ...doc.value, parts: [...doc.value.parts, part] });
      selection.value = new Set([id]);
      return id;
    },

    moveParts(ids, dx, dy, snap = true) {
      const moving = new Set(ids);
      if (moving.size === 0 || (dx === 0 && dy === 0)) return;
      const parts = doc.value.parts.map((p) => {
        if (!moving.has(p.id)) return p;
        const def = definitions.get(p.type);
        const target = { x: p.x + dx, y: p.y + dy };
        const at = def === undefined ? target : snapPart(def, p.rotation, target, snap);
        return { ...p, x: at.x, y: at.y };
      });
      commit({ ...doc.value, parts });
    },

    rotateParts(ids) {
      const turning = new Set(ids);
      if (turning.size === 0) return;
      const parts = doc.value.parts.map((p) =>
        turning.has(p.id) ? { ...p, rotation: ((p.rotation + 90) % 360) as PartInstance['rotation'] } : p,
      );
      commit({ ...doc.value, parts });
    },

    deleteSelection() {
      if (selectedWire.value !== null) {
        store.deleteWire(selectedWire.value);
        return;
      }
      const gone = selection.value;
      if (gone.size === 0) return;
      const firmware = Object.fromEntries(Object.entries(doc.value.firmware).filter(([id]) => !gone.has(id)));
      commit({
        ...doc.value,
        parts: doc.value.parts.filter((p) => !gone.has(p.id)),
        wires: doc.value.wires.filter((w) => !gone.has(w.from.part) && !gone.has(w.to.part)),
        firmware,
      });
      selection.value = new Set();
    },

    setProp(id, key, value) {
      const part = doc.value.parts.find((p) => p.id === id);
      if (part === undefined || part.props[key] === value) return;
      const parts = doc.value.parts.map((p) => (p.id === id ? { ...p, props: { ...p.props, [key]: value } } : p));
      commit({ ...doc.value, parts });
    },

    setFirmware(board, ref) {
      const firmware = { ...doc.value.firmware };
      if (ref === null) {
        if (!(board in firmware)) return;
        delete firmware[board];
      } else {
        const current = firmware[board];
        if (current !== undefined && JSON.stringify(current) === JSON.stringify(ref)) return;
        firmware[board] = { ...ref };
      }
      commit({ ...doc.value, firmware });
    },

    editSketch(board, ref) {
      const current = doc.value.firmware[board];
      if (current !== undefined && JSON.stringify(current) === JSON.stringify(ref)) return;
      const next = { ...doc.value, firmware: { ...doc.value.firmware, [board]: structuredClone(ref) } };
      if (codeEdit === board && undoStack.length > 0) {
        redoStack = [];
        doc.value = next;
        return;
      }
      commit(next);
      codeEdit = board;
    },

    addWire(from, to, waypoints, color) {
      const id = nextWireId();
      const wire: Wire = {
        id,
        from: { part: from.part, pin: from.pin },
        to: { part: to.part, pin: to.pin },
        waypoints: waypoints.map((p) => ({ x: p.x, y: p.y })),
        color,
      };
      commit({ ...doc.value, wires: [...doc.value.wires, wire] });
      return id;
    },

    updateWire(id, patch) {
      const wire = doc.value.wires.find((w) => w.id === id);
      if (wire === undefined) return;
      const next: Wire = {
        ...wire,
        waypoints: patch.waypoints === undefined ? wire.waypoints : patch.waypoints.map((p) => ({ x: p.x, y: p.y })),
        color: patch.color ?? wire.color,
      };
      if (JSON.stringify(next) === JSON.stringify(wire)) return;
      commit({ ...doc.value, wires: doc.value.wires.map((w) => (w.id === id ? next : w)) });
    },

    deleteWire(id) {
      if (!doc.value.wires.some((w) => w.id === id)) return;
      commit({ ...doc.value, wires: doc.value.wires.filter((w) => w.id !== id) });
      if (selectedWire.value === id) selectedWire.value = null;
    },

    selectWire(id) {
      selectedWire.value = id;
      if (id !== null && selection.value.size > 0) selection.value = new Set();
    },

    select(ids) {
      selection.value = new Set(ids);
      if (selection.value.size > 0) selectedWire.value = null;
    },

    undo() {
      const previous = undoStack.pop();
      if (previous === undefined) return;
      redoStack.push(structuredClone(doc.value));
      codeEdit = null;
      doc.value = previous;
      keepSelection(previous);
    },

    redo() {
      const next = redoStack.pop();
      if (next === undefined) return;
      undoStack.push(structuredClone(doc.value));
      codeEdit = null;
      doc.value = next;
      keepSelection(next);
    },

    replaceDoc(next) {
      commit(next);
      selection.value = new Set();
      selectedWire.value = null;
    },
  };
  return store;
}
