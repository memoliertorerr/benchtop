/**
 * The bridge's way out (BT101): started with `--network host:port[,host:port…]` (off without
 * it), the app's simulated WiFi reaches those real hosts through TCP connections the bridge
 * opens for it — nothing else, and nothing listens. `POST /api/net/open` {host, port} answers
 * with an event stream: `open` {id} once connected, `data` (base64) as bytes arrive, `close`
 * {error} at the end; `POST /api/net/send` {id, data}, `/api/net/end` {id} (no more from the
 * app) and `/api/net/close` {id} act on it, and the stream closing closes the socket. At most 16
 * connections, each closed after 60 s idle; the server checks the Host and Origin as for
 * compiling (only the app's own page).
 *
 * The list's rules are the simulator's (`parseAllowList` in @benchtop/core's net/uplink.ts —
 * repeated here: the bridge shares no code with the app; network.test.ts keeps them equal).
 */

import { connect, type Socket } from 'node:net';
import type { ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

export interface NetEntry {
  host: string;
  port: number;
}

export const MAX_NET_ENTRIES = 32;
export const MAX_NET_CONNECTIONS = 16;
const IDLE_MS = 60_000;
const HOST = /^([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*)\.?:(\d{1,5})$/;

/** `host:port` entries a line or a comma apart, `#` comments; a host is a DNS name or IPv4 address, the port required. */
export function parseNetworkList(text: string): { entries: NetEntry[]; errors: string[] } {
  const entries: NetEntry[] = [];
  const errors: string[] = [];
  for (const raw of text.split(/[\n,]/)) {
    const item = raw.replace(/#.*/, '').trim();
    if (item === '') continue;
    const m = HOST.exec(item);
    const port = m === null ? 0 : Number(m[2]);
    if (m === null || port < 1 || port > 65535 || m[1].length > 253) {
      errors.push(`"${item.length > 40 ? `${item.slice(0, 39)}…` : item}" isn't host:port`);
      continue;
    }
    if (entries.length >= MAX_NET_ENTRIES) {
      errors.push(`more than ${MAX_NET_ENTRIES} entries`);
      break;
    }
    const host = m[1].toLowerCase();
    if (!entries.some((e) => e.host === host && e.port === port)) entries.push({ host, port });
  }
  return { entries, errors };
}

export type Reply = { status: number; body: unknown };

/** The open connections and what may be opened. */
export class NetworkProxy {
  readonly allow: readonly NetEntry[];
  private readonly sockets = new Map<string, Socket>();
  private readonly connectTo: (host: string, port: number) => Socket;

  constructor(allow: readonly NetEntry[], connectTo: (host: string, port: number) => Socket = (host, port) => connect({ host, port })) {
    this.allow = allow;
    this.connectTo = connectTo;
  }

  get open(): number {
    return this.sockets.size;
  }

  /** Why `host`:`port` may not be opened now, or null. */
  refusal(host: unknown, port: unknown): Reply | null {
    if (this.allow.length === 0) return { status: 403, body: { error: 'the bridge was started without --network: nothing leaves this machine' } };
    if (typeof host !== 'string' || typeof port !== 'number' || !Number.isInteger(port)) return { status: 400, body: { error: 'body must be { "host": string, "port": integer }' } };
    const h = host.toLowerCase().replace(/\.$/, '');
    if (!this.allow.some((e) => e.host === h && e.port === port)) return { status: 403, body: { error: `${host}:${port} isn't on the bridge's --network list` } };
    if (this.sockets.size >= MAX_NET_CONNECTIONS) return { status: 429, body: { error: `at most ${MAX_NET_CONNECTIONS} connections at once` } };
    return null;
  }

  /** Opens `host`:`port` (already allowed) and streams it to `res` until either side closes. */
  stream(res: ServerResponse, host: string, port: number): void {
    const id = randomUUID();
    const socket = this.connectTo(host, port);
    this.sockets.set(id, socket);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(': benchtop bridge network\n\n');
    const event = (name: string, data: string): void => {
      if (!res.writableEnded) res.write(`event: ${name}\ndata: ${data}\n\n`);
    };
    let error: string | null = null;
    socket.setNoDelay(true);
    socket.setTimeout(IDLE_MS, () => socket.destroy(new Error('idle for 60 s')));
    socket.on('connect', () => event('open', JSON.stringify({ id })));
    socket.on('data', (chunk: Buffer) => event('data', chunk.toString('base64')));
    socket.on('error', (e) => (error = e.message));
    socket.on('close', () => {
      this.sockets.delete(id);
      event('close', JSON.stringify({ error }));
      res.end();
    });
    // The app dropped the stream (its fetch aborted, the page went): the socket goes too.
    res.on('close', () => {
      if (this.sockets.get(id) === socket) socket.destroy();
    });
  }

  /** send / end / close on an open connection. */
  act(action: 'send' | 'end' | 'close', body: { id?: unknown; data?: unknown }): Reply {
    const socket = typeof body.id === 'string' ? this.sockets.get(body.id) : undefined;
    if (socket === undefined) return { status: 404, body: { error: 'no such connection' } };
    if (action === 'send') {
      if (typeof body.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.data)) return { status: 400, body: { error: 'data must be base64' } };
      socket.write(Buffer.from(body.data, 'base64'));
    } else if (action === 'end') socket.end();
    else socket.destroy();
    return { status: 200, body: { ok: true } };
  }

  closeAll(): void {
    for (const socket of this.sockets.values()) socket.destroy();
    this.sockets.clear();
  }
}
