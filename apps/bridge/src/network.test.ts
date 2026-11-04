import { request } from 'node:http';
import { createServer, type Server } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseAllowList } from '../../../packages/core/src/net/uplink.ts';
import { parseNetworkList } from './network.ts';
import { type Bridge, createBridge } from './server.ts';

// BT101: the bridge's network proxy — off without --network, only its hosts, only from the app's
// origin; an event stream per connection against a local echo server.

const ORIGIN = { origin: 'http://localhost:5173', 'content-type': 'application/json' };

function post(port: number, path: string, body: unknown, headers: Record<string, string> = ORIGIN): Promise<{ status: number; body: string }> {
  return new Promise((done, fail) => {
    const req = request({ host: '127.0.0.1', port, method: 'POST', path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let text = '';
      res.on('data', (c: Buffer) => (text += c.toString()));
      res.on('end', () => done({ status: res.statusCode ?? 0, body: text }));
    });
    req.on('error', fail);
    req.end(JSON.stringify(body));
  });
}

/** Opens a connection and collects its events as they stream. */
function open(port: number, body: unknown): Promise<{ events: { event: string; data: string }[]; next(event: string): Promise<string>; abort(): void }> {
  return new Promise((done, fail) => {
    const events: { event: string; data: string }[] = [];
    const waiters: { event: string; resolve: (data: string) => void }[] = [];
    const req = request({ host: '127.0.0.1', port, method: 'POST', path: '/api/net/open', headers: { host: `127.0.0.1:${port}`, ...ORIGIN } }, (res) => {
      let buffer = '';
      res.on('data', (c: Buffer) => {
        buffer += c.toString();
        let end: number;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (event === undefined || data === undefined) continue;
          events.push({ event, data });
          const i = waiters.findIndex((w) => w.event === event);
          if (i >= 0) waiters.splice(i, 1)[0].resolve(data);
        }
      });
      done({
        events,
        next: (event) => {
          const seen = events.find((e) => e.event === event);
          return seen !== undefined ? Promise.resolve(seen.data) : new Promise((resolve) => waiters.push({ event, resolve }));
        },
        abort: () => req.destroy(),
      });
    });
    req.on('error', fail);
    req.end(JSON.stringify(body));
  });
}

describe('the bridge network list (BT101)', () => {
  it('has the simulator\'s rules (core\'s parseAllowList)', () => {
    for (const text of ['api.example.com:443, 1.2.3.4:80', 'API.Example.COM.:443\n# x\n', 'a:0, b:70000, *.x:1, c d:2, https://e:3, f', Array.from({ length: 40 }, (_, i) => `h${i}:1`).join(',')]) {
      expect(parseNetworkList(text)).toEqual(parseAllowList(text));
    }
  });
});

describe('the bridge network proxy (BT101)', () => {
  let echo: Server;
  let echoPort = 0;
  let bridge: Bridge;
  let port = 0;
  let closedBridge: Bridge;
  let closedPort = 0;
  beforeAll(async () => {
    echo = createServer((socket) => socket.on('data', (c: Buffer) => socket.write(c.toString().toUpperCase())));
    await new Promise<void>((r) => echo.listen(0, '127.0.0.1', () => r()));
    echoPort = (echo.address() as { port: number }).port;
    bridge = createBridge({ cli: undefined, network: [{ host: '127.0.0.1', port: echoPort }] });
    port = await bridge.listen(0);
    closedBridge = createBridge({ cli: undefined });
    closedPort = await closedBridge.listen(0);
  });
  afterAll(async () => {
    await bridge.close();
    await closedBridge.close();
    echo.close();
  });

  it('streams a connection: open, bytes both ways, close', async () => {
    const c = await open(port, { host: '127.0.0.1', port: echoPort });
    const { id } = JSON.parse(await c.next('open')) as { id: string };
    expect(await post(port, '/api/net/send', { id, data: Buffer.from('hello').toString('base64') })).toMatchObject({ status: 200 });
    expect(Buffer.from(await c.next('data'), 'base64').toString()).toBe('HELLO');
    expect(await post(port, '/api/net/close', { id })).toMatchObject({ status: 200 });
    expect(JSON.parse(await c.next('close'))).toEqual({ error: null });
    expect(await post(port, '/api/net/send', { id, data: '' })).toMatchObject({ status: 404 });
  });

  it('closing the stream closes the socket', async () => {
    const c = await open(port, { host: '127.0.0.1', port: echoPort });
    const { id } = JSON.parse(await c.next('open')) as { id: string };
    c.abort();
    let status = 0;
    for (let i = 0; i < 100 && status !== 404; i++) {
      await new Promise((r) => setTimeout(r, 10));
      status = (await post(port, '/api/net/send', { id, data: '' })).status;
    }
    expect(status).toBe(404);
  });

  it('refuses without --network, a host not on it, a request without the app\'s origin, a bad body', async () => {
    expect(await post(closedPort, '/api/net/open', { host: '127.0.0.1', port: echoPort })).toEqual({ status: 403, body: JSON.stringify({ error: 'the bridge was started without --network: nothing leaves this machine' }) });
    expect(await post(port, '/api/net/open', { host: '127.0.0.1', port: echoPort + 1 })).toMatchObject({ status: 403, body: expect.stringContaining("isn't on the bridge's --network list") });
    expect(await post(port, '/api/net/open', { host: 'localhost', port: echoPort })).toMatchObject({ status: 403 });
    expect(await post(port, '/api/net/open', { host: '127.0.0.1', port: echoPort }, { 'content-type': 'application/json' })).toMatchObject({ status: 403, body: expect.stringContaining('origin required') });
    expect(await post(port, '/api/net/open', { host: '127.0.0.1', port: echoPort }, { ...ORIGIN, origin: 'https://evil.example' })).toMatchObject({ status: 403, body: expect.stringContaining('origin not allowed') });
    expect(await post(port, '/api/net/open', { host: '127.0.0.1', port: String(echoPort) })).toMatchObject({ status: 400 });
    expect(await post(port, '/api/net/send', { id: 'nope', data: 'aGk=' })).toMatchObject({ status: 404 });
    expect(await post(port, '/api/net/what', {})).toMatchObject({ status: 404 });
  });
});
