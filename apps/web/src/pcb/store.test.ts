import type { ProjectDoc } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { readFixtureText } from '../../../../packages/core/src/firmware/fixtures.test-helper.ts';
import type { StorageLike } from '../editor/persistence.ts';
import { createPcbStore, loadPcbAutosave, PCB_AUTOSAVE_KEY } from './store.ts';

const blink = (): ProjectDoc => JSON.parse(readFixtureText('fixtures/projects/blink-led.json')) as ProjectDoc;

function memory(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) };
}

describe('the PCB editor store (BT59)', () => {
  it('seeds from the bench, then follows its edits without losing the layout', () => {
    const store = createPcbStore();
    const project = blink();
    store.sync(project);
    const seeded = store.doc.value!;
    expect(seeded.footprints.map((f) => f.ref).sort()).toEqual(['A1', 'D1', 'R1']);
    store.moveFootprints(['r1'], 5, -2.5);
    const moved = store.doc.value!;
    store.sync(project); // nothing changed on the bench
    expect(store.doc.value).toBe(moved);
    store.sync({ ...project, parts: [...project.parts, { id: 'r2', type: 'resistor', x: 0, y: 0, rotation: 0, props: {} }] });
    expect(store.doc.value!.footprints.map((f) => f.ref).sort()).toEqual(['A1', 'D1', 'R1', 'R2']);
    expect(store.doc.value!.footprints.find((f) => f.part === 'r1')).toEqual(moved.footprints.find((f) => f.part === 'r1'));
    // Another project: a fresh layout.
    store.sync({ ...project, name: 'other' });
    expect(store.doc.value!.footprints.find((f) => f.part === 'r1')!.x).toBe(seeded.footprints.find((f) => f.part === 'r1')!.x);
  });

  it('routes, deletes, rotates, undoes and redoes', () => {
    const store = createPcbStore();
    store.sync(blink());
    store.addRoute([{ layer: 'F', width: 0.4, points: [{ x: 0, y: 0 }, { x: 5, y: 0 }] }, { layer: 'B', width: 0.4, points: [{ x: 5, y: 0 }, { x: 5, y: 5 }] }], [{ x: 5, y: 0, drill: 0.4, diameter: 0.8 }]);
    expect(store.doc.value!.traces.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(store.doc.value!.vias.map((v) => v.id)).toEqual(['v1']);
    store.selection.value = new Set(['tr:t1', 'fp:r1']);
    store.deleteSelection();
    expect(store.doc.value!.traces.map((t) => t.id)).toEqual(['t2']);
    expect([...store.selection.value]).toEqual(['fp:r1']);
    store.rotateFootprints(['r1']);
    expect(store.doc.value!.footprints.find((f) => f.part === 'r1')!.rotation).toBe(90);
    store.undo();
    store.undo();
    expect(store.doc.value!.traces.map((t) => t.id)).toEqual(['t1', 't2']);
    store.redo();
    expect(store.doc.value!.traces.map((t) => t.id)).toEqual(['t2']);
    store.addRoute([{ layer: 'F', width: 0.4, points: [{ x: 1, y: 1 }, { x: 2, y: 1 }] }], []);
    expect(store.doc.value!.traces.map((t) => t.id)).toEqual(['t2', 't1']); // ids reused once free
    expect(store.canRedo()).toBe(false);
  });

  it('autosaves after edits and restores what parses', () => {
    const storage = memory();
    const timer: { pending: (() => void) | null } = { pending: null };
    const store = createPcbStore({ storage, timers: { set: (fn) => ((timer.pending = fn), 1), clear: () => (timer.pending = null) } });
    store.sync(blink());
    store.moveFootprints(['led1'], 1, 1);
    expect(storage.map.has(PCB_AUTOSAVE_KEY)).toBe(false);
    timer.pending?.();
    const restored = loadPcbAutosave(storage);
    expect(restored?.project).toBe('blink-led');
    expect(restored?.doc).toEqual(store.doc.value);
    const again = createPcbStore({ storage });
    expect(again.doc.value).toEqual(store.doc.value);
    storage.map.set(PCB_AUTOSAVE_KEY, '{"project":"x","doc":{"format":2}}');
    expect(loadPcbAutosave(storage)).toBeUndefined();
    storage.map.set(PCB_AUTOSAVE_KEY, 'not json');
    expect(loadPcbAutosave(storage)).toBeUndefined();
  });

  it('fits the outline and edits rules', () => {
    const store = createPcbStore();
    const project = blink();
    store.sync(project);
    store.moveFootprints(['led1'], 40, 0);
    store.fitOutline(project);
    expect(Math.max(...store.doc.value!.outline.map((p) => p.x))).toBeGreaterThan(140);
    store.setRule('clearance', 0.3);
    expect(store.doc.value!.rules.clearance).toBe(0.3);
    store.setRule('clearance', -1);
    expect(store.doc.value!.rules.clearance).toBe(0.3);
  });
});
