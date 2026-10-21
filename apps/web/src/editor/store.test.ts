import { emptyProject, parseProject } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { createEditorStore, MAX_UNDO } from './store.ts';

describe('editor store', () => {
  it('adds, moves, rotates, edits and deletes parts with valid ids', () => {
    const s = createEditorStore(emptyProject('t'));
    const uno = s.addPart('arduino-uno', { x: 0, y: 0 });
    const r1 = s.addPart('resistor', { x: 100, y: 20 });
    const r2 = s.addPart('resistor', { x: 120, y: 20 });
    expect([uno, r1, r2]).toEqual(['uno1', 'r1', 'r2']);
    expect(s.selection.value).toEqual(new Set(['r2']));
    const before = s.doc.value.parts.find((p) => p.id === r1)!;
    s.moveParts([r1], 5.08, -2.54); // placed parts are already on the grid: moves stay exact
    const moved = s.doc.value.parts.find((p) => p.id === r1)!;
    expect(moved.x - before.x).toBeCloseTo(5.08, 6);
    expect(moved.y - before.y).toBeCloseTo(-2.54, 6);
    s.rotateParts([r1, r2]);
    s.rotateParts([r1]);
    expect(s.doc.value.parts.map((p) => p.rotation)).toEqual([0, 180, 90]);
    s.setProp(r1, 'ohms', 1000);
    expect(s.doc.value.parts.find((p) => p.id === r1)?.props).toEqual({ ohms: 1000 });
    s.select([r2, uno]);
    s.deleteSelection();
    expect(s.doc.value.parts.map((p) => p.id)).toEqual(['r1']);
    expect(s.selection.value.size).toBe(0);
    expect(s.addPart('resistor', { x: 0, y: 0 })).toBe('r2');
    expect(parseProject(s.doc.value).ok).toBe(true);
  });

  it('undoes and redoes 200 edits back to the exact documents', () => {
    const s = createEditorStore(emptyProject('t'));
    const snapshots = [structuredClone(s.doc.value)];
    const id = s.addPart('led', { x: 0, y: 0 });
    snapshots.push(structuredClone(s.doc.value));
    for (let i = 1; i < MAX_UNDO; i++) {
      if (i % 3 === 0) s.rotateParts([id]);
      else s.moveParts([id], 2.54, 0, false);
      snapshots.push(structuredClone(s.doc.value));
    }
    expect(s.canUndo()).toBe(true);
    for (let i = snapshots.length - 2; i >= 0; i--) {
      s.undo();
      expect(s.doc.value).toEqual(snapshots[i]);
    }
    expect(s.canUndo()).toBe(false);
    for (let i = 1; i < snapshots.length; i++) {
      s.redo();
      expect(s.doc.value).toEqual(snapshots[i]);
    }
    expect(s.canRedo()).toBe(false);
  });

  it('keeps at most 200 undo steps, and a new edit clears redo', () => {
    const s = createEditorStore(emptyProject('t'));
    const id = s.addPart('led', { x: 0, y: 0 });
    for (let i = 0; i < 250; i++) s.moveParts([id], 2.54, 0, false);
    let undos = 0;
    while (s.canUndo()) {
      s.undo();
      undos++;
    }
    expect(undos).toBe(MAX_UNDO);
    s.redo();
    expect(s.canRedo()).toBe(true);
    s.rotateParts([id]);
    expect(s.canRedo()).toBe(false);
  });

  it('deleting a part removes the wires and firmware that reference it', () => {
    const s = createEditorStore({
      format: 1,
      name: 't',
      parts: [
        { id: 'uno', type: 'arduino-uno', x: 0, y: 0, rotation: 0, props: {} },
        { id: 'led1', type: 'led', x: 90, y: 0, rotation: 0, props: {} },
      ],
      wires: [{ id: 'w1', from: { part: 'uno', pin: '13' }, to: { part: 'led1', pin: 'A' }, waypoints: [], color: 'green' }],
      firmware: { uno: { kind: 'file', name: 'blink.hex', format: 'hex' } },
    });
    s.select(['uno']);
    s.deleteSelection();
    expect(s.doc.value.wires).toEqual([]);
    expect(s.doc.value.firmware).toEqual({});
    s.undo();
    expect(s.doc.value.wires).toHaveLength(1);
  });

  it('adds, updates and deletes wires with undo, and keeps wire and part selection apart', () => {
    const s = createEditorStore(emptyProject('t'));
    s.addPart('arduino-uno', { x: 0, y: 0 });
    s.addPart('led', { x: 90, y: 0 });
    const w = s.addWire({ part: 'uno1', pin: '13' }, { part: 'led1', pin: 'A' }, [{ x: 40, y: -5 }], 'green');
    expect(w).toBe('w1');
    expect(parseProject(s.doc.value).ok).toBe(true);
    s.selectWire(w);
    expect(s.selection.value.size).toBe(0);
    s.updateWire(w, { color: 'red', waypoints: [{ x: 40, y: -10 }] });
    expect(s.doc.value.wires[0]).toMatchObject({ color: 'red', waypoints: [{ x: 40, y: -10 }] });
    s.deleteSelection(); // the selected wire, not the parts
    expect(s.doc.value.wires).toEqual([]);
    expect(s.doc.value.parts).toHaveLength(2);
    expect(s.selectedWire.value).toBeNull();
    s.undo();
    expect(s.doc.value.wires[0]?.color).toBe('red');
    s.undo();
    expect(s.doc.value.wires[0]?.color).toBe('green');
    s.selectWire('w1');
    s.select(['led1']);
    expect(s.selectedWire.value).toBeNull();
    expect(s.addWire({ part: 'uno1', pin: 'GND.1' }, { part: 'led1', pin: 'C' }, [], 'black')).toBe('w2');
  });
});


describe('inline sketch edits (BT42)', () => {
  it('coalesce consecutive edits of one board into one undo step', () => {
    const store = createEditorStore();
    const uno = store.addPart('arduino-uno', { x: 0, y: 0 });
    const ref = (text: string) => ({ kind: 'inline' as const, fqbn: 'arduino:avr:uno', files: { 'sketch.ino': text }, main: 'sketch.ino' });
    store.editSketch(uno, ref('a'));
    store.editSketch(uno, ref('ab'));
    store.editSketch(uno, ref('abc'));
    expect(store.doc.value.firmware[uno]).toEqual(ref('abc'));
    store.undo(); // all three typing edits at once
    expect(store.doc.value.firmware[uno]).toBeUndefined();
    store.redo();
    expect(store.doc.value.firmware[uno]).toEqual(ref('abc'));
    // Another edit in between starts a new step.
    store.editSketch(uno, ref('abcd'));
    store.moveParts([uno], 2.54, 0);
    store.editSketch(uno, ref('abcde'));
    store.undo();
    expect(store.doc.value.firmware[uno]).toEqual(ref('abcd'));
  });
});
