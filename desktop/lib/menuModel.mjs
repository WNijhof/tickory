// De menu's van de desktop-app als gewone gegevens (zonder Electron, zodat ze te testen zijn): het menu in het systeemvak zoals bij
// Todoist (Taak toevoegen, Tickory tonen, de taken van vandaag, de vaste overzichten, Instellingen, In systeemvak blijven draaien,
// Afsluiten) en het hoofdmenu (Bestand, Bewerken, Weergave, Venster, Help). Een item heeft `id` (wat er gebeurt) of `role` (Electron).

/** De vaste overzichten (shared/general.js viewFromHash). */
export const NAV = Object.freeze(['inbox', 'today', 'upcoming', 'completed', 'notes', 'productivity']);

/**
 * @param {(k: string, v?: object) => string} t
 * @param {{ items: { id: string, title: string, priority: number, overdue: boolean }[], count: number } | null} today
 * @param {{ stayInTray: boolean, quickAddShortcut: string }} state
 */
export function trayMenu(t, today, state) {
  const out = [
    { id: 'quickAdd', label: t('quickAdd'), accelerator: state.quickAddShortcut || undefined },
    { id: 'show', label: t('show') },
    { type: 'separator' },
  ];
  if (today) {
    if (today.items.length === 0) out.push({ label: t('nothingToday'), enabled: false });
    for (const item of today.items) out.push({ id: `task:${item.id}`, label: item.title || '…', priority: item.priority, overdue: item.overdue });
    if (today.count > today.items.length) out.push({ id: 'nav:today', label: t('moreToday', { n: today.count - today.items.length }) });
    out.push({ type: 'separator' });
  }
  for (const v of NAV.filter((x) => x !== 'productivity')) out.push({ id: `nav:${v}`, label: t(v) });
  out.push(
    { type: 'separator' },
    { id: 'settings', label: t('settings') },
    { id: 'stayInTray', label: t('stayInTray'), type: 'checkbox', checked: state.stayInTray },
    { id: 'changelog', label: t('changelog') },
    { type: 'separator' },
    { id: 'quit', label: t('quit') },
  );
  return out;
}

/** Het hoofdmenu, zoals dat van de Todoist-app op Windows. */
export function appMenu(t, state) {
  return [
    { label: t('file'), submenu: [
      { id: 'quickAdd', label: t('quickAdd'), accelerator: 'CommandOrControl+Shift+A' },
      { id: 'newWindow', label: t('newWindow'), accelerator: 'CommandOrControl+Shift+N' },
      { type: 'separator' },
      { id: 'settings', label: t('settings'), accelerator: 'CommandOrControl+,' },
      { id: 'changeServer', label: t('changeServer') },
      { id: 'clearData', label: t('clearData') },
      { type: 'separator' },
      { id: 'quit', label: t('quit'), accelerator: 'CommandOrControl+Q' },
    ] },
    { label: t('edit'), submenu: [
      { role: 'undo', label: t('undo') }, { role: 'redo', label: t('redo') }, { type: 'separator' },
      { role: 'cut', label: t('cut') }, { role: 'copy', label: t('copy') }, { role: 'paste', label: t('paste') },
      { role: 'pasteAndMatchStyle', label: t('pasteAndMatchStyle') }, { role: 'selectAll', label: t('selectAll') },
    ] },
    { label: t('view'), submenu: [
      { id: 'back', label: t('back'), accelerator: 'Alt+Left' }, { id: 'forward', label: t('forward'), accelerator: 'Alt+Right' },
      { type: 'separator' },
      { id: 'reload', label: t('reload'), accelerator: 'CommandOrControl+R' },
      { id: 'resetZoom', label: t('resetZoom'), accelerator: 'CommandOrControl+0' },
      { id: 'zoomIn', label: t('zoomIn'), accelerator: 'CommandOrControl+Plus' },
      { id: 'zoomOut', label: t('zoomOut'), accelerator: 'CommandOrControl+-' },
      { type: 'separator' },
      { role: 'togglefullscreen', label: t('fullScreen') },
      { id: 'devTools', label: t('devTools'), accelerator: 'CommandOrControl+Shift+I' },
    ] },
    { label: t('window'), submenu: [
      { id: 'floatOnTop', label: t('floatOnTop'), type: 'checkbox', checked: state.floatOnTop },
      { role: 'minimize', label: t('minimize') },
    ] },
    { label: t('help'), submenu: [
      { id: 'guide', label: t('guide') }, { id: 'changelog', label: t('changelog') }, { id: 'checkUpdates', label: t('checkUpdates') },
      { type: 'separator' }, { id: 'about', label: t('about') },
    ] },
  ];
}
