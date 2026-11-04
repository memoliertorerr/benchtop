/**
 * The app's real network (BT101), in the simulation worker: an `Uplink` through the compile
 * bridge's network proxy (apps/bridge network.ts). `POST /api/net/open` streams one connection's
 * events (`open` {id}, `data` base64, `close` {error}); sends, half closes and closes are POSTs in
 * order (one at a time, so the bytes stay in order). The bridge opens only the hosts it was
 * started with (`--network`); the project's access point already narrowed them to its own list.
 * Events land between simulation slices, at the bench's time then.
 */

import type { Uplink, UplinkEvents, UplinkSocket } from '@benchtop/core';
import { base64Decode, base64Encode } from '@benchtop/parts';
import { SseParser } from './bridge-sse.ts';

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** What a failed open says when the bridge didn't answer at all. */
export const NO_BRIDGE = "the compile bridge isn't running with --network (npm run bridge -- --network host:port,…)";

export class BridgeUplink implements Uplink {
  private readonly fetch: Fetch;

  constructor(fetchFn: Fetch = (input, init) => fetch(input, init)) {
    this.fetch = fetchFn;
  }

  connect(host: string, port: number, events: UplinkEvents): UplinkSocket {
    const abort = new AbortController();
    const headers = { 'Content-Type': 'application/json' };
    let id: string | null = null;
    let closed = false;
    /** Sends before the id came, in order. */
    const early: (() => void)[] = [];
    let chain: Promise<unknown> = Promise.resolve();
    const post = (action: 'send' | 'end' | 'close', body: object): void => {
      const run = (): void => {
        chain = chain.then(() => this.fetch(`/api/net/${action}`, { method: 'POST', headers, body: JSON.stringify({ id, ...body }) }).catch(() => undefined));
      };
      if (id === null) early.push(run);
      else run();
    };
    const finish = (error: string | null): void => {
      if (closed) return;
      closed = true;
      events.closed(error);
    };
    void (async () => {
      let response: Response;
      try {
        response = await this.fetch('/api/net/open', { method: 'POST', headers, body: JSON.stringify({ host, port }), signal: abort.signal });
      } catch {
        finish(NO_BRIDGE);
        return;
      }
      if (!response.ok || response.body === null) {
        // The bridge's own refusals say why; anything else (an older bridge, a proxy with none behind it) means no bridge.
        const own = response.status === 400 || response.status === 403 || response.status === 429;
        const reason = own ? await response.json().then((j: { error?: unknown }) => (typeof j.error === 'string' ? j.error : null), () => null) : null;
        finish(reason ?? NO_BRIDGE);
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseParser();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const event of parser.push(decoder.decode(value, { stream: true }))) {
            if (closed) return;
            if (event.event === 'open') {
              id = (JSON.parse(event.data) as { id: string }).id;
              for (const run of early.splice(0)) run();
              events.opened();
            } else if (event.event === 'data') {
              const bytes = base64Decode(event.data);
              if (bytes !== null) events.data(bytes);
            } else if (event.event === 'close') {
              finish((JSON.parse(event.data) as { error: string | null }).error);
              return;
            }
          }
        }
        finish(null);
      } catch {
        finish(closed ? null : 'the bridge closed the connection');
      }
    })();
    return {
      send: (bytes) => {
        if (!closed) post('send', { data: base64Encode(bytes) });
      },
      end: () => {
        if (!closed) post('end', {});
      },
      close: () => {
        if (closed) return;
        closed = true;
        if (id !== null) post('close', {});
        abort.abort();
      },
    };
  }
}
