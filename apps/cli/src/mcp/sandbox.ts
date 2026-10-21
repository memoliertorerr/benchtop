/**
 * The MCP server's file boundary (BT68): every path a tool takes is relative to the root folder
 * (`--root`) and must resolve inside it, symlinks followed — an absolute path only when it is
 * inside too. `io()` is the CLI's file access with that rule on every read, so `runHeadless`,
 * specs and projects can't reach outside the root whatever their contents say; the downloaded
 * ROMs and interpreters come from the CLI's own cache, never from a tool's path.
 */

import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { SuiteIo } from '../suite.ts';

/** A path outside the root, or one that can't be a path. The tool reports it as an error. */
export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxError';
  }
}

/** The real path of `path`, or of its nearest existing ancestor joined with the rest. */
function realish(path: string): string {
  let head = path;
  const rest: string[] = [];
  while (!existsSync(head)) {
    const parent = dirname(head);
    if (parent === head) break;
    rest.unshift(basename(head));
    head = parent;
  }
  const real = existsSync(head) ? realpathSync(head) : head;
  return rest.length === 0 ? real : join(real, ...rest);
}

export class Sandbox {
  /** The root's real path. */
  readonly root: string;

  constructor(root: string) {
    const absolute = resolve(root);
    if (!existsSync(absolute)) throw new SandboxError(`root ${absolute} does not exist`);
    this.root = realpathSync(absolute);
  }

  /** Whether a real path lies inside the root. */
  contains(real: string): boolean {
    const rel = relative(this.root, real);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  }

  /** The absolute path a tool's `path` names, inside the root; throws SandboxError otherwise. */
  resolve(path: string, what = 'path'): string {
    if (typeof path !== 'string' || path === '' || path.includes('\0')) throw new SandboxError(`${what} must be a non-empty path`);
    const absolute = isAbsolute(path) ? resolve(path) : resolve(this.root, path);
    const real = realish(absolute);
    if (!this.contains(real)) throw new SandboxError(`${what} ${path} is outside the root folder (${this.root})`);
    return real;
  }

  /** `path` relative to the root, for results (forward slashes). */
  display(absolute: string): string {
    const rel = relative(this.root, absolute);
    return rel === '' ? '.' : rel.split('\\').join('/');
  }

  /** The CLI's file access confined to the root; the clock and the cached ROMs from `base`. */
  io(base: SuiteIo): SuiteIo {
    const io: SuiteIo = {
      readFile: (path) => base.readFile(this.resolve(path)),
      now: () => base.now(),
      isDirectory: (path) => {
        try {
          return base.isDirectory(this.resolve(path));
        } catch (error) {
          if (error instanceof SandboxError) throw error;
          return false;
        }
      },
      list: (dir) => base.list(this.resolve(dir)),
    };
    if (base.esp32Rom !== undefined) io.esp32Rom = () => base.esp32Rom?.();
    if (base.micropython !== undefined) io.micropython = () => base.micropython?.();
    if (base.rp2350Rom !== undefined) io.rp2350Rom = () => base.rp2350Rom?.();
    if (base.micropythonPico2 !== undefined) io.micropythonPico2 = () => base.micropythonPico2?.();
    return io;
  }
}
