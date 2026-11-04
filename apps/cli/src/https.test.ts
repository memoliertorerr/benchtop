import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../../packages/core/src/firmware/fixtures.test-helper.ts';
import { loadCachedRom } from '../../../packages/esp32/src/test-support/rom.test-helper.ts';
import { type RunIo, runHeadless } from './run.ts';
import { makeCa, makeServerCert, type TestCert } from './tls.test-helper.ts';

// BT104: HTTPS from a simulated ESP32 — mbedTLS's handshake on the SHA, AES and RSA accelerators,
// through the access point's gateway and `--network` to a TLS server on its own thread. The
// certificates are made at run time (no key committed): the sketch gets the CA over serial.

const CA_NAME = 'Benchtop Test CA';
let ca: TestCert;
let worker: Worker;
let port = 0;

beforeAll(async () => {
  ca = makeCa(CA_NAME);
  const server = makeServerCert(ca, CA_NAME, 'secure.bench');
  // runHeadless keeps this thread busy while it runs, so the server has a thread of its own.
  worker = new Worker(
    `const { createServer } = require('node:tls');
     const { parentPort, workerData } = require('node:worker_threads');
     const server = createServer({ key: workerData.key, cert: workerData.cert }, (socket) => {
       let request = '';
       socket.on('data', (chunk) => {
         request += chunk;
         if (!request.includes('\\r\\n\\r\\n')) return;
         const path = request.split(' ')[1];
         const body = path === '/hello' ? 'hello over tls' : 'nope';
         socket.end('HTTP/1.1 ' + (path === '/hello' ? '200 OK' : '404 Not Found') + '\\r\\nContent-Type: text/plain\\r\\nContent-Length: ' + body.length + '\\r\\nConnection: close\\r\\n\\r\\n' + body);
       });
       socket.on('error', () => {});
     });
     server.listen(0, '127.0.0.1', () => parentPort.postMessage(server.address().port));`,
    { eval: true, workerData: { key: server.key, cert: server.cert } },
  );
  port = await new Promise<number>((r) => worker.once('message', r));
});
afterAll(() => worker.terminate());

const project = {
  format: 1,
  name: 'esp32-https',
  parts: [
    { id: 'esp', type: 'esp32-devkit-v1', x: 0, y: 0, rotation: 0, props: {} },
    { id: 'ap', type: 'wifi-ap', x: 90, y: 10, rotation: 0, props: { internet: true, allow: 'secure.bench:443' } },
  ],
  wires: [],
  firmware: { esp: { kind: 'file', name: 'https-get.bin', format: 'esp32-bin' } },
};
const io = (): RunIo => ({
  readFile: (path) => readFileSync(resolve(REPO_ROOT, path)),
  now: () => performance.now(),
  esp32Rom: () => loadCachedRom(),
  network: [{ host: 'secure.bench', port: 443 }],
  networkRedirect: { 'secure.bench:443': `127.0.0.1:${port}` },
});
const run = (serial: string) =>
  runHeadless({ project: 'inline', projectJson: project, firmware: { esp: 'fixtures/firmware/esp32/https-get.bin' }, scriptJson: [{ at: '2s', serial }], expect: [], duration: '12s' }, io());

describe('HTTPS from the ESP32 (BT104)', () => {
  it('verifies the server against the CA it was given and GETs over TLS', () => {
    const report = run(ca.cert);
    expect(report.error).toBeNull();
    expect(report.serial.esp).toContain('ready\r\n');
    expect(report.serial.esp).toContain('GET 200 hello over tls\n');
    const took = /took (\d+) ms/.exec(report.serial.esp);
    expect(took).not.toBeNull();
    console.info(`https handshake + GET: ${took?.[1]} ms simulated, ${Math.round(report.wallMs)} ms wall`);
  }, 180_000);

  it('setInsecure() skips the check; a CA that didn\'t sign the server fails the handshake', () => {
    expect(run('INSECURE\n').serial.esp).toContain('GET 200 hello over tls\n');
    const other = makeCa('Some Other CA');
    const wrong = run(other.cert).serial.esp;
    expect(wrong).toMatch(/GET -1 /);
    expect(wrong).not.toContain('hello over tls');
  }, 360_000);
});
