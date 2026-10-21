import { describe, expect, it, vi } from 'vitest';
import { type BridgeCompileResult, type BridgeDeps, bridgeState, checkBridge, compileSketch, BridgeRefusal, watchSketch } from './bridge-client.ts';

type Timer = ReturnType<typeof setTimeout>;

/** Fetch and timers under the test's control: each fetch takes the next scripted answer. */
function fakeBridge(answers: (() => Promise<Response>)[]) {
  const delays: number[] = [];
  const timers: (() => void)[] = [];
  const requests: { url: string; init?: RequestInit }[] = [];
  const deps: BridgeDeps = {
    fetch: (url, init) => {
      requests.push(init === undefined ? { url } : { url, init });
      const answer = answers.shift();
      return answer === undefined ? new Promise(() => undefined) : answer();
    },
    setTimer: (fn, ms) => {
      delays.push(ms);
      timers.push(fn);
      return timers.length as unknown as Timer;
    },
    clearTimer: () => undefined,
  };
  /** Runs the scheduled reconnect, if any. */
  const fire = () => timers.shift()?.();
  return { deps, delays, requests, fire };
}

/** A response whose body yields `chunks` (strings), then ends. */
function stream(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const down = () => Promise.reject(new TypeError('fetch failed'));
const result: BridgeCompileResult = { ok: true, durationMs: 1200, diagnostics: [], stdout: '', stderr: '', artifacts: { hex: ':00000001FF\n' } };

describe('watch client', () => {
  it('delivers events split across chunks, multi-byte characters included', async () => {
    const json = JSON.stringify({ ...result, stdout: 'Sketch uses 924 bytes — 2%' });
    const text = `: hi\n\nevent: compile-start\ndata: {}\n\nevent: compile-result\ndata: ${json}\n\n`;
    const bytes = new TextEncoder().encode(text);
    const cut = bytes.indexOf(0xe2) + 1; // inside the em dash
    const fake = fakeBridge([
      () =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(bytes.slice(0, 17));
                controller.enqueue(bytes.slice(17, cut));
                controller.enqueue(bytes.slice(cut));
              },
            }),
          ),
        ),
    ]);
    const seen: string[] = [];
    const results: BridgeCompileResult[] = [];
    const watch = watchSketch('/Users/me/Blink', 'arduino:avr:uno', {
      onStart: () => seen.push('start'),
      onResult: (r) => results.push(r),
      onRefused: () => seen.push('refused'),
      onConnection: (c) => seen.push(c ? 'open' : 'closed'),
    }, fake.deps);
    await flush();
    await flush();
    expect(seen).toEqual(['open', 'start']);
    expect(results).toEqual([{ ...result, stdout: 'Sketch uses 924 bytes — 2%' }]);
    expect(fake.requests[0]!.url).toBe('/api/watch?sketch=%2FUsers%2Fme%2FBlink&fqbn=arduino%3Aavr%3Auno');
    watch.close();
  });

  it('reconnects with backoff while the bridge is down, and starts over after a good connection', async () => {
    const fake = fakeBridge([down, down, down, () => Promise.resolve(stream(['event: compile-start\ndata: {}\n\n'])), down]);
    const connections: boolean[] = [];
    let starts = 0;
    const watch = watchSketch('/s/blink', 'arduino:avr:uno', {
      onStart: () => starts++,
      onResult: () => undefined,
      onRefused: () => undefined,
      onConnection: (c) => connections.push(c),
    }, fake.deps);
    await flush();
    expect(bridgeState.value).toBe('down');
    for (let i = 0; i < 3; i++) {
      fake.fire();
      await flush();
      await flush();
    }
    // Three failures (1 s, 2 s, 4 s), then a stream that opened, delivered one event and ended:
    // the next delay starts again at 1 s.
    expect(fake.delays).toEqual([1000, 2000, 4000, 1000]);
    expect(connections).toEqual([true, false]);
    expect(starts).toBe(1);
    fake.fire();
    await flush();
    expect(fake.delays).toEqual([1000, 2000, 4000, 1000, 2000]);
    watch.close();
    fake.fire();
    await flush();
    expect(fake.requests).toHaveLength(6);
    expect(fake.delays).toHaveLength(5);
  });

  it('reopens a stream that stays silent past the keep-alive window', async () => {
    vi.useFakeTimers();
    try {
      const silent = () =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(': benchtop bridge\n\n'));
              },
            }),
          ),
        );
      const fake = fakeBridge([silent]);
      const connections: boolean[] = [];
      const watch = watchSketch('/s/blink', 'arduino:avr:uno', { onStart() {}, onResult() {}, onRefused() {}, onConnection: (c) => connections.push(c) }, fake.deps);
      await vi.advanceTimersByTimeAsync(14_000);
      expect(connections).toEqual([true]);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(connections).toEqual([true, false]);
      expect(fake.delays).toEqual([1000]);
      watch.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats a proxy error page as the bridge being down', async () => {
    const fake = fakeBridge([() => Promise.resolve(new Response('proxy error', { status: 500 }))]);
    const watch = watchSketch('/s/blink', 'arduino:avr:uno', { onStart() {}, onResult() {}, onRefused() {}, onConnection() {} }, fake.deps);
    await flush();
    await flush();
    expect(fake.delays).toEqual([1000]);
    expect(bridgeState.value).toBe('down');
    watch.close();
  });

  it('stops for good when the bridge refuses the sketch', async () => {
    const fake = fakeBridge([() => Promise.resolve(Response.json({ error: 'the folder has no blink.ino' }, { status: 400 }))]);
    const refused: string[] = [];
    watchSketch('/s/blink', 'arduino:avr:uno', { onStart() {}, onResult() {}, onRefused: (m) => refused.push(m), onConnection() {} }, fake.deps);
    await flush();
    await flush();
    expect(refused).toEqual(['the folder has no blink.ino']);
    expect(fake.delays).toEqual([]);
    expect(bridgeState.value).toBe('up');
  });
});

describe('health and one-shot compile', () => {
  it('reports up, no-cli and down', async () => {
    await checkBridge(fakeBridge([() => Promise.resolve(Response.json({ cli: '1.5.1', cores: [] }))]).deps);
    expect(bridgeState.value).toBe('up');
    await checkBridge(fakeBridge([() => Promise.resolve(Response.json({ cli: null, cores: [] }))]).deps);
    expect(bridgeState.value).toBe('no-cli');
    await checkBridge(fakeBridge([down]).deps);
    expect(bridgeState.value).toBe('down');
  });

  it('posts the sketch and FQBN, and separates refusals from an absent bridge', async () => {
    const fake = fakeBridge([
      () => Promise.resolve(Response.json(result)),
      () => Promise.resolve(Response.json({ error: 'fqbn must be one of arduino:avr:uno, esp32:esp32:esp32' }, { status: 400 })),
      down,
    ]);
    await expect(compileSketch('/s/blink', 'arduino:avr:uno', fake.deps)).resolves.toEqual(result);
    expect(fake.requests[0]).toMatchObject({ url: '/api/compile', init: { method: 'POST', body: '{"sketch":"/s/blink","fqbn":"arduino:avr:uno"}' } });
    await expect(compileSketch('/s/blink', 'arduino:avr:mega', fake.deps)).rejects.toBeInstanceOf(BridgeRefusal);
    await expect(compileSketch('/s/blink', 'arduino:avr:uno', fake.deps)).rejects.toThrow('not reachable');
    expect(bridgeState.value).toBe('down');
  });
});
