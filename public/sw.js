// Notizzettel – Service Worker
// Hält die App-Oberfläche vor, damit sie auch ohne Verbindung startet
// (wichtig für Zettel ohne Anmeldung). Immer zuerst das Netz: Updates nach
// "git pull" kommen sofort an, der Zwischenspeicher dient nur als Rückfall.
// API-Anfragen werden nie zwischengespeichert.

const VERSION = 'v1';
const CACHE = `notizzettel-${VERSION}`;

const SHELL = [
  '/',
  '/css/app.css',
  '/img/linen.png',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/apple-touch-icon.png',
  '/manifest.webmanifest',
  '/js/app.js',
  '/js/admin.js',
  '/js/api.js',
  '/js/auth.js',
  '/js/editor.js',
  '/js/icons.js',
  '/js/idb.js',
  '/js/sanitize.js',
  '/js/store.js',
  '/js/sync.js',
  '/js/ui.js',
  '/js/util.js',
  '/js/views.js',
  '/js/webauthn.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('notizzettel-') && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  // Seitenaufrufe (auch Einladungs-/Reset-Links) liefern immer die App-Shell.
  // Gespeichert wird sie nur unter "/", damit keine Links mit Token im Cache landen.
  const isPage = req.mode === 'navigate';
  const key = isPage ? '/' : req;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') cache.put(key, res.clone());
      return res;
    } catch (err) {
      const cached = await cache.match(key, { ignoreSearch: true });
      if (cached) return cached;
      throw err;
    }
  })());
});
