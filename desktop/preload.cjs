// De brug tussen de web-app (van je eigen server) en de desktop-app: `window.TickoryDesktop`, zoals `window.TickoryAndroid` in de
// Android-app. De web-app geeft zo het sessietoken door (voor de herinneringen), zegt dat er iets aan de herinneringen veranderde,
// geeft het aantal taken van vandaag door (voor de badge) en sluit het venster Taak toevoegen. De desktop-app kan de web-app naar een
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
});

// de desktop-app vraagt om een plek in de web-app: alleen een fragment (#view=…, #task=…), nooit een ander adres
ipcRenderer.on('desktop:navigate', (_event, hash) => {
  if (typeof hash === 'string' && /^#(?:view=[a-z-]+|task=[A-Za-z0-9_-]{8,40}|quickadd)$/.test(hash)) {
    if (location.hash === hash) window.dispatchEvent(new HashChangeEvent('hashchange'));
    else location.hash = hash;
  }
});
ipcRenderer.on('desktop:quickadd-open', () => {
  quickAddRequested = true;
  window.dispatchEvent(new Event('tickory-desktop-quickadd'));
});
