// De brug voor de eigen schermen van de desktop-app (het serveradres kiezen, de instellingen). Die pagina's staan in de app zelf
// (pages/), niet op de server; ze praten alleen via deze paar functies met het hoofdproces.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('TickoryPages', {
  /** De teksten en de huidige instellingen. */
  load: () => ipcRenderer.invoke('pages:load'),
  /** Het serveradres kiezen en controleren; geeft { ok } of { error }. */
  setServer: (text) => ipcRenderer.invoke('pages:set-server', String(text ?? '').slice(0, 300)),
  /** De instellingen bewaren (sneltoetsen, systeemvak, opstarten); geeft { ok } of { error, field }. */
  save: (changes) => ipcRenderer.invoke('pages:save', changes && typeof changes === 'object' ? changes : {}),
  close: () => ipcRenderer.send('pages:close'),
  /** Het thema kiezen (werkt meteen, in alle vensters); { theme, accent }. */
  setAppearance: (a) => ipcRenderer.invoke('pages:set-appearance', { theme: String(a?.theme ?? '').slice(0, 10), accent: String(a?.accent ?? '').slice(0, 20) }),
  /** Het thema is in de web-app gekozen terwijl dit scherm openstaat. */
  onAppearance: (callback) => { listener = typeof callback === 'function' ? callback : null; },
});

let listener = null;
ipcRenderer.on('pages:appearance', (_event, a) => listener?.({ theme: String(a?.theme ?? ''), accent: String(a?.accent ?? '') }));
