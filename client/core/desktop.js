// De brug naar de desktop-app voor Windows (eigen-tool/desktop, een Electron-schil zoals de desktop-app van Todoist). Draait de
// web-app daarin, dan bestaat `window.TickoryDesktop` (desktop/preload.cjs). Net als bij Android: het sessietoken (de desktop-app
// plant de herinneringen zelf, Electron kent geen web-push), een seintje als herinneringen veranderen, het aantal taken van vandaag
// voor de badge op de taakbalk, het thema (Weergave, ook te kiezen in de app zelf) en het sluiten van het losse venster Taak toevoegen.

/** @param {object | undefined} [host] het object dat de desktop-app aanbiedt (standaard `window.TickoryDesktop`) */
export function desktopBridge(host = globalThis.window?.TickoryDesktop) {
  const call = (name, ...args) => {
    try {
      return typeof host?.[name] === 'function' ? host[name](...args) : undefined;
    } catch {
      return undefined; // een fout in de brug mag de web-app nooit breken
    }
  };
  return {
    available: Boolean(host),
    setSession: (token) => call('setSession', token ?? ''),
    remindersChanged: () => call('remindersChanged'),
    setBadge: (count) => call('setBadge', count),
    closeQuickAdd: () => call('closeQuickAdd'),
    /** Heeft de desktop-app gevraagd Taak toevoegen te openen? (Eén keer true per verzoek.) */
    takeQuickAddRequest: () => call('takeQuickAddRequest') === true,
    setLanguage: (lang) => call('setLanguage', lang),
    /** Het thema uit Weergave doorgeven (titelbalk, andere vensters); `initial` bij het opstarten van dit venster. */
    setAppearance: ({ theme, accent }, initial = false) => call('setAppearance', { theme, accent }, initial),
    /** Het thema is elders gekozen (de eigen Instellingen van de desktop-app of een ander venster). */
    onAppearance: (callback) => call('onAppearance', callback),
    /** De desktop-app heeft zelf iets gewijzigd (Voltooien of Uitstellen in een melding van Windows): nu synchroniseren. */
    onSyncRequest: (callback) => call('onSyncRequest', callback),
    /** Kent deze desktop-app Instellingen › Desktop-app (sneltoetsen, opstarten, systeemvak)? Een oudere niet. */
    canSettings: () => typeof host?.getSettings === 'function',
    /** De instellingen van de desktop-app zelf: { shortcuts: { quickAdd, activate }, openAtLogin, startMinimized, stayInTray, server, version }. */
    getSettings: async () => (await call('getSettings')) ?? null,
    /** Bewaren; geeft { ok } of { ok: false, error } ('shortcutInvalid'). */
    saveSettings: async (changes) => (await call('saveSettings', changes)) ?? { ok: false, error: 'unavailable' },
    /** Het venster om een andere server te kiezen. */
    changeServer: () => call('changeServer'),
    /**
     * Toont deze desktop-app zelf meldingen bij samenwerken, herinneringen op notities en het dagelijks overzicht, met een
     * testmelding? (Vanaf 0.12; een oudere alleen de herinneringen bij taken.)
     */
    canNotify: () => typeof host?.testNotification === 'function',
    /** Een testmelding van Windows; geeft { ok }. */
    testNotification: async () => (await call('testNotification')) ?? { ok: false },
    /** De instellingen van Windows voor meldingen openen (aan of uit voor Tickory, Niet storen). */
    openNotificationSettings: () => call('openNotificationSettings'),
    /** De desktop-app vraagt Instellingen te openen (het menu Bestand › Instellingen of het systeemvak). */
    onOpenSettings: (callback) => call('onOpenSettings', callback),
  };
}

/** Draait deze pagina als het losse venster Taak toevoegen van de desktop-app (`?desktop=quickadd`)? */
export const isDesktopQuickAdd = (search = globalThis.location?.search ?? '') => new URLSearchParams(search).get('desktop') === 'quickadd';

/** Het aantal open taken voor vandaag en wat te laat is (de badge, zoals bij Todoist), uit de taken in de store. */
export function todayCount(view, today) {
  let n = 0;
  for (const task of view.tasks.values()) {
    const date = task.due?.date;
    if (!task.checked && !task.is_deleted && typeof date === 'string' && date.slice(0, 10) <= today) n += 1;
  }
  return n;
}

/**
 * Houdt de badge bij: na elke wijziging in de store het aantal voor vandaag, alleen als het veranderde. Ook elke minuut, want na
 * middernacht wordt een taak van morgen een taak van vandaag zonder dat er iets in de store verandert.
 * @returns {() => void} stoppen
 */
export function watchBadge({ store, bridge, today, every = 60_000 }) {
  if (!bridge.available) return () => {};
  let last = -1;
  const update = () => {
    if (!store.ready) return;
    const n = store.me ? todayCount(store.view, today()) : 0;
    if (n !== last) { last = n; bridge.setBadge(n); }
  };
  update();
  const unsubscribe = store.subscribe(update);
  const timer = every > 0 ? setInterval(update, every) : null;
  timer?.unref?.(); // in node (de tests) houdt de klok het proces niet open
  return () => {
    unsubscribe?.();
    if (timer) clearInterval(timer);
  };
}
