/* Service worker — offline support.
 *
 * Two caches with deliberately different policies:
 *   SHELL  — app code and the three JSON data files (~3.6 MB). Precached on
 *            install so a cold, offline first launch works.
 *   MEDIA  — guideline figures (~10 MB across 122 PNGs). Cached on demand.
 *            Precaching these would make the first load hostile on a phone
 *            tether for images most learners will never open.
 *
 * Bump CACHE_VERSION whenever the app or the guideline edition changes; the
 * activate handler drops every cache that does not match.
 */
const CACHE_VERSION = 'v3-2026.09.15';
const SHELL = `lfn-shell-${CACHE_VERSION}`;
const MEDIA = `lfn-media-${CACHE_VERSION}`;

const SHELL_ASSETS = [
  './',
  'index.html',
  'manifest.webmanifest',
  // Icons are precached so an installed home-screen copy keeps its icon and
  // can be reinstalled offline.
  'apple-touch-icon.png',
  'apple-touch-icon-152.png',
  'apple-touch-icon-167.png',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png',
  'css/tokens.css',
  'css/app.css',
  'css/quiz.css',
  'css/analytics.css',
  'js/main.js',
  'js/router.js',
  'js/store.js',
  'js/data.js',
  'js/ui.js',
  'js/srs.js',
  'js/quiz.js',
  'js/analytics.js',
  'js/search.js',
  'data/content.json',
  'data/questions.json',
  'data/modules.json',
  'data/search.json',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // addAll fails the whole install if any single request 404s; add
    // individually so one missing asset cannot leave the app with no cache.
    await Promise.all(SHELL_ASSETS.map(async (url) => {
      try { await cache.add(new Request(url, { cache: 'reload' })); }
      catch (err) { console.warn('[sw] skipped', url, err); }
    }));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((k) => k.startsWith('lfn-') && k !== SHELL && k !== MEDIA)
      .map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // Figures: cache-first, then fill the media cache.
  if (/\/data\/images\//.test(url.pathname)) {
    e.respondWith((async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      try {
        const res = await fetch(req);
        if (res.ok) (await caches.open(MEDIA)).put(req, res.clone());
        return res;
      } catch {
        return new Response('', { status: 504, statusText: 'offline' });
      }
    })());
    return;
  }

  // Everything else: stale-while-revalidate, so an update lands on next load
  // without ever blocking a session on the network.
  e.respondWith((async () => {
    const cached = await caches.match(req);
    const network = fetch(req).then(async (res) => {
      if (res && res.ok) (await caches.open(SHELL)).put(req, res.clone());
      return res;
    }).catch(() => null);

    if (cached) { network; return cached; }
    const res = await network;
    if (res) return res;
    // Navigation requests fall back to the cached shell so deep links work
    // offline (hash routing means index.html can serve every route).
    if (req.mode === 'navigate') {
      const shell = await caches.match('index.html');
      if (shell) return shell;
    }
    return new Response('Offline and not cached.', { status: 504 });
  })());
});
