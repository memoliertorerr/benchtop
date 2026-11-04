import { describe, expect, it } from 'vitest';
import { BridgeUplink, NO_BRIDGE } from './uplink.ts';

// BT101: the worker's uplink through the compile bridge, against a fake fetch: the event stream
// in arbitrary chunks, sends in order (queued until the bridge names the connection), the
// bridge's refusal and its absence.

const enc = new TextEncoder();
const b64 = (text: string): string => btoa(text);

/** A fetch whose /api/net/open streams what the test pushes, and that records the other POSTs. */
function fakeBridge() {
  const posts: { path: string; body: Record<string, unknown> }[] = [];
  let push: ((text: string) => void) | null = null;
  let end: (() => void) | null = null;
  const fetchFn = (input: string, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    if (input === '/api/net/open') {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          push = (text) => controller.enqueue(enc.encode(text));
          end = () => controller.close();
        },
      });
      return Promise.resolve(new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
    }
    posts.push({ path: input, body });
    return Promise.resolve(Response.json({ ok: true }));
  };
  return { fetchFn, posts, push: (text: string) => push?.(text), end: () => end?.() };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('BridgeUplink (BT101)', () => {
  it('streams a connection: sends wait for its id and go in order; data and close arrive as events', async () => {
    const bridge = fakeBridge();
    const uplink = new BridgeUplink(bridge.fetchFn);
    const log: string[] = [];
    const socket = uplink.connect('api.example.com', 443, { opened: () => log.push('open'), data: (b) => log.push(`data ${new TextDecoder().decode(b)}`), closed: (e) => log.push(`closed ${e}`) });
    socket.send(enc.encode('one'));
    socket.send(enc.encode('two'));
    await settle();
    expect(bridge.posts).toEqual([]);
    bridge.push('event: open\ndata: {"id":"c1"}\n\nevent: da'); // an event split across chunks
    bridge.push(`ta\ndata: ${b64('hi')}\n\n`);
    for (let i = 0; i < 5; i++) await settle();
    socket.send(enc.encode('three'));
    socket.end();
    for (let i = 0; i < 5; i++) await settle();
    expect(log).toEqual(['open', 'data hi']);
    expect(bridge.posts).toEqual([
      { path: '/api/net/send', body: { id: 'c1', data: b64('one') } },
      { path: '/api/net/send', body: { id: 'c1', data: b64('two') } },
      { path: '/api/net/send', body: { id: 'c1', data: b64('three') } },
      { path: '/api/net/end', body: { id: 'c1' } },
    ]);
    bridge.push('event: close\ndata: {"error":"ECONNRESET"}\n\n');
    for (let i = 0; i < 5; i++) await settle();
    expect(log.at(-1)).toBe('closed ECONNRESET');
  });

  it('close() tells the bridge and stops the events', async () => {
    const bridge = fakeBridge();
    const log: string[] = [];
    const socket = new BridgeUplink(bridge.fetchFn).connect('h', 1, { opened: () => log.push('open'), data: () => log.push('data'), closed: (e) => log.push(`closed ${e}`) });
    bridge.push('event: open\ndata: {"id":"c2"}\n\n');
    for (let i = 0; i < 5; i++) await settle();
    socket.close();
    bridge.push(`event: data\ndata: ${b64('late')}\n\n`);
    for (let i = 0; i < 5; i++) await settle();
    expect(log).toEqual(['open']);
    expect(bridge.posts).toEqual([{ path: '/api/net/close', body: { id: 'c2' } }]);
  });

  it('says why when the bridge refuses or isn\'t there', async () => {
    const reasons: (string | null)[] = [];
    const events = { opened: () => {}, data: () => {}, closed: (e: string | null) => reasons.push(e) };
    new BridgeUplink(() => Promise.resolve(Response.json({ error: "x:1 isn't on the bridge's --network list" }, { status: 403 }))).connect('x', 1, events);
    new BridgeUplink(() => Promise.reject(new TypeError('fetch failed'))).connect('x', 1, events);
    new BridgeUplink(() => Promise.resolve(Response.json({ error: 'no such endpoint' }, { status: 404 }))).connect('x', 1, events);
    for (let i = 0; i < 5; i++) await settle();
    expect(reasons.sort()).toEqual([NO_BRIDGE, NO_BRIDGE, "x:1 isn't on the bridge's --network list"].sort());
  });
});
