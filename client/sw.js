// Service worker: bewaart de bestanden van de app, zodat die ook zonder verbinding opent.
// De gegevens zelf staan in IndexedDB; verzoeken naar /api/ gaan hier nooit doorheen.
//
// Werkwijze: antwoord meteen uit de bewaarde kopie en haal op de achtergrond de nieuwste versie op.
// Een wijziging in de app is daardoor na de eerstvolgende keer openen actief.
// Voeg je een bestand toe aan de app, zet het dan in SHELL (een test controleert dat de lijst compleet is).

const CACHE = 'tickory-v50';
const SHELL = [
  '/',
  '/app.css',
  '/search.css',
  '/dnd.css',
  '/templates.css',
  '/attachments.css',
  '/bulk.css',
  '/notify.css',
  '/manifest.webmanifest',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/ui/app.js',
  '/ui/exportDialog.js',
  '/ui/accountDialogs.js',
  '/ui/attachments.js',
  '/ui/board.js',
  '/ui/bulkDialogs.js',
  '/ui/calendar.js',
  '/ui/comments.js',
  '/ui/completed.js',
  '/ui/dom.js',
  '/ui/filterDialog.js',
  '/ui/filterHelp.js',
  '/ui/find.js',
  '/ui/findViews.js',
  '/ui/dragdrop.js',
  '/ui/icons.js',
  '/ui/inbox.js',
  '/ui/inboxSettings.js',
  '/ui/mentionPicker.js',
  '/ui/labelDialog.js',
  '/ui/miscDialogs.js',
  '/ui/projectDialog.js',
  '/ui/quickAdd.js',
  '/ui/reminderUi.js',
  '/ui/placesUi.js',
  '/ui/render.js',
  '/ui/searchDialog.js',
  '/ui/selection.js',
  '/ui/shareDialog.js',
  '/ui/taskDialog.js',
  '/ui/templateUi.js',
  '/ui/viewPrefs.js',
  '/ui/viewSwitch.js',
  '/core/actions.js',
  '/core/android.js',
  '/core/attachments.js',
  '/core/attachmentsApi.js',
  '/core/auth.js',
  '/core/backend.js',
  '/core/bulk.js',
  '/core/calendar.js',
  '/core/colors.js',
  '/core/commentText.js',
  '/core/completed.js',
  '/core/dateHint.js',
  '/core/dateNl.js',
  '/core/dnd.js',
  '/core/events.js',
  '/core/filter.js',
  '/core/filterText.js',
  '/core/filterViews.js',
  '/core/fold.js',
  '/core/format.js',
  '/core/i18n.js',
  '/core/idb.js',
  '/core/imageResize.js',
  '/core/inverse.js',
  '/core/inbox.js',
  '/core/mentions.js',
  '/core/labelManage.js',
  '/core/messages.js',
  '/core/projectViews.js',
  '/core/push.js',
  '/core/quickDates.js',
  '/core/reminderText.js',
  '/core/places.js',
  '/core/quickadd.js',
  '/core/reducer.js',
  '/core/rowModel.js',
  '/core/search.js',
  '/core/duration.js',
  '/core/export.js',
  '/core/share.js',
  '/core/voice.js',
  '/core/searchKeys.js',
  '/core/selection.js',
  '/core/selectors.js',
  '/core/shortcuts.js',
  '/core/store.js',
  '/core/syncClient.js',
  '/core/templateFile.js',
  '/core/templates.js',
  '/core/starters/build.js',
  '/core/starters/en.js',
  '/core/starters/index.js',
  '/core/starters/nl.js',
  '/core/timeAgo.js',
  '/core/undo.js',
  '/i18n/en.js',
  '/i18n/nl.js',
  '/vendor/nlDatum.generated.js',
  '/shared/activity.js',
  '/shared/attachments.js',
  '/shared/notifications.js',
  '/shared/orderKey.js',
  '/shared/password.js',
  '/shared/recurrence.js',
  '/shared/roles.js',
  '/shared/reminders.js',
  '/shared/places.js',
  '/shared/schema.js',
  '/shared/template.js',
  '/shared/text.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

/**
 * Mag dit antwoord in de bewaarde kopie? Alleen een geslaagd antwoord van onszelf, en de app-pagina "/" alleen als het echte HTML
 * is (geen JSON of foutpagina van een tussenliggende dienst: die zou de app bij het volgende openen vervangen).
 */
function storable(key, response) {
  return response.ok && response.type === 'basic' && (key !== '/' || (response.headers.get('content-type') ?? '').startsWith('text/html'));
}

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
      if (storable(path, response)) await cache.put(path, response);
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

/**
 * Wat deze service worker bewaart en teruggeeft: alleen de eigen bestanden uit SHELL, en voor een navigatie alleen de app-pagina "/".
 * Al het andere (een ander pad, de API, een link naar bijvoorbeeld /app.css) gaat gewoon naar het netwerk. Een navigatie naar een
 * ander bestand mag nooit de bewaarde app-pagina overschrijven: dat liet de app, na één klik op zo'n link, met een stylesheet
 * als pagina openen (en zonder verbinding zo blijven).
 * @returns {string | null} de sleutel in de bewaarde kopie, of null als dit verzoek niet van ons is
 */
function cacheKey(request, url) {
  if (request.method !== 'GET' || url.origin !== self.location.origin) return null;
  if (request.mode === 'navigate') return url.pathname === '/' ? '/' : null;
  return url.pathname !== '/' && SHELL.includes(url.pathname) ? url.pathname : null;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const key = cacheKey(request, new URL(request.url));
  if (key === null) return;
  const navigation = request.mode === 'navigate';

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(key);
    // De app-pagina halen we zonder zoekdeel op, zodat wat er na het vraagteken staat nooit in de bewaarde kopie terechtkomt.
    const fresh = fetch(navigation ? '/' : request)
      .then((response) => {
        if (storable(key, response)) cache.put(key, response.clone());
        return response;
      });
    if (navigation) event.waitUntil(ensureShell()); // bij elke start controleren of de kopie nog compleet is
    if (!cached) return fresh;
    event.waitUntil(fresh.catch(() => { /* geen verbinding: de bewaarde kopie volstaat */ }));
    return cached;
  })());
});

// ---------- meldingen (Web Push) ----------
// De server stuurt een versleuteld bericht; hier wordt het een melding. De paar woorden die daarbij horen staan hier zelf
// (de service worker kan de woordenlijsten van de app niet laden); het bericht zegt in welke taal dit apparaat werkt.

const PUSH_TEXT = {
  nl: {
    reminder: 'Herinnering', complete: 'Voltooien', snooze: 'Over 10 minuten', test: 'Meldingen werken', testBody: 'Zo komt een herinnering van Tickory binnen.', open: 'Openen',
    assigned: '{actor} heeft je een taak toegewezen', comment: '{actor} reageerde op een taak', commentProject: '{actor} schreef een opmerking bij het project',
    mention: '{actor} noemde je in een opmerking', completed: '{actor} heeft je taak afgevinkt', shared: '{actor} heeft je toegevoegd aan een project',
    other: '{actor} deed iets in een gedeeld project', someone: 'Iemand',
  },
  en: {
    reminder: 'Reminder', complete: 'Complete', snooze: 'In 10 minutes', test: 'Notifications work', testBody: 'This is how a Tickory reminder arrives.', open: 'Open',
    assigned: '{actor} assigned you a task', comment: '{actor} commented on a task', commentProject: '{actor} commented on the project',
    mention: '{actor} mentioned you in a comment', completed: '{actor} completed your task', shared: '{actor} added you to a project',
    other: '{actor} did something in a shared project', someone: 'Someone',
  },
};
const ACTIVITY_KINDS = ['assigned', 'comment', 'mention', 'completed', 'shared'];
const SAFE_ID = /^[A-Za-z0-9_-]{8,40}$/;

/**
 * Een melding bij samenwerken (iemand wees je een taak toe, reageerde, noemde je, ...): de zin in de taal van dit apparaat,
 * de titel van de taak of het project, en het begin van de opmerking. Alles is tekst: een melding toont geen HTML.
 */
function activityNotification(data, text, base) {
  const kind = ACTIVITY_KINDS.includes(data.kind) ? data.kind : 'other';
  const key = kind === 'comment' && !data.task_id ? 'commentProject' : kind;
  const actor = typeof data.actor === 'string' && data.actor ? data.actor : text.someone;
  const title = typeof data.title === 'string' ? data.title : '';
  const lines = [title + (typeof data.project === 'string' && data.project ? ` · ${data.project}` : ''), typeof data.text === 'string' ? data.text : ''].filter(Boolean);
  const id = typeof data.id === 'string' && SAFE_ID.test(data.id) ? data.id : null;
  return {
    title: text[key].replace('{actor}', actor),
    options: {
      ...base,
      body: lines.join('\n'),
      tag: id ? `tickory-n-${id}` : 'tickory-n', // twee keer hetzelfde bericht geeft één melding
      data: { notificationId: id, taskId: typeof data.task_id === 'string' && SAFE_ID.test(data.task_id) ? data.task_id : null },
      actions: [{ action: 'open', title: text.open }],
    },
  };
}

/** Maakt van een bericht van de server de titel en opties van een melding. Onbekende of kapotte berichten: een neutrale melding. */
function notificationFor(data) {
  const text = PUSH_TEXT[data && data.lang] || PUSH_TEXT.nl;
  const base = { icon: '/icon-192.png', badge: '/icon-192.png', lang: data && data.lang === 'en' ? 'en' : 'nl' };
  if (data && data.type === 'activity') return activityNotification(data, text, base);
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
      // zonder token geen knop "Voltooien" (een lezer kan de taak niet afvinken; zie shared/roles.js)
      actions: [data.complete && { action: 'complete', title: text.complete }, { action: 'snooze', title: text.snooze }].filter(Boolean),
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
  // Tikken op de melding zelf (of op "Openen"): de app naar voren halen (of openen) bij de taak, of bij de melding bij samenwerken
  // (die zet de app dan op gelezen en opent wat erbij hoort, zie ui/inbox.js).
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = windows.find((c) => new URL(c.url).origin === self.location.origin);
    if (open) {
      await open.focus();
      if (d.notificationId) open.postMessage({ type: 'open-notification', id: d.notificationId });
      else if (d.taskId) open.postMessage({ type: 'open-task', id: d.taskId });
      return;
    }
    await self.clients.openWindow(d.notificationId ? `/#notification=${d.notificationId}` : d.taskId ? `/#task=${d.taskId}` : '/');
  })());
});
