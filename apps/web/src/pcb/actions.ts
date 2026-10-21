/**
 * PCB file actions for the toolbar (BT59): download the fabrication files as one ZIP or the
 * layout as `.pcb.json`, and open a `.pcb.json` for the bench on screen.
 */

import { benchEnvParts } from '@benchtop/parts';
import { fabricationZip, fileBase, parsePcb, PcbBoard } from '@benchtop/pcb';
import { editor, editorMessage } from '../editor/app-store.ts';
import { pcbEditor } from './app-pcb.ts';
import { viewMode } from './mode.ts';

function download(data: BlobPart, type: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** The PCB for the bench on screen (seeded if there is none yet). */
function currentPcb() {
  pcbEditor.sync(editor.doc.peek());
  return pcbEditor.doc.peek();
}

export function exportFabricationZip(): void {
  const pcb = currentPcb();
  if (pcb === null || pcb.footprints.length === 0) {
    editorMessage.value = 'Nothing on the bench goes on a PCB yet.';
    return;
  }
  const board = new PcbBoard(editor.doc.peek(), pcb, benchEnvParts);
  download(fabricationZip(board) as Uint8Array<ArrayBuffer>, 'application/zip', `${fileBase(pcb.name || editor.doc.peek().name)}-fab.zip`);
}

export function exportPcbLayout(): void {
  const pcb = currentPcb();
  if (pcb === null) return;
  download(`${JSON.stringify(pcb, null, 2)}\n`, 'application/json', `${fileBase(pcb.name || editor.doc.peek().name)}.pcb.json`);
}

/** Opens a PCB layout for the bench on screen and shows it. */
export function openPcbDocument(json: unknown, fileName: string): void {
  const parsed = parsePcb(json);
  if (!parsed.ok) {
    const shown = parsed.errors.slice(0, 3).map((e) => `${e.path || '/'} ${e.message}`);
    editorMessage.value = `Could not open ${fileName}: ${shown.join('; ')}`;
    return;
  }
  pcbEditor.load(parsed.doc, editor.doc.peek());
  viewMode.value = 'pcb';
  editorMessage.value = `Opened the PCB layout ${fileName} for this bench.`;
}
