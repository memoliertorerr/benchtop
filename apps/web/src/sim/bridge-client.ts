/**
 * The app's side of the compile bridge (apps/bridge): health check, one-shot compile, and the
 * watch stream as Server-Sent Events read over fetch (EventSource can't report why it failed).
 * The watch reconnects with backoff (1 s → 30 s) until closed, and treats a stream silent for
 * 15 s (no keep-alive) as dropped. `bridgeState` says whether the bridge answered last time. Runs in Node too (tests inject fetch and timers).
 *
 * The response shapes mirror apps/bridge/src/server.ts (the two apps share no code).
 */

import { signal } from '@preact/signals';
import { Backoff, SseParser } from './bridge-sse.ts';

export interface BridgeDiagnostic {
  file: string;
  line: number;
  column: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
}

export interface BridgeCompileResult {
  ok: boolean;
  durationMs: number;
  diagnostics: BridgeDiagnostic[];
  stdout: string;
  stderr: string;
  /** hex is text; elf, bin, partitions and uf2 are base64. */
  artifacts: { hex?: string; elf?: string; bin?: string; partitions?: string; uf2?: string };
  error?: string;
}

export interface BridgeHealth {
  cli: string | null;
  cores: { id: string; version: string }[];
}

/** unknown: not asked yet · up · down: no answer · no-cli: the bridge runs but found no arduino-cli. */
export type BridgeState = 'unknown' | 'up' | 'down' | 'no-cli';
export const bridgeState = signal<BridgeState>('unknown');

type Timer = ReturnType<typeof setTimeout>;

export interface BridgeDeps {
  fetch(input: string, init?: RequestInit): Promise<Response>;
  setTimer(fn: () => void, ms: number): Timer;
  clearTimer(timer: Timer): void;
}

const defaultDeps: BridgeDeps = {
  fetch: (input, init) => fetch(input, init),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (timer) => clearTimeout(timer),
};

/**
 * The bridge sends a keep-alive comment every 5 s; a watch stream silent this long is dead
 * (a proxy or network that never closed it) and is reopened.
 */
export const WATCH_STALE_MS = 15_000;

/** The bridge refused a request (bad sketch path, FQBN): retrying won't help. */
export class BridgeRefusal extends Error {}

async function errorOf(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === 'string') return body.error;
  } catch {
    // not JSON (a proxy's error page)
  }
  return `HTTP ${response.status}`;
}

/** Asks the bridge for its arduino-cli version; null when it doesn't answer. */
export async function checkBridge(deps: BridgeDeps = defaultDeps): Promise<BridgeHealth | null> {
  try {
    const response = await deps.fetch('/api/health');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const health = (await response.json()) as BridgeHealth;
    bridgeState.value = health.cli === null ? 'no-cli' : 'up';
    return health;
  } catch {
    bridgeState.value = 'down';
    return null;
  }
}

/** One compile. Throws BridgeRefusal for a refused request, Error when the bridge is down. */
export function compileSketch(sketch: string, fqbn: string, deps: BridgeDeps = defaultDeps): Promise<BridgeCompileResult> {
  return post('/api/compile', { sketch, fqbn }, deps);
}

/** An inline sketch's compile (BT42): its files, main and FQBN. Throws as compileSketch does. */
export function compileInlineSketch(sketch: { fqbn: string; files: Record<string, string>; main: string }, deps: BridgeDeps = defaultDeps): Promise<BridgeCompileResult> {
  return post('/api/compile-inline', { fqbn: sketch.fqbn, files: sketch.files, main: sketch.main }, deps);
}

async function post(path: string, body: unknown, deps: BridgeDeps): Promise<BridgeCompileResult> {
  let response: Response;
  try {
    response = await deps.fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    bridgeState.value = 'down';
    throw new Error('compile bridge not reachable');
  }
  if (response.status === 400 || response.status === 403 || response.status === 413) {
    bridgeState.value = 'up';
    throw new BridgeRefusal(await errorOf(response));
  }
  if (!response.ok) {
    bridgeState.value = 'down'; // the dev server's proxy answers 5xx when the bridge is gone
    throw new Error(await errorOf(response));
  }
  bridgeState.value = 'up';
  return (await response.json()) as BridgeCompileResult;
}

export interface WatchHandlers {
  /** A compile started (on connect, or after a saved change). */
  onStart(): void;
  onResult(result: BridgeCompileResult): void;
  /** The bridge refused the watch (bad path, FQBN); it is not retried. */
  onRefused(message: string): void;
  /** The stream opened (true) or dropped (false; a reconnect is scheduled). */
  onConnection(connected: boolean): void;
}

export interface Watch {
  close(): void;
}

/** Watches a sketch folder through the bridge until `close()`. */
export function watchSketch(sketch: string, fqbn: string, handlers: WatchHandlers, deps: BridgeDeps = defaultDeps): Watch {
  const url = `/api/watch?sketch=${encodeURIComponent(sketch)}&fqbn=${encodeURIComponent(fqbn)}`;
  const backoff = new Backoff();
  const parser = new SseParser();
  let closed = false;
  let timer: Timer | null = null;
  let abort: AbortController | null = null;

  const retry = (): void => {
    if (closed) return;
    bridgeState.value = 'down';
    timer = deps.setTimer(() => {
      timer = null;
      void connect();
    }, backoff.next());
  };

  const dispatch = (event: string, data: string): void => {
    if (event === 'compile-start') handlers.onStart();
    else if (event === 'compile-result') {
      let result: BridgeCompileResult;
      try {
        result = JSON.parse(data) as BridgeCompileResult;
      } catch {
        return;
      }
      handlers.onResult(result);
    }
  };

  const connect = async (): Promise<void> => {
    abort = new AbortController();
    parser.reset();
    let response: Response;
    try {
      response = await deps.fetch(url, { signal: abort.signal, headers: { Accept: 'text/event-stream' } });
    } catch {
      retry();
      return;
    }
    if (closed) return;
    if (response.status === 400 || response.status === 403) {
      bridgeState.value = 'up';
      handlers.onRefused(await errorOf(response));
      return;
    }
    if (!response.ok || response.body === null) {
      retry();
      return;
    }
    backoff.reset();
    bridgeState.value = 'up';
    handlers.onConnection(true);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const connection = abort;
    const stale = (): void => {
      connection.abort();
      reader.cancel().catch(() => undefined);
    };
    let watchdog = setTimeout(stale, WATCH_STALE_MS);
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done || closed) break;
        clearTimeout(watchdog);
        watchdog = setTimeout(stale, WATCH_STALE_MS);
        for (const event of parser.push(decoder.decode(value, { stream: true }))) dispatch(event.event, event.data);
      }
    } catch {
      // dropped, aborted, or silent for too long
    } finally {
      clearTimeout(watchdog);
    }
    if (closed) return;
    handlers.onConnection(false);
    retry();
  };

  void connect();
  return {
    close() {
      closed = true;
      if (timer !== null) deps.clearTimer(timer);
      abort?.abort();
    },
  };
}
