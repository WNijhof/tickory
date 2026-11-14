// Test van de browserextensie in een echte browser (Edge of Chrome, zonder venster), bestuurd via het DevTools-protocol over een
// pipe. De extensie wordt uitgepakt geladen met Extensions.loadUnpacked (de vlag --load-extension werkt in de merkversies van
// Chrome en Edge niet meer) en het venster in de werkbalk geopend met Extensions.triggerAction, zoals een klik op het pictogram:
// dan geldt ook activeTab echt. Start zelf een Tickory-server en een "website" op een andere host; raakt geen echte gegevens.
//
// Gebruik: node scripts/e2e-extension.ts [pad-naar-browser]
// Poorten: E2E_EXT_PORT (de server, standaard 8826) en E2E_EXT_PAGE_PORT (de website, standaard 8827).
// Schermafbeeldingen komen in .e2e-ext/shots/. Sluit af met code 1 als een controle mislukt.
//
// Wat niet kan zonder venster, en dus anders: de toestemmingsvraag voor de host (permissions.request) is niet te beantwoorden, dus
// de testbouw (dist/extension/chrome-test, alleen hier) heeft een vaste toestemming voor http://127.0.0.1; de echte zips niet. Het
// contextmenu is niet aan te klikken: de test roept de functie achter het menu (onMenuClick in background.js) in de service worker aan.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { createSchema } from '../server/schema.ts';
import { createApp } from '../server/main.ts';
import type { App } from '../server/main.ts';
import { handleSync } from '../server/sync.ts';
import { createSession, createUser, hashPassword, listSessions, revokeSession, setPasswordCostForTests } from '../server/users.ts';
import { build } from './build-extension.ts';

const BROWSERS = [
  process.argv[2],
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/microsoft-edge',
].filter(Boolean) as string[];
const browserPath = BROWSERS.find((p) => existsSync(p));
if (!browserPath) throw new Error('geen browser gevonden; geef het pad mee als argument');

const PORT = Number(process.env.E2E_EXT_PORT ?? 8826);
const PAGE_PORT = Number(process.env.E2E_EXT_PAGE_PORT ?? 8827);
const BASE = `http://127.0.0.1:${PORT}`;
const PAGE = `http://localhost:${PAGE_PORT}`; // een andere host dan de server: daar heeft de extensie alleen activeTab
const workDir = fileURLToPath(new URL('../.e2e-ext/', import.meta.url));
const shotsDir = `${workDir}shots/`;
rmSync(workDir, { recursive: true, force: true });
mkdirSync(shotsDir, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const js = (v: unknown) => JSON.stringify(v);
const results: string[] = [];
const step = (text: string) => { results.push(text); console.log(`✔ ${text}`); };

// ---------- de testbouw ----------
const built = build(`${workDir}dist`, { testHosts: ['http://127.0.0.1/*'] });

// ---------- server en website ----------
setPasswordCostForTests(1024);
const db = new DatabaseSync(':memory:');
createSchema(db);
const PASSWORD = 'alice-wachtwoord-1';
const alice = createUser(db, { username: 'alice', name: 'Alice', passwordHash: await hashPassword(PASSWORD) });
const bob = createUser(db, { username: 'bob', name: 'Bob', passwordHash: await hashPassword('bob-wachtwoord-123') });
handleSync(db, { commands: [
  { type: 'project_add', uuid: 'e2e-proj-werk', args: { id: 'project-werk', name: 'Werk' } },
  { type: 'section_add', uuid: 'e2e-sect-lezen', args: { id: 'section-lezen', project_id: 'project-werk', name: 'Lezen' } },
  { type: 'label_add', uuid: 'e2e-label-lezen', args: { id: 'label-lezen', name: 'lezen' } },
] }, alice.id);
handleSync(db, { commands: [
  { type: 'project_add', uuid: 'e2e-proj-club', args: { id: 'project-club', name: 'Club van Bob' } },
  { type: 'project_share', uuid: 'e2e-share-club', args: { project_id: 'project-club', username: 'alice', role: 'viewer' } },
] }, bob.id);
const tasksOf = (userId: string) => (handleSync(db, { sync_token: '*' }, userId).tasks as any[]);

/** Elk verzoek aan de API: adres, oorsprong en of er een cookie meekwam (de extensie stuurt er nooit een). */
const apiSeen: { url: string; origin?: string; cookie?: string; acao?: string }[] = [];
let app: App | null = null;
async function startServer() {
  app = createApp({ db, log: () => {}, backup: null, sessionSweepMs: 0 });
  app.server.prependListener('request', (req, res) => {
    if (!req.url?.startsWith('/api/')) return;
    const entry = { url: req.url, origin: req.headers.origin, cookie: req.headers.cookie } as (typeof apiSeen)[number];
    apiSeen.push(entry);
    res.once('finish', () => { entry.acao = res.getHeader('access-control-allow-origin') as string | undefined; });
  });
  await new Promise<void>((r) => app!.server.listen(PORT, '127.0.0.1', r));
}
async function stopServer() {
  await app?.close();
  app = null;
}
await startServer();

const ARTICLE_TITLE = 'Morgen gratis koffie - Testkrant';
const pageSeen: { url: string; origin?: string }[] = [];
const site = createServer((req, res) => {
  pageSeen.push({ url: req.url ?? '', origin: req.headers.origin });
  if (req.url === '/artikel') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html lang="nl"><head><meta charset="utf-8"><title>${ARTICLE_TITLE}</title></head><body><h1>Koffie</h1>`
      + '<p id="quote">Wie morgen langskomt, krijgt een kop koffie.</p><p><a id="boek" href="/boek">Het koffieboek</a></p></body></html>');
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise<void>((r) => site.listen(PAGE_PORT, 'localhost', r));

// ---------- de browser, via het DevTools-protocol over een pipe ----------
type Handler = (params: any, sessionId?: string) => void;
function startBrowser(lang: string) {
  const proc = spawn(browserPath!, [
    '--headless=new', '--remote-debugging-pipe', '--enable-unsafe-extension-debugging', `--user-data-dir=${workDir}profile-${lang}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', `--lang=${lang}`, '--window-size=1200,900', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  const out = proc.stdio[3] as NodeJS.WritableStream;
  const inp = proc.stdio[4] as NodeJS.ReadableStream;
  let buffer = '';
  let seq = 0;
  const waiting = new Map<number, (m: any) => void>();
  const handlers = new Map<string, Handler[]>();
  inp.on('data', (d: Buffer) => {
    buffer += d.toString('utf8');
    for (let i = buffer.indexOf('\0'); i >= 0; i = buffer.indexOf('\0')) {
      const m = JSON.parse(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
      if (m.id && waiting.has(m.id)) {
        waiting.get(m.id)!(m);
        waiting.delete(m.id);
      } else if (m.method) {
        for (const h of handlers.get(m.method) ?? []) h(m.params, m.sessionId);
      }
    }
  });
  const send = (method: string, params: object = {}, sessionId?: string): Promise<any> => new Promise((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
    out.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
  });
  const on = (method: string, h: Handler) => handlers.set(method, [...(handlers.get(method) ?? []), h]);
  return { proc, send, on };
}

let failed: unknown = null;
const browser = startBrowser('nl');
const { send, on } = browser;
/** Per doel (pagina, service worker) de sessie; voor de pagina's van de extensie ook het netwerkverkeer en de fouten. */
const sessions = new Map<string, { sessionId: string; url: string; type: string }>();
const extRequests: { url: string; from: string }[] = [];
const consoleErrors: string[] = [];
on('Target.attachedToTarget', async (p) => {
  const info = p.targetInfo;
  if (process.env.E2E_DEBUG) console.log('aangehaakt', info.type, info.url, p.waitingForDebugger);
  sessions.set(info.targetId, { sessionId: p.sessionId, url: info.url, type: info.type });
  try {
    // elk doel: een venster van de extensie heeft bij het aanhaken vaak nog geen adres (about:blank); het verkeer telt per adres op het moment zelf
    // (het venster in de werkbalk haakt aan als soort "other", zonder adres, en wordt pas daarna een pagina)
    await send('Network.enable', {}, p.sessionId).catch(() => {});
    await send('Runtime.enable', {}, p.sessionId).catch(() => {});
    if (p.waitingForDebugger) await send('Runtime.runIfWaitingForDebugger', {}, p.sessionId);
  } catch { /* het doel is alweer weg */ }
});
on('Target.detachedFromTarget', (p) => { for (const [id, s] of sessions) if (s.sessionId === p.sessionId) sessions.delete(id); });
on('Target.targetInfoChanged', (p) => { const s = sessions.get(p.targetInfo.targetId); if (s) s.url = p.targetInfo.url; });
on('Network.requestWillBeSent', (p, sessionId) => {
  const from = [...sessions.values()].find((s) => s.sessionId === sessionId)?.url ?? '?';
  if (from.startsWith('chrome-extension://')) extRequests.push({ url: p.request.url, from });
});
on('Runtime.exceptionThrown', (p, sessionId) => {
  const from = [...sessions.values()].find((s) => s.sessionId === sessionId)?.url ?? '?';
  if (from.startsWith('chrome-extension://')) consoleErrors.push(`${from}: ${p.exceptionDetails.exception?.description ?? p.exceptionDetails.text}`);
});
on('Runtime.consoleAPICalled', (p, sessionId) => {
  const from = [...sessions.values()].find((s) => s.sessionId === sessionId)?.url ?? '?';
  if (p.type === 'error' && from.startsWith('chrome-extension://')) consoleErrors.push(`${from}: ${p.args.map((a: any) => a.value ?? a.description).join(' ')}`);
});

const evalIn = async <T = any>(sessionId: string, expression: string): Promise<T> => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId);
  if (r.exceptionDetails) throw new Error(`in pagina: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}\n  bij: ${expression.slice(0, 200)}`);
  return r.result.value as T;
};
async function waitFor(sessionId: string, expression: string, what: string, timeoutMs = 10_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (await evalIn(sessionId, `(async () => Boolean(await (${expression})))()`).catch(() => false)) return;
    if (Date.now() > end) {
      const text = await evalIn<string>(sessionId, `document.body?.innerText?.replace(/\\s+/g, ' ').slice(0, 600)`).catch(() => '?');
      throw new Error(`wachten mislukt: ${what}\n  voorwaarde: ${expression}\n  scherm: ${text}`);
    }
    await sleep(100);
  }
}
async function waitForTarget(match: (url: string) => boolean, what: string, timeoutMs = 10_000): Promise<{ targetId: string; sessionId: string; url: string }> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    for (const [targetId, s] of sessions) if (match(s.url)) return { targetId, sessionId: s.sessionId, url: s.url };
    if (Date.now() > end) throw new Error(`geen doel: ${what}; wel: ${[...sessions.values()].map((s) => s.url).join(', ')}`);
    await sleep(100);
  }
}
async function waitGone(targetId: string, what: string, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  while (sessions.has(targetId)) {
    if (Date.now() > end) throw new Error(`niet gesloten: ${what}`);
    await sleep(100);
  }
}
let shotNo = 0;
async function shot(sessionId: string, name: string) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  writeFileSync(`${shotsDir}${String(++shotNo).padStart(2, '0')}-${name}.png`, Buffer.from(data, 'base64'));
}
const typeIn = (sessionId: string, selector: string, text: string) =>
  evalIn(sessionId, `(() => { const el = document.querySelector(${js(selector)}); if (!el) throw new Error('niet gevonden: ' + ${js(selector)}); el.focus(); el.value = ${js(text)}; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
const submitIn = (sessionId: string, selector: string) => evalIn(sessionId, `document.querySelector(${js(selector)}).requestSubmit()`);
const textOf = (sessionId: string, selector: string) => evalIn<string>(sessionId, `document.querySelector(${js(selector)})?.textContent ?? null`);
/** Steekt er iets uit het venster? (vaste breedte; op Linux zijn lettertypen breder) */
const overflow = (sessionId: string) => evalIn<string[]>(sessionId, `(() => { const edge = document.body.getBoundingClientRect().right + 0.5; return [...document.querySelectorAll('body *')].filter((el) => el.offsetParent !== null && (el.getBoundingClientRect().right > edge || el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX === 'visible')).map((el) => el.tagName + '#' + el.id + '.' + el.className); })()`);

try {
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  await send('Target.setDiscoverTargets', { discover: true });
  const { id: extId } = await send('Extensions.loadUnpacked', { path: built.testDir });
  const EXT = `chrome-extension://${extId}/`;
  step(`extensie uitgepakt geladen (${extId}) in ${(await send('Browser.getVersion')).product}`);

  // ---- 1. bij de eerste installatie opent de instellingenpagina vanzelf ----
  const options = await waitForTarget((u) => u === `${EXT}options.html`, 'instellingen na installeren');
  const opt = options.sessionId;
  await waitFor(opt, `!document.getElementById('server-view').hidden`, 'het adresveld');
  assert.equal(await textOf(opt, 'h1'), 'Verbinden met je Tickory-server');
  assert.equal(await evalIn(opt, 'document.documentElement.lang'), 'nl');
  step('bij installeren opent de instellingenpagina, in het Nederlands');

  // ---- 2. verbinden: een onveilig adres, dan het echte; fout wachtwoord, dan het goede ----
  await typeIn(opt, '#server', 'http://taken.voorbeeld.nl');
  await submitIn(opt, '#server-form');
  await waitFor(opt, `document.getElementById('server-error').textContent.includes('onversleuteld')`, 'http naar internet geweigerd');
  await typeIn(opt, '#server', `${BASE}/app/`);
  await submitIn(opt, '#server-form');
  await waitFor(opt, `!document.getElementById('login-view').hidden`, 'het inlogscherm');
  assert.equal(await textOf(opt, '#login-heading'), `Inloggen op 127.0.0.1:${PORT}`);
  await typeIn(opt, '#username', 'alice');
  await typeIn(opt, '#password', 'verkeerd-wachtwoord');
  await submitIn(opt, '#password-form');
  await waitFor(opt, `document.getElementById('login-error').textContent === 'Gebruikersnaam of wachtwoord klopt niet.'`, 'Nederlandse foutmelding');
  await typeIn(opt, '#password', PASSWORD);
  await submitIn(opt, '#password-form');
  await waitFor(opt, `!document.getElementById('connected-view').hidden`, 'verbonden');
  assert.equal(await textOf(opt, '#connected-as'), `Verbonden met ${BASE} als Alice (@alice).`);
  assert.match(await textOf(opt, '#shortcut'), /^Sneltoets: Alt\+Shift\+K\./);
  await shot(opt, 'instellingen-verbonden');
  const extSession = listSessions(db, alice.id).find((s) => s.name.startsWith('Browserextensie'));
  assert.ok(extSession, 'een eigen sessie');
  assert.match(extSession.name, /^Browserextensie \((Edge|Chrome)\)$/);
  assert.equal(extSession.device.kind, 'extension');
  const stored = await evalIn(opt, `chrome.storage.local.get(null)`);
  assert.match(stored.connection.token, /^tky_/);
  assert.deepEqual(await evalIn(opt, `chrome.storage.sync.get(null)`), {}, 'niets in de gesynchroniseerde opslag');
  step(`verbonden: http naar internet geweigerd, foutmelding bij een fout wachtwoord, een eigen sessie "${extSession.name}" (soort extensie), het token alleen lokaal`);

  // ---- 3. een pagina opslaan via het pictogram: titel, adres en selectie, de snelle invoer, het project ----
  const { targetId: articleTarget } = await send('Target.createTarget', { url: `${PAGE}/artikel` });
  const article = await waitForTarget((u) => u === `${PAGE}/artikel`, 'het artikel');
  await waitFor(article.sessionId, `document.readyState === 'complete' && document.getElementById('quote')`, 'artikel geladen');
  await evalIn(article.sessionId, `getSelection().selectAllChildren(document.getElementById('quote'))`);
  const tabOf = async (url: string) => (await send('Target.getTargets', { filter: [{ type: 'tab' }] })).targetInfos.find((t: any) => t.url === url).targetId;
  /** Zoals een klik op het pictogram terwijl dat tabblad voorop staat. */
  const openPopup = async (url: string) => {
    const page = [...sessions.entries()].find(([, s]) => s.url === url && s.type === 'page');
    if (page) await send('Target.activateTarget', { targetId: page[0] });
    await send('Extensions.triggerAction', { id: extId, targetId: await tabOf(url) });
    return waitForTarget((u) => u.startsWith(`${EXT}popup.html`), 'het venster');
  };
  const popup = await openPopup(`${PAGE}/artikel`);
  const pop = popup.sessionId;
  await waitFor(pop, `!document.getElementById('save-form').hidden && document.getElementById('project').options.length >= 3`, 'het venster met projecten');
  assert.equal(await evalIn(pop, `document.getElementById('title').value`), ARTICLE_TITLE);
  assert.equal(await evalIn(pop, `document.getElementById('description').value`), `${PAGE}/artikel\n\n> Wie morgen langskomt, krijgt een kop koffie.`);
  assert.deepEqual(await evalIn(pop, `[...document.getElementById('project').options].map((o) => [o.textContent.trim(), o.disabled])`),
    [['Inbox', false], ['Club van Bob (alleen lezen)', true], ['Werk', false]]);
  assert.equal(await evalIn(pop, `document.getElementById('project').selectedOptions[0].textContent`), 'Inbox');
  assert.deepEqual(await evalIn(pop, `[...document.querySelectorAll('#chips li')].length`), 0, '"Morgen" in de paginatitel is geen datum');
  assert.equal(await textOf(pop, '#account'), `Alice op 127.0.0.1:${PORT}`);
  assert.equal(await evalIn(pop, 'document.body.getBoundingClientRect().width'), 360);
  assert.deepEqual(await overflow(pop), [], 'niets steekt uit het venster');
  await evalIn(pop, `(() => { const p = document.getElementById('project'); p.value = 'project-werk'; p.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await evalIn(pop, `(() => { const t = document.getElementById('title'); t.value += ' morgen p1 /Lezen @lezen'; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const chips = await evalIn<string[]>(pop, `[...document.querySelectorAll('#chips li')].map((li) => li.textContent)`);
  assert.equal(chips.length, 4, chips.join(' | '));
  assert.match(chips[0], /^morgen · /);
  assert.deepEqual(chips.slice(1), ['P1', '/Lezen', '@lezen'], 'de sectie in het gekozen project');
  assert.deepEqual(await overflow(pop), [], 'ook met de stukjes niets uit het venster');
  await shot(pop, 'venster-artikel');
  await submitIn(pop, '#save-form');
  await waitFor(pop, `document.getElementById('done').textContent === 'Opgeslagen in Werk.'`, 'opgeslagen');
  await waitGone(popup.targetId, 'het venster na opslaan');
  const saved = tasksOf(alice.id).find((t) => t.content === ARTICLE_TITLE);
  assert.ok(saved, 'de taak staat op de server');
  assert.equal(saved.project_id, 'project-werk');
  assert.equal(saved.section_id, 'section-lezen');
  assert.equal(saved.priority, 1);
  assert.deepEqual(saved.labels, ['label-lezen']);
  assert.equal(saved.due.string, 'morgen');
  assert.equal(saved.description, `${PAGE}/artikel\n\n> Wie morgen langskomt, krijgt een kop koffie.`);
  step('een pagina opslaan via het pictogram: titel, adres en selectie (activeTab), keuzelijst met alleen-lezen, snelle invoer achter de titel, opgeslagen en gesloten');

  // ---- 4. het laatst gekozen project blijft; geen verbinding: een nette fout, en opnieuw proberen lukt (één taak) ----
  const second = await openPopup(`${PAGE}/artikel`);
  await waitFor(second.sessionId, `!document.getElementById('save-form').hidden`, 'het venster opnieuw');
  await sleep(300); // de lijst met projecten van de server
  assert.equal(await evalIn(second.sessionId, `document.getElementById('project').value`), 'project-werk', 'het laatst gekozen project');
  await typeIn(second.sessionId, '#title', 'Koffieboek bestellen #Inbox');
  assert.deepEqual(await evalIn(second.sessionId, `[...document.querySelectorAll('#chips li')].map((li) => li.textContent)`), ['#Inbox'], '#project gaat voor de keuzelijst');
  await stopServer();
  await submitIn(second.sessionId, '#save-form');
  await waitFor(second.sessionId, `document.getElementById('error').textContent === 'Tickory is niet bereikbaar.'`, 'niet bereikbaar');
  await startServer();
  await submitIn(second.sessionId, '#save-form');
  await waitFor(second.sessionId, `document.getElementById('done').textContent.startsWith('Opgeslagen in')`, 'opgeslagen na opnieuw proberen');
  await waitGone(second.targetId, 'het venster');
  const retried = tasksOf(alice.id).filter((t) => t.content === 'Koffieboek bestellen');
  assert.equal(retried.length, 1);
  assert.equal(retried[0].project_id, alice.inbox_project_id);
  step('het laatst gekozen project blijft gekozen (#project gaat voor); zonder server een nette melding, daarna opnieuw proberen: één taak');

  // ---- 5. het contextmenu op een link (de functie achter het menu, in de service worker) ----
  const worker = await waitForTarget((u) => u === `${EXT}background.js`, 'de service worker');
  const articleTab = await tabOf(`${PAGE}/artikel`);
  const tabId = await evalIn<number>(worker.sessionId, `chrome.tabs.query({}).then((tabs) => tabs.find((t) => t.url === ${js(`${PAGE}/artikel`)})?.id)`);
  assert.ok(articleTab && Number.isInteger(tabId));
  await evalIn(worker.sessionId, `onMenuClick({ menuItemId: 'tickory-save', pageUrl: ${js(`${PAGE}/artikel`)}, linkUrl: ${js(`${PAGE}/boek`)} }, { id: ${tabId}, title: ${js(ARTICLE_TITLE)}, url: ${js(`${PAGE}/artikel`)} })`);
  const menuPopup = await waitForTarget((u) => u.startsWith(`${EXT}popup.html`), 'het venster na het contextmenu');
  await waitFor(menuPopup.sessionId, `!document.getElementById('save-form').hidden`, 'het venster na het contextmenu');
  assert.equal(await evalIn(menuPopup.sessionId, `document.getElementById('title').value`), `${PAGE}/boek`);
  assert.equal(await evalIn(menuPopup.sessionId, `document.getElementById('description').value`), `${PAGE}/boek\n\nGevonden op: ${PAGE}/artikel`);
  await typeIn(menuPopup.sessionId, '#title', 'Het koffieboek lezen');
  await submitIn(menuPopup.sessionId, '#save-form');
  await waitFor(menuPopup.sessionId, `document.getElementById('done').textContent.startsWith('Opgeslagen in')`, 'link opgeslagen');
  await waitGone(menuPopup.targetId, 'het venster na het contextmenu');
  assert.equal(tasksOf(alice.id).find((t) => t.content === 'Het koffieboek lezen').description, `${PAGE}/boek\n\nGevonden op: ${PAGE}/artikel`);
  assert.equal(await evalIn(worker.sessionId, `chrome.storage.session.get('pending').then((s) => s.pending ?? null)`), null, 'de keuze is meteen gewist');
  step(`het contextmenu op een link: de link wordt de taak, met de pagina erbij (${menuPopup.url.includes('?tab=') ? 'in een eigen venster' : 'in het venster van de werkbalk'})`);

  // ---- 6. een ingetrokken sessie: het venster vraagt om opnieuw te verbinden ----
  revokeSession(db, alice.id, extSession.id);
  const revoked = await openPopup(`${PAGE}/artikel`);
  await waitFor(revoked.sessionId, `!document.getElementById('connect').hidden`, 'opnieuw verbinden');
  assert.equal(await textOf(revoked.sessionId, '#connect-text'), 'De verbinding met Tickory is verlopen of ingetrokken. Verbind opnieuw.');
  await shot(revoked.sessionId, 'venster-opnieuw-verbinden');
  await evalIn(revoked.sessionId, 'window.close()');
  await waitGone(revoked.targetId, 'het venster');
  step('in Tickory afgemeld: het venster zegt dat je opnieuw moet verbinden');

  // ---- 7. de koppelcode uit de web-app (Bob), dan in de extensie koppelen ----
  const bobWeb = createSession(db, bob.id, 'Web', { kind: 'browser', browser: 'Edge', os: 'Windows' });
  const { targetId: webTarget } = await send('Target.createTarget', { url: `${BASE}/` });
  const web = await waitForTarget((u) => u.startsWith(`${BASE}/`), 'de web-app');
  await waitFor(web.sessionId, `document.readyState === 'complete'`, 'web-app geladen');
  await evalIn(web.sessionId, `localStorage.setItem('tickory.token', ${js(bobWeb.token)}); localStorage.setItem('tickory.lang', 'nl'); location.reload()`).catch(() => {});
  await sleep(500);
  await waitFor(web.sessionId, `document.body.classList.contains('ready') && !document.querySelector('dialog[open]')`, 'web-app ingelogd als Bob', 20_000);
  const clickText = (sessionId: string, text: string, root = 'document') => evalIn(sessionId, `(() => { const el = [...${root}.querySelectorAll('button')].find((b) => b.textContent.trim() === ${js(text)}); if (!el) throw new Error('geen knop: ' + ${js(text)}); el.click(); })()`);
  const bobItem = `[...document.querySelectorAll('.nav-item')].find((b) => b.querySelector('.nav-label')?.textContent === 'Bob')`;
  await waitFor(web.sessionId, bobItem, 'Bob in de zijbalk', 20_000);
  await evalIn(web.sessionId, `${bobItem}.click()`);
  await waitFor(web.sessionId, `document.querySelector('dialog[open] .menu')`, 'instellingenmenu');
  await clickText(web.sessionId, 'Account, wachtwoord en apparaten');
  await waitFor(web.sessionId, `document.querySelector('dialog[open] .pairing')`, 'Browserextensie koppelen');
  await clickText(web.sessionId, 'Koppelcode maken');
  await waitFor(web.sessionId, `document.querySelector('dialog[open] .pairing input[type=password]')`, 'eerst het wachtwoord');
  await typeIn(web.sessionId, 'dialog[open] .pairing input[type=password]', 'bob-wachtwoord-123');
  await submitIn(web.sessionId, 'dialog[open] .pairing form');
  await waitFor(web.sessionId, `document.querySelector('dialog[open] .pair-code')`, 'de koppelcode');
  const pairCode = await textOf(web.sessionId, 'dialog[open] .pair-code');
  assert.match(pairCode, /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
  await shot(web.sessionId, 'web-app-koppelcode');

  // in de extensie: de sessie van Alice is ingetrokken, dus de instellingen vragen om opnieuw te verbinden; nu koppelen als Bob
  await evalIn(opt, `location.reload()`).catch(() => {});
  await waitFor(opt, `document.readyState === 'complete' && !document.getElementById('server-view').hidden`, 'instellingen: opnieuw verbinden');
  assert.equal(await textOf(opt, '#server-error'), 'De verbinding met Tickory is verlopen of ingetrokken. Verbind opnieuw.');
  assert.equal(await evalIn(opt, `chrome.storage.local.get('connection').then((s) => s.connection.token)`), null, 'het ingetrokken token is weg');
  assert.equal(await evalIn(opt, `document.getElementById('server').value`), BASE, 'het adres blijft ingevuld');
  await submitIn(opt, '#server-form');
  await waitFor(opt, `!document.getElementById('login-view').hidden`, 'het inlogscherm');
  await typeIn(opt, '#pair-code', 'ABCD-EFGH-JKMN-PQR');
  await submitIn(opt, '#pair-form');
  await waitFor(opt, `document.getElementById('login-error').textContent.startsWith('Een koppelcode heeft 16 tekens')`, 'een tikfout meteen gezien');
  await typeIn(opt, '#pair-code', pairCode.toLowerCase().replace(/-/g, ' '));
  await submitIn(opt, '#pair-form');
  await waitFor(opt, `!document.getElementById('connected-view').hidden`, 'verbonden als Bob');
  assert.equal(await textOf(opt, '#connected-as'), `Verbonden met ${BASE} als Bob (@bob).`);
  const bobExt = listSessions(db, bob.id).find((s) => s.name.startsWith('Browserextensie'));
  assert.ok(bobExt);
  assert.equal(bobExt.device.kind, 'extension');
  // de web-app toont de extensie in de lijst, als browserextensie
  await clickText(web.sessionId, 'Klaar', `document.querySelector('dialog[open] .pairing')`);
  await waitFor(web.sessionId, `[...document.querySelectorAll('dialog[open] .device-kind')].some((e) => e.textContent.startsWith('Browserextensie'))`, 'de extensie in de apparatenlijst');
  await shot(web.sessionId, 'web-app-apparaten');
  step('koppelcode: in de web-app gemaakt na het wachtwoord, in de extensie (kleine letters, spaties) ingewisseld; uitloggen haalt het token weg; de web-app toont "Browserextensie"');

  // ---- 8. Bob slaat een pagina op in zijn Inbox ----
  const bobPopup = await openPopup(`${PAGE}/artikel`);
  await waitFor(bobPopup.sessionId, `!document.getElementById('save-form').hidden`, 'het venster van Bob');
  assert.equal(await textOf(bobPopup.sessionId, '#account'), `Bob op 127.0.0.1:${PORT}`);
  await submitIn(bobPopup.sessionId, '#save-form');
  await waitFor(bobPopup.sessionId, `document.getElementById('done').textContent === 'Opgeslagen in Inbox.'`, 'opgeslagen bij Bob');
  await waitGone(bobPopup.targetId, 'het venster van Bob');
  assert.equal(tasksOf(bob.id).filter((t) => t.content === ARTICLE_TITLE && t.project_id === bob.inbox_project_id).length, 1, JSON.stringify(tasksOf(bob.id).map((t) => t.content)));
  step('na koppelen slaat Bob een pagina op in zijn eigen Inbox');

  // ---- uitloggen in de extensie trekt de sessie in Tickory in ----
  await evalIn(opt, `document.getElementById('logout').click()`);
  await waitFor(opt, `!document.getElementById('server-view').hidden && document.getElementById('server-status').textContent === 'Uitgelogd.'`, 'uitgelogd');
  assert.equal(listSessions(db, bob.id).some((s) => s.id === bobExt.id), false, 'de sessie is ingetrokken');
  assert.deepEqual(await evalIn(opt, `chrome.storage.local.get(null)`), {}, 'niets meer bewaard');
  const afterLogout = await openPopup(`${PAGE}/artikel`);
  await waitFor(afterLogout.sessionId, `!document.getElementById('connect').hidden`, 'niet verbonden');
  assert.equal(await textOf(afterLogout.sessionId, '#connect-text'), 'Nog niet verbonden met je Tickory-server.');
  await evalIn(afterLogout.sessionId, 'window.close()');
  step('uitloggen trekt de sessie in Tickory in en wist alles in de extensie; het venster zegt dan dat je moet verbinden');

  // ---- 9. alleen verkeer naar de eigen server, zonder cookies, en zonder CORS ----
  const ours = extRequests.filter((r) => r.from.startsWith(EXT)); // de ingebouwde extensies van de browser zelf tellen niet
  const foreign = ours.filter((r) => !r.url.startsWith(EXT) && !r.url.startsWith(`${BASE}/api/v1/`));
  assert.deepEqual(foreign, [], 'de extensie praat alleen met de eigen server');
  assert.ok(ours.filter((r) => r.url.startsWith(`${BASE}/api/v1/`)).length >= 8, `verzoeken gezien (${ours.length}): ${JSON.stringify(ours.map((r) => r.from.slice(-14) + ' ' + r.url.slice(-30)))}`);
  const fromExtension = apiSeen.filter((r) => r.origin === EXT.slice(0, -1));
  assert.ok(fromExtension.length >= 8, 'de server zag de verzoeken van de extensie');
  assert.ok(fromExtension.every((r) => !r.cookie), 'nooit een cookie');
  assert.ok(fromExtension.every((r) => !r.acao), 'geen CORS-kop nodig: de extensie heeft toestemming voor de host');
  assert.ok(pageSeen.every((r) => !r.origin?.startsWith('chrome-extension://')), 'de website kreeg niets van de extensie');
  assert.deepEqual(consoleErrors.filter((e) => e.startsWith(EXT)), [], 'geen fouten in de extensie');
  step(`alleen verkeer naar de eigen server (${fromExtension.length} verzoeken, geen cookies, geen CORS-koppen), niets naar de website, geen fouten in de console`);
  await send('Target.closeTarget', { targetId: webTarget }).catch(() => {});
  await send('Target.closeTarget', { targetId: articleTarget }).catch(() => {});
} catch (err) {
  failed = err;
} finally {
  browser.proc.kill();
}

// ---- 10. in een Engelse browser is de extensie Engels ----
if (!failed) {
  const en = startBrowser('en-US');
  try {
    const attached = new Map<string, { sessionId: string; url: string }>();
    en.on('Target.attachedToTarget', async (p) => {
      attached.set(p.targetInfo.targetId, { sessionId: p.sessionId, url: p.targetInfo.url });
      if (p.waitingForDebugger) await en.send('Runtime.runIfWaitingForDebugger', {}, p.sessionId).catch(() => {});
    });
    en.on('Target.targetInfoChanged', (p) => { const t = attached.get(p.targetInfo.targetId); if (t) t.url = p.targetInfo.url; });
    await en.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    await en.send('Target.setDiscoverTargets', { discover: true });
    const { id } = await en.send('Extensions.loadUnpacked', { path: built.testDir });
    let sessionId = '';
    for (let i = 0; i < 100 && !sessionId; i++) {
      sessionId = [...attached.values()].find((t) => t.url === `chrome-extension://${id}/options.html`)?.sessionId ?? '';
      await sleep(100);
    }
    assert.ok(sessionId, 'de instellingen openen ook in het Engels');
    let heading = '';
    for (let i = 0; i < 100 && heading !== 'Connect to your Tickory server'; i++) {
      heading = (await en.send('Runtime.evaluate', { expression: `document.querySelector('h1')?.textContent`, returnByValue: true }, sessionId)).result.value ?? '';
      await sleep(100);
    }
    assert.equal(heading, 'Connect to your Tickory server');
    step('in een Engelse browser is de extensie Engels');
  } catch (err) {
    failed = err;
  } finally {
    en.proc.kill();
  }
}

await stopServer();
site.close();
if (failed) {
  console.error('\n✖ MISLUKT:', failed);
  process.exitCode = 1;
} else {
  console.log(`\nAlle ${results.length} stappen geslaagd. Schermafbeeldingen in ${shotsDir}`);
}
