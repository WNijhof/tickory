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
});
