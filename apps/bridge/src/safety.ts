/**
 * What the bridge accepts. It runs a compiler on paths it is given, so every request is
 * checked: the Host header (a DNS-rebinding guard), the Origin (only the bridge's own page or
 * the Vite dev server), the board (an FQBN allowlist) and the sketch path — or, for an inline
 * sketch (BT42), its files: names, count and size, the same limits the app's parseProject puts
 * on a document (repeated in scripts/compile.ts: the app and the bridge share no code;
 * safety.test.ts keeps them equal).
 */

import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, sep } from 'node:path';

// The FQBN allowlist and an inline sketch's rules live with the compile code they guard
// (scripts/compile.ts, shared with the CLI's MCP server since BT70).
export { FQBN_ALLOWLIST, type InlineCheck, isAllowedFqbn, MAX_SKETCH_BYTES, MAX_SKETCH_FILES, SKETCH_FILE_PATTERN, validateInlineSketch } from '../../../scripts/compile.ts';

/** The Vite dev server's origins (npm run dev). */
export const DEV_ORIGINS: readonly string[] = ['http://localhost:5173', 'http://127.0.0.1:5173'];
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
/** An inline compile's request body: 256 KB of source, which JSON escaping can grow. */
export const MAX_INLINE_BODY_BYTES = 1024 * 1024;
const FORBIDDEN_ROOTS = ['/System', '/usr', '/bin'];

/** The Host header must name this bridge on loopback: 127.0.0.1:<port> or localhost:<port>. */
export function isAllowedHost(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

/** Origins allowed to call the bridge: its own page and the Vite dev server. */
export function isAllowedOrigin(origin: string | undefined, port: number): boolean {
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}` || (origin !== undefined && DEV_ORIGINS.includes(origin));
}

export type SketchCheck = { ok: true; dir: string; name: string } | { ok: false; error: string };

/**
 * A sketch is an absolute, existing directory `<dir>/<name>` holding `<name>.ino`, outside
 * node_modules and the system folders. Symlinks are resolved before the checks repeat.
 */
export function validateSketchPath(input: unknown): SketchCheck {
  if (typeof input !== 'string' || input.length === 0 || input.length > 4096) return { ok: false, error: 'sketch must be a path' };
  if (!isAbsolute(input)) return { ok: false, error: 'sketch must be an absolute path' };
  if (input.split(/[\\/]/).includes('..')) return { ok: false, error: 'sketch path must not contain ..' };
  const forbidden = (path: string): string | undefined => {
    if (path.split(sep).includes('node_modules')) return 'sketches under node_modules are not allowed';
    if (FORBIDDEN_ROOTS.some((root) => path === root || path.startsWith(`${root}/`))) return 'sketches in system folders are not allowed';
    return undefined;
  };
  const before = forbidden(input);
  if (before !== undefined) return { ok: false, error: before };
  let dir: string;
  try {
    dir = realpathSync(input);
    if (!statSync(dir).isDirectory()) return { ok: false, error: 'sketch must be a folder' };
  } catch {
    return { ok: false, error: 'sketch folder does not exist' };
  }
  const after = forbidden(dir);
  if (after !== undefined) return { ok: false, error: after };
  const name = basename(dir);
  if (!existsSync(join(dir, `${name}.ino`))) return { ok: false, error: `the folder has no ${name}.ino` };
  return { ok: true, dir, name };
}
