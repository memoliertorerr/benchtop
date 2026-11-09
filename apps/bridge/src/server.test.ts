import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import * as CORE from '../../../packages/core/src/project/validate.ts';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { CompileResult } from './compile.ts';
import * as SAFETY from './safety.ts';
import { DOWNLOADS } from '../../../scripts/downloads.ts';
import { type Bridge, createBridge } from './server.ts';

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function send(port: number, opts: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path, headers: { host: `127.0.0.1:${port}`, ...opts.headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.end(opts.body);
  });
}

const ORIGIN = { origin: 'http://localhost:5173', 'content-type': 'application/json' };
// Real path: the bridge resolves symlinks (macOS /var → /private/var) before compiling.
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'benchtop-bridge-')));
const sketch = join(scratch, 'demo');
mkdirSync(sketch);
writeFileSync(join(sketch, 'demo.ino'), 'void setup() {}\nvoid loop() {}\n');
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function okResult(n: number): CompileResult {
  return { ok: true, durationMs: n, diagnostics: [], stdout: `build ${n}`, stderr: '', artifacts: { hex: ':00000001FF\n', elf: new Uint8Array([0x7f, 0x45, n]) } };
}

describe('bridge request guards', () => {
  let bridge: Bridge;
  let port: number;
  const calls: string[] = [];

  beforeAll(async () => {
    bridge = createBridge({
      cli: undefined,
      compile: (dir, fqbn, _buildKey, module) => {
        calls.push(`${dir} ${fqbn}${module === undefined ? '' : ` ${module}`}`);
        return Promise.resolve(okResult(calls.length));
      },
    });
    port = await bridge.listen(0);
  });
  afterAll(() => bridge.close());

  it('reports health without an arduino-cli', async () => {
    const reply = await send(port, { path: '/api/health' });
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toEqual({ cli: null, cores: [], network: [] });
  });

  it('rejects a rebinding Host header', async () => {
    expect((await send(port, { path: '/api/health', headers: { host: `evil.example:${port}` } })).status).toBe(403);
    expect((await send(port, { path: '/api/health', headers: { host: `127.0.0.1:${port + 1}` } })).status).toBe(403);
    expect((await send(port, { path: '/api/health', headers: { host: `localhost:${port}` } })).status).toBe(200);
  });

  it('rejects a foreign Origin on any request', async () => {
    expect((await send(port, { path: '/api/health', headers: { origin: 'https://evil.example' } })).status).toBe(403);
    const post = await send(port, {
      method: 'POST',
      path: '/api/compile',
      headers: { origin: 'https://evil.example' },
      body: JSON.stringify({ sketch, fqbn: 'arduino:avr:uno' }),
    });
    expect(post.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('requires an Origin on POST', async () => {
    const reply = await send(port, { method: 'POST', path: '/api/compile', body: JSON.stringify({ sketch, fqbn: 'arduino:avr:uno' }) });
    expect(reply.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('refuses FQBNs outside the allowlist', async () => {
    const reply = await send(port, { method: 'POST', path: '/api/compile', headers: ORIGIN, body: JSON.stringify({ sketch, fqbn: 'arduino:avr:leonardo' }) });
    expect(reply.status).toBe(400);
    expect(JSON.parse(reply.body).error).toMatch(/fqbn/);
    const watch = await send(port, { path: `/api/watch?fqbn=arduino:avr:leonardo&sketch=${encodeURIComponent(sketch)}` });
    expect(watch.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('refuses bad sketch paths, bad JSON and oversized bodies', async () => {
    const post = (body: string) => send(port, { method: 'POST', path: '/api/compile', headers: ORIGIN, body });
    expect((await post(JSON.stringify({ sketch: 'demo', fqbn: 'arduino:avr:uno' }))).status).toBe(400);
    expect((await post(JSON.stringify({ sketch: `${sketch}/../demo`, fqbn: 'arduino:avr:uno' }))).status).toBe(400);
    expect((await post('{nope')).status).toBe(400);
    expect((await post(JSON.stringify({ sketch, fqbn: 'arduino:avr:uno', pad: 'x'.repeat(70 * 1024) }))).status).toBe(413);
    expect(calls).toEqual([]);
  });

  it('compiles an allowed sketch and returns binary artifacts as base64', async () => {
    const reply = await send(port, { method: 'POST', path: '/api/compile', headers: ORIGIN, body: JSON.stringify({ sketch, fqbn: 'arduino:avr:uno' }) });
    expect(reply.status).toBe(200);
    const body = JSON.parse(reply.body);
    expect(body).toMatchObject({ ok: true, stdout: 'build 1', artifacts: { hex: ':00000001FF\n' } });
    expect([...Buffer.from(body.artifacts.elf, 'base64')]).toEqual([0x7f, 0x45, 1]);
    expect(calls).toEqual([`${sketch} arduino:avr:uno`]);
  });

  it('BT137: passes on a board module its FQBN knows; refuses another before compiling (compile and watch)', async () => {
    const before = calls.length;
    const post = (body: unknown) => send(port, { method: 'POST', path: '/api/compile', headers: ORIGIN, body: JSON.stringify(body) });
    expect((await post({ sketch, fqbn: 'esp32:esp32:esp32', module: 'N8R8' })).status).toBe(400);
    expect(JSON.parse((await post({ sketch, fqbn: 'arduino:avr:uno', module: 'WROVER-E' })).body).error).toMatch(/no modules/);
    const watch = await send(port, { path: `/api/watch?fqbn=esp32:esp32:esp32s3&module=WROVER-E&sketch=${encodeURIComponent(sketch)}` });
    expect(watch.status).toBe(400);
    expect(calls.length).toBe(before);
    expect((await post({ sketch, fqbn: 'esp32:esp32:esp32', module: 'WROVER-E' })).status).toBe(200);
    expect((await post({ sketch, fqbn: 'esp32:esp32:esp32', module: 'auto' })).status).toBe(200);
    expect(calls.slice(before)).toEqual([`${sketch} esp32:esp32:esp32 WROVER-E`, `${sketch} esp32:esp32:esp32`]);
  });

  it('answers 404 for unknown endpoints and static files when nothing is served', async () => {
    expect((await send(port, { path: '/api/nope' })).status).toBe(404);
    expect((await send(port, { path: '/index.html' })).status).toBe(404);
  });
});

describe('bridge static files', () => {
  let bridge: Bridge;
  let port: number;
  const root = join(scratch, 'dist');

  beforeAll(async () => {
    mkdirSync(join(root, 'assets'), { recursive: true });
    writeFileSync(join(root, 'index.html'), '<!doctype html><title>t</title>');
    writeFileSync(join(root, 'assets', 'app.js'), 'export {};');
    writeFileSync(join(scratch, 'secret.txt'), 'secret');
    bridge = createBridge({ cli: undefined, serveDir: root });
    port = await bridge.listen(0);
  });
  afterAll(() => bridge.close());

  it('serves index.html at / with cross-origin isolation headers', async () => {
    const reply = await send(port, { path: '/' });
    expect(reply.status).toBe(200);
    expect(reply.body).toContain('<title>t</title>');
    expect(reply.headers['content-type']).toMatch(/text\/html/);
    expect(reply.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(reply.headers['cross-origin-embedder-policy']).toBe('require-corp');
    const js = await send(port, { path: '/assets/app.js' });
    expect(js.status).toBe(200);
    expect(js.headers['content-type']).toMatch(/javascript/);
  });

  it('never lists directories or escapes the served folder', async () => {
    expect((await send(port, { path: '/assets' })).status).toBe(404);
    expect((await send(port, { path: '/assets/' })).status).toBe(404);
    const escaped = await send(port, { path: '/..%2fsecret.txt' });
    expect(escaped.status).toBe(403);
    expect(escaped.body).not.toContain('secret"');
    expect((await send(port, { path: '/../secret.txt' })).status).toBe(404);
    expect((await send(port, { path: '/%2e%2e/secret.txt' })).status).toBe(404);
    expect((await send(port, { path: '/a%00b' })).status).toBe(400);
  });
});

describe('bridge downloads (BT147)', () => {
  let bridge: Bridge;
  let port: number;
  const repo = join(scratch, 'repo');
  const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3]);

  beforeAll(async () => {
    const root = join(scratch, 'dist-downloads');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'index.html'), '<!doctype html><title>t</title>');
    mkdirSync(join(repo, '.cache', 'esp32-rom'), { recursive: true });
    writeFileSync(join(repo, '.cache', 'esp32-rom', 'esp32_rev0_rom.elf'), elf);
    writeFileSync(join(repo, '.cache', 'esp32-rom', 'esp-rom-elfs-20241011.tar.gz'), 'not served');
    bridge = createBridge({ cli: undefined, serveDir: root, downloadsRoot: repo });
    port = await bridge.listen(0);
  });
  afterAll(() => bridge.close());

  it('lists what the worker fetches: the ESP32, C3, S3 and S2 ROMs, the RP2350 bootrom, both MicroPython UF2s', () => {
    expect(DOWNLOADS.map((d) => [d.path, d.file])).toEqual([
      ['/esp32-rom/esp32_rev0_rom.elf', '.cache/esp32-rom/esp32_rev0_rom.elf'],
      ['/esp32c3-rom/esp32c3_rev3_rom.elf', '.cache/esp32c3-rom/esp32c3_rev3_rom.elf'],
      ['/esp32s3-rom/esp32s3_rev0_rom.elf', '.cache/esp32s3-rom/esp32s3_rev0_rom.elf'],
      ['/esp32s2-rom/esp32s2_rev0_rom.elf', '.cache/esp32s2-rom/esp32s2_rev0_rom.elf'],
      ['/rp2350-rom/bootrom-combined.bin', '.cache/rp2350-rom/bootrom-combined.bin'],
      [expect.stringMatching(/^\/micropython\/RPI_PICO-.*\.uf2$/), expect.stringMatching(/^\.cache\/micropython\/RPI_PICO-.*\.uf2$/)],
      [expect.stringMatching(/^\/micropython\/RPI_PICO2-.*\.uf2$/), expect.stringMatching(/^\.cache\/micropython\/RPI_PICO2-.*\.uf2$/)],
    ]);
    // The dev server answers from the same table.
    const vite = readFileSync(join(import.meta.dirname, '..', '..', 'web', 'vite.config.ts'), 'utf8');
    expect(vite).toContain("import { DOWNLOADS, missingText } from '../../scripts/downloads.ts';");
    expect(vite).toContain('plugins: [downloads(), appShell()]');
  });

  it('serves a download from .cache: its bytes, octet-stream, same-origin CORP and isolation headers; HEAD without a body', async () => {
    const got = await send(port, { path: '/esp32-rom/esp32_rev0_rom.elf' });
    expect(got.status).toBe(200);
    expect(got.body).toBe(elf.toString('utf8'));
    expect(got.headers['content-type']).toBe('application/octet-stream');
    expect(got.headers['content-length']).toBe('7');
    expect(got.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(got.headers['cross-origin-embedder-policy']).toBe('require-corp');
    const head = await send(port, { method: 'HEAD', path: '/esp32-rom/esp32_rev0_rom.elf' });
    expect(head.status).toBe(200);
    expect(head.headers['content-length']).toBe('7');
    expect(head.body).toBe('');
  });

  it('a missing download is a 404 naming its fetch command; other names in those folders, POST, a foreign Host or Origin are refused', async () => {
    const missing = await send(port, { path: '/esp32s3-rom/esp32s3_rev0_rom.elf' });
    expect(missing.status).toBe(404);
    expect(missing.body).toBe('ESP32-S3 ROM not installed: run npm run fetch:esp32-rom');
    expect((await send(port, { path: '/micropython/x.uf2' })).body).toMatch(/not found/);
    expect((await send(port, { path: '/esp32-rom/esp-rom-elfs-20241011.tar.gz' })).status).toBe(404);
    expect((await send(port, { path: '/esp32-rom/../esp32-rom/esp32_rev0_rom.elf' })).status).toBe(200); // the URL parser folds ..
    expect((await send(port, { path: '/esp32-rom/' })).status).toBe(404);
    expect((await send(port, { method: 'POST', path: '/esp32-rom/esp32_rev0_rom.elf', headers: ORIGIN, body: '{}' })).status).toBe(404);
    expect((await send(port, { path: '/esp32-rom/esp32_rev0_rom.elf', headers: { host: 'evil.example' } })).status).toBe(403);
    expect((await send(port, { path: '/esp32-rom/esp32_rev0_rom.elf', headers: { origin: 'http://evil.example' } })).status).toBe(403);
  });

  it('without a served folder (the dev server proxying /api), the bridge serves none', async () => {
    const bare = createBridge({ cli: undefined, downloadsRoot: repo });
    const barePort = await bare.listen(0);
    try {
      expect((await send(barePort, { path: '/esp32-rom/esp32_rev0_rom.elf' })).status).toBe(404);
    } finally {
      await bare.close();
    }
  });
});

describe('bridge watch (Server-Sent Events)', () => {
  let bridge: Bridge | undefined;
  afterEach(() => bridge?.close());

  /** A compile that finishes only when the test says so. */
  function controlledCompiler() {
    const pending: (() => void)[] = [];
    let count = 0;
    return {
      get count() {
        return count;
      },
      finishNext: () => pending.shift()?.(),
      compile: (): Promise<CompileResult> => {
        count++;
        const n = count;
        return new Promise((resolve) => pending.push(() => resolve(okResult(n))));
      },
    };
  }

  /** Opens the event stream; returns the events received so far and a closer. */
  function watch(port: number) {
    const events: { event: string; data: string }[] = [];
    let buffer = '';
    const req = request({
      host: '127.0.0.1',
      port,
      path: `/api/watch?fqbn=arduino:avr:uno&sketch=${encodeURIComponent(sketch)}`,
      headers: { host: `127.0.0.1:${port}` },
    });
    req.on('response', (res) => {
      expect(res.headers['content-type']).toBe('text/event-stream');
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffer += chunk;
        let end: number;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (event !== undefined && data !== undefined) events.push({ event, data });
        }
      });
    });
    req.on('error', () => undefined);
    req.end();
    return { events, close: () => req.destroy() };
  }

  async function until(check: () => boolean, ms = 5000): Promise<void> {
    const start = Date.now();
    while (!check()) {
      if (Date.now() - start > ms) throw new Error('timed out waiting');
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  it('compiles on start, then again after a saved change', async () => {
    const compiler = controlledCompiler();
    bridge = createBridge({ cli: undefined, compile: compiler.compile });
    const port = await bridge.listen(0);
    const stream = watch(port);
    await until(() => compiler.count === 1);
    compiler.finishNext();
    await until(() => stream.events.length === 2);
    expect(stream.events.map((e) => e.event)).toEqual(['compile-start', 'compile-result']);
    expect(JSON.parse(stream.events[1]!.data)).toMatchObject({ ok: true, stdout: 'build 1' });

    writeFileSync(join(sketch, 'notes.txt'), 'not a source file');
    await new Promise((r) => setTimeout(r, 600));
    expect(compiler.count).toBe(1);

    writeFileSync(join(sketch, 'demo.ino'), 'void setup() {}\nvoid loop() { }\n');
    await until(() => compiler.count === 2);
    compiler.finishNext();
    await until(() => stream.events.length === 4);
    expect(JSON.parse(stream.events[3]!.data)).toMatchObject({ stdout: 'build 2' });
    stream.close();
  });

  it('queues exactly one more compile for changes made during a compile', async () => {
    const compiler = controlledCompiler();
    bridge = createBridge({ cli: undefined, compile: compiler.compile });
    const port = await bridge.listen(0);
    const stream = watch(port);
    await until(() => compiler.count === 1);
    // Three saves, each past the 300 ms debounce, all while compile 1 is still running.
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(sketch, 'helper.h'), `// edit ${i}\n`);
      await new Promise((r) => setTimeout(r, 450));
    }
    expect(compiler.count).toBe(1);
    compiler.finishNext();
    await until(() => compiler.count === 2);
    compiler.finishNext();
    await until(() => stream.events.filter((e) => e.event === 'compile-result').length === 2);
    await new Promise((r) => setTimeout(r, 500));
    expect(compiler.count).toBe(2);
    stream.close();
  });

  it('shares one compile between two clients watching the same sketch', async () => {
    const compiler = controlledCompiler();
    bridge = createBridge({ cli: undefined, compile: compiler.compile });
    const port = await bridge.listen(0);
    const a = watch(port);
    await until(() => compiler.count === 1);
    const b = watch(port);
    await until(() => b.events.length === 0 && a.events.length === 1);
    await new Promise((r) => setTimeout(r, 100));
    compiler.finishNext();
    await until(() => compiler.count === 2);
    compiler.finishNext();
    await until(() => a.events.filter((e) => e.event === 'compile-result').length === 2 && b.events.some((e) => e.event === 'compile-result'));
    a.close();
    b.close();
  });
});

describe('inline sketches (BT42)', () => {
  let bridge: Bridge;
  let port: number;
  /** What the fake compile saw: the folder, its files at that moment, the build key. */
  const seen: { dir: string; fqbn: string; buildKey: string | undefined; module?: string | undefined; files: Record<string, string> }[] = [];

  beforeAll(async () => {
    bridge = createBridge({
      cli: undefined,
      compile: (dir, fqbn, buildKey, module) => {
        const files = Object.fromEntries(readdirSync(dir).map((name) => [name, readFileSync(join(dir, name), 'utf8')]));
        seen.push({ dir, fqbn, buildKey, module, files });
        // arduino-cli reports absolute paths, macOS's temp dir through /private.
        const real = realpathSync(dir);
        return Promise.resolve({
          ok: false,
          durationMs: 1,
          diagnostics: [
            { file: join(real, 'sketch.ino'), line: 3, column: 5, severity: 'error', message: "'ledPin' was not declared in this scope" },
            { file: '/opt/arduino/Arduino.h', line: 1, column: 1, severity: 'info', message: 'in a core header' },
          ],
          stdout: '',
          stderr: `${join(real, 'sketch.ino')}:3:5: error`,
          artifacts: {},
        });
      },
    });
    port = await bridge.listen(0);
  });
  afterAll(() => bridge.close());

  const post = (body: unknown, headers: Record<string, string> = ORIGIN) =>
    send(port, { method: 'POST', path: '/api/compile-inline', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const files = { 'sketch.ino': '#include "pins.h"\nvoid setup() {\n    pinMode(ledPin, OUTPUT);\n}\nvoid loop() {}\n', 'pins.h': '#define LED 13\n' };

  it('writes the files into a fresh folder named after main, compiles it, removes it, and names files as given', async () => {
    const reply = await post({ fqbn: 'arduino:avr:uno', files, main: 'sketch.ino' });
    expect(reply.status).toBe(200);
    const call = seen.at(-1)!;
    expect(call.dir.endsWith(`${sep}sketch`)).toBe(true);
    expect(call.dir.startsWith(realpathSync(tmpdir())) || call.dir.startsWith(tmpdir())).toBe(true);
    expect(call.files).toEqual(files);
    expect(call.fqbn).toBe('arduino:avr:uno');
    expect(call.buildKey).toBe('inline\u0000arduino:avr:uno\u0000sketch');
    expect(existsSync(call.dir)).toBe(false);
    const result = JSON.parse(reply.body) as CompileResult;
    expect(result.diagnostics.map((d) => [d.file, d.line, d.column])).toEqual([
      ['sketch.ino', 3, 5],
      ['/opt/arduino/Arduino.h', 1, 1],
    ]);
    expect(result.stderr).toBe('sketch.ino:3:5: error');
  });

  it('BT137: an inline sketch\u2019s module reaches the compile; a module its FQBN lacks is refused', async () => {
    const reply = await post({ fqbn: 'esp32:esp32:esp32s3', files, main: 'sketch.ino', module: 'N8R8' });
    expect(reply.status).toBe(200);
    expect(seen.at(-1)?.module).toBe('N8R8');
    const count = seen.length;
    expect((await post({ fqbn: 'esp32:esp32:esp32s3', files, main: 'sketch.ino', module: 'WROVER-E' })).status).toBe(400);
    expect(seen.length).toBe(count);
  });

  it('refuses unsafe or oversize sketches before writing anything', async () => {
    const before = seen.length;
    const cases: [unknown, number][] = [
      [{ fqbn: 'arduino:avr:leonardo', files, main: 'sketch.ino' }, 400],
      [{ fqbn: 'arduino:avr:uno', files: { 'sketch.ino': '', '../escape.h': '' }, main: 'sketch.ino' }, 400],
      [{ fqbn: 'arduino:avr:uno', files: { 'sketch.ino': '', 'evil.sh': '' }, main: 'sketch.ino' }, 400],
      [{ fqbn: 'arduino:avr:uno', files: { 'sketch.ino': 7 }, main: 'sketch.ino' }, 400],
      [{ fqbn: 'arduino:avr:uno', files, main: 'pins.h' }, 400],
      [{ fqbn: 'arduino:avr:uno', files, main: 'other.ino' }, 400],
      [{ fqbn: 'arduino:avr:uno', files: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`f${i}.ino`, ''])), main: 'f0.ino' }, 400],
      [{ fqbn: 'arduino:avr:uno', files: { 'sketch.ino': 'x'.repeat(256 * 1024 + 1) }, main: 'sketch.ino' }, 400],
      [{ fqbn: 'arduino:avr:uno', files: { 'sketch.ino': 'x'.repeat(1024 * 1024) }, main: 'sketch.ino' }, 413],
      ['{not json', 400],
    ];
    for (const [body, status] of cases) expect([body, (await post(body)).status]).toEqual([body, status]);
    expect((await post({ fqbn: 'arduino:avr:uno', files, main: 'sketch.ino' }, { 'content-type': 'application/json' })).status).toBe(403);
    expect(seen.length).toBe(before);
  });

  it("keeps the app's limits", () => {
    expect([SAFETY.SKETCH_FILE_PATTERN.source, SAFETY.MAX_SKETCH_FILES, SAFETY.MAX_SKETCH_BYTES]).toEqual([
      CORE.SKETCH_FILE_PATTERN.source,
      CORE.MAX_SKETCH_FILES,
      CORE.MAX_SKETCH_BYTES,
    ]);
  });
});
