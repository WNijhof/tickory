// Service worker: bewaart de bestanden van de app, zodat die ook zonder verbinding opent.
// De gegevens zelf staan in IndexedDB; verzoeken naar /api/ gaan hier nooit doorheen.
//
// Werkwijze: antwoord meteen uit de bewaarde kopie en haal op de achtergrond de nieuwste versie op.
// Een wijziging in de app is daardoor na de eerstvolgende keer openen actief.
// Voeg je een bestand toe aan de app, zet het dan in SHELL (een test controleert dat de lijst compleet is).

const CACHE = 'tickory-v1';
const SHELL = [
  '/',
  '/app.css',
  '/manifest.webmanifest',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/ui/app.js',
  '/ui/accountDialogs.js',
  '/ui/dom.js',
  '/ui/render.js',
  '/ui/shareDialog.js',
  '/ui/taskDialog.js',
  '/core/actions.js',
  '/core/android.js',
  '/core/auth.js',
  '/core/backend.js',
  '/core/dateNl.js',
  '/core/events.js',
  '/core/format.js',
  '/core/idb.js',
  '/core/messages.js',
  '/core/quickadd.js',
  '/core/reducer.js',
  '/core/selectors.js',
  '/core/store.js',
  '/core/syncClient.js',
  '/vendor/nlDatum.generated.js',
  '/shared/orderKey.js',
  '/shared/recurrence.js',
  '/shared/reminders.js',
  '/shared/schema.js',
  '/shared/text.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

/**
 * Vult de bewaarde kopie aan als er bestanden ontbreken. Nodig omdat de kopie buiten de app om gewist kan worden:
 * door de browser bij ruimtegebrek, en door netwerkfilters als AdGuard, dat eigen code vóór elke service worker plakt
 * en daarmee alle caches wist bij de eerste start en na elke herstart van AdGuard.
 */
async function ensureShell() {
  const cache = await caches.open(CACHE);
  const have = new Set((await cache.keys()).map((request) => new URL(request.url).pathname));
  const missing = SHELL.filter((path) => !have.has(path));
  await Promise.all(missing.map(async (path) => {
    try {
      const response = await fetch(path, { cache: 'no-cache' });
      if (response.ok) await cache.put(path, response);
    } catch { /* geen verbinding: volgende keer opnieuw */ }
  }));
}

self.addEventListener('message', (event) => {
  if (event.data === 'ensure-shell') event.waitUntil(ensureShell());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/health' || url.pathname === '/sw.js') return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const key = request.mode === 'navigate' ? '/' : url.pathname; // elke navigatie opent dezelfde app
    const cached = await cache.match(key);
    const fresh = fetch(request)
      .then((response) => {
        if (response.ok && response.type === 'basic') cache.put(key, response.clone());
        return response;
      });
    if (request.mode === 'navigate') event.waitUntil(ensureShell()); // bij elke start controleren of de kopie nog compleet is
    if (!cached) return fresh;
    event.waitUntil(fresh.catch(() => { /* geen verbinding: de bewaarde kopie volstaat */ }));
    return cached;
  })());
});
