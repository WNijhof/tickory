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
  };
}

/** Het taak-id uit de URL (`#task=<id>`), zoals de Android-app dat meegeeft als je op een melding tikt. Anders null. */
export function taskIdFromHash(hash) {
  const m = /^#task=([A-Za-z0-9_-]{8,40})$/.exec(hash ?? '');
  return m ? m[1] : null;
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
    lines.push([r.id, r.type, r.minute_offset ?? '', r.due?.date ?? '', t ? `${t.due?.date ?? ''}|${t.checked ? 1 : 0}|${t.content}` : 'x'].join('\u0001'));
  }
  return lines.sort().join('\u0002');
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
