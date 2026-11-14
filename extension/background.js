// De achtergrond van de extensie (in Chrome en Edge een service worker, in Firefox een achtergrondscript): het contextmenu
// "Opslaan in Tickory" op een pagina, link of selectie, en bij de eerste installatie de instellingen openen. Geen netwerkverkeer:
// alleen het venster (popup.js) praat met de server.

const ext = globalThis.browser ?? globalThis.chrome;
const MENU_ID = 'tickory-save';

/** Het menu opnieuw aanmaken (na installeren, bijwerken of het starten van de browser), zonder dubbele items. */
async function setupMenu() {
  try {
    await ext.contextMenus.removeAll();
    ext.contextMenus.create({ id: MENU_ID, title: ext.i18n.getMessage('menuSave'), contexts: ['page', 'link', 'selection'] });
  } catch (err) {
    console.error('menu', err);
  }
}

ext.runtime.onInstalled.addListener((details) => {
  setupMenu();
  if (details.reason === 'install') ext.runtime.openOptionsPage();
});
ext.runtime.onStartup.addListener(setupMenu);

/**
 * Een klik in het contextmenu: wat er gekozen is, gaat even in de sessie-opslag (het venster leest en wist het meteen, zie
 * usePending in core/model.js), en het venster opent. Kan de browser het venster in de werkbalk niet openen, dan in een klein venster.
 */
function onMenuClick(info, tab) {
  if (info.menuItemId !== MENU_ID) return;
  const pending = {
    at: Date.now(),
    tabId: typeof tab?.id === 'number' ? tab.id : null,
    pageUrl: info.pageUrl ?? tab?.url ?? '',
    pageTitle: tab?.title ?? '',
    linkUrl: info.linkUrl ?? '',
    linkText: info.linkText ?? '', // alleen Firefox geeft de tekst van een link
    selectionText: info.selectionText ?? '',
  };
  // eerst het venster vragen (Firefox staat dat alleen direct na de klik toe), en tegelijk de keuze bewaren
  const saved = ext.storage.session.set({ pending });
  let opened;
  try {
    opened = Promise.resolve(ext.action.openPopup());
  } catch (err) {
    opened = Promise.reject(err);
  }
  opened.catch(() => saved.then(() => ext.windows.create({
    url: ext.runtime.getURL(`popup.html${pending.tabId === null ? '' : `?tab=${pending.tabId}`}`), type: 'popup', width: 400, height: 640,
  })));
}
ext.contextMenus.onClicked.addListener(onMenuClick);
