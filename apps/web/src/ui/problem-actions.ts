/** Clicking a problem: select its parts and frame them on the canvas. */

import { editor } from '../editor/app-store.ts';
import { frameParts } from '../editor/frame.ts';

export function showParts(ids: readonly string[]): void {
  const doc = editor.doc.peek();
  const parts = doc.parts.filter((p) => ids.includes(p.id));
  if (parts.length === 0) return;
  editor.select(parts.map((p) => p.id));
  frameParts(parts);
}
