// Caches static assets only (js/css/json/images + the pinned supabase-js file).
// HTML and every API call go straight to the network: Cloudflare Pages redirects /x.html -> /x,
// and a cached redirect breaks page navigations. Bump V after a deploy that changes assets.
const V = 'ds-v1';
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
  if (r.method !== 'GET' || !(cdn || (u.origin === location.origin && /\.(js|css|json|png|svg)$/.test(u.pathname)))) return;
  // stale-while-revalidate
  e.respondWith(caches.open(V).then(async c => {
    const hit = await c.match(r);
    const net = fetch(r).then(res => { if (res.ok || res.type === 'opaque') c.put(r, res.clone()); return res; }).catch(() => hit);
    return hit || net;
  }));
});
