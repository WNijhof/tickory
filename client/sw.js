// Service worker: bewaart de bestanden van de app, zodat die ook zonder verbinding opent.
// De gegevens zelf staan in IndexedDB; verzoeken naar /api/ gaan hier nooit doorheen.
//
// Werkwijze: antwoord meteen uit de bewaarde kopie en haal op de achtergrond de nieuwste versie op.
// Een wijziging in de app is daardoor na de eerstvolgende keer openen actief.
// Voeg je een bestand toe aan de app, zet het dan in SHELL (een test controleert dat de lijst compleet is).

const CACHE = 'tickory-v4';
const SHELL = [
  '/',
  '/app.css',
  '/dnd.css',
  '/manifest.webmanifest',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/ui/app.js',
  '/ui/accountDialogs.js',
  '/ui/comments.js',
  '/ui/dom.js',
  '/ui/dragdrop.js',
  '/ui/icons.js',
  '/ui/miscDialogs.js',
  '/ui/projectDialog.js',
  '/ui/quickAdd.js',
  '/ui/reminderUi.js',
  '/ui/render.js',
  '/ui/shareDialog.js',
  '/ui/taskDialog.js',
  '/core/actions.js',
  '/core/android.js',
  '/core/auth.js',
  '/core/backend.js',
  '/core/colors.js',
  '/core/commentText.js',
  '/core/dateHint.js',
  '/core/dateNl.js',
  '/core/dnd.js',
  '/core/events.js',
  '/core/format.js',
  '/core/i18n.js',
  '/core/idb.js',
  '/core/messages.js',
  '/core/push.js',
  '/core/quickDates.js',
  '/core/reminderText.js',
  '/core/quickadd.js',
  '/core/reducer.js',
  '/core/rowModel.js',
  '/core/selectors.js',
  '/core/shortcuts.js',
  '/core/store.js',
  '/core/syncClient.js',
  '/core/timeAgo.js',
  '/i18n/en.js',
  '/i18n/nl.js',
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

// ---------- meldingen (Web Push) ----------
// De server stuurt een versleuteld bericht; hier wordt het een melding. De paar woorden die daarbij horen staan hier zelf
// (de service worker kan de woordenlijsten van de app niet laden); het bericht zegt in welke taal dit apparaat werkt.

const PUSH_TEXT = {
  nl: { reminder: 'Herinnering', complete: 'Voltooien', snooze: 'Over 10 minuten', test: 'Meldingen werken', testBody: 'Zo komt een herinnering van Tickory binnen.' },
  en: { reminder: 'Reminder', complete: 'Complete', snooze: 'In 10 minutes', test: 'Notifications work', testBody: 'This is how a Tickory reminder arrives.' },
};

/** Maakt van een bericht van de server de titel en opties van een melding. Onbekende of kapotte berichten: een neutrale melding. */
function notificationFor(data) {
  const text = PUSH_TEXT[data && data.lang] || PUSH_TEXT.nl;
  const base = { icon: '/icon-192.png', badge: '/icon-192.png', lang: data && data.lang === 'en' ? 'en' : 'nl' };
  if (!data || data.type !== 'reminder' || typeof data.title !== 'string') {
    return { title: text.test, options: { ...base, body: text.testBody, tag: 'tickory-test' } };
  }
  const time = typeof data.time === 'string' && data.time.length >= 16 ? data.time.slice(11, 16) : '';
  return {
    title: data.title,
    options: {
      ...base,
      body: time ? `${text.reminder} · ${time}` : text.reminder,
      tag: `tickory-${data.id}-${data.moment}`, // dezelfde herinnering twee keer ontvangen geeft één melding
      requireInteraction: true,
      data: { taskId: data.task_id, complete: data.complete, snooze: data.snooze, message: data },
      actions: [{ action: 'complete', title: text.complete }, { action: 'snooze', title: text.snooze }],
    },
  };
}

self.addEventListener('push', (event) => {
  let data = null;
  try {
    data = event.data ? event.data.json() : null;
  } catch { /* geen leesbaar bericht: toon toch iets, een pushbericht zonder melding mag niet van de browser */ }
  const n = notificationFor(data);
  event.waitUntil(self.registration.showNotification(n.title, n.options));
});

self.addEventListener('notificationclick', (event) => {
  const d = event.notification.data || {};
  event.notification.close();
  if (event.action === 'complete' || event.action === 'snooze') {
    // De knop: zonder de app te openen. Lukt het niet (geen verbinding), dan komt de melding terug zodat je het opnieuw kunt proberen.
    event.waitUntil(
      fetch('/api/v1/push/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: d[event.action] }) })
        .then((res) => { if (!res.ok && res.status !== 400) throw new Error('mislukt'); })
        .catch(() => {
          const n = notificationFor(d.message);
          return self.registration.showNotification(n.title, n.options);
        }),
    );
    return;
  }
  // Tikken op de melding zelf: de app naar voren halen (of openen) bij de taak.
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = windows.find((c) => new URL(c.url).origin === self.location.origin);
    if (open) {
      await open.focus();
      if (d.taskId) open.postMessage({ type: 'open-task', id: d.taskId });
      return;
    }
    await self.clients.openWindow(d.taskId ? `/#task=${d.taskId}` : '/');
  })());
});
