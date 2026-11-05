// Caches static files only (js/css/json/images + the pinned supabase-js file). HTML and API calls are never cached:
// Cloudflare Pages redirects /x.html -> /x, and a cached redirect breaks page loads.
// Own files: network-first (a deploy is picked up immediately; cache is the offline/slow-network fallback).
// Pinned CDN file: cache-first (its URL never changes). Bump V when the file list changes.
const V = 'ds-v2';
const FILES = ['styles.css', 'lib.js', 'app.js', 'book.js', 'config.js', 'manifest.json', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => Promise.allSettled(FILES.map(f => c.add(f)))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  const cdn = u.hostname === 'cdn.jsdelivr.net';
  const own = u.origin === location.origin && /\.(js|css|json|png|svg)$/.test(u.pathname);
  if (r.method !== 'GET' || !(cdn || own)) return;
  e.respondWith(caches.open(V).then(async c => {
    const hit = await c.match(r);
    if (cdn && hit) return hit;
    try {
      const res = await fetch(r);
      if (res.ok || res.type === 'opaque') c.put(r, res.clone());
      return res;
    } catch (err) {
      if (hit) return hit;
      throw err;
    }
  }));
});
