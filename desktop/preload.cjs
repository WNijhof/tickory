// De brug tussen de web-app (van je eigen server) en de desktop-app: `window.TickoryDesktop`, zoals `window.TickoryAndroid` in de
// Android-app. De web-app geeft zo het sessietoken door (voor de herinneringen), zegt dat er iets aan de herinneringen veranderde,
// geeft het aantal taken van vandaag door (voor de badge), het thema (Weergave) en sluit het venster Taak toevoegen. De desktop-app kan de web-app naar een
// vast overzicht sturen (#view=…) of een taak laten openen (#task=…). Niets anders gaat over deze brug.
const { contextBridge, ipcRenderer } = require('electron');

const safeText = (s, max) => (typeof s === 'string' ? s.slice(0, max) : '');
// een verzoek om Taak toevoegen te openen blijft staan tot de web-app het ophaalt (ze kan nog aan het opstarten zijn)
let quickAddRequested = false;

contextBridge.exposeInMainWorld('TickoryDesktop', {
  available: true,
  /** Het sessietoken van deze aanmelding ('' bij afmelden). */
  setSession: (token) => ipcRenderer.send('desktop:session', safeText(token, 300)),
  /** Er is iets veranderd aan taken of herinneringen: opnieuw plannen. */
  remindersChanged: () => ipcRenderer.send('desktop:reminders-changed'),
  /** Hoeveel taken er vandaag (en te laat) zijn: de badge op de taakbalk. */
  setBadge: (count) => ipcRenderer.send('desktop:badge', Number.isInteger(count) && count >= 0 ? Math.min(count, 9999) : 0),
  /** Het venster Taak toevoegen is klaar (toegevoegd of geannuleerd). */
  closeQuickAdd: () => ipcRenderer.send('desktop:quickadd-close'),
  /** Is er gevraagd om Taak toevoegen te openen? Eén keer true per verzoek. */
  takeQuickAddRequest: () => {
    const asked = quickAddRequested;
    quickAddRequested = false;
    return asked;
  },
  /** De taal van de web-app (nl of en), voor de menu's van de desktop-app. */
  setLanguage: (lang) => ipcRenderer.send('desktop:language', lang === 'nl' ? 'nl' : 'en'),
  /** Het thema uit Instellingen › Weergave (zoals het apparaat, licht of donker, en de accentkleur), voor de titelbalk en de andere vensters. */
  setAppearance: (a, initial = false) => ipcRenderer.send('desktop:appearance', { theme: safeText(a?.theme, 10), accent: safeText(a?.accent, 20), initial: initial === true }),
  /** Wat te doen als het thema elders gekozen is (de eigen Instellingen van de app, of een ander venster). */
  onAppearance: (callback) => { appearanceListener = typeof callback === 'function' ? callback : null; },
  /** De desktop-app heeft zelf iets gewijzigd (Voltooien of Uitstellen in een melding): de web-app synchroniseert dan meteen. */
  onSyncRequest: (callback) => { syncListener = typeof callback === 'function' ? callback : null; },
  /** De instellingen van de desktop-app zelf (sneltoetsen, opstarten, systeemvak, server), voor Instellingen › Desktop-app. */
  getSettings: () => ipcRenderer.invoke('desktop:get-settings'),
  /** Bewaren; geeft { ok } of { ok: false, error }. */
  saveSettings: (changes) => ipcRenderer.invoke('desktop:save-settings', {
    shortcuts: { quickAdd: safeText(changes?.shortcuts?.quickAdd, 60), activate: safeText(changes?.shortcuts?.activate, 60) },
    openAtLogin: changes?.openAtLogin === true, startMinimized: changes?.startMinimized === true, stayInTray: changes?.stayInTray !== false,
  }),
  /** Het venster om een andere server te kiezen. */
  changeServer: () => ipcRenderer.send('desktop:change-server'),
  /** Een testmelding van Windows (Instellingen › Meldingen); geeft { ok }. */
  testNotification: () => ipcRenderer.invoke('desktop:test-notification'),
  /** De instellingen van Windows voor meldingen (aan of uit per app, Niet storen). */
  openNotificationSettings: () => ipcRenderer.send('desktop:notification-settings'),
  /** Wat te doen als de desktop-app vraagt Instellingen te openen; daarmee weet de app ook dat deze web-app dat kan. */
  onOpenSettings: (callback) => {
    settingsListener = typeof callback === 'function' ? callback : null;
    if (settingsListener) ipcRenderer.send('desktop:settings-ready');
  },
});

let settingsListener = null;
ipcRenderer.on('desktop:open-settings', () => settingsListener?.());

let syncListener = null;
ipcRenderer.on('desktop:sync', () => syncListener?.());

let appearanceListener = null;
ipcRenderer.on('desktop:appearance', (_event, a) => {
  if (appearanceListener && a && typeof a === 'object') appearanceListener({ theme: safeText(a.theme, 10), accent: safeText(a.accent, 20) });
});

// de desktop-app vraagt om een plek in de web-app: alleen een fragment (#view=…, #task=…), nooit een ander adres
ipcRenderer.on('desktop:navigate', (_event, hash) => {
  if (typeof hash === 'string' && /^#(?:view=[a-z-]+|(?:task|note|notification)=[A-Za-z0-9_-]{8,40}|quickadd|help(?:=[a-z0-9-]{1,60})?)$/.test(hash)) {
    if (location.hash === hash) window.dispatchEvent(new HashChangeEvent('hashchange'));
    else location.hash = hash;
  }
});
ipcRenderer.on('desktop:quickadd-open', () => {
  quickAddRequested = true;
  window.dispatchEvent(new Event('tickory-desktop-quickadd'));
});
