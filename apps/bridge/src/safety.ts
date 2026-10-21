/**
 * What the bridge accepts. It runs a compiler on paths it is given, so every request is
 * checked: the Host header (a DNS-rebinding guard), the Origin (only the bridge's own page or
 * the Vite dev server), the board (an FQBN allowlist) and the sketch path — or, for an inline
 * sketch (BT42), its files: names, count and size, the same limits the app's parseProject puts
 * on a document (repeated here: the two apps share no code; safety.test.ts keeps them equal).
 */

import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, sep } from 'node:path';

export const FQBN_ALLOWLIST: readonly string[] = ['arduino:avr:uno', 'arduino:avr:nano', 'arduino:avr:mega', 'esp32:esp32:esp32'];
/** The Vite dev server's origins (npm run dev). */
export const DEV_ORIGINS: readonly string[] = ['http://localhost:5173', 'http://127.0.0.1:5173'];
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
/** An inline sketch's file names: a plain name, no folders, a C/C++/Arduino extension. */
export const SKETCH_FILE_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}\.(?:ino|h|hpp|c|cpp)$/;
export const MAX_SKETCH_FILES = 32;
/** UTF-8 bytes of source over an inline sketch's files. */
export const MAX_SKETCH_BYTES = 256 * 1024;
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

export function isAllowedFqbn(fqbn: unknown): fqbn is string {
  return typeof fqbn === 'string' && FQBN_ALLOWLIST.includes(fqbn);
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

export type InlineCheck = { ok: true; fqbn: string; files: Record<string, string>; main: string } | { ok: false; error: string };

/**
 * An inline sketch (BT42): `{ fqbn, files: { name: text }, main }` — an allowed FQBN, 1–32 files
 * with safe names (written into a fresh folder, so a name can't leave it), at most 256 KB of
 * UTF-8 source, and `main` one of them ending in .ino.
 */
export function validateInlineSketch(body: unknown): InlineCheck {
  if (typeof body !== 'object' || body === null) return { ok: false, error: 'body must be an object' };
  const { fqbn, files, main } = body as { fqbn?: unknown; files?: unknown; main?: unknown };
  if (!isAllowedFqbn(fqbn)) return { ok: false, error: `fqbn must be one of ${FQBN_ALLOWLIST.join(', ')}` };
  if (typeof files !== 'object' || files === null || Array.isArray(files)) return { ok: false, error: 'files must be an object of name → text' };
  const names = Object.keys(files);
  if (names.length === 0 || names.length > MAX_SKETCH_FILES) return { ok: false, error: `a sketch has 1–${MAX_SKETCH_FILES} files` };
  const out: Record<string, string> = {};
  let bytes = 0;
  for (const name of names) {
    const text = (files as Record<string, unknown>)[name];
    if (!SKETCH_FILE_PATTERN.test(name)) return { ok: false, error: `bad file name ${JSON.stringify(name.slice(0, 80))}` };
    if (typeof text !== 'string') return { ok: false, error: `${name} must be text` };
    bytes += Buffer.byteLength(text, 'utf8');
    out[name] = text;
  }
  if (bytes > MAX_SKETCH_BYTES) return { ok: false, error: `the sketch is ${bytes} bytes, at most ${MAX_SKETCH_BYTES}` };
  if (typeof main !== 'string' || !main.endsWith('.ino') || !Object.hasOwn(out, main)) return { ok: false, error: 'main must name one of the files, a .ino' };
  return { ok: true, fqbn, files: out, main };
}
