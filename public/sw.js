const CACHE = 'tsr-v7';
const SHELL = ['style.css', 'app.js', 'sync.js', 'icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Network first with a short timeout so the screen is never blank for long; cache as fallback.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const network = fetch(e.request).then((res) => {
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    });
    const timeout = new Promise((resolve) => setTimeout(resolve, 1500));
    const first = await Promise.race([network.catch(() => null), timeout]);
    return first ?? (await cache.match(e.request, { ignoreSearch: true })) ?? network;
  })());
});
