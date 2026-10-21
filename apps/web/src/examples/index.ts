/**
 * Opening an example (BT38, editable since BT43): its project, and for every board its sketch as
 * an inline sketch (BT42) plus the precompiled firmware built from it — stored tagged with that
 * source, so the Code tab knows the build is current and it runs without the compile bridge.
 * The list is manifest.ts. `openedExample` remembers the last one opened for "Reset example".
 */

import { type FirmwareRef, parseProject, type ProjectDoc } from '@benchtop/core';
import { signal } from '@preact/signals';
import { editor, editorMessage } from '../editor/app-store.ts';
import { type FirmwareFormat, firmwareStore, type StoredFirmware } from '../editor/firmware-store.ts';
import { frameDoc } from '../editor/frame.ts';
import { importNotes } from '../editor/import-notes.ts';
import { sourceHash } from '../editor/inline-compile.ts';
import { fqbnOf } from '../editor/sketch-actions.ts';
import { firmwareChanged } from '../sim/controller.ts';
import { resetPcb } from '../pcb/mode.ts';
import { EXAMPLES, loadFirmware, loadPcb, loadProject, loadSketch } from './manifest.ts';

const formatOf = (path: string): FirmwareFormat => (path.endsWith('.hex') ? 'hex' : path.endsWith('.elf') ? 'elf' : 'esp32-bin');

/** The example opened last: its id, title and the document it made (for Reset and share links). */
export const openedExample = signal<{ id: string; title: string; doc: ProjectDoc } | null>(null);

/** Replaces the bench with an example (undoable): circuit, sketches, precompiled firmware; frames it. */
export async function openExample(id: string): Promise<void> {
  const example = EXAMPLES.find((e) => e.id === id);
  if (example === undefined) return;
  try {
    const json = await loadProject(example);
    const parsed = parseProject((json as { default?: unknown }).default ?? json);
    if (!parsed.ok) throw new Error(parsed.errors[0]?.message ?? 'invalid project');
    const firmware: Record<string, FirmwareRef> = {};
    const stored: [string, StoredFirmware][] = [];
    for (const [board, files] of Object.entries(example.boards)) {
      const part = parsed.doc.parts.find((p) => p.id === board);
      const fqbn = part === undefined ? undefined : fqbnOf(part.type);
      if (fqbn === undefined) throw new Error(`no board "${board}" in the project`);
      const [bytes, sketch] = await Promise.all([loadFirmware(files), loadSketch(files)]);
      const ref = { kind: 'inline' as const, fqbn, files: sketch.files, main: sketch.main };
      firmware[board] = ref;
      stored.push([board, { name: files.firmware.split('/').pop() as string, format: formatOf(files.firmware), bytes, source: sourceHash(ref) }]);
    }
    const doc: ProjectDoc = { ...parsed.doc, name: example.title, firmware: { ...parsed.doc.firmware, ...firmware } };
    await Promise.all(stored.map(([board, f]) => firmwareStore.put(board, f)));
    const pcbText = await loadPcb(example);
    editor.replaceDoc(doc);
    importNotes.value = [];
    // BT59: the example's own PCB, if it has one; else the next PCB view seeds one.
    resetPcb();
    if (pcbText !== undefined) {
      const [{ parsePcb }, { pcbEditor }] = await Promise.all([import('@benchtop/pcb'), import('../pcb/app-pcb.ts')]);
      const pcb = parsePcb(JSON.parse(pcbText));
      if (pcb.ok) pcbEditor.load(pcb.doc, editor.doc.peek());
    }
    firmwareChanged();
    frameDoc(doc);
    openedExample.value = { id: example.id, title: example.title, doc: editor.doc.peek() };
    editorMessage.value = `Opened the ${example.title} example — press Run, or change its code in the Code tab.`;
  } catch (error) {
    editorMessage.value = `Could not open the ${example.title} example: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** Puts the last opened example back as it was (circuit and code; undoable). */
export function resetExample(): void {
  const opened = openedExample.peek();
  if (opened !== null) void openExample(opened.id);
}
