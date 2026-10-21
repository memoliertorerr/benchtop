/**
 * Share links (BT44): a project travels in the URL's hash — `#project=` + base64url of its JSON
 * deflated (CompressionStream 'deflate-raw', no dependency) — or, for an example opened and not
 * changed since, just `#example=<id>`. No firmware bytes travel: dropped files and sketch
 * folders (paths on the sender's machine) are left out; inline sketches are part of the
 * document and go along. A link over 8 KB is refused (some apps cut long URLs). Opening a link is
 * untrusted input: size-checked before inflating, inflated with a cap, then parseProject.
 */

import { type ParseProjectResult, parseProject, type ProjectDoc } from '@benchtop/core';

/** The longest share link, characters of the hash. */
export const MAX_LINK_CHARS = 8 * 1024;
/** The largest project JSON a link may inflate to. */
const MAX_JSON_BYTES = 4 * 1024 * 1024;

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('not base64url');
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream, cap: number): Promise<Uint8Array> {
  const reader = new Blob([bytes as BlobPart]).stream().pipeThrough(stream).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > cap) {
      await reader.cancel();
      throw new Error('the shared project is too large');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** The document as it travels: firmware that can't (dropped files, local sketch folders) left out. */
export function shareable(doc: ProjectDoc): ProjectDoc {
  const firmware: ProjectDoc['firmware'] = {};
  for (const [board, ref] of Object.entries(doc.firmware)) if (ref.kind === 'inline') firmware[board] = ref;
  return { ...doc, firmware };
}

export type ShareHash = { ok: true; hash: string } | { ok: false; error: string };

/** The hash for a project (`#project=…`), or why it can't be shared. */
export async function projectHash(doc: ProjectDoc): Promise<ShareHash> {
  const json = new TextEncoder().encode(JSON.stringify(shareable(doc)));
  const hash = `#project=${toBase64Url(await pipe(json, new CompressionStream('deflate-raw'), Number.POSITIVE_INFINITY))}`;
  if (hash.length > MAX_LINK_CHARS) {
    return { ok: false, error: `the link would be ${Math.ceil(hash.length / 1024)} KB, over the ${MAX_LINK_CHARS / 1024} KB a link can safely carry — export the project file instead` };
  }
  return { ok: true, hash };
}

/** The hash for an example by id. */
export function exampleHash(id: string): string {
  return `#example=${encodeURIComponent(id)}`;
}

export type SharedLink =
  | { kind: 'none' }
  | { kind: 'example'; id: string }
  | { kind: 'project'; result: ParseProjectResult }
  | { kind: 'error'; error: string };

/** What a URL hash holds: nothing of ours, an example id, a project (parsed), or why it's broken. */
export async function readHash(hash: string): Promise<SharedLink> {
  if (hash.startsWith('#example=')) {
    const id = decodeURIComponent(hash.slice('#example='.length));
    return /^[a-z0-9-]{1,64}$/.test(id) ? { kind: 'example', id } : { kind: 'error', error: 'the example id is malformed' };
  }
  if (!hash.startsWith('#project=')) return { kind: 'none' };
  if (hash.length > MAX_LINK_CHARS) return { kind: 'error', error: 'the link is longer than a share link can be' };
  try {
    const json = await pipe(fromBase64Url(hash.slice('#project='.length)), new DecompressionStream('deflate-raw'), MAX_JSON_BYTES);
    const value: unknown = JSON.parse(new TextDecoder().decode(json));
    return { kind: 'project', result: parseProject(value) };
  } catch (error) {
    return { kind: 'error', error: `the link is damaged (${error instanceof Error ? error.message : String(error)})` };
  }
}
