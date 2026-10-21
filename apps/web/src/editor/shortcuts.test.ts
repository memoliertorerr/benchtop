import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { matchPcbShortcut, matchShortcut, PCB_SHORTCUTS, SHORTCUTS, type ShortcutId } from './shortcuts.ts';

const key = (k: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey', boolean>> = {}) => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

describe('shortcut table', () => {
  it('matches each handled key on Mac and other platforms', () => {
    const cases: [ReturnType<typeof key>, ShortcutId | undefined][] = [
      [key('z', { metaKey: true }), 'undo'],
      [key('z', { ctrlKey: true }), 'undo'],
      [key('Z', { metaKey: true, shiftKey: true }), 'redo'],
      [key('z', { ctrlKey: true, shiftKey: true }), 'redo'],
      [key('y', { ctrlKey: true }), 'redo'],
      [key('r'), 'rotate'],
      [key('R', { shiftKey: true }), 'rotate'],
      [key('r', { metaKey: true }), undefined], // ⌘R reloads the page; not ours
      [key('Backspace'), 'delete'],
      [key('Delete'), 'delete'],
      [key('Escape'), 'escape'],
      [key(' '), 'pan'],
      [key('f'), 'fit'],
      [key('f', { ctrlKey: true }), undefined], // find in page
      [key('?', { shiftKey: true }), 'help'],
      [key('z'), undefined],
      [key('x'), undefined],
    ];
    for (const [event, id] of cases) expect([event, matchShortcut(event)]).toEqual([event, id]);
  });

  it('lists every handled id once, and every row has keys for both platforms', () => {
    const ids = SHORTCUTS.flatMap((s) => (s.id === undefined ? [] : [s.id]));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(['delete', 'escape', 'fit', 'help', 'pan', 'redo', 'rotate', 'undo']);
    for (const s of SHORTCUTS) {
      expect(s.keys.mac.length).toBeGreaterThan(0);
      expect(s.keys.other.length).toBeGreaterThan(0);
      expect(s.id === undefined).toBe(s.match === undefined);
    }
  });

  it('is what the canvas handles: a case for every id, no key list of its own', () => {
    const canvas = readFileSync(new URL('./Canvas.tsx', import.meta.url), 'utf8');
    for (const s of SHORTCUTS) if (s.id !== undefined) expect(canvas).toContain(`case '${s.id}':`);
    expect(canvas).toContain('switch (matchShortcut(event))');
    expect(canvas).not.toMatch(/event\.key === '[a-zA-Z?]'/);
  });

  it("is what the README's shortcut table lists", () => {
    const readme = readFileSync(new URL('../../../../README.md', import.meta.url), 'utf8');
    for (const s of [...SHORTCUTS, ...PCB_SHORTCUTS]) expect(readme).toContain(`| ${s.keys.mac} | ${s.keys.other} | ${s.label} |`);
  });

  it('BT59: the PCB view handles its own keys and the shared ones it uses', () => {
    expect(matchPcbShortcut(key('x'))).toBe('pcb-route');
    expect(matchPcbShortcut(key('L', { shiftKey: true }))).toBe('pcb-layer');
    expect(matchPcbShortcut(key('v'))).toBe('pcb-via');
    expect(matchPcbShortcut(key('v', { metaKey: true }))).toBeUndefined(); // paste
    const view = readFileSync(new URL('../pcb/PcbView.tsx', import.meta.url), 'utf8');
    for (const s of PCB_SHORTCUTS) if (s.id !== undefined) expect(view).toContain(`case '${s.id}':`);
    for (const id of ['escape', 'delete', 'undo', 'redo', 'rotate', 'fit', 'help']) expect(view).toContain(`case '${id}':`);
    // The bench ignores keys while the PCB is shown.
    const canvas = readFileSync(new URL('./Canvas.tsx', import.meta.url), 'utf8');
    expect(canvas).toContain("viewMode.peek() === 'pcb'");
  });
});
