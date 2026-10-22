/**
 * The Inspector's microSD card section (BT91): the card in or out of its socket, the files on
 * the card now (while a bench is loaded: view, download, remove, upload, download all, keep as
 * the power-up files) and the files it starts with — the part's `files` prop (add a text file,
 * upload, remove; a change restarts the card with them). The card's files come from the worker
 * (`sim.storage`), refreshed when the card reports a write.
 */

import type { PartInstance, StoredFile } from '@benchtop/core';
import { cardFilesProp, SD_FILES_MAX } from '@benchtop/parts';
import { zip } from '@benchtop/pcb';
import { useEffect, useState } from 'preact/hooks';
import { editor, editorMessage } from '../../editor/app-store.ts';
import { onVisuals, sim, simLoaded } from '../../sim/host.ts';
import { baseName, formatSize, powerUpFiles, previewOf, withFiles, withoutFile } from './card-files.ts';

function download(bytes: Uint8Array, filename: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart]));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function readPicked(input: HTMLInputElement): Promise<[string, Uint8Array][]> {
  const files = [...(input.files ?? [])];
  input.value = '';
  return Promise.all(files.map(async (f): Promise<[string, Uint8Array]> => [f.name, new Uint8Array(await f.arrayBuffer())]));
}

/** The card's live state from its visual (`inserted`, `writes`), while a bench runs it. */
function useCardVisual(part: string): { inserted: boolean | null; writes: number } {
  const [state, setState] = useState<{ inserted: boolean | null; writes: number }>({ inserted: null, writes: 0 });
  useEffect(
    () =>
      onVisuals((parts) => {
        for (const [id, visual] of parts) {
          if (id !== part) continue;
          const inserted = visual.inserted === true;
          const writes = typeof visual.writes === 'number' ? visual.writes : 0;
          setState((old) => (old.inserted === inserted && old.writes === writes ? old : { inserted, writes }));
        }
      }),
    [part],
  );
  return state;
}

function LiveFiles({ part }: { part: string }) {
  const { writes } = useCardVisual(part);
  const [files, setFiles] = useState<StoredFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<{ path: string; text: string } | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = (): void => setTick((n) => n + 1);

  useEffect(() => {
    let live = true;
    // Writes come in bursts (a block at a time): list at most every 300 ms.
    const timer = setTimeout(() => {
      void sim.storage(part, { op: 'list' }).then((reply) => {
        if (!live) return;
        setFiles(reply.ok ? (reply.files ?? []) : []);
        setError(reply.ok ? null : (reply.error ?? 'unreadable'));
      });
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [part, writes, tick]);

  const read = async (path: string): Promise<Uint8Array | null> => {
    const reply = await sim.storage(part, { op: 'read', path });
    return reply.ok && reply.bytes !== undefined ? reply.bytes : null;
  };
  const view = async (path: string): Promise<void> => {
    if (open?.path === path) return setOpen(null);
    const bytes = await read(path);
    setOpen({ path, text: bytes === null ? 'Not on the card any more.' : previewOf(bytes) });
  };
  const save = async (path: string): Promise<void> => {
    const bytes = await read(path);
    if (bytes !== null) download(bytes, baseName(path));
  };
  const remove = async (path: string): Promise<void> => {
    await sim.storage(part, { op: 'remove', path });
    if (open?.path === path) setOpen(null);
    refresh();
  };
  const upload = async (input: HTMLInputElement): Promise<void> => {
    for (const [name, bytes] of await readPicked(input)) {
      const reply = await sim.storage(part, { op: 'write', path: name, bytes });
      if (!reply.ok) editorMessage.value = `${name} didn't fit on the card`;
    }
    refresh();
  };
  const all = async (): Promise<[string, Uint8Array][]> => {
    const out: [string, Uint8Array][] = [];
    for (const f of files ?? []) {
      if (f.dir) continue;
      const bytes = await read(f.path);
      if (bytes !== null) out.push([f.path, bytes]);
    }
    return out;
  };
  const zipAll = async (): Promise<void> => download(zip((await all()).map(([name, data]) => ({ name, data }))), `${part}-card.zip`);
  const keep = async (): Promise<void> => {
    const files = await all();
    const prop = cardFilesProp(files);
    const total = files.reduce((n, [, b]) => n + b.length, 0);
    if (total > SD_FILES_MAX) {
      editorMessage.value = `The card holds ${formatSize(total)}: more than the ${formatSize(SD_FILES_MAX)} a project keeps`;
      return;
    }
    editor.setProp(part, 'files', prop);
    editorMessage.value = 'The card starts with these files now (it restarted with them)';
  };

  return (
    <>
      <div class="field-label">On the card now</div>
      {error !== null ? (
        <p class="muted panel-note">No files to show: {error}.</p>
      ) : files === null ? (
        <p class="muted panel-note">Reading…</p>
      ) : files.length === 0 ? (
        <p class="muted panel-note">Empty.</p>
      ) : (
        <ul class="card-files">
          {files.map((f) => (
            <li key={f.path} class={f.dir ? 'card-dir' : ''}>
              {f.dir ? (
                <span class="card-name">{f.path}/</span>
              ) : (
                <button type="button" class="card-name link-button" title="Show its contents" onClick={() => void view(f.path)} aria-expanded={open?.path === f.path}>
                  {f.path}
                </button>
              )}
              <span class="card-size muted">{f.dir ? '' : formatSize(f.size)}</span>
              {!f.dir && (
                <button type="button" class="icon-button" title="Download" aria-label={`Download ${f.path}`} onClick={() => void save(f.path)}>
                  ⤓
                </button>
              )}
              <button type="button" class="icon-button" title="Delete from the card" aria-label={`Delete ${f.path}`} onClick={() => void remove(f.path)}>
                ✕
              </button>
              {open?.path === f.path && <pre class="card-preview">{open.text}</pre>}
            </li>
          ))}
        </ul>
      )}
      <div class="card-actions">
        <label class="tool-button">
          Upload…
          <input type="file" multiple hidden onChange={(e) => void upload(e.currentTarget)} />
        </label>
        <button type="button" class="tool-button" disabled={!files?.some((f) => !f.dir)} onClick={() => void zipAll()}>
          Download all
        </button>
        <button type="button" class="tool-button" disabled={files === null} title="Start the card with what it holds now, next time too" onClick={() => void keep()}>
          Keep as power-up files
        </button>
      </div>
    </>
  );
}

function PowerUpFiles({ part }: { part: PartInstance }) {
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const files = powerUpFiles(part.props.files);
  const set = (prop: string | null): void => {
    if (prop === null) editorMessage.value = `A card starts with ${formatSize(SD_FILES_MAX)} of files at most`;
    else editor.setProp(part.id, 'files', prop);
  };
  const upload = async (input: HTMLInputElement): Promise<void> => set(withFiles(part.props.files, await readPicked(input)));
  const add = (): void => {
    const path = name.trim();
    if (path === '') return;
    set(withFiles(part.props.files, [[path, new TextEncoder().encode(text)]]));
    setName('');
    setText('');
  };
  return (
    <>
      <div class="field-label">At power-up</div>
      {files.length === 0 ? (
        <p class="muted panel-note">An empty card.</p>
      ) : (
        <ul class="card-files">
          {files.map((f) => (
            <li key={f.path}>
              <span class="card-name">{f.path}</span>
              <span class="card-size muted">{formatSize(f.size)}</span>
              <button type="button" class="icon-button" title="Remove" aria-label={`Remove ${f.path}`} onClick={() => editor.setProp(part.id, 'files', withoutFile(part.props.files, f.path))}>
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      <label class="field">
        <span class="field-label">New text file</span>
        <input type="text" placeholder="config.txt or data/notes.txt" value={name} onInput={(e) => setName(e.currentTarget.value)} />
      </label>
      <textarea class="card-text" rows={3} placeholder="Its contents" value={text} onInput={(e) => setText(e.currentTarget.value)} />
      <div class="card-actions">
        <button type="button" class="tool-button" disabled={name.trim() === ''} onClick={add}>
          Add
        </button>
        <label class="tool-button">
          Upload…
          <input type="file" multiple hidden onChange={(e) => void upload(e.currentTarget)} />
        </label>
      </div>
      {simLoaded.value && <p class="muted panel-note">Changing these restarts the card with them.</p>}
    </>
  );
}

export function CardControls({ part }: { part: PartInstance }) {
  const loaded = simLoaded.value;
  const { inserted: live } = useCardVisual(part.id);
  const initial = part.props.inserted !== false;
  const inserted = loaded && live !== null ? live : initial;
  const toggle = (on: boolean): void => {
    if (loaded) sim.input(part.id, { kind: 'value', value: on ? 1 : 0 });
    else editor.setProp(part.id, 'inserted', on);
  };
  return (
    <div class="part-controls card-controls">
      <div class="field-label">microSD card {loaded ? '(live)' : ''}</div>
      <label class="field field-check">
        <input type="checkbox" checked={inserted} onChange={(e) => toggle(e.currentTarget.checked)} />
        <span class="field-label">Card in the socket</span>
      </label>
      {loaded && inserted && <LiveFiles part={part.id} />}
      <PowerUpFiles part={part} />
    </div>
  );
}
