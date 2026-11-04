import { createServer, type Server } from 'node:net';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../../packages/core/src/firmware/fixtures.test-helper.ts';
import { loadCachedRom } from '../../../packages/esp32/src/test-support/rom.test-helper.ts';
import { type RunIo, runHeadless } from './run.ts';
import { NodeUplink } from './uplink.ts';

// BT101: the CLI's real network — NodeUplink's sockets (a worker thread, pumped synchronously)
// against local servers, and an ESP32's HTTPClient reaching a real HTTP server through
// `--network` (the project's access point allowing the same host).

/** A TCP server in this thread that echoes in capitals. */
function echoServer(): Promise<{ server: Server; port: number }> {
  return new Promise((done) => {
    const server = createServer((socket) => socket.on('data', (chunk: Buffer) => socket.write(chunk.toString().toUpperCase())));
    server.listen(0, '127.0.0.1', () => done({ server, port: (server.address() as { port: number }).port }));
  });
}

const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('NodeUplink (BT101)', () => {
  let echo: { server: Server; port: number };
  beforeAll(async () => {
    echo = await echoServer();
  });
  afterAll(() => echo.server.close());

  it('opens what --network allows, carries bytes both ways, and refuses the rest at the next pump', async () => {
    const uplink = new NodeUplink({ allow: [{ host: 'echo.test', port: 7 }], redirect: { 'echo.test:7': `127.0.0.1:${echo.port}` }, pace: false });
    const log: string[] = [];
    const socket = uplink.connect('echo.test', 7, { opened: () => log.push('open'), data: (b) => log.push(`data ${new TextDecoder().decode(b)}`), closed: (e) => log.push(`closed ${e}`) });
    uplink.connect('other.test', 7, { opened: () => log.push('other open'), data: () => {}, closed: (e) => log.push(`other closed ${e}`) });
    for (let i = 0; i < 200 && !log.includes('open'); i++) {
      uplink.pump(0);
      await tick();
    }
    expect(log).toEqual(['other closed other.test:7 isn\'t on --network', 'open']);
    socket.send(new TextEncoder().encode('hello'));
    for (let i = 0; i < 200 && !log.some((l) => l.startsWith('data')); i++) {
      uplink.pump(0);
      await tick();
    }
    expect(log.at(-1)).toBe('data HELLO');
    socket.close();
    uplink.pump(0);
    expect(log.at(-1)).toBe('data HELLO'); // closed by us: no event
    uplink.dispose();
  });

  it('reports a refused connection with the reason', async () => {
    const closed = await echoServer();
    const port = closed.port;
    closed.server.close();
    await tick(20);
    const uplink = new NodeUplink({ allow: [{ host: '127.0.0.1', port }], pace: false });
    let reason: string | null | undefined;
    uplink.connect('127.0.0.1', port, { opened: () => {}, data: () => {}, closed: (e) => (reason = e) });
    for (let i = 0; i < 200 && reason === undefined; i++) {
      uplink.pump(0);
      await tick();
    }
    expect(reason).toMatch(/ECONNREFUSED/);
    uplink.dispose();
  });
});

describe('an ESP32 on the real network through --network (BT101)', () => {
  let worker: Worker;
  let port = 0;
  beforeAll(async () => {
    // The HTTP server runs in its own thread: runHeadless keeps this one busy while it runs.
    worker = new Worker(
      `const { createServer } = require('node:http');
       const { parentPort } = require('node:worker_threads');
       const server = createServer((req, res) => {
         let body = '';
         req.on('data', (c) => (body += c));
         req.on('end', () => {
           const text = req.url === '/api/hello' ? '{"hello":"real","host":"' + req.headers.host + '"}' : req.url === '/api/echo' ? 'real ' + body : 'nope';
           res.writeHead(req.url === '/api/hello' || req.url === '/api/echo' ? 200 : 404, { 'Content-Type': 'text/plain', Connection: 'close' });
           res.end(text);
         });
       });
       server.listen(0, '127.0.0.1', () => parentPort.postMessage(server.address().port));`,
      { eval: true },
    );
    port = await new Promise<number>((r) => worker.once('message', r));
  });
  afterAll(() => worker.terminate());

  const project = (internet: boolean) => ({
    format: 1,
    name: 'esp32-internet',
    parts: [
      { id: 'esp', type: 'esp32-devkit-v1', x: 0, y: 0, rotation: 0, props: {} },
      { id: 'ap', type: 'wifi-ap', x: 90, y: 10, rotation: 0, props: { internet, allow: 'api.bench:80' } },
    ],
    wires: [],
    firmware: { esp: { kind: 'file', name: 'wifi-http-get.bin', format: 'esp32-bin' } },
  });
  const io = (network: boolean): RunIo => ({
    readFile: (path) => readFileSync(resolve(REPO_ROOT, path)),
    now: () => performance.now(),
    esp32Rom: () => loadCachedRom(),
    ...(network ? { network: [{ host: 'api.bench', port: 80 }], networkRedirect: { 'api.bench:80': `127.0.0.1:${port}` } } : {}),
  });
  const firmware = { esp: 'fixtures/firmware/esp32/wifi-http-get.bin' };

  it('HTTPClient GETs and POSTs to a real server by name, the Host header intact', () => {
    const report = runHeadless({ project: 'inline', projectJson: project(true), firmware, expect: ['serial contains "POST 200 real ping" by 6s'] }, io(true));
    expect(report.error).toBeNull();
    expect(report.serial.esp).toContain('GET 200 {"hello":"real","host":"api.bench"}\n');
    expect(report.exitCode).toBe(0);
    expect(report.problems.map((p) => p.code)).not.toContain('net-internet');
  }, 120_000);

  it('without --network the AP says so and the sketch gets no answer; with internet off the name doesn\'t resolve', () => {
    const none = runHeadless({ project: 'inline', projectJson: project(true), firmware, expect: [], duration: '3s' }, io(false));
    expect(none.problems.map((p) => p.code)).toContain('net-no-uplink');
    expect(none.serial.esp).not.toContain('GET 200');
    const off = runHeadless({ project: 'inline', projectJson: project(false), firmware, expect: [], duration: '3s' }, io(true));
    expect(off.serial.esp).toMatch(/GET -1 connection refused/);
  }, 120_000);
});
