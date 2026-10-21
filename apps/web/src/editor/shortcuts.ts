/**
 * Every keyboard shortcut and pointer gesture, in one table (BT40): the canvas's key handler
 * matches against it and the `?` sheet lists it, so the two can't disagree. A row with `match`
 * is a key the canvas handles (by `id`); one without is a gesture the sheet only describes.
 */

import { signal } from '@preact/signals';

/** The `?` sheet is open. */
export const shortcutsOpen = signal(false);

export type ShortcutId = 'pan' | 'escape' | 'undo' | 'redo' | 'rotate' | 'delete' | 'fit' | 'help';

export interface Shortcut {
  /** Set for keys the canvas handles. */
  id?: ShortcutId;
  group: 'Editing' | 'Wiring' | 'View' | 'Help';
  /** How the sheet writes the keys or gesture, Mac and other platforms. */
  keys: { mac: string; other: string };
  label: string;
  /** Whether a keydown is this shortcut (typing in a field never reaches here). */
  match?: (event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>) => boolean;
}

const mod = (e: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey'>): boolean => e.metaKey || e.ctrlKey;
const plain = (e: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey'>): boolean => !e.metaKey && !e.ctrlKey && !e.altKey;

export const SHORTCUTS: readonly Shortcut[] = [
  { id: 'undo', group: 'Editing', keys: { mac: '⌘Z', other: 'Ctrl+Z' }, label: 'Undo', match: (e) => mod(e) && !e.shiftKey && e.key.toLowerCase() === 'z' },
  {
    id: 'redo',
    group: 'Editing',
    keys: { mac: '⇧⌘Z or ⌘Y', other: 'Ctrl+Shift+Z or Ctrl+Y' },
    label: 'Redo',
    match: (e) => mod(e) && ((e.shiftKey && e.key.toLowerCase() === 'z') || e.key.toLowerCase() === 'y'),
  },
  { id: 'rotate', group: 'Editing', keys: { mac: 'R', other: 'R' }, label: 'Rotate the selected parts 90°', match: (e) => plain(e) && e.key.toLowerCase() === 'r' },
  {
    id: 'delete',
    group: 'Editing',
    keys: { mac: '⌫ or Delete', other: 'Backspace or Delete' },
    label: 'Delete the selection (while drawing a wire: remove its last bend)',
    match: (e) => e.key === 'Backspace' || e.key === 'Delete',
  },
  { group: 'Editing', keys: { mac: '⇧-click', other: 'Shift+click' }, label: 'Add a part to the selection' },
  { group: 'Editing', keys: { mac: 'Drag on the bench', other: 'Drag on the bench' }, label: 'Select parts in a box' },
  { group: 'Editing', keys: { mac: '⌥ while dragging', other: 'Alt while dragging' }, label: 'Move without snapping to the grid' },
  { group: 'Wiring', keys: { mac: 'Click a pin', other: 'Click a pin' }, label: 'Start a wire; click the bench to add bends, another pin to finish' },
  {
    id: 'escape',
    group: 'Wiring',
    keys: { mac: 'Esc', other: 'Esc' },
    label: 'Cancel the wire being drawn, leave the probe tool, or clear the selection',
    match: (e) => e.key === 'Escape',
  },
  { group: 'View', keys: { mac: 'Scroll', other: 'Scroll' }, label: 'Pan the bench' },
  { group: 'View', keys: { mac: '⌘ + scroll or pinch', other: 'Ctrl + scroll or pinch' }, label: 'Zoom at the pointer' },
  { id: 'pan', group: 'View', keys: { mac: 'Space + drag', other: 'Space + drag' }, label: 'Pan the bench', match: (e) => e.key === ' ' },
  { id: 'fit', group: 'View', keys: { mac: 'F', other: 'F' }, label: 'Fit the whole circuit in view', match: (e) => plain(e) && e.key.toLowerCase() === 'f' },
  { id: 'help', group: 'Help', keys: { mac: '?', other: '?' }, label: 'Show this sheet', match: (e) => e.key === '?' },
];

/** The handled shortcut a keydown is, if any (first match wins: redo before undo is not needed — they exclude each other). */
export function matchShortcut(event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>): ShortcutId | undefined {
  for (const s of SHORTCUTS) if (s.id !== undefined && s.match?.(event) === true) return s.id;
  return undefined;
}
