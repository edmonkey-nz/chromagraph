// Service worker for the output window (production builds only).
// Network first, cache fallback: while the server is up everything is fresh; if the
// server is down when the output (re)loads, the last good page, bundle and data files
// come from the cache so the output still boots and renders.
const CACHE = 'data-wrangler-output-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === '/ws' || url.pathname.startsWith('/api/')) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      try {
        const res = await fetch(req, { cache: 'no-cache' });
        if (res.ok) await cache.put(req, res.clone());
        return res;
      } catch (err) {
        const hit = await cache.match(req, { ignoreVary: true });
        if (hit) return hit;
        throw err;
      }
    })(),
  );
});

// The page reports what it loaded before this worker took control (page, bundle, data
// files) so a first-boot reload can still come from the cache.
self.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || msg.t !== 'precache' || !Array.isArray(msg.urls)) return;
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      for (const u of msg.urls) {
        try {
          const url = new URL(u, self.location.origin);
          if (url.origin !== self.location.origin || url.pathname === '/ws' || url.pathname.startsWith('/api/')) continue;
          const res = await fetch(url, { cache: 'no-cache' });
          if (res.ok) await cache.put(url, res);
        } catch {
          // best effort
        }
      }
    })(),
  );
});
