/**
 * Share links in the app (BT44; share.ts holds the format): "Copy share link" puts the bench —
 * or, for an example not changed since it was opened, the example's id — in a link on the
 * clipboard; a page opened with such a link (or a link pasted into the address bar later) puts it
 * on the bench, after a confirm when the bench isn't empty. A shared project's boards keep no
 * firmware from before: their inline sketches compile with Compile & Run. A broken link opens
 * nothing and says why in the Problems tab. The hash is cleared once handled.
 */

import { openedExample, openExample } from '../examples/index.ts';
import { firmwareChanged } from '../sim/controller.ts';
import { editor, editorMessage } from './app-store.ts';
import { firmwareStore } from './firmware-store.ts';
import { frameDoc } from './frame.ts';
import { importNotes } from './import-notes.ts';
import { exampleHash, projectHash, readHash } from './share.ts';

/** Copies a link to the current bench (or the open, unchanged example). */
export async function copyShareLink(): Promise<void> {
  const doc = editor.doc.peek();
  const opened = openedExample.peek();
  let hash: string;
  if (opened !== null && opened.doc === doc) {
    hash = exampleHash(opened.id);
  } else {
    const shared = await projectHash(doc);
    if (!shared.ok) {
      editorMessage.value = `Can't share this bench as a link: ${shared.error}.`;
      return;
    }
    hash = shared.hash;
  }
  const link = `${location.origin}${location.pathname}${hash}`;
  try {
    await navigator.clipboard.writeText(link);
    editorMessage.value = `Copied a share link (${link.length < 1024 ? `${link.length} characters` : `${(link.length / 1024).toFixed(1)} KB`}).`;
  } catch {
    editorMessage.value = `Couldn't reach the clipboard; the link is ${link}`;
  }
}

function clearHash(): void {
  history.replaceState(null, '', `${location.pathname}${location.search}`);
}

/** Opens what the page's URL hash shares, if anything. */
export async function openSharedLink(): Promise<void> {
  const shared = await readHash(location.hash);
  if (shared.kind === 'none') return;
  clearHash();
  if (shared.kind === 'error') {
    importNotes.value = [`Share link: ${shared.error}. Nothing was opened.`];
    return;
  }
  if (editor.doc.peek().parts.length > 0 && !window.confirm('Replace the bench with the shared circuit? (Undo brings the current one back.)')) return;
  if (shared.kind === 'example') {
    await openExample(shared.id);
    return;
  }
  if (!shared.result.ok) {
    const first = shared.result.errors[0];
    importNotes.value = [`Share link: not a Benchtop project (${first === undefined ? 'invalid' : `${first.path || '/'} ${first.message}`}). Nothing was opened.`];
    return;
  }
  const doc = shared.result.doc;
  await Promise.all(Object.keys(doc.firmware).map((board) => firmwareStore.delete(board)));
  editor.replaceDoc(doc);
  importNotes.value = [];
  firmwareChanged();
  frameDoc(doc);
  editorMessage.value = `Opened the shared circuit "${doc.name}"${Object.keys(doc.firmware).length > 0 ? ' — Compile & Run its sketch in the Code tab' : ''}.`;
}

window.addEventListener('hashchange', () => void openSharedLink());
