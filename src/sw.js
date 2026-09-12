/* global self, caches */
/**
 * The app shell, so the register boots with no network at all.
 *
 * `PRECACHE` and `BUILD_ID` are written in at build time by the plugin in vite.config.ts: the
 * worker's own bytes have to change on every release, because a browser installs a new worker only
 * when its script differs from the one it holds.
 *
 * Navigations go to the network first and fall back to the cached page, so a shop that is online
 * always sees the deployed app; hashed assets never change under their name, so they come from the
 * cache first. Nothing here calls skipWaiting: a new version waits until every tab of the old one
 * is closed, so a half-updated app never drains a queue written by the version before it.
 */
const BUILD_ID = '__BUILD_ID__';
const CACHE = `pos-shell-${BUILD_ID}`;
const PRECACHE = ['__PRECACHE_MANIFEST__'];
const PRECACHED = new Set(PRECACHE);
const SHELL = PRECACHE.find((path) => path.endsWith('/index.html'));

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)));
});

self.addEventListener('activate', (event) => {
  // The build before this one is no use now: its files are gone from the server.
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name))),
      ),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') {
    return;
  }
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
    return;
  }
  if (PRECACHED.has(url.pathname)) {
    event.respondWith(cacheFirst(request));
  }
});

async function networkFirst(request) {
  try {
    return await fetch(request);
  } catch (error) {
    const cached = SHELL ? await caches.match(SHELL) : undefined;
    if (cached) {
      return cached;
    }
    throw error;
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) {
    return cached;
  }
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(CACHE);
    await cache.put(request, response.clone());
  }
  return response;
}
