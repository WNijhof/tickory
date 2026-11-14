// De brug naar de Android-app. Draait de web-app in de Tickory-app voor Android, dan bestaat `window.TickoryAndroid`;
// daarlangs krijgt de app het sessietoken en hoort hij dat er iets aan taken of herinneringen is veranderd. De Android-app
// haalt die dan zelf op en plant de meldingen op het toestel in (zodat ze ook afgaan als de app dicht is).
// In een gewone browser bestaat de brug niet en doen alle aanroepen hier niets.

/**
 * @param {object | undefined} [host] het object dat de Android-app aanbiedt (standaard `window.TickoryAndroid`)
 */
export function androidBridge(host = globalThis.window?.TickoryAndroid) {
  // Een fout in de brug mag de web-app nooit breken; aanroepen als methode, zodat Android het juiste object krijgt.
  const call = (name, ...args) => {
    try {
      return typeof host?.[name] === 'function' ? host[name](...args) : undefined;
    } catch {
      return undefined;
    }
  };
  return {
    /** true als de web-app in de Android-app draait. */
    available: Boolean(host),
    /** Geeft het sessietoken door (een lege tekst bij afmelden: de app wist dan token en geplande meldingen). */
    setSession: (token) => call('setSession', token ?? ''),
    /** Meldt dat taken of herinneringen zijn gewijzigd. */
    remindersChanged: () => call('remindersChanged'),
    /** Meldt dat iets is veranderd dat in de widgets van de Android-app staat (taken, projecten, volgorde); de app ververst ze. */
    widgetsChanged: () => call('widgetsChanged'),
    /** @returns {{ notifications: boolean, exactAlarms: boolean, batteryOptimized: boolean, appVersion: string } | null} */
    status() {
      try {
        const raw = call('notificationStatus');
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : null;
        return parsed && typeof parsed === 'object' ? parsed : null;
      } catch {
        return null;
      }
    },
    requestNotificationPermission: () => call('requestNotificationPermission'),
    openNotificationSettings: () => call('openNotificationSettings'),
    openBatterySettings: () => call('openBatterySettings'),
    changeServer: () => call('changeServer'),
    /** Kan de app een bijlage zelf ophalen en aan een andere app geven? (Een oudere versie van de app kan dat niet.) */
    canOpenAttachments: () => typeof host?.openAttachment === 'function',
    /** Haalt een bijlage op en opent hem in een andere app (de app gebruikt zijn eigen sessietoken). */
    openAttachment: (id, name, mime) => call('openAttachment', id, name, mime),
    /** Haalt een bijlage op en laat de gebruiker kiezen waar hij wordt opgeslagen. */
    saveAttachment: (id, name, mime) => call('saveAttachment', id, name, mime),
    canSaveText: () => typeof host?.saveText === 'function',
    saveText: (name, mime, text) => call('saveText', name, mime, text),

    // ---- herinneringen op een locatie (zie locationStatusText in core/places.js voor de vorm van de status) ----
    /**
     * Wat de locatiecontrole van de app nu doet, of null als de app er geen kent of de tekst onleesbaar is.
     * @returns {import('./places.js').LocationStatus | null}
     */
    locationStatus() {
      try {
        const raw = call('locationStatus');
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : null;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).length > 0 ? parsed : null;
      } catch {
        return null;
      }
    },
    /** Zet de locatiecontrole aan en vraagt zo nodig de toestemmingen, met uitleg vooraf. Alleen na een tik van de gebruiker aanroepen. */
    requestLocationPermission: () => call('requestLocationPermission'),
    /** Zet de locatiecontrole aan of uit zonder iets te vragen (uit: alle controles stoppen). */
    setLocationEnabled: (on) => call('setLocationEnabled', Boolean(on)),
    /** Controleert nu één keer de positie (voor "Controleer nu"); de uitkomst staat daarna in locationStatus(). */
    checkLocationNow: () => call('checkLocationNow'),
    /**
     * Vraagt één keer de positie van het toestel (voor "gebruik mijn huidige positie"); het antwoord komt als voorval
     * `tickory-position` op window, met `detail` { lat, lon, accuracy } of { error: 'denied' | 'unavailable' | 'timeout' }.
     */
    requestCurrentPosition: () => call('requestCurrentPosition'),
    /** Opent de instellingen van de app in Android, waar de locatietoestemming te wijzigen is. */
    openLocationSettings: () => call('openLocationSettings'),
  };
}

/** Het taak-id uit de URL (`#task=<id>`), zoals de Android-app dat meegeeft als je op een melding tikt. Anders null. */
export function taskIdFromHash(hash) {
  const m = /^#task=([A-Za-z0-9_-]{8,40})$/.exec(hash ?? '');
  return m ? m[1] : null;
}

/**
 * Het venster "Taak toevoegen" openen vanuit een widget: `#add` (waar je nu bent), `#add=today` (met vandaag als datum) of
 * `#add=<project-id>` (in dat project). Geeft de context voor het venster terug (`{}` voor "waar je nu bent"), of null als
 * de URL hier niet over gaat. Een project dat de app niet kent, geeft `{}`.
 * @param {string | null | undefined} hash
 * @param {(id: string) => boolean} [knowsProject]
 */
export function addContextFromHash(hash, knowsProject = () => true) {
  const m = /^#add(?:=([A-Za-z0-9_-]{1,40}))?$/.exec(hash ?? '');
  if (!m) return null;
  if (!m[1]) return {};
  if (m[1] === 'today') return { due: 'today' };
  return knowsProject(m[1]) ? { projectId: m[1] } : {};
}

/**
 * Een vingerafdruk van alles wat in de widgets van de Android-app staat: van elke open taak de titel, datum, prioriteit,
 * plek en volgorde, en de namen van de projecten. Verandert hij, dan moet de Android-app de widgets verversen.
 */
export function widgetFingerprint(view) {
  const lines = [];
  for (const t of view.tasks.values()) {
    if (t.checked) continue;
    lines.push([t.id, t.content, t.due?.date ?? '', t.due?.recurrence ? 1 : 0, t.priority, t.project_id, t.section_id ?? '', t.parent_id ?? '', t.order_key].join(''));
  }
  const projects = [];
  for (const p of view.projects.values()) projects.push([p.id, p.name, p.parent_id ?? '', p.is_archived ? 1 : 0, p.order_key].join(''));
  const sections = [];
  for (const s of view.sections.values()) sections.push([s.id, s.name, s.order_key, s.is_archived ? 1 : 0].join(''));
  return [lines.sort().join(''), projects.sort().join(''), sections.sort().join('')].join('');
}

/**
 * Een vingerafdruk van alles wat bepaalt wanneer er een melding komt: de eigen herinneringen en, van de taken waar ze bij
 * horen, de datum, de titel en of ze af zijn. Verandert de vingerafdruk, dan moet de Android-app opnieuw inplannen.
 */
export function reminderFingerprint(view, userId) {
  const lines = [];
  for (const r of view.reminders.values()) {
    if (r.owner_id && userId && r.owner_id !== userId) continue;
    const t = view.tasks.get(r.task_id);
    lines.push([r.id, r.type, r.minute_offset ?? '', r.due?.date ?? '', t ? `${t.due?.date ?? ''}|${t.checked ? 1 : 0}|${t.content}` : 'x', r.place_id ?? '', r.trigger ?? ''].join('\u0001'));
  }
  // de plaatsen horen erbij: een andere positie of straal verandert wanneer een locatieherinnering afgaat
  for (const p of view.places.values()) {
    if (p.owner_id && userId && p.owner_id !== userId) continue;
    lines.push(['place', p.id, p.name, p.lat, p.lon, p.radius].join('\u0001'));
  }
  return lines.sort().join('\u0002');
}

/**
 * Houdt de Android-app op de hoogte van wat in de widgets staat: roept `bridge.widgetsChanged()` aan zodra de vingerafdruk
 * (zie widgetFingerprint) verandert, kort uitgesteld, zodat een reeks wijzigingen één melding geeft. Geeft een functie
 * terug om te stoppen.
 * @param {{ store: import('./store.js').Store, bridge: ReturnType<typeof androidBridge>, delayMs?: number,
 *           timers?: { setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout } }} options
 */
export function watchWidgets({ store, bridge, delayMs = 2000, timers = globalThis }) {
  if (!bridge.available) return () => {};
  let last = widgetFingerprint(store.view);
  let timer = null;
  const unsubscribe = store.subscribe(() => {
    const now = widgetFingerprint(store.view);
    if (now === last) return;
    last = now;
    if (timer !== null) timers.clearTimeout(timer);
    timer = timers.setTimeout(() => {
      timer = null;
      bridge.widgetsChanged();
    }, delayMs);
  });
  return () => {
    if (timer !== null) timers.clearTimeout(timer);
    unsubscribe();
  };
}

/**
 * Houdt de Android-app op de hoogte: roept `bridge.remindersChanged()` aan zodra de vingerafdruk verandert (kort
 * uitgesteld, zodat een reeks wijzigingen één melding geeft). Geeft een functie terug om te stoppen.
 * @param {{ store: import('./store.js').Store, bridge: ReturnType<typeof androidBridge>, delayMs?: number,
 *           timers?: { setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout } }} options
 */
export function watchReminders({ store, bridge, delayMs = 1500, timers = globalThis }) {
  if (!bridge.available) return () => {};
  let last = reminderFingerprint(store.view, store.userId);
  let timer = null;
  const unsubscribe = store.subscribe(() => {
    const now = reminderFingerprint(store.view, store.userId);
    if (now === last) return;
    last = now;
    if (timer !== null) timers.clearTimeout(timer);
    timer = timers.setTimeout(() => {
      timer = null;
      bridge.remindersChanged();
    }, delayMs);
  });
  return () => {
    if (timer !== null) timers.clearTimeout(timer);
    unsubscribe();
  };
}
