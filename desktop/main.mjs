// Tickory voor Windows: de web-app van je eigen Tickory-server in een eigen venster, gebouwd naar de desktop-app van Todoist (een
// Electron-schil om de web-app): een icoon in het systeemvak met Taak toevoegen, de taken van vandaag en de vaste overzichten; een
// globale sneltoets voor een los venster Taak toevoegen (Ctrl+Spatie) en een om Tickory te tonen (Win+Alt+S); een badge op de
// taakbalk als er taken voor vandaag zijn; herinneringen als meldingen van Windows met Voltooien en Uitstellen; het hoofdmenu met
// zoomen, zwevend op voorgrond en terug/verder; en updates via de GitHub-releases. Notities zitten in de web-app zelf.
//
// Veiligheid: de pagina's van de server draaien zonder Node (contextIsolation, sandbox); ze zien alleen window.TickoryDesktop
// (preload.cjs). Alleen de eigen server mag in het venster; andere adressen gaan naar de browser. Het sessietoken staat versleuteld
// (safeStorage, gekoppeld aan je Windows-account) en gaat alleen naar je eigen server.
import { app, BrowserWindow, Menu, Notification, Tray, dialog, globalShortcut, ipcMain, nativeImage, nativeTheme, powerMonitor, safeStorage, screen, session, shell } from 'electron';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, addSnooze, loadSettings, markShown, normalizeShortcut, removeSnooze, settingsOf } from './lib/settings.mjs';
import { normalizeServer, sameOrigin } from './lib/server.mjs';
import { planReminders, planSnoozes, snoozeMs, todayItems } from './lib/reminderPlan.mjs';
import { appMenu, trayMenu } from './lib/menuModel.mjs';
import { langOf, translator } from './lib/i18n.mjs';
import { parseActionUrl, reminderToastXml } from './lib/toast.mjs';
import { ACCENTS, BACKGROUND, appearanceOf, appearanceOrDefault, fromWeb, sameAppearance } from './lib/appearance.mjs';
import { epochToFloating } from './shared/reminders.js';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const SYNC_EVERY_MS = 5 * 60 * 1000;
/** Het venster Taak toevoegen: breder dan de telefoonopmaak van de web-app (760 px), zodat het de kaart van een computer toont. */
const QUICK_W = 820;
const QUICK_H = 560;
const GUIDE_URL = 'https://wnijhof.github.io/tickory/';
const RELEASES_URL = 'https://github.com/WNijhof/tickory/releases';

app.setAppUserModelId('io.github.wnijhof.tickory.desktop'); // nodig voor meldingen van Windows
// Alleen bij het ontwikkelen (niet in de installer): een eigen gegevensmap, en een rooktest die schermafdrukken maakt en stopt.
const DEV_DATA = !app.isPackaged ? process.env.TICKORY_DESKTOP_DATA : undefined;
const DEV_SHOT = !app.isPackaged ? process.env.TICKORY_DESKTOP_SHOT : undefined;
if (DEV_DATA) app.setPath('userData', DEV_DATA);
// Draait Tickory al, dan gaat dit verzoek naar die (second-instance) en stopt deze tweede start meteen, zonder systeemvak,
// sneltoetsen of instellingen voor het opstarten aan te raken (zie whenReady).
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();

// ---------- instellingen en token ----------

const dataDir = () => app.getPath('userData');
const settingsFile = () => join(dataDir(), 'settings.json');
const tokenFile = () => join(dataDir(), 'session.bin');
let settings = settingsOf(null);
const saveSettings = (next) => {
  settings = settingsOf(next);
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
};
const loadToken = async () => {
  try {
    if (!existsSync(tokenFile()) || !(await safeStorage.isAsyncEncryptionAvailable())) return null;
    const { result } = await safeStorage.decryptStringAsync(readFileSync(tokenFile()));
    return /^[\x21-\x7e]{10,300}$/.test(result) ? result : null;
  } catch {
    return null;
  }
};
const saveToken = async (token) => {
  try {
    if (!token) rmSync(tokenFile(), { force: true });
    else if (await safeStorage.isAsyncEncryptionAvailable()) writeFileSync(tokenFile(), await safeStorage.encryptStringAsync(token));
  } catch { /* zonder versleuteling bewaren we het token niet (dan geen herinneringen na een herstart tot de web-app weer start) */ }
};

let lang = 'nl';
let t = translator(lang);

// ---------- vensters ----------

let main = null;
let quickAdd = null;
let pages = null;
let tray = null;
let quitting = false;
let syncData = null;
let token = null;
const timers = new Map();

const icon = () => nativeImage.createFromPath(join(here, 'assets', 'icon.png'));

/** Een venster tonen. In de rooktest buiten beeld en zonder focus, zodat wie op de pc werkt er geen last van heeft. */
function present(win) {
  if (DEV_SHOT) {
    win.setSkipTaskbar(true);
    win.setPosition(-6000, -6000);
    win.showInactive();
    return;
  }
  win.show();
  win.focus();
}
const webPreferences = (preload) => ({ preload, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true });

// ---------- thema (zie lib/appearance.mjs) ----------

/** De achtergrond van een venster: die van de web-app bij het gekozen thema (nativeTheme volgt de keuze, zie applyTheme). */
const windowBg = () => (nativeTheme.shouldUseDarkColors ? BACKGROUND.dark : BACKGROUND.light);

/** Zoals Todoist: de titelbalk in de kleur van de pagina (setAccentColor, alleen Windows), en de achtergrond bij het thema. */
function themed(win) {
  if (!win || win.isDestroyed() || win === quickAdd) return; // het venster Taak toevoegen is doorzichtig en zonder rand
  win.setBackgroundColor(windowBg());
  if (process.platform === 'win32') win.setAccentColor?.(windowBg());
}

/** Het bewaarde thema toepassen op Windows zelf (titelbalk, menu's, prefers-color-scheme in alle vensters) en op elk venster. */
function applyTheme() {
  nativeTheme.themeSource = appearanceOrDefault(settings.appearance).theme;
  for (const win of BrowserWindow.getAllWindows()) themed(win);
}

/** De vensters met de web-app (hoofdvenster, Taak toevoegen, extra vensters): alleen die van de eigen server. */
const webWindows = () => BrowserWindow.getAllWindows().filter((w) => w !== pages && !w.isDestroyed() && settings.server && sameOrigin(w.webContents.getURL(), settings.server));

/** Een nieuwe keuze bewaren, toepassen en aan de vensters met de web-app geven (behalve het venster waar hij vandaan kwam). */
function setAppearance(next, from = null) {
  saveSettings({ ...settings, appearance: next });
  applyTheme();
  for (const w of webWindows()) if (w.webContents !== from) w.webContents.send('desktop:appearance', next);
  if (pages && !pages.isDestroyed()) pages.webContents.send('pages:appearance', next); // de eigen Instellingen, als die open staan
}

/** Alleen de eigen server in het venster; links naar elders openen in de browser (zoals Todoist). */
function guard(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (settings.server && sameOrigin(url, settings.server)) {
      openWindow(url); // "Openen in nieuw venster"
    } else if (/^https?:\/\//.test(url) || url.startsWith('mailto:')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (settings.server && sameOrigin(url, settings.server)) {
      // inloggen via SSO: de inlogdienst staat op een ander adres en hoort niet in dit venster (met de brug naar de app)
      if (isSsoStart(url)) {
        event.preventDefault();
        openSignIn(url, win);
      }
      return;
    }
    event.preventDefault();
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
  });
}

// ---------- laden, ook als de server (nog) niet bereikbaar is ----------

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/** Wat te laden zodra de verbinding er weer is, per venster; na het ontwaken uit de slaapstand meteen. */
const retries = new Map();

/** De pagina zolang de server niet te bereiken is: een uitleg en een knop; het venster probeert het zelf elke tien seconden. */
function offlinePage(target) {
  const dark = nativeTheme.shouldUseDarkColors;
  const html = `<!doctype html><html lang="${lang}"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`
    + `<title>Tickory</title><style>body{font-family:"Segoe UI",system-ui,sans-serif;background:${dark ? BACKGROUND.dark : BACKGROUND.light};color:${dark ? '#f2f2f2' : '#202020'};`
    + 'display:grid;place-items:center;min-height:90vh;margin:0;text-align:center}main{max-width:420px;padding:24px}h1{font-size:1.3rem}p{opacity:.8}'
    + `a{display:inline-block;margin-top:12px;padding:8px 18px;border-radius:8px;background:${dark ? '#2dd4bf' : '#0f766e'};color:${dark ? '#06201d' : '#fff'};text-decoration:none}</style>`
    + `<main><h1>${escapeHtml(t('offlineTitle'))}</h1><p>${escapeHtml(t('offlineText', { server: settings.server ?? '' }))}</p>`
    + `<a href="${escapeHtml(target)}">${escapeHtml(t('retry'))}</a></main></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

/**
 * Een pagina van de eigen server in een venster laden. Lukt dat niet (net uit de slaapstand, wifi nog niet verbonden bij het
 * aanmelden, server uit), dan geen foutvenster maar een eigen pagina, en elke tien seconden (en na het ontwaken) opnieuw.
 */
function loadServer(win, url) {
  let timer = null;
  const retry = () => {
    clearTimeout(timer);
    timer = null;
    if (!win.isDestroyed()) win.loadURL(url).catch(() => {});
  };
  win.webContents.on('did-fail-load', (_event, code, _text, failedUrl, isMainFrame) => {
    // -3: afgebroken (een nieuwe navigatie, of de gebruiker zelf); alleen de pagina zelf telt, geen plaatje of script
    if (!isMainFrame || code === -3 || !settings.server || !sameOrigin(failedUrl, settings.server)) return;
    win.loadURL(offlinePage(url)).catch(() => {});
    clearTimeout(timer);
    timer = setTimeout(retry, 10_000);
  });
  win.webContents.on('did-finish-load', () => {
    if (settings.server && sameOrigin(win.webContents.getURL(), settings.server)) { clearTimeout(timer); timer = null; }
  });
  retries.set(win, () => { if (timer) retry(); });
  win.on('closed', () => { clearTimeout(timer); retries.delete(win); });
  win.loadURL(url).catch(() => {}); // de fout zelf handelt did-fail-load af
}

// ---------- inloggen via SSO ----------

/** Het begin van een SSO-poging op de eigen server (de web-app gaat erheen na /api/v1/auth/oidc/start). */
const isSsoStart = (url) => {
  try {
    return new URL(url).pathname === '/api/v1/auth/oidc/authorize';
  } catch {
    return false;
  }
};
let signIn = null;

/**
 * De inlogdienst in een eigen venster, zonder de brug naar de app (window.TickoryDesktop) en zonder de beperking tot de eigen
 * server: hij heeft zijn eigen adres, formulieren en doorverwijzingen. Komt hij terug op de eigen server met de uitkomst
 * (`/#oidc=…` of `/#oidc-error=…`), dan gaat het venster dicht en ronden het venster dat de poging begon dat af (het wisselt de
 * code in met het geheim dat het in localStorage bewaarde; beide vensters delen die opslag).
 */
function openSignIn(url, from) {
  signIn?.destroy();
  // het kleine venster Taak toevoegen verdwijnt zodra het de focus kwijt is: dan rondt het hoofdvenster het inloggen af
  const owner = from && !from.isDestroyed() && from !== quickAdd ? from : main;
  const win = new BrowserWindow({
    width: 560, height: 760, parent: owner ?? undefined, icon: icon(), title: t('signInTitle'), autoHideMenuBar: true, backgroundColor: windowBg(),
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  signIn = win;
  themed(win);
  win.removeMenu();
  const finish = (target) => {
    let hash = '';
    try {
      const u = new URL(target);
      if (!settings.server || u.origin !== settings.server || !/^#(oidc|oidc-error)=/.test(u.hash)) return false;
      hash = u.hash;
    } catch {
      return false;
    }
    win.destroy();
    const back = owner && !owner.isDestroyed() ? owner : null;
    if (back) {
      back.loadURL(`${settings.server}/${hash}`).catch(() => {});
      present(back);
    } else {
      showMain(hash);
    }
    return true;
  };
  for (const name of ['will-redirect', 'will-navigate']) {
    win.webContents.on(name, (event, target) => {
      if (finish(target)) event.preventDefault();
      else if (!/^https?:\/\//.test(target)) event.preventDefault();
    });
  }
  win.webContents.on('did-navigate', (_event, target) => finish(target));
  win.webContents.setWindowOpenHandler(({ url: link }) => {
    if (/^https?:\/\//.test(link)) shell.openExternal(link);
    return { action: 'deny' };
  });
  win.on('closed', () => { if (signIn === win) signIn = null; });
  win.loadURL(url).catch(() => {});
}

function openWindow(url) {
  const win = new BrowserWindow({ width: 1100, height: 760, minWidth: 400, minHeight: 300, icon: icon(), backgroundColor: windowBg(), webPreferences: webPreferences(join(here, 'preload.cjs')) });
  themed(win);
  guard(win);
  loadServer(win, url);
  return win;
}

/** Wanneer het hoofdvenster voor het laatst de focus verloor: een klik op het systeemvak haalt de focus eerst weg. */
let mainBlurAt = 0;
/** Staat het hoofdvenster voor de gebruiker (zichtbaar en net nog actief)? Dan verbergt een klik op het systeemvak het. */
const mainInFront = () => Boolean(main?.isVisible() && !main.isMinimized() && (main.isFocused() || Date.now() - mainBlurAt < 400));
/** Heeft de web-app in het hoofdvenster ooit haar thema doorgegeven? Zo niet, dan is de server te oud voor de themakeuze. */
let mainLoaded = false;
let webAppearanceSeen = false;

function createMain({ hidden = false, hash = '' } = {}) {
  const b = settings.bounds;
  const onScreen = b && screen.getAllDisplays().some((d) => b.x < d.bounds.x + d.bounds.width && b.x + b.width > d.bounds.x && b.y < d.bounds.y + d.bounds.height && b.y + b.height > d.bounds.y);
  main = new BrowserWindow({
    ...(onScreen ? { x: b.x, y: b.y, width: b.width, height: b.height } : { width: 1200, height: 800 }),
    minWidth: 400, minHeight: 300, show: false, icon: icon(), title: 'Tickory', alwaysOnTop: settings.floatOnTop,
    backgroundColor: windowBg(),
    webPreferences: webPreferences(join(here, 'preload.cjs')),
  });
  themed(main);
  guard(main);
  const win = main;
  // de zoom hoort bij een geladen pagina (Chromium onthoudt hem per adres): na elke keer laden opnieuw zetten
  win.webContents.on('did-finish-load', () => {
    if (win.isDestroyed()) return;
    win.webContents.setZoomLevel(settings.zoom);
    if (settings.server && sameOrigin(win.webContents.getURL(), settings.server)) mainLoaded = true;
  });
  win.on('blur', () => { mainBlurAt = Date.now(); });
  // met een plek (#task=…, #view=…) meteen in het adres: een bericht vóór het laden zou verloren gaan
  loadServer(main, `${settings.server}/${hash}`);
  main.once('ready-to-show', () => {
    if (onScreen && b.maximized && !DEV_SHOT) main.maximize();
    if (!hidden) present(main);
  });
  const remember = () => {
    if (!main || main.isMinimized() || main.isFullScreen()) return;
    saveSettings({ ...settings, bounds: { ...main.getNormalBounds(), maximized: main.isMaximized() } });
  };
  main.on('resized', remember);
  main.on('moved', remember);
  main.on('maximize', remember);
  main.on('unmaximize', remember);
  main.on('close', (event) => {
    // zoals Todoist: sluiten laat Tickory in het systeemvak doorlopen (voor de herinneringen en de sneltoets), tenzij je dat uitzet;
    // dan sluit het hoofdvenster Tickory helemaal af
    if (quitting) return;
    if (settings.stayInTray) {
      event.preventDefault();
      main.hide();
    } else {
      quitting = true;
      setImmediate(() => app.quit());
    }
  });
  main.on('closed', () => { if (main === win) main = null; });
}

function showMain(hash = null) {
  if (!settings.server) return openPages('setup');
  if (!main) {
    createMain({ hash: hash ?? '' });
    hash = null; // zit al in het adres
  }
  if (main.isMinimized()) main.restore();
  present(main);
  // Instellingen geopend terwijl Tickory in het systeemvak zat: nu pas bij het hoofdvenster, anders valt het erachter
  if (pages && !pages.isDestroyed() && !pages.getParentWindow()) {
    pages.setParentWindow(main);
    present(pages);
  }
  if (!hash) return;
  // laadt het venster nog (of opnieuw, na geen verbinding), dan pas daarna: anders hoort de web-app het bericht niet
  const target = main;
  if (target.webContents.isLoading()) target.webContents.once('did-finish-load', () => { if (!target.isDestroyed()) target.webContents.send('desktop:navigate', hash); });
  else target.webContents.send('desktop:navigate', hash);
}

/** Het losse venster Taak toevoegen (globale sneltoets of het systeemvak): klein, bovenop, zonder rand; weg zodra je klaar bent. */
function showQuickAdd() {
  if (!settings.server) return showMain();
  if (!quickAdd) {
    quickAdd = new BrowserWindow({
      width: QUICK_W, height: QUICK_H, show: false, frame: false, resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
      skipTaskbar: true, alwaysOnTop: !DEV_SHOT, icon: icon(), transparent: true, backgroundColor: '#00000000', hasShadow: false,
      webPreferences: webPreferences(join(here, 'preload.cjs')),
    });
    guard(quickAdd);
    loadServer(quickAdd, `${settings.server}/?desktop=quickadd`);
    quickAdd.on('blur', () => quickAdd?.hide());
    quickAdd.on('closed', () => { quickAdd = null; });
  }
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { x, y, width } = display.workArea;
  quickAdd.setBounds({ x: Math.round(x + (width - QUICK_W) / 2), y: Math.round(y + 100), width: QUICK_W, height: QUICK_H });
  const open = () => {
    present(quickAdd);
    quickAdd.webContents.send('desktop:quickadd-open');
  };
  if (quickAdd.webContents.isLoading()) quickAdd.webContents.once('did-finish-load', open);
  else open();
}

let pagesMode = null;
const pagesHeight = (mode) => (mode === 'setup' ? 520 : Math.min(960, screen.getPrimaryDisplay().workAreaSize.height - 40));

function openPages(mode) {
  if (pages) {
    // al open, maar voor iets anders (Instellingen open en dan Andere server…): hetzelfde venster met de andere inhoud
    if (pagesMode !== mode) {
      pagesMode = mode;
      pages.setResizable(true);
      pages.setSize(520, pagesHeight(mode));
      pages.setResizable(false);
      pages.loadFile(join(here, 'pages', 'prefs.html'), { query: { mode } });
    }
    if (pages.isMinimized()) pages.restore();
    present(pages);
    return;
  }
  pagesMode = mode;
  // Hoort bij het hoofdvenster (blijft er dan altijd boven) en doet mee met "altijd bovenop", anders valt het erachter.
  const owner = main && !main.isDestroyed() && main.isVisible() ? main : undefined;
  pages = new BrowserWindow({
    width: 520, height: pagesHeight(mode), resizable: false, show: false, minimizable: false, maximizable: false, icon: icon(), title: 'Tickory',
    parent: owner, alwaysOnTop: !!settings.floatOnTop && !DEV_SHOT,
    autoHideMenuBar: true, backgroundColor: windowBg(),
    webPreferences: { ...webPreferences(join(here, 'pages', 'pages-preload.cjs')), spellcheck: false },
  });
  themed(pages);
  pages.removeMenu();
  pages.loadFile(join(here, 'pages', 'prefs.html'), { query: { mode } });
  pages.on('closed', () => { pages = null; pagesMode = null; });
  pages.once('ready-to-show', () => present(pages));
  pages.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // alleen de eigen pagina: een bestand dat je op het venster sleept, laadt er niet in (met de brug naar de instellingen)
  pages.webContents.on('will-navigate', (event) => event.preventDefault());
}

// ---------- menu's ----------

function runMenu(id) {
  if (id === 'quickAdd') return showQuickAdd();
  if (id === 'show') return showMain();
  if (id.startsWith('nav:')) return showMain(`#view=${id.slice(4)}`);
  if (id.startsWith('task:')) return showMain(`#task=${id.slice(5)}`);
  switch (id) {
    case 'settings': return openPages('prefs');
    case 'changeServer': return openPages('setup');
    case 'stayInTray': saveSettings({ ...settings, stayInTray: !settings.stayInTray }); return refreshMenus();
    case 'floatOnTop':
      saveSettings({ ...settings, floatOnTop: !settings.floatOnTop });
      main?.setAlwaysOnTop(settings.floatOnTop);
      pages?.setAlwaysOnTop(settings.floatOnTop);
      return refreshMenus();
    case 'newWindow': return settings.server && openWindow(`${settings.server}/`);
    case 'reload': return focused()?.webContents.reload();
    case 'back': return focused()?.webContents.navigationHistory.goBack();
    case 'forward': return focused()?.webContents.navigationHistory.goForward();
    case 'resetZoom': return zoom(0, true);
    case 'zoomIn': return zoom(1);
    case 'zoomOut': return zoom(-1);
    case 'devTools': return focused()?.webContents.toggleDevTools();
    case 'guide': return shell.openExternal(GUIDE_URL);
    case 'changelog': return shell.openExternal(RELEASES_URL);
    case 'checkUpdates': return checkUpdates(true);
    case 'about': return dialog.showMessageBox({ title: t('about'), message: `Tickory ${app.getVersion()}`, detail: settings.server ?? '', icon: icon() });
    case 'clearData': return clearData();
    case 'quit': quitting = true; return app.quit();
    default: return undefined;
  }
}

const focused = () => BrowserWindow.getFocusedWindow() ?? main;
function zoom(step, reset = false) {
  const next = reset ? 0 : Math.max(-5, Math.min(5, settings.zoom + step));
  saveSettings({ ...settings, zoom: next });
  main?.webContents.setZoomLevel(next);
}

/** Van de gegevens (menuModel.mjs) naar een echt menu van Electron. */
function build(template) {
  const priorityIcon = (p) => {
    const colors = { 1: [209, 69, 59], 2: [235, 137, 9], 3: [36, 111, 224] };
    return dot(colors[p] ?? [153, 153, 153], 16);
  };
  return Menu.buildFromTemplate(template.map(function convert(item) {
    const out = { ...item };
    delete out.id;
    delete out.priority;
    delete out.overdue;
    if (item.submenu) out.submenu = item.submenu.map(convert);
    if (item.id) out.click = () => runMenu(item.id);
    if (item.id?.startsWith('task:')) out.icon = priorityIcon(item.priority);
    return out;
  }));
}

function refreshMenus() {
  Menu.setApplicationMenu(build(appMenu(t, { floatOnTop: settings.floatOnTop })));
  if (tray) {
    const today = syncData ? todayItems(syncData, epochToFloating(Date.now()).slice(0, 10)) : null;
    tray.setContextMenu(build(trayMenu(t, today, { stayInTray: settings.stayInTray, quickAddShortcut: settings.shortcuts.quickAdd })));
  }
}

/** Een gekleurde stip (voor de prioriteit in het menu en de badge op de taakbalk), zonder plaatje uit een bestand. */
function dot([r, g, b], size) {
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      const a = d <= c - 1.5 ? 255 : d <= c ? Math.round(255 * (c - d) / 1.5) : 0;
      const i = (y * size + x) * 4;
      buf[i] = b; buf[i + 1] = g; buf[i + 2] = r; buf[i + 3] = a; // BGRA
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function createTray() {
  tray = new Tray(icon().resize({ width: 16, height: 16 }));
  tray.setToolTip(t('tooltip'));
  tray.on('click', () => (mainInFront() ? main.hide() : showMain()));
  refreshMenus();
}

// ---------- sneltoetsen ----------

/** @returns {string[]} de sneltoetsen die niet geregistreerd konden worden (al in gebruik door een andere app) */
function registerShortcuts() {
  globalShortcut.unregisterAll();
  const failed = [];
  const add = (accelerator, fn) => {
    if (!accelerator) return;
    try {
      if (!globalShortcut.register(accelerator, fn)) failed.push(accelerator);
    } catch {
      failed.push(accelerator);
    }
  };
  add(settings.shortcuts.quickAdd, showQuickAdd);
  add(settings.shortcuts.activate, () => (main?.isVisible() && !main.isMinimized() && main.isFocused() ? main.hide() : showMain()));
  return failed;
}

// ---------- herinneringen ----------

async function api(path, body) {
  if (!settings.server || !token) return null;
  const used = token;
  const res = await fetch(`${settings.server}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${used}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
  });
  // alleen afmelden als dit token nog geldt: intussen opnieuw ingelogd (een nieuw token) laat de nieuwe aanmelding staan
  if (res.status === 401) { if (token === used) setSession(''); return null; }
  return res.ok ? res.json() : null;
}

async function refreshReminders() {
  try {
    const data = await api('/api/v1/sync', { sync_token: '*', resource_types: ['tasks', 'reminders', 'settings'] });
    if (!data) return;
    syncData = data;
    schedule();
    refreshMenus();
  } catch { /* geen verbinding: de oude planning blijft staan, de volgende ronde probeert het opnieuw */ }
}

function schedule() {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  if (!syncData) return;
  for (const r of [...planReminders(syncData, Date.now(), settings.shown), ...planSnoozes(syncData, settings.snoozes, Date.now())]) {
    const wait = Math.max(0, r.at - Date.now());
    timers.set(r.key, setTimeout(() => fire(r), Math.min(wait, 2 ** 31 - 1)));
  }
}

/** In de rooktest: meldingen in een bestand in plaats van op het scherm (wie op de pc werkt, krijgt ze niet te zien). */
function devNote(entry) {
  const file = join(DEV_SHOT, 'notifications.json');
  mkdirSync(DEV_SHOT, { recursive: true });
  const list = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
  list.push(entry);
  writeFileSync(file, JSON.stringify(list, null, 1));
}

function fire(r) {
  timers.delete(r.key);
  if (r.snoozeId) saveSettings(removeSnooze(settings, r.snoozeId)); // een uitstel gaat één keer af
  else if (settings.shown.includes(r.key)) return;
  else saveSettings(markShown(settings, r.key));
  const time = r.moment.slice(11, 16);
  if (DEV_SHOT) return devNote({ kind: 'reminder', title: r.title, time, xml: reminderToastXml({ title: r.title, time, taskId: r.taskId, reminderId: r.id, moment: r.moment, t }) });
  const options = process.platform === 'win32'
    ? { toastXml: reminderToastXml({ title: r.title, time, taskId: r.taskId, reminderId: r.id, moment: r.moment, t }) }
    : { title: r.title, body: `${t('reminder')} · ${time}` };
  const n = new Notification(options);
  n.on('click', () => showMain(`#task=${r.taskId}`));
  n.show();
}

function note(text) {
  if (DEV_SHOT) return devNote({ kind: 'note', text });
  if (Notification.isSupported()) new Notification({ title: 'Tickory', body: text, silent: true }).show();
}

async function handleAction(url) {
  const a = parseActionUrl(url);
  if (!a) return;
  if (a.action === 'quick-add') return showQuickAdd();
  if (a.action === 'open') return showMain(`#task=${a.taskId}`);
  // gestart door de knop in een melding (Tickory was afgesloten): eerst de gegevens, voor de naam, de uitstelduur en de tijdzone
  if (!syncData && token) await refreshReminders();
  const title = syncData?.tasks?.find((x) => x.id === a.taskId)?.content ?? '';
  if (a.action === 'snooze') {
    // alleen op deze pc, zoals op Android: geen herinnering erbij op de server (die zou ook op de telefoon en in de browser afgaan)
    const id = `s${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    saveSettings(addSnooze(settings, { id, taskId: a.taskId, reminderId: a.reminderId, at: Date.now() + snoozeMs(syncData) }));
    schedule();
    note(t('snoozedNote', { title }));
    return;
  }
  const uuid = `tickory-d-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  try {
    const res = await api('/api/v1/sync', { sync_token: '*', resource_types: ['settings'], commands: [{ type: 'task_complete', uuid, args: { id: a.taskId } }] });
    if (res?.sync_status?.[uuid] !== 'ok') throw new Error('geweigerd');
    note(t('completedNote', { title }));
    // de web-app synchroniseert zelf (geen herladen: wat je daar aan het typen was, blijft staan)
    for (const w of webWindows()) w.webContents.send('desktop:sync');
    await refreshReminders();
  } catch {
    note(t('failedNote'));
  }
}

function setSession(next) {
  token = next || null;
  saveToken(token);
  if (!token) {
    syncData = null;
    schedule();
    refreshMenus();
    main?.setOverlayIcon(null, '');
    return;
  }
  refreshReminders();
}

// ---------- updates ----------

let updater = null;
async function checkUpdates(manual = false) {
  if (!app.isPackaged) {
    if (manual) dialog.showMessageBox({ title: t('updateTitle'), message: t('upToDate', { version: app.getVersion() }) });
    return;
  }
  try {
    updater ??= require('electron-updater').autoUpdater;
    updater.autoDownload = true;
    updater.removeAllListeners('update-downloaded');
    updater.on('update-downloaded', async () => {
      const { response } = await dialog.showMessageBox({ title: t('updateTitle'), message: t('updateReady'), buttons: [t('restart'), t('later')], defaultId: 0 });
      if (response === 0) { quitting = true; updater.quitAndInstall(); }
    });
    const result = await updater.checkForUpdates();
    if (manual && (!result?.updateInfo || result.updateInfo.version === app.getVersion())) dialog.showMessageBox({ title: t('updateTitle'), message: t('upToDate', { version: app.getVersion() }) });
  } catch {
    if (manual) dialog.showMessageBox({ type: 'warning', title: t('updateTitle'), message: t('updateError') });
  }
}

async function clearData() {
  const { response } = await dialog.showMessageBox({ type: 'warning', title: t('clearData'), message: t('clearData'), detail: t('clearDataText'), buttons: [t('clear'), t('cancel')], defaultId: 1, cancelId: 1 });
  if (response !== 0) return;
  await session.defaultSession.clearStorageData(); // ook als het hoofdvenster dicht is: alle vensters delen deze sessie
  saveToken(null);
  saveSettings({ ...DEFAULTS, server: settings.server });
  app.relaunch();
  quitting = true;
  app.quit();
}

// ---------- berichten van de web-app en de eigen schermen ----------

/** Komt dit bericht van een pagina van de eigen server (het hoofdvenster, Taak toevoegen of een extra venster)? */
const fromServer = (event) => Boolean(settings.server && sameOrigin(event.sender.getURL(), settings.server));
// inloggen of afmelden kan in elk venster van de web-app (ze delen dezelfde opslag)
ipcMain.on('desktop:session', (event, value) => { if (fromServer(event)) setSession(value); });
let changedTimers = [];
ipcMain.on('desktop:reminders-changed', () => {
  // na 2 seconden, en voor de zekerheid nog eens na 15: is de sync van de web-app traag, dan mist de eerste ronde de wijziging
  for (const timer of changedTimers) clearTimeout(timer);
  changedTimers = [setTimeout(refreshReminders, 2000), setTimeout(refreshReminders, 15_000)];
});
ipcMain.on('desktop:badge', (event, count) => {
  if (event.sender !== main?.webContents || !main) return;
  // zoals Todoist: een stip op het icoon in de taakbalk als er taken voor vandaag zijn
  main.setOverlayIcon(count > 0 ? dot([211, 51, 34], 16) : null, t(count > 0 ? 'hasDueToday' : 'noDueToday'));
});
ipcMain.on('desktop:quickadd-close', (event) => {
  if (event.sender !== quickAdd?.webContents) return;
  quickAdd.hide();
  refreshReminders();
});
ipcMain.on('desktop:language', (_event, value) => {
  const next = value === 'nl' ? 'nl' : 'en';
  if (next === lang) return;
  lang = next;
  t = translator(lang);
  saveSettings({ ...settings, lang });
  refreshMenus();
});

// het thema van de web-app (Instellingen › Weergave); `initial` bij het opstarten van een venster
ipcMain.on('desktop:appearance', (event, value) => {
  if (!fromServer(event)) return;
  webAppearanceSeen = true; // de web-app van de server kent de themakeuze van de desktop-app (vanaf 0.10.1)
  const { save, reply } = fromWeb(settings.appearance, value, value?.initial === true);
  if (save) setAppearance(save, event.sender);
  if (reply) event.sender.send('desktop:appearance', reply);
});

const pagesSender = (event) => pages && event.sender === pages.webContents;
ipcMain.handle('pages:load', (event) => {
  const mode = new URL(event.sender.getURL()).searchParams.get('mode') === 'setup' ? 'setup' : 'prefs';
  const keys = ['setupTitle', 'setupText', 'serverLabel', 'connect', 'serverError_empty', 'serverError_invalid', 'serverError_http', 'serverError_unreachable', 'settings',
    'shortcuts', 'quickAdd', 'show', 'shortcutHint', 'startup', 'openAtLogin', 'startMinimized', 'stayInTray', 'save', 'close', 'shortcutInvalid',
    'appearance', 'theme', 'theme_system', 'theme_light', 'theme_dark', 'accent', 'appearanceHint', 'appearanceOldServer', ...ACCENTS.map((a) => `accent_${a.name}`)];
  return {
    mode, lang, texts: Object.fromEntries(keys.map((k) => [k, t(k)])),
    accents: ACCENTS.map((a) => a.name),
    // het hoofdvenster liet de server zien, maar de web-app gaf nooit haar thema door: een server van vóór 0.10.1
    oldServer: mainLoaded && !webAppearanceSeen,
    settings: { server: settings.server, shortcuts: settings.shortcuts, openAtLogin: settings.openAtLogin, startMinimized: settings.startMinimized, stayInTray: settings.stayInTray, appearance: appearanceOrDefault(settings.appearance) },
  };
});
// het thema in de eigen Instellingen: werkt meteen, net als Weergave in de web-app
ipcMain.handle('pages:set-appearance', (event, value) => {
  const next = appearanceOf(value);
  if (!pagesSender(event) || !next) return { ok: false };
  if (!sameAppearance(next, settings.appearance)) setAppearance(next);
  return { ok: true };
});
ipcMain.handle('pages:set-server', async (_event, text) => {
  const { origin, error } = normalizeServer(text);
  if (error) return { ok: false, error };
  try {
    const res = await fetch(`${origin}/manifest.webmanifest`, { signal: AbortSignal.timeout(8000) });
    const manifest = res.ok ? await res.json() : null;
    if (!/tickory/i.test(String(manifest?.name ?? ''))) return { ok: false, error: 'unreachable' };
  } catch {
    return { ok: false, error: 'unreachable' };
  }
  const changed = origin !== settings.server;
  saveSettings({ ...settings, server: origin });
  if (changed) { setSession(''); main?.destroy(); main = null; quickAdd?.destroy(); quickAdd = null; }
  pages?.close();
  showMain();
  return { ok: true };
});
ipcMain.handle('pages:save', (_event, changes) => {
  const sc = changes.shortcuts ?? {};
  // "ctrl+shift+a" mag: in de schrijfwijze van Electron ("Ctrl+Shift+A")
  const quickAddKey = normalizeShortcut(sc.quickAdd ?? '');
  const activateKey = normalizeShortcut(sc.activate ?? '');
  if (quickAddKey === null || activateKey === null) return { ok: false, error: 'shortcutInvalid' };
  const before = settings;
  saveSettings({ ...settings, shortcuts: { quickAdd: quickAddKey, activate: activateKey }, openAtLogin: changes.openAtLogin === true, startMinimized: changes.startMinimized === true, stayInTray: changes.stayInTray !== false });
  if (registerShortcuts().length > 0) {
    saveSettings({ ...settings, shortcuts: before.shortcuts });
    registerShortcuts();
    return { ok: false, error: 'shortcutInvalid' };
  }
  applyLoginItem();
  refreshMenus();
  return { ok: true };
});
ipcMain.on('pages:close', () => pages?.close());

function applyLoginItem() {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return;
  app.setLoginItemSettings({ openAtLogin: settings.openAtLogin, args: settings.startMinimized ? ['--hidden'] : [] });
}

// ---------- opstarten ----------

const urlFromArgs = (argv) => argv.find((a) => a.startsWith('tickory://'));

app.on('second-instance', (_event, argv) => {
  const url = urlFromArgs(argv);
  if (url) handleAction(url);
  else showMain();
});
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { /* blijft draaien in het systeemvak */ });

app.whenReady().then(async () => {
  if (!primary) return; // een tweede start: die stopt (zie bovenaan)
  settings = loadSettings(() => (existsSync(settingsFile()) ? readFileSync(settingsFile(), 'utf8') : null));
  lang = langOf(settings.lang, app.getLocale());
  t = translator(lang);
  applyTheme();
  // "zoals het apparaat" en Windows wisselt tussen licht en donker: de achtergrond en titelbalk gaan mee
  nativeTheme.on('updated', () => { for (const win of BrowserWindow.getAllWindows()) themed(win); });
  // in de rooktest niets aan Windows veranderen: geen tickory://-koppeling, geen icoon, geen sneltoetsen, niet opstarten met Windows
  if (!DEV_SHOT) {
    if (process.defaultApp) app.setAsDefaultProtocolClient('tickory', process.execPath, [join(here)]);
    else app.setAsDefaultProtocolClient('tickory');
    createTray();
    registerShortcuts();
    applyLoginItem();
  }
  token = await loadToken();
  // tijdens het wachten op het token kan een tweede start of een melding het hoofdvenster al hebben geopend
  if (!settings.server) openPages('setup');
  else if (!main) createMain({ hidden: process.argv.includes('--hidden') });
  const loaded = token ? refreshReminders() : Promise.resolve();
  setInterval(refreshReminders, SYNC_EVERY_MS);
  powerMonitor.on('resume', () => {
    refreshReminders();
    for (const retry of retries.values()) retry(); // een venster zonder verbinding: meteen opnieuw proberen
  });
  const startUrl = urlFromArgs(process.argv);
  if (startUrl) loaded.then(() => handleAction(startUrl)); // eerst de gegevens (de uitstelduur, de naam van de taak)
  if (!DEV_SHOT) setTimeout(() => checkUpdates(false), 10_000);
  // de rooktest stopt altijd, ook als een schermafdruk mislukt (een venster zonder inhoud, zonder server)
  if (DEV_SHOT) smokeShots(DEV_SHOT).catch((e) => console.error('rooktest:', e)).finally(() => { quitting = true; app.quit(); });
});

/** De rooktest (alleen bij het ontwikkelen): het hoofdvenster, het systeemvakmenu als tekst, en het venster Taak toevoegen. */
async function smokeShots(dir) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  mkdirSync(dir, { recursive: true });
  await wait(6000);
  const devToken = process.env.TICKORY_DESKTOP_TOKEN;
  if (main && devToken) {
    await main.webContents.executeJavaScript(`localStorage.setItem('tickory.token', ${JSON.stringify(devToken)}); location.reload(); true`);
    await wait(6000);
  }
  if (main) {
    present(main);
    await wait(1500);
    writeFileSync(join(dir, 'main.png'), (await main.webContents.capturePage()).toPNG());
    writeFileSync(join(dir, 'main.json'), JSON.stringify({ url: main.webContents.getURL(), title: main.getTitle(), desktop: await main.webContents.executeJavaScript('Boolean(window.TickoryDesktop)') }));
  }
  if (pages) writeFileSync(join(dir, 'pages.png'), (await pages.webContents.capturePage()).toPNG());
  const menu = trayMenu(t, syncData ? todayItems(syncData, epochToFloating(Date.now()).slice(0, 10)) : null, { stayInTray: settings.stayInTray, quickAddShortcut: settings.shortcuts.quickAdd });
  writeFileSync(join(dir, 'tray.json'), JSON.stringify({ menu: menu.map((m) => m.label ?? m.type), shortcuts: settings.shortcuts, synced: Boolean(syncData) }, null, 1));
  if (settings.server) {
    showQuickAdd();
    await wait(5000);
    if (quickAdd) {
      writeFileSync(join(dir, 'quickadd.png'), (await quickAdd.webContents.capturePage()).toPNG());
      writeFileSync(join(dir, 'quickadd.json'), JSON.stringify(await quickAdd.webContents.executeJavaScript(`(() => { const d = document.querySelector('dialog[open]'); const r = d?.getBoundingClientRect(); return { url: location.href, quickadd: document.body.classList.contains('desktop-quickadd'), dialog: d ? d.className : null, rect: r ? [r.x, r.y, r.width, r.height] : null, me: Boolean(document.querySelector('#view-title')) }; })()`)));
    }
  }
  // een thema kiezen zoals in de eigen Instellingen (TICKORY_DESKTOP_APPEARANCE=dark:teal) of in Weergave van de web-app
  // (web:light:blue): gaan alle vensters mee?
  const look = process.env.TICKORY_DESKTOP_APPEARANCE?.split(':');
  if (look) {
    if (look[0] === 'web') {
      // via het echte scherm: Instellingen › Weergave, dan het thema en de accentkleur aanklikken
      const js = (code) => main?.webContents.executeJavaScript(code);
      await js(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('Instellingen') || b.textContent.includes('Settings'))?.click(); true`);
      await wait(800);
      await js(`document.querySelector('[data-fk="settings:appearance"]')?.click(); true`);
      await wait(800);
      await js(`document.querySelector('dialog[open] [data-role="theme-choice"] input[value=${JSON.stringify(look[1])}]')?.click(); document.querySelector('dialog[open] [data-role="accent-choice"] input[value=${JSON.stringify(look[2])}]')?.click(); true`);
    } else if (look[0] !== 'check') { // check: alleen kijken hoe het na het opstarten staat
      setAppearance(appearanceOf({ theme: look[0], accent: look[1] }));
    }
    await wait(1500);
    const read = (win) => win?.webContents.executeJavaScript(`({ theme: document.documentElement.dataset.theme ?? 'system', accent: document.documentElement.dataset.accent ?? 'teal', stored: localStorage.getItem('tickory.theme'), bg: getComputedStyle(document.body).backgroundColor })`);
    openPages('prefs');
    await wait(2500);
    writeFileSync(join(dir, 'appearance.json'), JSON.stringify({ pagesOwnedByMain: Boolean(pages && main && pages.getParentWindow() === main), settings: settings.appearance, themeSource: nativeTheme.themeSource, dark: nativeTheme.shouldUseDarkColors, main: await read(main), quickAdd: await read(quickAdd), pages: await pages?.webContents.executeJavaScript(`({ accent: document.documentElement.dataset.accent, theme: document.getElementById('theme')?.value, bg: getComputedStyle(document.body).backgroundColor })`) }, null, 1));
    if (main) writeFileSync(join(dir, 'main-themed.png'), (await main.webContents.capturePage()).toPNG());
    if (pages) writeFileSync(join(dir, 'prefs-themed.png'), (await pages.webContents.capturePage()).toPNG());
  }
  // een knop uit een melding nabootsen (tickory://complete?… of tickory://snooze?…), na even wachten (zodat een herinnering kan afgaan)
  const action = process.env.TICKORY_DESKTOP_ACTION;
  if (action) {
    await wait(Number(process.env.TICKORY_DESKTOP_WAIT ?? 0));
    await handleAction(action);
    await wait(1500);
  }
  quitting = true;
  app.quit();
}
