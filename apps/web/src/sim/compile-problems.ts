/**
 * A compile's outcome as rows for the Problems tab: severity, a short `file:line:col` (relative
 * to the sketch folder when the file is in it), the message, and the `file:line` a click
 * copies (full path, for an editor's "go to file"). Pure; tested in Node.
 */

import type { BridgeCompileResult } from './bridge-client.ts';

export interface CompileProblemRow {
  key: string;
  board: string;
  severity: 'error' | 'warning' | 'info';
  /** `file:line:col` as shown; empty when the failure has no location. */
  location: string;
  /** `file:line` copied on click; empty when there is no location. */
  copy: string;
  message: string;
}

function shorten(file: string, sketchDir: string): string {
  const dir = sketchDir.replace(/[\\/]+$/, '');
  // An inline sketch (BT42) has no folder: its files already come by name.
  if (dir !== '' && (file.startsWith(`${dir}/`) || file.startsWith(`${dir}\\`))) return file.slice(dir.length + 1);
  const slash = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
  return slash >= 0 ? file.slice(slash + 1) : file;
}

export function compileProblemRows(board: string, sketchDir: string, result: Pick<BridgeCompileResult, 'ok' | 'diagnostics' | 'error'>): CompileProblemRow[] {
  const rows: CompileProblemRow[] = result.diagnostics.map((d, i) => {
    const located = d.file !== '' && d.line > 0;
    return {
      key: `${board}:${i}`,
      board,
      severity: d.severity,
      location: located ? `${shorten(d.file, sketchDir)}:${d.line}:${d.column}` : '',
      copy: located ? `${d.file}:${d.line}` : '',
      message: d.message,
    };
  });
  if (!result.ok && !rows.some((r) => r.severity === 'error')) {
    rows.unshift({ key: `${board}:failed`, board, severity: 'error', location: '', copy: '', message: result.error ?? 'compile failed' });
  }
  return rows;
}

/** At most this many recent sketch folders are remembered. */
export const RECENT_FOLDERS = 5;

/** The recent-folders list after using `path`: newest first, no duplicates, at most five. */
export function rememberFolder(list: readonly string[], path: string): string[] {
  return [path, ...list.filter((p) => p !== path)].slice(0, RECENT_FOLDERS);
}
