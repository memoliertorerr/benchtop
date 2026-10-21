/**
 * The bridge's HTTP server, bound to 127.0.0.1 only.
 *
 *   GET  /api/health                     → { cli: version | null, cores: [{ id, version }] }
 *   POST /api/compile { sketch, fqbn }   → CompileResult (binary artifacts base64)
 *   POST /api/compile-inline { fqbn, files, main } → CompileResult (BT42): the files go into a
 *        fresh folder under the system temp dir, named after main, which is compiled and then
 *        removed; diagnostics name the files as given; one build cache per board + sketch name.
 *   GET  /api/watch?sketch=…&fqbn=…      → Server-Sent Events: `compile-start`, then
 *        `compile-result` (CompileResult) on start and after every saved .ino/.h/.hpp/.c/.cpp
 *        change (300 ms debounce; one compile at a time per sketch; a change during a compile
 *        queues exactly one more).
 *   With `serveDir`: every other GET serves a file from it (cross-origin isolation headers, no
 *   directory listing, no path escape).
 *
 * Every request must carry an allowed Host; any Origin must be allowed, and POST must have one.
 */

import { type FSWatcher, readFileSync, statSync, watch } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, resolve, sep } from 'node:path';
import { type CompileResult, compileInlineSketch, compile as runCompile } from './compile.ts';
import { runArduinoCli } from '../../../scripts/arduino-cli.ts';
import {
  FQBN_ALLOWLIST,
  isAllowedFqbn,
  isAllowedHost,
  isAllowedOrigin,
  MAX_BODY_BYTES,
  MAX_INLINE_BODY_BYTES,
  MAX_RESPONSE_BYTES,
  validateInlineSketch,
  validateSketchPath,
} from './safety.ts';

export interface BridgeOptions {
  /** Path of arduino-cli, or undefined when none was found (health reports it). */
  cli: string | undefined;
  /** Static files to serve (the built app), or undefined. */
  serveDir?: string;
  /** Injected for tests; defaults to the real compile. `buildKey` names the build cache. */
  compile?: (sketchDir: string, fqbn: string, buildKey?: string) => Promise<CompileResult>;
}

export interface Bridge {
  readonly server: Server;
  /** Listens on 127.0.0.1:`port` (0 = any free port); resolves to the port. */
  listen(port: number): Promise<number>;
  close(): Promise<void>;
}

const WATCHED = /\.(ino|h|hpp|c|cpp)$/i;
const DEBOUNCE_MS = 300;
/** Clients treat three missed keep-alives as a dead connection (see the app's bridge client). */
const KEEPALIVE_MS = 5_000;

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.bin': 'application/octet-stream',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

const ISOLATION = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };

/** CompileResult as JSON: binary artifacts as base64. */
export function compileResultToJson(result: CompileResult): string {
  const b64 = (bytes: Uint8Array | undefined) => (bytes === undefined ? undefined : Buffer.from(bytes).toString('base64'));
  return JSON.stringify({
    ...result,
    artifacts: {
      hex: result.artifacts.hex,
      elf: b64(result.artifacts.elf),
      bin: b64(result.artifacts.bin),
      partitions: b64(result.artifacts.partitions),
      uf2: b64(result.artifacts.uf2),
    },
  });
}

/** One sketch being watched: shared by every client watching it, one compile at a time. */
class SketchWatch {
  readonly clients = new Set<(event: string, data: string) => void>();
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private compiling = false;
  private queued = false;
  private readonly dir: string;
  private readonly fqbn: string;
  private readonly compile: (dir: string, fqbn: string) => Promise<CompileResult>;
  private readonly onEmpty: () => void;

  constructor(dir: string, fqbn: string, compile: (dir: string, fqbn: string) => Promise<CompileResult>, onEmpty: () => void) {
    this.dir = dir;
    this.fqbn = fqbn;
    this.compile = compile;
    this.onEmpty = onEmpty;
  }

  add(client: (event: string, data: string) => void): void {
    this.clients.add(client);
    if (this.watcher === null) {
      this.watcher = watch(this.dir, (_event, file) => {
        if (file !== null && WATCHED.test(String(file))) this.schedule();
      });
      // The folder went away (deleted, unmounted): stop watching; clients keep the last result.
      this.watcher.on('error', () => {
        this.watcher?.close();
      });
    }
    void this.run();
  }

  remove(client: (event: string, data: string) => void): void {
    this.clients.delete(client);
    if (this.clients.size > 0) return;
    this.watcher?.close();
    this.watcher = null;
    if (this.timer !== null) clearTimeout(this.timer);
    this.onEmpty();
  }

  private schedule(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, DEBOUNCE_MS);
  }

  private async run(): Promise<void> {
    if (this.compiling) {
      this.queued = true;
      return;
    }
    this.compiling = true;
    try {
      do {
        this.queued = false;
        this.broadcast('compile-start', JSON.stringify({ sketch: this.dir, fqbn: this.fqbn }));
        let json: string;
        try {
          json = compileResultToJson(await this.compile(this.dir, this.fqbn));
        } catch (error) {
          json = JSON.stringify({ ok: false, durationMs: 0, diagnostics: [], stdout: '', stderr: '', artifacts: {}, error: error instanceof Error ? error.message : String(error) });
        }
        this.broadcast('compile-result', json.length > MAX_RESPONSE_BYTES ? JSON.stringify({ ok: false, error: 'compile output too large' }) : json);
      } while (this.queued && this.clients.size > 0);
    } finally {
      this.compiling = false;
    }
  }

  private broadcast(event: string, data: string): void {
    for (const client of this.clients) client(event, data);
  }
}

export function createBridge(options: BridgeOptions): Bridge {
  const cli = options.cli;
  const compileOnce =
    options.compile ??
    ((dir: string, fqbn: string, buildKey?: string): Promise<CompileResult> => {
      if (cli === undefined) {
        return Promise.resolve({ ok: false, durationMs: 0, diagnostics: [], stdout: '', stderr: '', artifacts: {}, error: 'arduino-cli not found' });
      }
      return runCompile(cli, dir, fqbn, undefined, buildKey);
    });
  // A build cache serves one compile at a time (watch and POST alike).
  const queues = new Map<string, Promise<unknown>>();
  const compile = (dir: string, fqbn: string, buildKey = dir): Promise<CompileResult> => {
    const next = (queues.get(buildKey) ?? Promise.resolve()).then(() => compileOnce(dir, fqbn, buildKey));
    const settled = next.catch(() => undefined);
    queues.set(buildKey, settled);
    void settled.then(() => {
      if (queues.get(buildKey) === settled) queues.delete(buildKey);
    });
    return next;
  };

  /** An inline sketch (BT42): written to a fresh temp folder, compiled, removed. */
  const compileInline = (fqbn: string, files: Record<string, string>, main: string): Promise<CompileResult> => compileInlineSketch(compile, fqbn, files, main);
  const watches = new Map<string, SketchWatch>();
  let health: Promise<string> | null = null;
  let port = 0;

  const send = (res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    if (text.length > MAX_RESPONSE_BYTES) {
      res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'response too large' }));
      return;
    }
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra }).end(text);
  };

  const readBody = (req: IncomingMessage, cap = MAX_BODY_BYTES): Promise<string | null> =>
    new Promise((resolveBody) => {
      let size = 0;
      const chunks: Buffer[] = [];
      // Past the cap the rest is discarded unread (Node drains it after the 413 is sent).
      if (Number(req.headers['content-length'] ?? 0) > cap) {
        resolveBody(null);
        return;
      }
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > cap) {
          resolveBody(null);
          chunks.length = 0;
          return;
        }
        if (size <= cap) chunks.push(chunk);
      });
      req.on('end', () => resolveBody(size > cap ? null : Buffer.concat(chunks).toString('utf8')));
      req.on('error', () => resolveBody(null));
    });

  const getHealth = (): Promise<string> => {
    health ??= (async () => {
      if (cli === undefined) return JSON.stringify({ cli: null, cores: [] });
      const version = JSON.parse((await runArduinoCli(cli, ['version', '--json'], 30_000)).stdout || '{}') as { VersionString?: string };
      const cores = JSON.parse((await runArduinoCli(cli, ['core', 'list', '--json'], 30_000)).stdout || '{}') as {
        platforms?: { id: string; installed_version?: string }[];
      };
      return JSON.stringify({
        cli: version.VersionString ?? null,
        cores: (cores.platforms ?? []).map((p) => ({ id: p.id, version: p.installed_version ?? '' })),
      });
    })().catch(() => JSON.stringify({ cli: null, cores: [] }));
    return health;
  };

  const handleWatch = (req: IncomingMessage, res: ServerResponse, url: URL): void => {
    const fqbn = url.searchParams.get('fqbn');
    if (!isAllowedFqbn(fqbn)) return send(res, 400, { error: `fqbn must be one of ${FQBN_ALLOWLIST.join(', ')}` });
    const sketch = validateSketchPath(url.searchParams.get('sketch'));
    if (!sketch.ok) return send(res, 400, { error: sketch.error });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(': benchtop bridge\n\n');
    const key = `${sketch.dir}\u0000${fqbn}`;
    let entry = watches.get(key);
    if (entry === undefined) {
      entry = new SketchWatch(sketch.dir, fqbn, compile, () => watches.delete(key));
      watches.set(key, entry);
    }
    const client = (event: string, data: string): void => {
      res.write(`event: ${event}\ndata: ${data}\n\n`);
    };
    const keepalive = setInterval(() => res.write(': keep-alive\n\n'), KEEPALIVE_MS);
    const watching = entry;
    req.on('close', () => {
      clearInterval(keepalive);
      watching.remove(client);
    });
    watching.add(client);
  };

  const handleStatic = (res: ServerResponse, pathname: string): void => {
    const root = resolve(options.serveDir as string);
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return send(res, 400, { error: 'bad path' });
    }
    if (decoded.includes('\0')) return send(res, 400, { error: 'bad path' });
    const file = resolve(root, `.${decoded === '/' ? '/index.html' : decoded}`);
    if (file !== root && !file.startsWith(root + sep)) return send(res, 403, { error: 'outside the served folder' });
    try {
      if (!statSync(file).isFile()) return send(res, 404, { error: 'not found' }); // no directory listing
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', ...ISOLATION });
      res.end(readFileSync(file));
    } catch {
      send(res, 404, { error: 'not found' });
    }
  };

  const server = createServer((req, res) => {
    void (async () => {
      try {
        if (!isAllowedHost(req.headers.host, port)) return send(res, 403, { error: 'bad Host header' });
        const origin = req.headers.origin;
        if (origin !== undefined && !isAllowedOrigin(origin, port)) return send(res, 403, { error: 'origin not allowed' });
        const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
        if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, await getHealth());
        if (req.method === 'POST' && url.pathname === '/api/compile') {
          if (origin === undefined) return send(res, 403, { error: 'origin required' });
          const text = await readBody(req);
          if (text === null) return send(res, 413, { error: `request body over ${MAX_BODY_BYTES} bytes` });
          let body: { sketch?: unknown; fqbn?: unknown };
          try {
            body = JSON.parse(text) as typeof body;
          } catch {
            return send(res, 400, { error: 'body must be JSON' });
          }
          if (!isAllowedFqbn(body.fqbn)) return send(res, 400, { error: `fqbn must be one of ${FQBN_ALLOWLIST.join(', ')}` });
          const sketch = validateSketchPath(body.sketch);
          if (!sketch.ok) return send(res, 400, { error: sketch.error });
          return send(res, 200, compileResultToJson(await compile(sketch.dir, body.fqbn)));
        }
        if (req.method === 'POST' && url.pathname === '/api/compile-inline') {
          if (origin === undefined) return send(res, 403, { error: 'origin required' });
          const text = await readBody(req, MAX_INLINE_BODY_BYTES);
          if (text === null) return send(res, 413, { error: `request body over ${MAX_INLINE_BODY_BYTES} bytes` });
          let body: unknown;
          try {
            body = JSON.parse(text);
          } catch {
            return send(res, 400, { error: 'body must be JSON' });
          }
          const sketch = validateInlineSketch(body);
          if (!sketch.ok) return send(res, 400, { error: sketch.error });
          return send(res, 200, compileResultToJson(await compileInline(sketch.fqbn, sketch.files, sketch.main)));
        }
        if (req.method === 'GET' && url.pathname === '/api/watch') return handleWatch(req, res, url);
        if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'no such endpoint' });
        if (req.method === 'GET' && options.serveDir !== undefined) return handleStatic(res, url.pathname);
        return send(res, 404, { error: 'not found' });
      } catch (error) {
        if (!res.headersSent) send(res, 500, { error: error instanceof Error ? error.message : String(error) });
        else res.end();
      }
    })();
  });

  return {
    server,
    listen(requested) {
      return new Promise((resolveListen, reject) => {
        server.once('error', reject);
        server.listen(requested, '127.0.0.1', () => {
          port = (server.address() as AddressInfo).port;
          resolveListen(port);
        });
      });
    },
    close() {
      return new Promise((resolveClose) => {
        server.closeAllConnections();
        server.close(() => resolveClose());
      });
    },
  };
}

/** Where the built app is, relative to this file (for `--serve` without a path). */
export const DEFAULT_SERVE_DIR = join(import.meta.dirname, '..', '..', 'web', 'dist');
