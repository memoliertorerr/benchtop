/*
 * Benchtop's service worker (BT40), hand-written: the app keeps working offline.
 *
 * - Install: precache the app shell that the build lists in /sw-precache.js (the page, its entry
 *   chunks and CSS, the simulation worker, icon and manifest) into a cache named by the build.
 * - Activate: drop the caches of older builds.
 * - Fetch: pages go to the network first and fall back to the cached page offline; files under
 *   /assets/ (content-hashed, so never stale) come from the cache, else from the network and
 *   are cached then — part views, example projects and firmware as they're first used. The
 *   compile bridge's /api/ is never cached: offline, the app shows its "bridge not running"
 *   banner as it does whenever the bridge is away.
 *
 * Cached responses keep their headers, so the cross-origin isolation headers the server sent
 * (COOP/COEP) still apply to a page served offline.
 */

importScripts('/sw-precache.js');

const SHELL = self.BENCHTOP_SHELL;
const CACHE = `benchtop-${SHELL.version}`;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL.files))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith('benchtop-') && key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() =>
        caches
          .open(CACHE)
          .then((cache) => cache.match('/index.html'))
          .then((page) => page ?? Response.error()),
      ),
    );
    return;
  }

  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(request);
      if (hit !== undefined) return hit;
      const response = await fetch(request);
      if (response.ok && url.pathname.startsWith('/assets/')) await cache.put(request, response.clone());
      return response;
    }),
  );
});
