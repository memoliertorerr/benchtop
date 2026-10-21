import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { type BundleEntry, precacheScript, shellFiles, shellVersion } from './shell.ts';

const chunk = (fileName: string, extra: Partial<BundleEntry> = {}): BundleEntry => ({ type: 'chunk', fileName, ...extra });
const asset = (fileName: string): BundleEntry => ({ type: 'asset', fileName });

const BUNDLE: Record<string, BundleEntry> = {
  'assets/index-A.js': chunk('assets/index-A.js', { isEntry: true, imports: ['assets/shared-B.js'], viteMetadata: { importedCss: new Set(['assets/index-C.css']) } }),
  'assets/shared-B.js': chunk('assets/shared-B.js', { imports: ['assets/index-A.js'] }),
  'assets/led-element-D.js': chunk('assets/led-element-D.js'),
  'assets/blink-E.js': chunk('assets/blink-E.js'),
  'assets/worker-F.js': asset('assets/worker-F.js'),
  'assets/index-C.css': asset('assets/index-C.css'),
  'assets/blink-G.bin': asset('assets/blink-G.bin'),
};

describe('the offline app shell', () => {
  it('holds the page, entry chunks with their static imports and CSS, and the worker — not lazy chunks', () => {
    expect(shellFiles(BUNDLE)).toEqual([
      '/assets/index-A.js',
      '/assets/index-C.css',
      '/assets/shared-B.js',
      '/assets/worker-F.js',
      '/favicon.svg',
      '/index.html',
      '/manifest.webmanifest',
    ]);
  });

  it('versions the list by its file names', () => {
    const files = shellFiles(BUNDLE);
    expect(shellVersion(files)).toMatch(/^[0-9a-f]{16}$/);
    expect(shellVersion(files)).toBe(shellVersion([...files]));
    expect(shellVersion(files.map((f) => f.replace('index-A', 'index-Z')))).not.toBe(shellVersion(files));
  });
});

// ── The service worker itself (public/sw.js), run in a VM context with fake caches and network ──

interface FakeResponse {
  url: string;
  ok: boolean;
  body: string;
  clone(): FakeResponse;
}

function response(url: string, body: string, ok = true): FakeResponse {
  return { url, ok, body, clone: () => response(url, body, ok) };
}

function loadWorker(files: string[], online: { value: boolean }) {
  const stores = new Map<string, Map<string, FakeResponse>>();
  const listeners = new Map<string, (event: unknown) => void>();
  const fetched: string[] = [];
  const keyOf = (r: string | { url: string }) => new URL(typeof r === 'string' ? r : r.url, 'http://bench.test').pathname;
  const caches = {
    async open(name: string) {
      let store = stores.get(name);
      if (store === undefined) stores.set(name, (store = new Map()));
      const s = store;
      return {
        async addAll(urls: string[]) {
          for (const u of urls) s.set(keyOf(u), await network(u));
        },
        async match(r: string | { url: string }) {
          return s.get(keyOf(r));
        },
        async put(r: { url: string }, res: FakeResponse) {
          s.set(keyOf(r), res);
        },
      };
    },
    async keys() {
      return [...stores.keys()];
    },
    async delete(name: string) {
      return stores.delete(name);
    },
  };
  const network = async (r: string | { url: string }): Promise<FakeResponse> => {
    const path = keyOf(r);
    fetched.push(path);
    if (!online.value) throw new TypeError('Failed to fetch');
    return response(path, `network ${path}`);
  };
  const self = {
    location: { origin: 'http://bench.test' },
    addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
    BENCHTOP_SHELL: undefined as unknown,
  };
  const context = {
    self,
    caches,
    fetch: network,
    URL,
    Promise,
    Response: { error: () => response('', 'error', false) },
    importScripts: (path: string) => {
      expect(path).toBe('/sw-precache.js');
      runInNewContext(precacheScript(files), { self });
    },
  };
  runInNewContext(readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8'), context);

  const dispatch = async (type: string, init: object = {}): Promise<FakeResponse | undefined> => {
    let pending: Promise<unknown> = Promise.resolve(undefined);
    let responded: Promise<FakeResponse> | undefined;
    listeners.get(type)?.({
      ...init,
      waitUntil: (p: Promise<unknown>) => (pending = p),
      respondWith: (p: Promise<FakeResponse>) => (responded = p),
    });
    await pending;
    return responded === undefined ? undefined : await responded;
  };
  const request = (path: string, mode = 'cors', method = 'GET') => ({ url: `http://bench.test${path}`, mode, method });
  return { stores, fetched, dispatch, request };
}

describe('the service worker', () => {
  const files = ['/assets/index-A.js', '/assets/worker-F.js', '/favicon.svg', '/index.html', '/manifest.webmanifest'];

  it('precaches the shell on install and drops older builds on activate', async () => {
    const online = { value: true };
    const sw = loadWorker(files, online);
    sw.stores.set('benchtop-old', new Map());
    sw.stores.set('someone-else', new Map());
    await sw.dispatch('install');
    await sw.dispatch('activate');
    const names = [...sw.stores.keys()];
    expect(names).toEqual(['someone-else', `benchtop-${shellVersion(files)}`]);
    expect([...sw.stores.get(names[1]!)!.keys()].sort()).toEqual(files);
  });

  it('serves the cached page offline, and asks the network first online', async () => {
    const online = { value: true };
    const sw = loadWorker(files, online);
    await sw.dispatch('install');
    expect((await sw.dispatch('fetch', { request: sw.request('/', 'navigate') }))?.body).toBe('network /');
    online.value = false;
    expect((await sw.dispatch('fetch', { request: sw.request('/', 'navigate') }))?.body).toBe('network /index.html');
  });

  it('caches lazy /assets/ files on first use and serves them offline after', async () => {
    const online = { value: true };
    const sw = loadWorker(files, online);
    await sw.dispatch('install');
    expect((await sw.dispatch('fetch', { request: sw.request('/assets/led-element-D.js') }))?.body).toBe('network /assets/led-element-D.js');
    online.value = false;
    expect((await sw.dispatch('fetch', { request: sw.request('/assets/led-element-D.js') }))?.body).toBe('network /assets/led-element-D.js');
    expect((await sw.dispatch('fetch', { request: sw.request('/assets/index-A.js') }))?.ok).toBe(true);
    await expect(sw.dispatch('fetch', { request: sw.request('/assets/never-seen.js') })).rejects.toThrow('Failed to fetch');
  });

  it('leaves the compile bridge, other origins and non-GET requests to the network', async () => {
    const online = { value: true };
    const sw = loadWorker(files, online);
    await sw.dispatch('install');
    expect(await sw.dispatch('fetch', { request: sw.request('/api/health') })).toBeUndefined();
    expect(await sw.dispatch('fetch', { request: { url: 'https://example.com/x.js', mode: 'cors', method: 'GET' } })).toBeUndefined();
    expect(await sw.dispatch('fetch', { request: sw.request('/assets/index-A.js', 'cors', 'POST') })).toBeUndefined();
  });
});
