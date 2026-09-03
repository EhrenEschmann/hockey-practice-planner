// Offline support (rink mode). Strategy: NETWORK-FIRST for everything — every online load fetches
// the newest deploy and refreshes the cache; the cache is only a fallback when the network is gone
// or too slow. So frequent app updates are always picked up, and a coach who opened the app once
// with internet can still open it cold at the rink.
const CACHE = 'hpp-v1';
const PRECACHE = ['./', './index.html', './css/style.css',
  './js/main.js', './js/render.js', './js/rink.js', './js/sim.js', './js/geometry.js', './js/store.js', './js/cloud.js',
  './js/firebase-config.js', './firebase-config.js'];
const RUNTIME_HOSTS = ['https://www.gstatic.com/firebasejs/']; // the Firebase SDK modules are cached too
const TIMEOUT = 4000; // ms to wait for a flaky one-bar connection before falling back to the cache

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await Promise.all(PRECACHE.map(u => c.add(u).catch(() => {}))); // config files may not exist in every deploy
    self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const sameOrigin = req.url.startsWith(self.location.origin);
  if (!sameOrigin && !RUNTIME_HOSTS.some(h => req.url.startsWith(h))) return; // auth/Firestore traffic passes straight through
  e.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  const net = fetch(req).then(res => {
    if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
    return res;
  });
  net.catch(() => {}); // a late failure after we fell back to cache must not surface as unhandled
  try {
    return await Promise.race([net, new Promise((_, rej) => setTimeout(rej, TIMEOUT))]);
  } catch {
    const hit = await cache.match(req) || (req.mode === 'navigate' ? await cache.match('./index.html') : null);
    // No cache entry either: give a slow network its chance before declaring us offline.
    return hit || net.catch(() => new Response('Offline — open this page once with internet first.', { status: 503, headers: { 'content-type': 'text/plain' } }));
  }
}
