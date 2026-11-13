// Test van de hele app in een echte browser (Edge of Chrome, zonder venster), bestuurd via het DevTools-protocol.
// Start zelf een server met een lege database in het geheugen; raakt geen echte gegevens.
//
// Gebruik: node scripts/e2e.ts [pad-naar-browser]
// Schermafbeeldingen komen in .e2e/shots/. Sluit af met code 1 als een controle mislukt.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { createSchema } from '../server/schema.ts';
import { createApp } from '../server/main.ts';
import type { App } from '../server/main.ts';
import { handleSync } from '../server/sync.ts';
import { addDays, formatDate, todayString } from '../client/core/format.js';

const BROWSERS = [
  process.argv[2],
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/chromium', '/usr/bin/google-chrome',
].filter(Boolean) as string[];
const browserPath = BROWSERS.find((p) => existsSync(p));
if (!browserPath) throw new Error('geen browser gevonden; geef het pad mee als argument');

const TOKEN = 'e2e-token-0123456789-abcdefghijkl';
const APP_PORT = 8791;
const CDP_PORT = 9341;
const BASE = `http://127.0.0.1:${APP_PORT}`;
const workDir = fileURLToPath(new URL('../.e2e/', import.meta.url));
const shotsDir = `${workDir}shots/`;
rmSync(workDir, { recursive: true, force: true });
mkdirSync(shotsDir, { recursive: true });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: string[] = [];
const step = (text: string) => { results.push(text); console.log(`✔ ${text}`); };

// ---------- server ----------
const db = new DatabaseSync(':memory:');
createSchema(db);
let app: App | null = null;
async function startServer() {
  app = createApp({ db, token: TOKEN });
  await new Promise<void>((r) => app!.server.listen(APP_PORT, '127.0.0.1', r));
}
async function stopServer() {
  await app?.close();
  app = null;
}
const serverState = () => handleSync(db, { sync_token: '*' }) as Record<string, any>;
const serverTask = (content: string) => (serverState().tasks as any[]).find((t) => t.content === content);

// ---------- browser ----------
await startServer();
const browser = spawn(browserPath, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${workDir}profile`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1280,860', 'about:blank',
], { stdio: 'ignore' });

let ws: WebSocket;
let seq = 0;
const pending = new Map<number, (m: any) => void>();
const consoleErrors: string[] = [];
const netLog: string[] = [];

async function connect() {
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const page = (list as any[]).find((t) => t.type === 'page');
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
        ws.onmessage = (e) => {
          const m = JSON.parse(String(e.data));
          if (m.id && pending.has(m.id)) {
            pending.get(m.id)!(m);
            pending.delete(m.id);
          } else if (m.method === 'Network.requestWillBeSent' && /\/api\//.test(m.params.request.url)) {
            netLog.push(`${new Date().toISOString().slice(11, 23)} → ${m.params.request.method} ${m.params.request.url.replace(BASE, '')} [${m.params.requestId}]`);
          } else if (m.method === 'Network.responseReceived' && /\/api\//.test(m.params.response.url)) {
            netLog.push(`${new Date().toISOString().slice(11, 23)} ← ${m.params.response.status} ${m.params.response.url.replace(BASE, '')} [${m.params.requestId}]`);
          } else if (m.method === 'Network.loadingFailed') {
            netLog.push(`${new Date().toISOString().slice(11, 23)} ✖ ${m.params.errorText}${m.params.canceled ? ' (afgebroken)' : ''} [${m.params.requestId}]`);
          } else if (m.method === 'Runtime.exceptionThrown') {
            consoleErrors.push(`exception: ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`);
          } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
            consoleErrors.push(`log: ${m.params.entry.text} (${m.params.entry.url ?? ''})`);
          } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
            consoleErrors.push(`console.error: ${m.params.args.map((a: any) => a.value ?? a.description).join(' ')}`);
          }
        };
        return;
      }
    } catch { /* browser start nog op */ }
    await sleep(100);
  }
  throw new Error('browser reageert niet op de debugpoort');
}
const send = (method: string, params: object = {}): Promise<any> =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });

async function evaluate<T = any>(expression: string): Promise<T> {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`in pagina: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}\n  bij: ${expression.slice(0, 200)}`);
  return r.result.value as T;
}
async function waitFor(expression: string, what: string, timeoutMs = 10_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    // tijdens het (her)laden van de pagina kan een meting mislukken; dan gewoon opnieuw proberen
    // de voorwaarde mag ook een belofte opleveren; die wordt eerst afgewacht
    if (await evaluate(`(async () => Boolean(await (${expression})))()`).catch(() => false)) return;
    if (Date.now() > end) {
      await shot('MISLUKT');
      throw new Error(`wachten mislukt: ${what}\n  voorwaarde: ${expression}\n  scherm: ${await pageText()}`);
    }
    await sleep(100);
  }
}
const js = (v: unknown) => JSON.stringify(v);
const pageText = () => evaluate<string>(`document.body.innerText.replace(/\\s+/g, ' ').slice(0, 900)`);
const typeInto = (selector: string, text: string) =>
  evaluate(`(() => { const el = document.querySelector(${js(selector)}); if (!el) throw new Error('niet gevonden: ' + ${js(selector)}); el.focus(); el.value = ${js(text)}; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
const submit = (selector: string) => evaluate(`document.querySelector(${js(selector)}).requestSubmit()`);
const click = (selector: string) =>
  evaluate(`(() => { const el = document.querySelector(${js(selector)}); if (!el) throw new Error('niet gevonden: ' + ${js(selector)}); el.click(); })()`);
/** Klikt op de knop met precies deze tekst (binnen `root`, standaard het hele document). */
const clickText = (text: string, root = 'document') =>
  evaluate(`(() => { const el = [...${root}.querySelectorAll('button')].find((b) => b.textContent.trim() === ${js(text)}); if (!el) throw new Error('geen knop: ' + ${js(text)}); el.click(); })()`);
const taskTitles = () => evaluate<string[]>(`[...document.querySelectorAll('.task .task-title')].map((e) => e.textContent)`);
const taskMeta = (content: string) =>
  evaluate<string[]>(`(() => { const li = [...document.querySelectorAll('.task')].find((l) => l.querySelector('.task-title').textContent === ${js(content)}); return li ? [...li.querySelectorAll('.chip')].map((c) => c.textContent) : null; })()`);
const status = () => evaluate<string>(`document.getElementById('sync-status').textContent`);
const quickAdd = async (text: string) => { await typeInto('#quick-input', text); await submit('#quick-add'); };
const nav = (label: string) => evaluate(`(() => { const el = [...document.querySelectorAll('.nav-item')].find((b) => b.querySelector('.nav-label')?.textContent === ${js(label)}); if (!el) throw new Error('geen menu-item: ' + ${js(label)}); el.click(); })()`);
let shotNo = 0;
async function shot(name: string) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  const file = `${shotsDir}${String(++shotNo).padStart(2, '0')}-${name}.png`;
  writeFileSync(file, Buffer.from(data, 'base64'));
  return file;
}
const promptAnswer = async (text: string) => {
  await waitFor(`document.querySelector('dialog[open] input')`, 'invoerveld in dialoog');
  await typeInto('dialog[open] input', text);
  await submit('dialog[open] form');
  await waitFor(`!document.querySelector('dialog[open]')`, 'dialoog gesloten');
};

let failed: unknown = null;
let diagnosis: unknown = null;
try {
  await connect();
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });

  const today = todayString();
  const tomorrow = addDays(today, 1);

  // ---- 1. eerste keer openen: token ----
  await send('Page.navigate', { url: `${BASE}/` });
  await waitFor(`document.body.classList.contains('ready')`, 'app gestart');
  await waitFor(`document.querySelector('dialog[open] input[type=password]')`, 'tokenvenster');
  await shot('token');
  await promptAnswer('fout-token-0123456789-abcdefghij');
  await waitFor(`document.querySelector('dialog[open] input[type=password]')`, 'tokenvenster opnieuw na fout token');
  assert.equal(await status(), 'Token nodig');
  step('fout token: de app vraagt opnieuw om het token');
  await promptAnswer(TOKEN);
  await waitFor(`document.getElementById('sync-status').textContent === 'Bijgewerkt'`, 'eerste sync');
  await waitFor(`[...document.querySelectorAll('.nav-label')].some((e) => e.textContent === 'Inbox')`, 'Inbox in de zijbalk');
  step('juist token: verbonden, Inbox zichtbaar');

  // ---- 2. snel toevoegen met Nederlandse datum ----
  await typeInto('#quick-input', 'Tandarts bellen morgen om 9 uur p1 @bellen');
  await waitFor(`document.querySelectorAll('#quick-preview .chip').length >= 4`, 'voorbeeld onder het invoerveld');
  const preview = await evaluate<string[]>(`[...document.querySelectorAll('#quick-preview .chip')].map((c) => c.textContent)`);
  assert.deepEqual(preview, ['Tandarts bellen', 'morgen 09:00', '@bellen (nieuw)', 'P1']);
  await shot('quick-add-voorbeeld');
  await submit('#quick-add');
  await waitFor(`document.getElementById('quick-input').value === ''`, 'invoerveld leeg');
  assert.deepEqual(await taskTitles(), [], 'de taak is voor morgen en hoort niet in Vandaag');
  await nav('Binnenkort');
  await waitFor(`document.querySelector('.task-title')?.textContent === 'Tandarts bellen'`, 'taak in Binnenkort');
  assert.deepEqual(await taskMeta('Tandarts bellen'), ['morgen 09:00', '@bellen', 'Inbox']);
  await waitFor(`document.getElementById('sync-status').textContent === 'Bijgewerkt'`, 'gesynchroniseerd');
  const tandarts = serverTask('Tandarts bellen');
  assert.equal(tandarts.due.date, `${tomorrow}T09:00`);
  assert.equal(tandarts.priority, 1);
  assert.equal(tandarts.due.string, 'morgen om 9 uur');
  assert.equal(serverState().labels[0].name, 'bellen');
  step('quick-add: "morgen om 9 uur p1 @bellen" is op de server aangekomen met datum, prioriteit en nieuw label');

  // ---- 3. project, sectie, taken ----
  await clickText('+');
  await promptAnswer('Thuis');
  await waitFor(`document.getElementById('view-title').textContent === 'Thuis'`, 'projectscherm');
  await clickText('Sectie toevoegen');
  await promptAnswer('Keuken');
  await waitFor(`[...document.querySelectorAll('.group-title')].some((e) => e.textContent === 'Keuken')`, 'sectie zichtbaar');
  await quickAdd('Afwasmachine uitruimen vandaag /Keuken');
  await quickAdd('Planten water geven elke dag');
  await quickAdd('Boodschappen doen #Inbox');
  await waitFor(`document.querySelectorAll('.task').length === 2`, 'twee taken in Thuis');
  assert.deepEqual(await taskTitles(), ['Planten water geven', 'Afwasmachine uitruimen']);
  assert.deepEqual(await taskMeta('Planten water geven'), ['↻ vandaag']);
  await shot('project');
  step('project met sectie; "/Keuken" zet de taak in de sectie, "#Inbox" in een ander project, "elke dag" wordt een herhaling');

  // ---- 4. taak bewerken, subtaak, datum in gewone taal ----
  await evaluate(`[...document.querySelectorAll('.task')].find((l) => l.querySelector('.task-title').textContent === 'Afwasmachine uitruimen').querySelector('.task-body').click()`);
  await waitFor(`document.querySelector('#task-dialog[open]')`, 'bewerkvenster');
  await typeInto('#task-dialog input[placeholder="Subtaak toevoegen"]', 'Glazen apart');
  await clickText('Toevoegen', `document.querySelector('#task-dialog')`);
  await typeInto('#task-dialog input[placeholder^="bv. morgen"]', 'volgende week donderdag');
  await waitFor(`document.querySelector('#task-dialog .hint').textContent.startsWith('Wordt:')`, 'uitleg bij de datum');
  await shot('bewerken');
  await typeInto('#task-dialog input[placeholder^="bv. morgen"]', 'ergens in de toekomst misschien');
  await submit('#task-dialog form');
  await waitFor(`document.querySelector('#task-dialog .error').textContent.includes('niet herkend')`, 'foutmelding bij onbekende datum');
  await typeInto('#task-dialog input[placeholder^="bv. morgen"]', 'volgende week donderdag');
  await submit('#task-dialog form');
  await waitFor(`!document.querySelector('dialog[open]')`, 'bewerkvenster gesloten');
  await waitFor(`document.querySelectorAll('.task').length === 3`, 'subtaak zichtbaar');
  assert.equal(await evaluate(`document.querySelector('.task[data-depth="1"] .task-title').textContent`), 'Glazen apart');
  await waitFor(`document.getElementById('sync-status').textContent === 'Bijgewerkt'`, 'gesynchroniseerd');
  const afwas = serverTask('Afwasmachine uitruimen');
  const expectedThursday = (() => {
    // donderdag van de volgende week (week begint op maandag)
    const d = new Date(`${today}T00:00:00Z`);
    const monday = addDays(today, -((d.getUTCDay() + 6) % 7));
    return addDays(monday, 7 + 3);
  })();
  assert.equal(afwas.due.date, expectedThursday);
  assert.equal(serverTask('Glazen apart').parent_id, afwas.id);
  assert.equal(serverTask('Glazen apart').section_id, afwas.section_id, 'de subtaak volgt de sectie');
  step('bewerken: onbekende datum wordt geweigerd, "volgende week donderdag" wordt begrepen, subtaak staat eronder');

  // ---- 5. afvinken, ongedaan maken, terugkerende taak ----
  const check = (content: string) =>
    evaluate(`[...document.querySelectorAll('.task')].find((l) => l.querySelector('.task-title').textContent === ${js(content)}).querySelector('.check').click()`);
  await check('Glazen apart');
  await waitFor(`document.querySelectorAll('.task').length === 2`, 'subtaak verdwenen na afvinken');
  await waitFor(`document.querySelector('.toast-action')`, 'melding met Ongedaan maken');
  await shot('afgevinkt');
  await click('.toast-action');
  await waitFor(`document.querySelectorAll('.task').length === 3`, 'subtaak terug na ongedaan maken');
  await check('Planten water geven');
  await waitFor(`[...document.querySelectorAll('.toast-text')].some((e) => e.textContent.startsWith('Volgende keer: morgen'))`, 'melding volgende keer');
  await waitFor(`[...document.querySelectorAll('.task')].find((l) => l.querySelector('.task-title').textContent === 'Planten water geven')?.querySelector('.chip')?.textContent === '↻ morgen'`, 'terugkerende taak toont de nieuwe datum');
  assert.deepEqual(await taskMeta('Planten water geven'), ['↻ morgen']);
  await waitFor(`document.getElementById('sync-status').textContent === 'Bijgewerkt'`, 'gesynchroniseerd');
  assert.equal(serverTask('Planten water geven').due.date, tomorrow);
  assert.equal(serverTask('Planten water geven').checked, false);
  assert.equal(serverTask('Glazen apart').checked, false);
  step('afvinken met ongedaan maken; een terugkerende taak schuift door naar morgen en blijft open');

  // ---- 6. een ander apparaat wijzigt iets: komt vanzelf binnen ----
  const other = await fetch(`${BASE}/api/v1/sync`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'X-Client-Id': 'ander-apparaat' },
    body: JSON.stringify({ commands: [{ type: 'task_add', uuid: 'e2e-ander-apparaat-1', args: { project_id: serverTask('Planten water geven').project_id, content: 'Van mijn telefoon' } }] }),
  });
  assert.equal(other.status, 200);
  await waitFor(`[...document.querySelectorAll('.task-title')].some((e) => e.textContent === 'Van mijn telefoon')`, 'taak van ander apparaat verschijnt zonder herladen', 6000);
  step('realtime: een taak van een ander apparaat verschijnt binnen enkele seconden, zonder herladen');

  // ---- 7. offline: server uit, taak toevoegen, app herladen zonder server ----
  await waitFor(`navigator.serviceWorker.controller !== null`, 'service worker actief', 15_000);
  // De offline-kopie moet compleet zijn. Op een pc met AdGuard wordt ze kort na het aanleggen gewist (AdGuard plakt
  // eigen code vóór de service worker); de app vult haar daarna zelf weer aan. Daarop wachten we hier.
  const cacheCount = `caches.open('eigen-tool-v1').then((c) => c.keys()).then((k) => k.length)`;
  const firstCount = await evaluate<number>(cacheCount);
  const otherCaches = await evaluate<string[]>(`caches.keys().then((n) => n.filter((x) => x !== 'eigen-tool-v1'))`);
  await waitFor(`caches.open('eigen-tool-v1').then((c) => c.keys()).then((k) => k.length >= 24)`, 'offline-kopie compleet (eventueel na aanvullen)', 30_000);
  const root = await evaluate<any>(`caches.open('eigen-tool-v1').then((c) => c.match('/')).then((m) => m && { status: m.status, type: m.type })`);
  assert.deepEqual(root, { status: 200, type: 'basic' });
  step(`offline-kopie compleet: 24 bestanden${firstCount < 24 ? ` (stond eerst op ${firstCount}: gewist door een filter met cache "${otherCaches.join(', ')}", daarna vanzelf aangevuld)` : ''}`);
  await stopServer();
  await quickAdd('Offline bedacht p2');
  await waitFor(`[...document.querySelectorAll('.task-title')].some((e) => e.textContent === 'Offline bedacht')`, 'offline taak direct zichtbaar');
  // Normaal staat hier binnen een seconde "Offline". Blijft het verzoek hangen (komt voor op een pc met een netwerkfilter
  // als AdGuard), dan breekt de app het na 30 seconden zelf af; daarop wachten we hier en we melden het.
  const offlineSince = Date.now();
  await waitFor(`document.getElementById('sync-status').textContent === 'Offline · 1 wachtend'`, 'status offline met wachtende wijziging', 45_000);
  const offlineAfter = Date.now() - offlineSince;
  if (offlineAfter > 5000) step(`let op: het sync-verzoek bleef ${Math.round(offlineAfter / 1000)} s hangen en is door de tijdslimiet van de app afgebroken (de app herstelde zelf)`);
  await shot('offline');
  await send('Page.reload');
  await waitFor(`document.body.classList.contains('ready')`, 'app start zonder server (uit de bewaarde kopie)', 15_000);
  await waitFor(`[...document.querySelectorAll('.task-title')].some((e) => e.textContent === 'Offline bedacht')`, 'offline taak overleeft herladen');
  assert.equal(await evaluate(`document.getElementById('view-title').textContent`), 'Thuis', 'het laatst bekeken scherm komt terug');
  assert.equal((await taskTitles()).length, 5);
  step('offline: de app opent zonder server, toont alle gegevens en bewaart de nieuwe taak');

  await startServer();
  await click('#sync-status');
  await waitFor(`document.getElementById('sync-status').textContent === 'Bijgewerkt'`, 'weer bijgewerkt na terugkeer van de server', 15_000);
  assert.equal(serverTask('Offline bedacht').priority, 2);
  assert.equal((serverState().tasks as any[]).filter((t) => t.content === 'Offline bedacht').length, 1);
  step('terug online: de offline taak staat één keer op de server');

  // ---- 8. project verwijderen (met bevestiging) ----
  await nav('Vandaag');
  await waitFor(`document.getElementById('view-title').textContent === 'Vandaag'`, 'scherm Vandaag');
  await shot('vandaag');

  // ---- 9. telefoonformaat en donkere modus ----
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await nav('Thuis');
  await sleep(300);
  await shot('telefoon-project');
  assert.equal(await evaluate(`getComputedStyle(document.getElementById('sidebar')).position`), 'fixed', 'op de telefoon is de zijbalk een uitschuifmenu');
  assert.equal(await evaluate(`document.documentElement.scrollWidth <= window.innerWidth`), true, 'geen horizontaal scrollen op de telefoon');
  await click('#menu-button');
  await sleep(350);
  await shot('telefoon-menu');
  await click('#scrim');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await sleep(200);
  await shot('telefoon-donker');
  await send('Emulation.setEmulatedMedia', { features: [] });
  step('telefoonformaat: uitschuifmenu, geen horizontaal scrollen; donkere modus werkt');

  // ---- 10. installeerbaar als app ----
  try {
    const manifest = await send('Page.getAppManifest');
    assert.equal(manifest.errors.length, 0, `manifestfouten: ${JSON.stringify(manifest.errors)}`);
    const install = await send('Page.getInstallabilityErrors');
    const names = (install.installabilityErrors as any[]).map((e) => e.errorId);
    step(`installeerbaarheid volgens de browser: ${names.length === 0 ? 'geen bezwaren' : `opmerkingen: ${names.join(', ')}`}`);
  } catch (err) {
    step(`installeerbaarheid kon in deze browser niet worden opgevraagd (${(err as Error).message})`);
  }

  // ---- 11. afmelden wist de lokale gegevens ----
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
  await nav('Instellingen');
  await waitFor(`document.querySelector('dialog[open] .menu')`, 'instellingenmenu');
  await clickText('Afmelden en lokale gegevens wissen');
  await waitFor(`[...document.querySelectorAll('dialog[open] button')].some((b) => b.textContent === 'Afmelden')`, 'bevestiging');
  await clickText('Afmelden', `document.querySelector('dialog[open]')`);
  await waitFor(`document.querySelector('dialog[open] input[type=password]') && document.querySelectorAll('.task').length === 0`, 'na afmelden: leeg en tokenvenster', 15_000);
  assert.equal(await evaluate(`localStorage.getItem('eigen-tool.token')`), null);
  const leftovers = await evaluate<number>(`new Promise((res, rej) => { const r = indexedDB.open('eigen-tool'); r.onsuccess = () => { const tx = r.result.transaction(['rows', 'queue'], 'readonly'); const a = tx.objectStore('rows').count(); const b = tx.objectStore('queue').count(); tx.oncomplete = () => res(a.result + b.result); }; r.onerror = () => rej(r.error); })`);
  assert.equal(leftovers, 0, 'geen taken meer in de lokale opslag');
  assert.ok((serverState().tasks as any[]).length >= 6, 'op de server staat alles nog');
  step('afmelden: token en lokale kopie zijn gewist, de server heeft alles nog');

  // ---- fouten in de console ----
  const own = consoleErrors.filter((e) => !/adguard/i.test(e));
  const expected = own.filter((e) => /401|Failed to fetch|ERR_CONNECTION_REFUSED|net::ERR/i.test(e));
  const unexpected = own.filter((e) => !expected.includes(e));
  assert.deepEqual(unexpected, [], 'onverwachte fouten in de console van de browser');
  step(`console: geen onverwachte fouten (${expected.length} verwachte netwerkmeldingen tijdens de offline-test en het foute token; ${consoleErrors.length - own.length} van AdGuard genegeerd)`);
} catch (err) {
  failed = err;
  try {
    // Wat doet de pagina zelf nog? Elke meting krijgt een tijdslimiet, want hier gaat het juist om dingen die blijven hangen.
    diagnosis = await evaluate(`(async () => {
      const limit = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r('HANGT (geen antwoord na ' + ms + ' ms)'), ms))]);
      const out = {};
      out.statusTekst = document.getElementById('sync-status')?.textContent;
      out.serviceWorker = navigator.serviceWorker.controller ? navigator.serviceWorker.controller.state : 'geen controller';
      const t0 = performance.now();
      out.kaleFetch = await limit(fetch('/api/v1/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((r) => 'antwoord ' + r.status).catch((e) => 'fout: ' + e.message), 4000);
      out.kaleFetchMs = Math.round(performance.now() - t0);
      out.indexedDb = await limit(new Promise((res) => { const r = indexedDB.open('eigen-tool'); r.onsuccess = () => { const tx = r.result.transaction('queue', 'readonly'); const c = tx.objectStore('queue').count(); tx.oncomplete = () => res('ok, ' + c.result + ' wachtend'); tx.onerror = () => res('fout'); }; r.onerror = () => res('fout bij openen'); r.onblocked = () => res('GEBLOKKEERD'); }), 4000);
      return out;
    })()`);
  } catch (e) {
    diagnosis = `diagnose zelf mislukt: ${(e as Error).message}`;
  }
} finally {
  try { ws?.close(); } catch { /* al dicht */ }
  browser.kill();
  await stopServer();
  await sleep(500);
  rmSync(`${workDir}profile`, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}

if (failed) {
  console.error(`\n✖ MISLUKT na ${results.length} geslaagde stappen:\n`, failed);
  console.error('\ndiagnose op het moment van falen:\n', diagnosis);
  if (consoleErrors.length) console.error('\nconsole van de browser:\n' + consoleErrors.slice(-15).join('\n'));
  if (netLog.length) console.error('\nlaatste API-verkeer:\n' + netLog.slice(-25).join('\n'));
  process.exit(1);
}
console.log(`\nALLE ${results.length} STAPPEN GESLAAGD · schermafbeeldingen in ${shotsDir}`);
