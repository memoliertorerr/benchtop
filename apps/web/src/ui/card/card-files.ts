/**
 * The Inspector's microSD card helpers (BT91), DOM-free so Node tests reach them: the power-up
 * files a card part's `files` prop holds, edits to that prop, and a preview of a file's bytes.
 */

import { cardFilesProp, parseCardFiles, SD_FILES_MAX, utf8Text } from '@benchtop/parts';

export interface PowerUpFile {
  path: string;
  size: number;
}

/** The files a card starts with, from its `files` prop (what parses of it). */
export function powerUpFiles(prop: unknown): PowerUpFile[] {
  return parseCardFiles(typeof prop === 'string' ? prop : '').files.map(([path, bytes]) => ({ path, size: bytes.length }));
}

/** The prop with `path` added or replaced, or null when the files would pass `SD_FILES_MAX`. */
export function withFiles(prop: unknown, added: readonly (readonly [string, Uint8Array])[]): string | null {
  const files = new Map(parseCardFiles(typeof prop === 'string' ? prop : '').files);
  for (const [path, bytes] of added) {
    for (const key of files.keys()) if (key.toUpperCase() === path.toUpperCase()) files.delete(key);
    files.set(path, bytes);
  }
  let total = 0;
  for (const bytes of files.values()) total += bytes.length;
  return total > SD_FILES_MAX ? null : cardFilesProp([...files]);
}

/** The prop without `path`. */
export function withoutFile(prop: unknown, path: string): string {
  return cardFilesProp(parseCardFiles(typeof prop === 'string' ? prop : '').files.filter(([p]) => p !== path));
}

/** Bytes shown in the Inspector: UTF-8 text (its first 4 KB), else a hex dump of the first 256 bytes. */
export function previewOf(bytes: Uint8Array): string {
  // A cut inside a UTF-8 sequence: back off up to three bytes to its start.
  let cut = Math.min(bytes.length, 4096);
  let text = utf8Text(bytes.subarray(0, cut));
  for (let back = 1; text === null && back <= 3 && cut === 4096 && bytes.length > 4096; back++) text = utf8Text(bytes.subarray(0, 4096 - back));
  if (text !== null) {
    cut = new TextEncoder().encode(text).length;
    return bytes.length > cut ? `${text}\n… ${(bytes.length - cut).toLocaleString('en-US')} more bytes` : text;
  }
  const lines: string[] = [];
  const shown = bytes.subarray(0, 256);
  for (let i = 0; i < shown.length; i += 16) {
    const row = shown.subarray(i, i + 16);
    const hex = [...row].map((v) => v.toString(16).padStart(2, '0')).join(' ');
    const ascii = [...row].map((v) => (v >= 0x20 && v < 0x7f ? String.fromCharCode(v) : '.')).join('');
    lines.push(`${i.toString(16).padStart(4, '0')}  ${hex.padEnd(47)}  ${ascii}`);
  }
  if (bytes.length > shown.length) lines.push(`… ${(bytes.length - shown.length).toLocaleString('en-US')} more bytes`);
  return lines.join('\n');
}

/** 1,234 B · 12.3 KB · 4.5 MB. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes.toLocaleString('en-US')} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The last part of a path, for a download's file name. */
export function baseName(path: string): string {
  return path.split('/').filter((p) => p !== '').pop() ?? 'file';
}
