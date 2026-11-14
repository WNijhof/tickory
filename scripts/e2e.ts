// Test van de hele app in een echte browser (Edge of Chrome, zonder venster), bestuurd via het DevTools-protocol.
// Start zelf een server met een lege database in het geheugen; raakt geen echte gegevens.
//
// Gebruik: node scripts/e2e.ts [pad-naar-browser]
// Schermafbeeldingen komen in .e2e/shots/. Sluit af met code 1 als een controle mislukt.
//
// De test loopt in het Nederlands, welke taal het systeem of de browser ook heeft: de talen van de browser worden via het
// DevTools-protocol op Nederlands gezet. Eén stap zet ze op Engels (de app moet dan vanzelf Engels kiezen) en één stap
// wisselt in de app naar Engels en terug. Met E2E_BROWSER_LANG=en-US start de browser zelf in die taal, om te
// controleren dat de test daar niet van afhangt.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { createSchema } from '../server/schema.ts';
import { createApp } from '../server/main.ts';
import { createPush } from '../server/push.ts';
import type { App } from '../server/main.ts';
import { handleSync } from '../server/sync.ts';
import { createSession, createUser, hashPassword, setPasswordCostForTests } from '../server/users.ts';
import { addDays, formatDate, formatDateInput, formatDueLong, todayString } from '../client/core/format.js';
import { addMonths, isoWeek, periodTitle } from '../client/core/calendar.js';
import { quickDates } from '../client/core/quickDates.js';
import { setLanguage } from '../client/core/i18n.js';
import { FILTER_EXAMPLES, FILTER_TERM_GROUPS } from '../client/core/filterText.js';
import dutchTexts from '../client/i18n/nl.js';
import en from '../client/i18n/en.js';
import { dragAndDropScenario } from './e2e-dnd.ts';
import { attachmentScenario } from './e2e-attachments.ts';
import { createAttachments } from '../server/attachments.ts';
import { geoScenario } from './e2e-geo.ts';
import { bulkScenario } from './e2e-bulk.ts';
import { templatesScenario } from './e2e-templates.ts';
import { notifyScenario } from './e2e-notify.ts';
import { rolesScenario } from './e2e-roles.ts';
import { boardDragScenario, boardTouchScenario, calendarDragScenario, calendarTouchScenario } from './e2e-views.ts';

const BROWSERS = [
  process.argv[2],
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/chromium', '/usr/bin/google-chrome',
].filter(Boolean) as string[];
const browserPath = BROWSERS.find((p) => existsSync(p));
if (!browserPath) throw new Error('geen browser gevonden; geef het pad mee als argument');

// Poorten zijn in te stellen (E2E_PORT, E2E_CDP_PORT), zodat er meerdere testen naast elkaar kunnen draaien.
const APP_PORT = Number(process.env.E2E_PORT ?? 8791);
const CDP_PORT = Number(process.env.E2E_CDP_PORT ?? 9341);
const BASE = `http://127.0.0.1:${APP_PORT}`;
const workDir = fileURLToPath(new URL('../.e2e/', import.meta.url));
const shotsDir = `${workDir}shots/`;
rmSync(workDir, { recursive: true, force: true });
mkdirSync(shotsDir, { recursive: true });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Het aantal bestanden dat de app offline bewaart en de naam van die bewaarplaats, uit de service worker zelf (zodat dit nooit achterloopt).
const swSource = readFileSync(fileURLToPath(new URL('../client/sw.js', import.meta.url)), 'utf8');
const SHELL_COUNT = (swSource.split('const SHELL = [')[1].split('];')[0].match(/'\/[^']*'/g) ?? []).length;
const CACHE_NAME = /const CACHE = '([^']+)'/.exec(swSource)![1];
const results: string[] = [];
const step = (text: string) => { results.push(text); console.log(`✔ ${text}`); };

// ---------- server ----------
setPasswordCostForTests(1024); // snelle wachtwoordhash; alleen voor deze test
const db = new DatabaseSync(':memory:');
createSchema(db);
const PASSWORD_ALICE = 'alice-wachtwoord-1';
const PASSWORD_BOB = 'bob-wachtwoord-123';
const alice = createUser(db, { username: 'alice', name: 'Alice', passwordHash: await hashPassword(PASSWORD_ALICE) });
const bob = createUser(db, { username: 'bob', name: 'Bob', passwordHash: await hashPassword(PASSWORD_BOB) });
// Bijlagen: de bestanden staan in een map naast de testgegevens; een bestand mag hier hooguit 5 MB zijn
const attachments = createAttachments(db, { dir: `${workDir}attachments`, maxUploadBytes: 5_000_000, quotaBytes: 50_000_000 });
let app: App | null = null;
async function startServer() {
  // met meldingen in de browser, zoals de echte server; de klok staat uit (niets wordt verstuurd, er is ook geen apparaat aangemeld)
  app = createApp({ db, push: createPush({ db }), pushIntervalMs: 0, attachments, attachmentSweepMs: 0 });
  await new Promise<void>((r) => app!.server.listen(APP_PORT, '127.0.0.1', r));
}
async function stopServer() {
  await app?.close();
  app = null;
}
const serverState = (as = alice.id) => handleSync(db, { sync_token: '*' }, as) as Record<string, any>;
const serverTask = (content: string) => (serverState().tasks as any[]).find((t) => t.content === content);

// ---------- browser ----------
await startServer();
const browser = spawn(browserPath, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${workDir}profile`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1280,860',
  ...(process.env.E2E_BROWSER_LANG ? [`--lang=${process.env.E2E_BROWSER_LANG}`] : []), 'about:blank',
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
/**
 * Echt bijgewerkt. De statusregel loopt één beeldverversing achter op de wachtrij; daarom eerst twee verversingen wachten,
 * zodat een zojuist gemaakte wijziging al als "wachtend" in beeld staat voordat we "Bijgewerkt" geloven.
 */
const js = (v: unknown) => JSON.stringify(v);
const synced = (label: string) => `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(document.getElementById('sync-status').textContent === ${js(label)}))))`;
const SYNCED = synced('Bijgewerkt');
const SYNCED_EN = synced('Up to date');
/**
 * Een sync-verzoek van "een ander apparaat", rechtstreeks vanuit deze test. Eén herhaling bij een verbroken verbinding:
 * na het stoppen en starten van de server kan Node nog een oude, bewaarde verbinding proberen. Elk commando heeft een
 * vaste uuid, dus herhalen is veilig.
 */
async function syncAs(token: string, clientId: string, commands: object[]): Promise<Response> {
  const request = () => fetch(`${BASE}/api/v1/sync`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Client-Id': clientId },
    body: JSON.stringify({ commands }),
  });
  try {
    return await request();
  } catch {
    await sleep(250);
    return request();
  }
}
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
let perf = '';
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

  // ---- 0. de taal: de app volgt de talen van de browser zolang er geen voorkeur is bewaard ----
  // Hiermee staat de taal van de test ook vast: daarna Nederlands, wat de eigen taal van de browser ook is.
  const { userAgent } = await send('Browser.getVersion');
  const setBrowserLanguages = (list: string) => send('Emulation.setUserAgentOverride', { userAgent, acceptLanguage: list });
  const ownLanguages = await evaluate<string[]>(`[...navigator.languages]`);
  await setBrowserLanguages('en-US,en');
  await send('Page.navigate', { url: `${BASE}/` });
  await waitFor(`document.body.classList.contains('ready')`, 'app gestart (Engelse browser)');
  await waitFor(`document.querySelector('dialog[open] input[type=password]')`, 'inlogscherm (Engelse browser)');
  assert.deepEqual(await evaluate(`[...navigator.languages]`), ['en-US', 'en'], 'de browser meldt nu Engels');
  assert.equal(await evaluate(`localStorage.getItem('tickory.lang')`), null, 'er is nog geen voorkeur bewaard');
  assert.equal(await evaluate(`document.documentElement.lang`), 'en');
  assert.equal(await evaluate(`document.querySelector('dialog[open] h2').textContent`), 'Sign in');
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('dialog[open] label')].map((l) => l.firstChild.textContent)`), ['Username', 'Password']);
  assert.equal(await evaluate(`document.getElementById('quick-input').placeholder`), en['quick.placeholder']);
  assert.equal(await evaluate(`document.querySelector('#quick-add button[type=submit]').textContent`), 'Add');
  assert.equal(await evaluate(`document.getElementById('sync-status').textContent`), 'Sign-in required');
  await typeInto('dialog[open] input[autocomplete=username]', 'alice');
  await typeInto('dialog[open] input[type=password]', 'verkeerd-wachtwoord');
  await submit('dialog[open] form');
  await waitFor(`document.querySelector('dialog[open] .error')?.textContent === 'Incorrect username or password.'`, 'Engelse foutmelding bij fout wachtwoord');
  await shot('engels-inloggen');
  await setBrowserLanguages('nl-NL,nl');
  step(`taal: een Engelse browser krijgt vanzelf de Engelse app, met een eigen Engelse foutmelding (de browser van deze test meldt zelf ${JSON.stringify(ownLanguages)})`);

  // ---- 1. eerste keer openen: inloggen ----
  await send('Page.navigate', { url: `${BASE}/` });
  await waitFor(`document.body.classList.contains('ready')`, 'app gestart');
  await waitFor(`document.querySelector('dialog[open] input[type=password]')`, 'inlogscherm');
  assert.deepEqual(await evaluate(`[...navigator.languages]`), ['nl-NL', 'nl'], 'de browser meldt nu Nederlands');
  assert.equal(await evaluate(`document.documentElement.lang`), 'nl');
  await shot('inloggen');
  assert.equal(await evaluate(`document.querySelector('dialog[open] h2').textContent`), 'Inloggen');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(150);
  assert.ok(await evaluate(`Boolean(document.querySelector('dialog[open] input[type=password]'))`), 'Escape sluit het inlogscherm niet');
  await typeInto('dialog[open] input[autocomplete=username]', 'alice');
  await typeInto('dialog[open] input[type=password]', 'verkeerd-wachtwoord');
  await submit('dialog[open] form');
  await waitFor(`document.querySelector('dialog[open] .error')?.textContent === 'Gebruikersnaam of wachtwoord klopt niet'`, 'foutmelding bij fout wachtwoord');
  assert.equal(await evaluate(`document.querySelector('dialog[open] input[type=password]').value`), '', 'het wachtwoord wordt gewist');
  step('fout wachtwoord: duidelijke melding, het inlogscherm blijft staan (ook na Escape)');
  await typeInto('dialog[open] input[autocomplete=username]', 'Alice'); // hoofdletters maken niet uit
  await typeInto('dialog[open] input[type=password]', PASSWORD_ALICE);
  await submit('dialog[open] form');
  await waitFor(`!document.querySelector('dialog[open]')`, 'inlogscherm gesloten');
  await waitFor(`await ${SYNCED}`, 'eerste sync');
  await waitFor(`[...document.querySelectorAll('.nav-label')].some((e) => e.textContent === 'Inbox')`, 'Inbox in de zijbalk');
  assert.ok(await evaluate(`[...document.querySelectorAll('.nav-label')].some((e) => e.textContent === 'Alice')`), 'de naam van de gebruiker staat in de zijbalk');
  assert.equal(await evaluate(`(localStorage.getItem('tickory.token') || '').startsWith('tky_')`), true);
  step('juist wachtwoord: ingelogd, Inbox zichtbaar, naam in de zijbalk');

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
  assert.deepEqual(await taskMeta('Tandarts bellen'), ['morgen 09:00', '@bellen', '🔔', 'Inbox']);
  await waitFor(`await ${SYNCED}`, 'gesynchroniseerd');
  const tandarts = serverTask('Tandarts bellen');
  assert.equal(tandarts.due.date, `${tomorrow}T09:00`);
  assert.equal(tandarts.priority, 1);
  assert.equal(tandarts.due.string, 'morgen om 9 uur');
  assert.equal(serverState().labels[0].name, 'bellen');
  step('quick-add: "morgen om 9 uur p1 @bellen" is op de server aangekomen met datum, prioriteit en nieuw label');

  // ---- 3. project, sectie, taken ----
  await click('.nav-heading button');
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
  await sleep(150);
  await shot('bewerken');
  await typeInto('#task-dialog input[placeholder^="bv. morgen"]', 'ergens in de toekomst misschien');
  await submit('#task-dialog form');
  await waitFor(`document.querySelector('#task-dialog .error').textContent.includes('niet herkend')`, 'foutmelding bij onbekende datum');
  await typeInto('#task-dialog input[placeholder^="bv. morgen"]', 'volgende week donderdag');
  await submit('#task-dialog form');
  await waitFor(`!document.querySelector('dialog[open]')`, 'bewerkvenster gesloten');
  await waitFor(`document.querySelectorAll('.task').length === 3`, 'subtaak zichtbaar');
  assert.equal(await evaluate(`document.querySelector('.task[data-depth="1"] .task-title').textContent`), 'Glazen apart');
  await waitFor(`await ${SYNCED}`, 'gesynchroniseerd');
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
  await evaluate(`document.querySelectorAll('.toast-close').forEach((b) => b.click())`); // ook opslaan en verwijderen hebben nu een melding met Ongedaan maken
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
  await waitFor(`await ${SYNCED}`, 'gesynchroniseerd');
  assert.equal(serverTask('Planten water geven').due.date, tomorrow);
  assert.equal(serverTask('Planten water geven').checked, false);
  assert.equal(serverTask('Glazen apart').checked, false);
  step('afvinken met ongedaan maken; een terugkerende taak schuift door naar morgen en blijft open');

  // ---- 5b. Nederlands: accenten, hoofdletters, IJ, ontleed getypte tekens, feestdagen en "de tweede dinsdag" ----
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const nextFixed = (month: number, day: number): string => {
    const t0 = new Date(); t0.setHours(0, 0, 0, 0);
    const y = t0.getFullYear();
    return `${new Date(y, month - 1, day) >= t0 ? y : y + 1}-${pad2(month)}-${pad2(day)}`;
  };
  await nav('Inbox');
  await waitFor(`document.getElementById('view-title').textContent === 'Inbox'`, 'scherm Inbox');
  await quickAdd('Morgen ijs kopen');
  await quickAdd('Café reserveren @één voor Sinterklaas');
  await quickAdd('Zoë bellen @ÉÉN'); // de ë als e + los trema, zoals sommige toetsenborden het opleveren
  await quickAdd('Oud papier elke tweede dinsdag');
  await quickAdd('Kerstdiner reserveren 25 december');
  await waitFor(`['IJs kopen', 'Café reserveren', 'Zoë bellen', 'Oud papier', 'Kerstdiner reserveren'].every((t) => [...document.querySelectorAll('.task .task-title')].some((e) => e.textContent === t))`, 'vijf Nederlandse taken in de Inbox');
  const nlTitles = await taskTitles();
  for (const t of ['IJs kopen', 'Café reserveren', 'Zoë bellen', 'Oud papier', 'Kerstdiner reserveren']) assert.ok(nlTitles.includes(t), `"${t}" ontbreekt in ${JSON.stringify(nlTitles)}`);
  assert.ok(nlTitles.every((t) => t === t.normalize('NFC')), `alle titels horen al in NFC te staan: ${JSON.stringify(nlTitles)}`);
  assert.ok(!nlTitles.some((t) => /Ijs/.test(t)), 'geen "Ijs": in het Nederlands is het "IJs"');
  await shot('nederlands');
  await waitFor(`await ${SYNCED}`, 'gesynchroniseerd');
  const nl = serverState();
  const labelNames = (nl.labels as any[]).map((l) => l.name);
  assert.deepEqual(labelNames.filter((n) => n.normalize('NFC').toLowerCase() === 'één').length, 1, `één label "één" (en niet ook "ÉÉN"): ${JSON.stringify(labelNames)}`);
  const een = (nl.labels as any[]).find((l) => l.name.toLowerCase() === 'één').id;
  assert.equal(serverTask('IJs kopen').due.date, tomorrow);
  assert.equal(serverTask('Café reserveren').due.date, nextFixed(12, 5));
  assert.deepEqual(serverTask('Café reserveren').labels, [een]);
  assert.equal(serverTask('Zoë bellen').content, 'Zoë bellen', 'op de server als NFC');
  assert.deepEqual(serverTask('Zoë bellen').labels, [een], 'het label in hoofdletters is hetzelfde label');
  assert.deepEqual(serverTask('Oud papier').due.recurrence, { freq: 'monthly', byweekday: [2], nth: 2 });
  assert.equal(serverTask('Kerstdiner reserveren').due.date, nextFixed(12, 25));
  step('Nederlands: "ijs" wordt "IJs", "é" en een los getypte "ë" kloppen, "@ÉÉN" is het label "één", "voor Sinterklaas" en "25 december" geven de juiste datum, "elke tweede dinsdag" is een echte herhaling');
  await nav('Thuis');
  await waitFor(`document.getElementById('view-title').textContent === 'Thuis'`, 'terug naar Thuis');

  // ---- 6. een ander apparaat wijzigt iets: komt vanzelf binnen ----
  const otherToken = createSession(db, alice.id, 'Telefoon').token;
  // slepen en verplaatsen (scripts/e2e-dnd.ts); met E2E_DND_ONLY=1 alleen dat onderdeel, om er snel aan te kunnen werken
  const dndScenario = () => dragAndDropScenario({ send, evaluate, waitFor, step, shot, sleep, js, SYNCED, db, alice, bob, syncAs, serverState, otherToken, startServer, stopServer });
  // meldingen bij samenwerken en @-vermeldingen (scripts/e2e-notify.ts); met E2E_NOTIFY_ONLY=1 alleen dat onderdeel
  const notifyCtx = () => ({ send, evaluate, waitFor, step, shot, sleep, js, SYNCED, db, alice, bob, syncAs, serverState, typeInto, click, clickText, nav });
  if (process.env.E2E_NOTIFY_ONLY) {
    try { await notifyScenario(notifyCtx()); console.log('ALLEEN MELDINGEN: GESLAAGD'); } catch (err) { console.error(err); if (consoleErrors.length) console.error(consoleErrors.slice(-10).join(' | ')); await shot('MISLUKT-meldingen'); process.exitCode = 1; }
    browser.kill();
    await stopServer();
    process.exit(process.exitCode ?? 0);
  }
  if (process.env.E2E_DND_ONLY) {
    try { await dndScenario(); console.log('ALLEEN SLEPEN: GESLAAGD'); } catch (err) { console.error(err); if (consoleErrors.length) console.error(consoleErrors.slice(-10).join(' | ')); await shot('MISLUKT-slepen'); process.exitCode = 1; }
    browser.kill();
    await stopServer();
    process.exit(process.exitCode ?? 0);
  }
  // meerdere taken selecteren, ongedaan maken en Voltooid (scripts/e2e-bulk.ts); met E2E_BULK_ONLY=1 alleen dat onderdeel
  const bulkCtx = { send, evaluate, waitFor, step, shot, sleep, js, SYNCED, db, alice, bob, syncAs, serverState, otherToken, startServer, stopServer };
  if (process.env.E2E_BULK_ONLY) {
    try { await bulkScenario(bulkCtx); console.log('ALLEEN SELECTEREN: GESLAAGD'); } catch (err) { console.error(err); if (consoleErrors.length) console.error(consoleErrors.slice(-10).join(' | ')); await shot('MISLUKT-selecteren'); process.exitCode = 1; }
    browser.kill();
    await stopServer();
    process.exit(process.exitCode ?? 0);
  }
  const other = await syncAs(otherToken, 'ander-apparaat', [{ type: 'task_add', uuid: 'e2e-ander-apparaat-1', args: { project_id: serverTask('Planten water geven').project_id, content: 'Van mijn telefoon' } }]);
  assert.equal(other.status, 200);
  await waitFor(`[...document.querySelectorAll('.task-title')].some((e) => e.textContent === 'Van mijn telefoon')`, 'taak van ander apparaat verschijnt zonder herladen', 6000);
  step('realtime: een taak van een ander apparaat verschijnt binnen enkele seconden, zonder herladen');

  // ---- 7. offline: server uit, taak toevoegen, app herladen zonder server ----
  await waitFor(`navigator.serviceWorker.controller !== null`, 'service worker actief', 15_000);
  // De offline-kopie moet compleet zijn. Op een pc met AdGuard wordt ze kort na het aanleggen gewist (AdGuard plakt
  // eigen code vóór de service worker); de app vult haar daarna zelf weer aan. Daarop wachten we hier.
  const cacheCount = `caches.open(${js(CACHE_NAME)}).then((c) => c.keys()).then((k) => k.length)`;
  const firstCount = await evaluate<number>(cacheCount);
  const otherCaches = await evaluate<string[]>(`caches.keys().then((n) => n.filter((x) => x !== ${js(CACHE_NAME)}))`);
  await waitFor(`caches.open(${js(CACHE_NAME)}).then((c) => c.keys()).then((k) => k.length >= ${SHELL_COUNT})`, 'offline-kopie compleet (eventueel na aanvullen)', 30_000);
  const root = await evaluate<any>(`caches.open(${js(CACHE_NAME)}).then((c) => c.match('/')).then((m) => m && { status: m.status, type: m.type })`);
  assert.deepEqual(root, { status: 200, type: 'basic' });
  step(`offline-kopie compleet: ${SHELL_COUNT} bestanden${firstCount < SHELL_COUNT ? ` (stond eerst op ${firstCount}: gewist door een filter met cache "${otherCaches.join(', ')}", daarna vanzelf aangevuld)` : ''}`);
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
  await waitFor(`await ${SYNCED}`, 'weer bijgewerkt na terugkeer van de server', 15_000);
  assert.equal(serverTask('Offline bedacht').priority, 2);
  assert.equal((serverState().tasks as any[]).filter((t) => t.content === 'Offline bedacht').length, 1);
  step('terug online: de offline taak staat één keer op de server');

  // ---- 8. project verwijderen (met bevestiging) ----
  await nav('Vandaag');
  await waitFor(`document.getElementById('view-title').textContent === 'Vandaag'`, 'scherm Vandaag');
  await shot('vandaag');

  // ---- 8b. een project delen, samenwerken en toewijzen ----
  await nav('Thuis');
  await waitFor(`document.getElementById('view-title').textContent === 'Thuis'`, 'scherm Thuis');
  await clickText('Delen');
  await waitFor(`document.querySelector('dialog[open] h2')?.textContent === 'Delen: Thuis'`, 'deelvenster');
  assert.ok(await evaluate(`document.querySelector('dialog[open]').textContent.includes('Alice')`), 'jij staat in de lijst');
  await typeInto('dialog[open] input[aria-label="Gebruikersnaam van de persoon"]', 'niemand-bekend');
  await submit('dialog[open] form.subtask-row');
  await waitFor(`[...document.querySelectorAll('.toast-text')].some((e) => e.textContent === 'Niet gelukt (project delen). Deze gebruiker bestaat niet.')`, 'melding: gebruiker bestaat niet');
  await typeInto('dialog[open] input[aria-label="Gebruikersnaam van de persoon"]', 'Bob');
  await submit('dialog[open] form.subtask-row');
  await waitFor(`[...document.querySelectorAll('dialog[open] .device-info strong')].some((e) => e.textContent.startsWith('Bob'))`, 'Bob in de ledenlijst');
  await shot('delen');
  await clickText('Sluiten', `document.querySelector('dialog[open]')`);
  await waitFor(`document.querySelector('.shared-with')?.textContent.startsWith('Gedeeld met Bob')`, 'regel "Gedeeld met Bob"');
  assert.ok(await evaluate(`[...document.querySelectorAll('.nav-item')].find((b) => b.querySelector('.nav-label')?.textContent === 'Thuis').querySelector('.nav-shared')`), 'het project staat als gedeeld in de zijbalk');
  const bobView = serverState(bob.id);
  assert.deepEqual((bobView.projects as any[]).map((p) => p.name).sort(), ['Inbox', 'Thuis']);
  assert.ok((bobView.tasks as any[]).some((t) => t.content === 'Planten water geven'), 'bob ziet de taken in het gedeelde project');
  assert.ok(!(bobView.tasks as any[]).some((t) => t.content === 'Tandarts bellen'), 'bob ziet niets uit Alice\' Inbox');
  step('delen via het scherm: onbekende gebruiker geeft een duidelijke melding, "Bob" wordt lid; Bob ziet het project en niets anders van Alice');

  const bobToken = createSession(db, bob.id, 'Bob zijn telefoon').token;
  const thuisId = (serverState().projects as any[]).find((p) => p.name === 'Thuis').id;
  const fromBob = await syncAs(bobToken, 'bob-telefoon', [{ type: 'task_add', uuid: 'e2e-bob-taak-0001', args: { project_id: thuisId, content: 'Gordijnen ophangen', assignee_id: alice.id } }]);
  assert.equal(fromBob.status, 200);
  await waitFor(`[...document.querySelectorAll('.task-title')].some((e) => e.textContent === 'Gordijnen ophangen')`, 'taak van Bob verschijnt vanzelf', 6000);
  assert.deepEqual(await taskMeta('Gordijnen ophangen'), ['voor jou']);
  step('realtime samenwerken: een taak van Bob die aan Alice is toegewezen verschijnt vanzelf met "voor jou"');

  await evaluate(`[...document.querySelectorAll('.task')].find((l) => l.querySelector('.task-title').textContent === 'Gordijnen ophangen').querySelector('.task-body').click()`);
  await waitFor(`document.querySelector('#task-dialog[open]')`, 'bewerkvenster');
  assert.ok(await evaluate(`[...document.querySelectorAll('#task-dialog select[aria-label="Toegewezen aan"] option')].map((o) => o.textContent).join('|') === '(niemand)|Alice (jij)|Bob'`), 'kiezen kan uit de leden van het project');
  await evaluate(`(() => { const sel = document.querySelector('#task-dialog select[aria-label="Toegewezen aan"]'); sel.value = ${js(bob.id)}; })()`);
  await submit('#task-dialog form');
  await waitFor(`!document.querySelector('dialog[open]')`, 'bewerkvenster gesloten');
  await waitFor(`await ${SYNCED}`, 'gesynchroniseerd');
  assert.equal(serverTask('Gordijnen ophangen').assignee_id, bob.id);
  assert.deepEqual(await taskMeta('Gordijnen ophangen'), ['voor Bob']);
  step('toewijzen in het bewerkvenster: de taak gaat naar Bob');

  // ---- 8c. account, apparaten en beheer ----
  await nav('Alice');
  await waitFor(`document.querySelector('dialog[open] .menu')`, 'instellingenmenu');
  await clickText('Account, wachtwoord en apparaten');
  await waitFor(`document.querySelector('dialog[open] .device .badge')?.textContent === 'dit apparaat'`, 'apparatenlijst');
  assert.ok(await evaluate(`document.querySelector('dialog[open]').textContent.includes('Alice') && document.querySelector('dialog[open]').textContent.includes('beheerder')`));
  await shot('account');
  await clickText('Gebruikersbeheer');
  await waitFor(`[...document.querySelectorAll('dialog[open] .device strong')].map((e) => e.textContent).join(',').includes('Bob')`, 'gebruikerslijst');
  await evaluate(`document.querySelectorAll('dialog[open] details')[1].open = true`);
  await typeInto('dialog[open] input[aria-label="Gebruikersnaam"]', 'carol');
  await typeInto('dialog[open] input[aria-label="Naam"]', 'Carol de Vries');
  await typeInto('dialog[open] input[aria-label="Beginwachtwoord"]', 'kort');
  await submit('dialog[open] details:nth-of-type(2) form');
  await sleep(200);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM users WHERE username = 'carol'").get() as any).n, 0, 'een te kort wachtwoord wordt niet verstuurd');
  await typeInto('dialog[open] input[aria-label="Beginwachtwoord"]', 'carol-wachtwoord-1');
  await submit('dialog[open] details:nth-of-type(2) form');
  await waitFor(`[...document.querySelectorAll('dialog[open] .device strong')].some((e) => e.textContent.startsWith('Carol de Vries'))`, 'Carol in de lijst');
  assert.ok((db.prepare("SELECT COUNT(*) AS n FROM users WHERE username = 'carol'").get() as any).n === 1);
  await shot('beheer');
  await clickText('Sluiten', `document.querySelector('dialog[open]')`);
  await waitFor(`document.querySelector('dialog[open] h2')?.textContent === 'Account'`, 'terug in het accountscherm');
  await clickText('Sluiten', `document.querySelector('dialog[open]')`);
  await waitFor(`!document.querySelector('dialog[open]')`, 'alles gesloten');
  step('account: apparatenlijst met "dit apparaat"; beheer: een account aanmaken via het scherm (te kort wachtwoord wordt geweigerd)');

  // ---- 8d. Engels: in de app wisselen, de schermen nalopen, en terug naar Nederlands ----
  /** Wat de app in het Engels zou tonen, uitgerekend met dezelfde code als de app (hier in Node). */
  const inEnglish = <T>(fn: () => T): T => { setLanguage('en'); try { return fn(); } finally { setLanguage('nl'); } };
  const texts = (selector: string) => evaluate<string[]>(`[...document.querySelectorAll(${js(selector)})].map((e) => e.textContent)`);
  const buttons = (root = 'dialog[open]') => evaluate<string[]>(`[...document.querySelectorAll(${js(`${root} button`)})].filter((b) => !b.closest('[hidden]')).map((b) => b.textContent.trim())`);
  const openMenu = async (label: string) => { await nav(label); await waitFor(`document.querySelector('dialog[open] .menu')`, 'instellingenmenu'); };
  const openTask = async (content: string) => {
    // een zojuist gesloten venster verdwijnt pas een tel later uit de pagina; daarop wachten, anders lezen we het oude uit
    await waitFor(`!document.querySelector('#task-dialog')`, 'het vorige bewerkvenster is weg');
    await evaluate(`[...document.querySelectorAll('.task')].find((l) => l.querySelector('.task-title').textContent === ${js(content)}).querySelector('.task-body').click()`);
    await waitFor(`document.querySelector('#task-dialog[open]')`, 'bewerkvenster');
  };
  /** Alles wat op dit moment te lezen is: de tekst op het scherm, en de teksten voor schermlezers, tooltips en lege velden. */
  const screenText = () => evaluate<string>(`(() => {
    const parts = [document.title, document.body.innerText];
    for (const el of document.querySelectorAll('[aria-label], [title], [placeholder]')) {
      for (const a of ['aria-label', 'title', 'placeholder']) if (el.getAttribute(a)) parts.push(el.getAttribute(a));
    }
    for (const el of document.querySelectorAll('option')) parts.push(el.textContent);
    return parts.join('\\n');
  })()`);
  // Elk stuk Nederlandse tekst uit het woordenboek dat niet ook Engels is ("Project", "Deadline" en "nov" tellen dus niet mee).
  const pieces = (dictionary: Record<string, unknown>) => Object.values(dictionary).flatMap((v) => (typeof v === 'string' ? [v] : Object.values(v as object) as string[]));
  const asWord = (s: string) => new RegExp(`(?<![\\p{L}])${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}])`, 'iu');
  const englishText = pieces(en).join('\n');
  const dutchPieces = [...new Set(pieces(dutchTexts).flatMap((text) => text.split(/\{\w+\}/)).map((s) => s.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '')))]
    .filter((s) => s.replace(/[^\p{L}]/gu, '').length >= 3 && !asWord(s).test(englishText));
  assert.ok(dutchPieces.length > 150 && dutchPieces.includes('Vandaag') && dutchPieces.includes('kan bewerken') && !dutchPieces.includes('Project'), `de lijst met Nederlandse teksten klopt niet (${dutchPieces.length})`);
  const checked: string[] = [];
  /** Controleert dat er op dit scherm geen Nederlandse tekst van de app staat (gegevens van de gebruiker mogen Nederlands zijn). */
  const noDutch = async (screen: string, userTexts: string[] = []) => {
    let text = await screenText();
    for (const user of userTexts) text = text.split(user).join(' '); // wat de gebruiker zelf typte (taken, opmerkingen) mag Nederlands zijn
    const found = dutchPieces.filter((p) => asWord(p).test(text));
    assert.deepEqual(found, [], `Nederlandse tekst in de Engelse interface (${screen})`);
    checked.push(screen);
  };
  const fits = async (what: string) => {
    assert.equal(await evaluate(`document.documentElement.scrollWidth <= window.innerWidth`), true, `${what}: de pagina is breder dan het scherm`);
    assert.equal(await evaluate(`[...document.querySelectorAll('dialog[open]')].every((d) => d.scrollWidth <= d.clientWidth + 1 && d.getBoundingClientRect().right <= window.innerWidth + 1)`), true, `${what}: het venster past niet`);
    // knoppen en vaste labels mogen niet afgekapt zijn (namen van de gebruiker wel: die krijgen bewust een beletselteken)
    const clipped = await evaluate<string[]>(`[...document.querySelectorAll('button:not(.nav-item):not(.task-body), .field-label, .hint, .group-title, summary, .badge, h2')].filter((e) => e.offsetParent !== null && e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent.trim().slice(0, 40))`);
    assert.deepEqual(clipped, [], `${what}: afgekapte tekst`);
  };

  // in het Nederlands geeft een Engelse datum geen uitleg over de datumtaal; die is er alleen in een andere taal
  await typeInto('#quick-input', 'Call the dentist tomorrow');
  await waitFor(`document.querySelector('#quick-preview .chip-title')?.textContent === 'Call the dentist tomorrow'`, 'voorbeeld in het Nederlands');
  assert.equal(await evaluate(`document.querySelector('#quick-preview .preview-note')`), null);
  await typeInto('#quick-input', '');

  // exporteren: de bestanden worden op het apparaat gemaakt (een blob-download); hier onderscheppen we ze
  await evaluate(`window.__downloads = []; const orig = URL.createObjectURL.bind(URL); URL.createObjectURL = (blob) => { blob.arrayBuffer().then((buf) => window.__downloads.push({ type: blob.type, text: new TextDecoder('utf-8', { ignoreBOM: true }).decode(buf) })); return orig(blob); }; HTMLAnchorElement.prototype.click = function () { window.__downloads.names = [...(window.__downloads.names || []), this.download]; };`);
  await openMenu('Alice');
  await clickText('Gegevens exporteren');
  await waitFor(`document.querySelector('dialog[open] h2')?.textContent === 'Gegevens exporteren'`, 'exportscherm');
  await click('dialog[open] [data-role="export-json"]');
  await click('dialog[open] [data-role="export-csv-all"]');
  await waitFor(`window.__downloads.length === 2`, 'twee bestanden gemaakt');
  const exported = await evaluate<{ type: string; text: string }[]>(`window.__downloads.map((d) => ({ type: d.type, text: d.text }))`);
  const names = await evaluate<string[]>(`window.__downloads.names`);
  assert.match(names[0], /^tickory-export-\d{4}-\d{2}-\d{2}\.json$/);
  assert.match(names[1], /^tickory-taken-\d{4}-\d{2}-\d{2}\.csv$/);
  const parsed = JSON.parse(exported[0].text);
  assert.equal(parsed.format, 'tickory-export');
  assert.equal(parsed.user.username, 'alice');
  assert.ok(parsed.tasks.length > 0 && parsed.projects.length > 0, 'taken en projecten staan erin');
  assert.ok(exported[1].text.startsWith('﻿PROJECT,TYPE,CONTENT,DESCRIPTION,PRIORITY,INDENT,AUTHOR,RESPONSIBLE,DATE,DATE_LANG,TIMEZONE\r\n'), 'CSV met BOM en kopregel');
  const someTask = parsed.tasks.find((t: any) => !t.is_deleted && t.content);
  assert.ok(someTask && exported[1].text.includes(someTask.content), 'een taak uit de JSON staat ook in de CSV');
  await clickText('Sluiten');
  await waitFor(`!document.querySelector('dialog[open]')`, 'exportscherm gesloten');
  await evaluate(`delete HTMLAnchorElement.prototype.click`);

  // weergave: donker en een andere accentkleur, meteen zichtbaar, bewaard na herladen; licht kiezen op een donker apparaat; terug naar de standaard
  const wasDark = await evaluate<boolean>(`matchMedia('(prefers-color-scheme: dark)').matches`);
  const emulateScheme = (value: string) => send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value }] });
  const accentNow = () => evaluate<string>(`getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()`);
  const bgNow = () => evaluate<string>(`getComputedStyle(document.body).backgroundColor`);
  const LIGHT_BG = 'rgb(255, 255, 255)';
  const DARK_BG = 'rgb(22, 25, 28)';
  const openAppearance = async () => {
    await openMenu('Alice');
    await clickText('Weergave');
    await waitFor(`document.querySelector('dialog[open] h2')?.textContent === 'Weergave'`, 'scherm Weergave');
  };
  await emulateScheme('light');
  assert.equal(await bgNow(), LIGHT_BG, 'het apparaat staat licht');
  await openAppearance();
  await click('dialog[open] [data-role="theme-choice"] input[value="dark"]');
  await click('dialog[open] [data-role="accent-choice"] input[value="rose"]');
  await waitFor(`document.documentElement.dataset.theme === 'dark' && document.documentElement.dataset.accent === 'rose'`, 'donker en roze gekozen');
  assert.equal(await accentNow(), '#f9a8c9', 'de donkere roze accentkleur');
  assert.equal(await bgNow(), DARK_BG, 'donker, ook al staat het apparaat licht');
  assert.equal(await evaluate(`document.querySelector('meta[name="theme-color"]').content`), '#f9a8c9');
  await clickText('Sluiten');
  await waitFor(`!document.querySelector('dialog[open]')`, 'weergave gesloten');
  await send('Page.reload');
  await waitFor(`document.body.classList.contains('ready') && document.documentElement.dataset.theme === 'dark'`, 'na herladen nog steeds donker');
  assert.equal(await accentNow(), '#f9a8c9');
  assert.equal(await bgNow(), DARK_BG);
  await emulateScheme('dark');
  await openAppearance();
  await click('dialog[open] [data-role="theme-choice"] input[value="light"]');
  await waitFor(`document.documentElement.dataset.theme === 'light'`, 'licht gekozen');
  assert.equal(await bgNow(), LIGHT_BG, 'licht, ook al staat het apparaat donker');
  assert.equal(await accentNow(), '#be185d', 'de lichte roze accentkleur');
  await click('dialog[open] [data-role="theme-choice"] input[value="system"]');
  await waitFor(`!document.documentElement.dataset.theme`, 'zoals het apparaat');
  assert.equal(await bgNow(), DARK_BG, 'zoals het apparaat: donker');
  await click('dialog[open] [data-role="accent-choice"] input[value="teal"]');
  await waitFor(`!document.documentElement.dataset.accent`, 'standaardkleur');
  assert.equal(await evaluate(`localStorage.getItem('tickory.theme') === null && localStorage.getItem('tickory.accent') === null`), true, 'de standaard staat niet in de opslag');
  await clickText('Sluiten');
  await waitFor(`!document.querySelector('dialog[open]')`, 'weergave weer gesloten');
  await emulateScheme(wasDark ? 'dark' : 'light');

  // wisselen via Instellingen
  await openMenu('Alice');
  assert.deepEqual(await buttons(), ['Account, wachtwoord en apparaten', 'Herinneringen en meldingen', 'Plaatsen', 'Gegevens exporteren', 'Sjablonen', 'Nu bijwerken', 'Weergave', 'Taal / Language', 'Afmelden en lokale gegevens wissen', 'Sluiten']);
  await clickText('Taal / Language');
  await waitFor(`document.querySelector('dialog[open] h2')?.textContent === 'Taal / Language'`, 'taalkeuze');
  assert.deepEqual(await buttons(), ['Nederlands ✓', 'English', 'Sluiten']);
  await clickText('English');
  await waitFor(`!document.querySelector('dialog[open]') && document.documentElement.lang === 'en'`, 'gewisseld naar Engels');
  assert.equal(await evaluate(`localStorage.getItem('tickory.lang')`), 'en', 'de keuze is bewaard');
  await send('Page.reload');
  await waitFor(`document.body.classList.contains('ready') && document.getElementById('sync-status').textContent === 'Up to date'`, 'na herladen nog steeds Engels (de browser zelf staat op Nederlands)', 15_000);
  assert.deepEqual(await evaluate(`[...navigator.languages]`), ['nl-NL', 'nl']);
  assert.equal(await evaluate(`document.documentElement.lang`), 'en');

  // zijbalk en projectscherm
  await waitFor(`document.getElementById('view-title').textContent === 'Thuis'`, 'project Thuis in het Engels');
  assert.deepEqual(await texts('.nav-item .nav-label'), ['Inbox', 'Today', 'Upcoming', 'Completed', 'Notifications', 'Thuis', 'Alice']);
  assert.deepEqual(await texts('.nav-heading span, .sidebar-footer .nav-count'), ['Projects', 'Settings']);
  assert.deepEqual(await evaluate(`[document.getElementById('sidebar').getAttribute('aria-label'), document.querySelector('.nav').getAttribute('aria-label'), document.getElementById('menu-button').getAttribute('aria-label'), document.querySelector('.nav-heading button').title, document.querySelector('.nav-shared').title, document.getElementById('sync-status').title]`),
    ['Navigation', 'Views', 'Menu', 'Add project', 'Shared project', 'Click to sync now']);
  assert.deepEqual(await evaluate(`[document.getElementById('quick-input').placeholder, document.getElementById('quick-input').getAttribute('aria-label'), document.querySelector('#quick-add button[type=submit]').textContent]`),
    [en['quick.placeholder'], 'Add task', 'Add']);
  assert.deepEqual(await buttons('.view-actions'), ['List', 'Board', 'Calendar', 'Comments', 'Shared', 'Project…']);
  assert.deepEqual(await buttons('.toolbar'), ['Add section']);
  assert.equal(await evaluate(`document.querySelector('.shared-with').textContent`), 'Shared with Bob');
  assert.equal(await evaluate(`document.title`), 'Thuis · Tickory');
  assert.deepEqual(await taskMeta('Gordijnen ophangen'), ['for Bob']);
  assert.deepEqual(await taskMeta('Planten water geven'), ['↻ tomorrow']);
  assert.deepEqual(await taskMeta('Afwasmachine uitruimen'), [inEnglish(() => formatDate(expectedThursday, today)), '0/1'], 'de datum en de teller van de subtaak');
  assert.equal(await evaluate(`document.querySelector('.check').getAttribute('aria-label')`), 'Complete: Planten water geven');
  await noDutch('project');
  await fits('project');
  await shot('engels-project');

  // Vandaag en Binnenkort
  await nav('Today');
  await waitFor(`document.getElementById('view-title').textContent === 'Today'`, 'scherm Today');
  assert.ok((await texts('.group-title')).some((x) => x === `Today · ${inEnglish(() => formatDueLong({ date: today }, today))}`), 'de kop van vandaag');
  await noDutch('today');
  await nav('Upcoming');
  await waitFor(`document.getElementById('view-title').textContent === 'Upcoming'`, 'scherm Upcoming');
  assert.equal((await texts('.group-title'))[0], `Tomorrow · ${inEnglish(() => formatDueLong({ date: tomorrow }, today))}`);
  assert.deepEqual(await taskMeta('Tandarts bellen'), ['tomorrow 09:00', '@bellen', '🔔', 'Inbox']);
  await noDutch('upcoming');
  await shot('engels-binnenkort');

  // een taak toevoegen: alleen notaties die in elke taal werken, en een eerlijke hint bij een Engelse datum
  await nav('Inbox');
  await waitFor(`document.getElementById('view-title').textContent === 'Inbox'`, 'Inbox in het Engels');
  await typeInto('#quick-input', 'Call the dentist tomorrow');
  await waitFor(`document.querySelector('#quick-preview .preview-note')`, 'uitleg over de datumtaal');
  assert.deepEqual(await texts('#quick-preview .chip'), ['Call the dentist tomorrow']);
  assert.equal(await evaluate(`document.querySelector('#quick-preview .preview-note').textContent`), en['date.dutchOnly']);
  await shot('engels-datumhint');
  const newYearsEve = nextFixed(12, 31);
  await typeInto('#quick-input', 'Call the dentist 31-12 p1 @calls');
  await waitFor(`document.querySelectorAll('#quick-preview .chip').length === 4`, 'voorbeeld onder het invoerveld (Engels)');
  assert.deepEqual(await texts('#quick-preview .chip'), ['Call the dentist', inEnglish(() => formatDate(newYearsEve, today)), '@calls (new)', 'P1']);
  assert.equal(await evaluate(`document.querySelector('#quick-preview .preview-note')`), null, 'bij een herkende datum geen uitleg');
  await shot('engels-quick-add');
  await submit('#quick-add');
  await waitFor(`[...document.querySelectorAll('.task-title')].some((e) => e.textContent === 'Call the dentist')`, 'Engelse taak in de Inbox');
  await waitFor(`await ${SYNCED_EN}`, 'gesynchroniseerd (Engels)');
  assert.equal(serverTask('Call the dentist').due.date, newYearsEve);
  assert.equal(serverTask('Call the dentist').priority, 1);
  await quickAdd('   ');
  await waitFor(`[...document.querySelectorAll('.toast-text')].some((e) => e.textContent === 'Give the task a name.')`, 'melding bij een lege taak');
  await typeInto('#quick-input', '');
  await noDutch('inbox met meldingen');

  // het bewerkvenster
  await openTask('Call the dentist');
  assert.equal(await evaluate(`document.querySelector('#task-dialog h2').textContent`), 'Edit task');
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('#task-dialog .prop-label')].filter((l) => !l.closest('[hidden]')).map((l) => l.textContent)`), ['Project', 'Section', 'Due date', 'Priority', 'Labels', 'Duration', 'Deadline']);
  assert.deepEqual((await buttons('#task-dialog')).filter(Boolean), ['Today', 'Tomorrow', 'This weekend', 'Next week', 'No date', 'Add reminder', 'Add', 'Add a file', 'Post comment', 'Delete', 'Save as template', 'Cancel', 'Save']);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('#task-dialog [placeholder]')].map((e) => e.placeholder)`), ['Description', en['task.duePlaceholder'], 'e.g. calls, home', 'Add subtask', 'Write a comment…']);
  assert.deepEqual(await texts('#task-dialog select:not([aria-label]) option'), ['Inbox', 'Thuis', '(no section)']);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('#task-dialog .prio-option')].map((l) => [l.title, l.querySelector('input').checked])`), [['P1 – highest', true], ['P2', false], ['P3', false], ['P4 – none', false]], 'vier prioriteitsknoppen; de taak "Call the dentist" is P1');
  const dueInput = `#task-dialog input[placeholder=${js(en['task.duePlaceholder'])}]`;
  assert.equal(await evaluate(`document.querySelector(${js(dueInput)}).value`), newYearsEve, 'de datum staat er in een vorm zonder Nederlands woord');
  assert.equal(await evaluate(`document.querySelector('#task-dialog .hint').textContent`), `Now: ${inEnglish(() => formatDueLong({ date: newYearsEve }, today))}`);
  await typeInto(dueInput, 'tomorrow at 9');
  await waitFor(`document.querySelector('#task-dialog .hint').classList.contains('hint-bad')`, 'onbekende datum (Engels)');
  assert.equal(await evaluate(`document.querySelector('#task-dialog .hint').textContent`), `I don't recognize this date. ${en['date.dutchOnly']}`);
  await submit('#task-dialog form');
  await waitFor(`document.querySelector('#task-dialog .error').textContent === ${js(en['task.dueError'])}`, 'Engelse foutmelding bij een onbekende datum');
  await noDutch('bewerkvenster met foutmelding');
  await fits('bewerkvenster');
  await shot('engels-bewerken-fout');
  await typeInto(dueInput, '');
  assert.equal(await evaluate(`document.querySelector('#task-dialog .hint').textContent`), en['date.dutchOnly'], 'bij een leeg datumveld staat welke notaties werken');
  await typeInto(dueInput, '2027-01-15T09:30');
  await waitFor(`document.querySelector('#task-dialog .hint').textContent === 'Will be: Fri 15 Jan 2027 09:30'`, 'uitleg bij de datum (Engels)');
  await typeInto('#task-dialog input[placeholder="Add subtask"]', 'Bring the forms');
  await clickText('Add', `document.querySelector('#task-dialog')`);
  await waitFor(`[...document.querySelectorAll('#task-dialog .sr-only')].some((e) => e.textContent === 'Subtask added: Bring the forms')`, 'subtaak toegevoegd (Engels)');
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('#task-dialog .subtask-title')].map((e) => e.value)`), ['Bring the forms']);
  assert.equal(await evaluate(`document.querySelector('#task-dialog .subtasks .subheading').textContent`), 'Subtasks (0/1)');
  await shot('engels-bewerken');
  await submit('#task-dialog form');
  await waitFor(`!document.querySelector('dialog[open]')`, 'bewerkvenster gesloten (Engels)');
  await waitFor(`await ${SYNCED_EN}`, 'gesynchroniseerd (Engels)');
  assert.equal(serverTask('Call the dentist').due.date, '2027-01-15T09:30');
  assert.deepEqual(await taskMeta('Call the dentist'), ['15 Jan 2027 09:30', '0/1', '@calls', '🔔']);
  await openTask('Bring the forms');
  assert.equal(await evaluate(`document.querySelector('#task-dialog h2').textContent`), 'Subtask of: Call the dentist');
  await clickText('Cancel', `document.querySelector('#task-dialog')`);
  await waitFor(`!document.querySelector('dialog[open]')`, 'subtaak gesloten');
  await openTask('Call the dentist');
  assert.equal(await evaluate(`document.querySelector(${js(dueInput)}).value`), '2027-01-15T09:30', 'datum met tijd: de vorm die de herkenner weer leest');
  await clickText('Delete', `document.querySelector('#task-dialog')`);
  await waitFor(`[...document.querySelectorAll('dialog[open] h2')].some((e) => e.textContent === 'Delete task?')`, 'bevestiging (Engels)');
  assert.ok(await evaluate(`[...document.querySelectorAll('dialog[open] p')].some((e) => e.textContent === '"Call the dentist" and any subtasks will be deleted.')`));
  await noDutch('taak verwijderen');
  await evaluate(`[...document.querySelectorAll('dialog[open]')].at(-1).querySelector('.button-danger').click()`);
  await waitFor(`!document.querySelector('dialog[open]') && ![...document.querySelectorAll('.task-title')].some((e) => e.textContent === 'Call the dentist')`, 'Engelse taak verwijderd');
  await waitFor(`await ${SYNCED_EN}`, 'gesynchroniseerd (Engels)');
  assert.equal(serverTask('Call the dentist'), undefined);

  // afvinken met ongedaan maken
  await evaluate(`document.querySelectorAll('.toast-close').forEach((b) => b.click())`);
  await check('Boodschappen doen');
  await waitFor(`document.querySelector('.toast-action')?.textContent === 'Undo'`, 'melding met Undo');
  assert.ok((await texts('.toast-text')).includes('Task completed'));
  await click('.toast-action');
  await waitFor(`[...document.querySelectorAll('.task-title')].some((e) => e.textContent === 'Boodschappen doen')`, 'taak terug na Undo');
  await evaluate(`document.querySelectorAll('.toast-close').forEach((b) => b.click())`);

  // het deelvenster, met een geweigerde uitnodiging
  await nav('Thuis');
  await waitFor(`document.getElementById('view-title').textContent === 'Thuis'`, 'Thuis (Engels)');
  await openTask('Gordijnen ophangen');
  assert.deepEqual(await texts('#task-dialog select[aria-label="Assigned to"] option'), ['(no one)', 'Alice (you)', 'Bob']);
  await clickText('Cancel', `document.querySelector('#task-dialog')`);
  await waitFor(`!document.querySelector('dialog[open]')`, 'bewerkvenster gesloten');
  await clickText('Shared');
  await waitFor(`document.querySelector('dialog[open] h2')?.textContent === 'Share: Thuis'`, 'deelvenster (Engels)');
  assert.deepEqual(await texts('dialog[open] .device-info'), ['Aliceyou@alice · owner', 'Bob@bob · can edit']);
  assert.deepEqual(await buttons(), ['Remove', 'Share', 'Close']);
  assert.deepEqual(await evaluate(`[document.querySelector('dialog[open] input').placeholder, document.querySelector('dialog[open] input').getAttribute('aria-label')]`), ['Username', "The person's username"]);
  await typeInto(`dialog[open] input[aria-label="The person's username"]`, 'niemand-bekend');
  await submit('dialog[open] form.subtask-row');
  await waitFor(`[...document.querySelectorAll('.toast-text')].some((e) => e.textContent === "Couldn't share the project. There's no user with that username.")`, 'Engelse melding: gebruiker bestaat niet');
  await noDutch('deelvenster met foutmelding');
  await fits('deelvenster');
  await shot('engels-delen');
  await clickText('Remove', `document.querySelector('dialog[open]')`);
  await waitFor(`[...document.querySelectorAll('dialog[open] h2')].some((e) => e.textContent === 'Remove from project?')`, 'bevestiging uit het project halen');
  assert.deepEqual(await evaluate(`[...[...document.querySelectorAll('dialog[open]')].at(-1).querySelectorAll('p, button')].map((e) => e.textContent)`),
    ['Bob will no longer see "Thuis". Their assignments and reminders for this project will be removed.', 'Cancel', 'Remove from project']);
  await noDutch('uit het project halen');
  await clickText('Cancel', `[...document.querySelectorAll('dialog[open]')].at(-1)`);
  await clickText('Close', `document.querySelector('dialog[open]')`);
  await waitFor(`!document.querySelector('dialog[open]')`, 'deelvenster gesloten');
  await evaluate(`document.querySelectorAll('.toast-close').forEach((b) => b.click())`);
  assert.equal((serverState(bob.id).projects as any[]).some((p) => p.name === 'Thuis'), true, 'Bob is nog lid');

  // het projectmenu
  await clickText('Project…');
  await waitFor(`document.querySelector('dialog[open] .menu')`, 'projectmenu (Engels)');
  assert.deepEqual(await buttons(), ['Edit…', 'Add subproject', 'Add tasks from template…', 'Save as template…', 'Add to favorites', 'View completed tasks', 'Activity', 'Share…', 'Archive', 'Delete project', 'Close']);
  await clickText('Delete project');
  await waitFor(`[...document.querySelectorAll('dialog[open] h2')].some((e) => e.textContent === 'Delete project?')`, 'bevestiging project verwijderen');
  assert.ok(await evaluate(`document.querySelector('dialog[open] p').textContent === '"Thuis" will be deleted, along with all its sections, tasks and subprojects — also for the people you share it with.'`));
  await noDutch('project verwijderen');
  await clickText('Cancel', `document.querySelector('dialog[open]')`);
  await waitFor(`!document.querySelector('dialog[open]')`, 'bevestiging gesloten');

  // account en gebruikersbeheer; de controles vóór het versturen geven een Engelse melding
  await openMenu('Alice');
  assert.deepEqual(await buttons(), ['Account, password and devices', 'Reminders and notifications', 'Places', 'Export data', 'Templates', 'Sync now', 'Appearance', 'Taal / Language', 'Sign out and clear local data', 'Close']);
  await clickText('Account, password and devices');
  await waitFor(`document.querySelector('dialog[open] .device .badge')?.textContent === 'this device'`, 'apparatenlijst (Engels)');
  assert.equal(await evaluate(`document.querySelector('dialog[open] p').textContent`), 'Alice @alice · admin');
  assert.deepEqual(await texts('dialog[open] summary'), ['Signed-in devices', 'Change password']);
  assert.ok((await texts('dialog[open] .device .hint')).every((x) => /^Last used: \d{1,2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2}$/.test(x)), 'datum en tijd in het Engels');
  await evaluate(`document.querySelectorAll('dialog[open] details')[1].open = true`);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('dialog[open] details')[1].querySelectorAll('.field-label')].map((l) => l.firstChild.textContent)`), ['Current password', 'New password', 'Repeat new password']);
  await typeInto('dialog[open] input[aria-label="Current password"]', PASSWORD_ALICE);
  await typeInto('dialog[open] input[aria-label="New password"]', 'kort');
  await typeInto('dialog[open] input[aria-label="Repeat new password"]', 'kort');
  await submit('dialog[open] details:nth-of-type(2) form');
  await waitFor(`document.querySelector('dialog[open] .section-form .error')?.textContent === 'The new password needs at least 10 characters.'`, 'te kort wachtwoord (Engels)');
  await typeInto('dialog[open] input[aria-label="Current password"]', 'niet-het-goede-wachtwoord');
  await typeInto('dialog[open] input[aria-label="New password"]', 'een-nieuw-wachtwoord-1');
  await typeInto('dialog[open] input[aria-label="Repeat new password"]', 'een-nieuw-wachtwoord-1');
  await submit('dialog[open] details:nth-of-type(2) form');
  await waitFor(`document.querySelector('dialog[open] .section-form .error')?.textContent === 'The current password is incorrect.'`, 'fout huidig wachtwoord: eigen Engelse vertaling van de servermelding');
  // één ander apparaat (de "Telefoon" van eerder) met een eigen knop, het formulier, en de knoppen van het venster
  assert.deepEqual(await buttons(), ['Sign out', 'Change password', 'Sign out', 'User management', 'Close']);
  await noDutch('account');
  await fits('account');
  await shot('engels-account');
  await clickText('User management');
  await waitFor(`[...document.querySelectorAll('dialog[open] .device strong')].some((e) => e.textContent.startsWith('Carol de Vries'))`, 'gebruikerslijst (Engels)');
  assert.equal(await evaluate(`document.querySelector('dialog[open] h2').textContent`), 'User management');
  assert.deepEqual(await texts('dialog[open] summary'), ['Accounts', 'New account']);
  assert.ok((await texts('dialog[open] .badge')).includes('admin'));
  await evaluate(`document.querySelectorAll('dialog[open] details')[1].open = true`);
  await typeInto('dialog[open] input[aria-label="Username"]', '.dave');
  await typeInto('dialog[open] input[aria-label="Initial password"]', 'dave-wachtwoord-1');
  await submit('dialog[open] details:nth-of-type(2) form');
  await waitFor(`document.querySelector('dialog[open] p[role=status]').textContent === ${js(en['account.usernameInvalid'])}`, 'ongeldige gebruikersnaam: Engelse melding vóór het versturen');
  await typeInto('dialog[open] input[aria-label="Username"]', 'dave-wachtwoord-1');
  await submit('dialog[open] details:nth-of-type(2) form');
  await waitFor(`document.querySelector('dialog[open] p[role=status]').textContent === "The password can't be the same as the username."`, 'wachtwoord gelijk aan gebruikersnaam (Engels)');
  await typeInto('dialog[open] input[aria-label="Username"]', 'bob');
  await submit('dialog[open] details:nth-of-type(2) form');
  await waitFor(`document.querySelector('dialog[open] p[role=status]').textContent === 'This username is already taken.'`, 'bestaande gebruikersnaam: eigen Engelse vertaling van de servermelding');
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM users WHERE username IN ('.dave', 'dave-wachtwoord-1')").get() as any).n, 0, 'ongeldige invoer is niet verstuurd');
  await evaluate(`[...document.querySelectorAll('dialog[open] .device')].find((d) => d.querySelector('strong').textContent.startsWith('Carol de Vries')).querySelector('button').click()`);
  await waitFor(`[...document.querySelectorAll('dialog[open] h2')].some((e) => e.textContent === 'Carol de Vries (@carol)')`, 'menu van een gebruiker');
  assert.deepEqual(await evaluate(`[...[...document.querySelectorAll('dialog[open]')].at(-1).querySelectorAll('button')].map((b) => b.textContent)`), ['Reset password', 'Block account', 'Make admin', 'Close']);
  await noDutch('gebruikersbeheer');
  await fits('gebruikersbeheer');
  await shot('engels-beheer');
  await clickText('Block account', `[...document.querySelectorAll('dialog[open]')].at(-1)`);
  await waitFor(`[...document.querySelectorAll('dialog[open] h2')].some((e) => e.textContent === 'Block account?')`, 'bevestiging blokkeren');
  assert.deepEqual(await evaluate(`[...[...document.querySelectorAll('dialog[open]')].at(-1).querySelectorAll('p, button')].map((e) => e.textContent)`),
    ['Carol de Vries can no longer sign in and has been signed out everywhere. Their data is kept.', 'Cancel', 'Block']);
  await clickText('Cancel', `[...document.querySelectorAll('dialog[open]')].at(-1)`);
  await clickText('Close', `document.querySelector('dialog[open]')`);
  await waitFor(`document.querySelector('dialog[open] h2')?.textContent === 'Account'`, 'terug in het accountscherm (Engels)');
  await clickText('Close', `document.querySelector('dialog[open]')`);
  await waitFor(`!document.querySelector('dialog[open]')`, 'alles gesloten (Engels)');

  // telefoonformaat in het Engels: niets afgekapt, niets buiten beeld
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(300);
  await fits('telefoon: project');
  await shot('engels-telefoon-project');
  await click('#menu-button');
  await sleep(350);
  await shot('engels-telefoon-menu');
  await click('#scrim');
  await openTask('Afwasmachine uitruimen');
  await typeInto(`#task-dialog input[placeholder=${js(en['task.duePlaceholder'])}]`, 'next friday');
  await waitFor(`document.querySelector('#task-dialog .hint').classList.contains('hint-bad')`, 'onbekende datum (telefoon)');
  await fits('telefoon: bewerkvenster');
  await shot('engels-telefoon-bewerken');
  await evaluate(`document.querySelector('#task-dialog').scrollTo(0, 9999)`);
  await shot('engels-telefoon-bewerken-onder');
  await clickText('Cancel', `document.querySelector('#task-dialog')`);
  await waitFor(`!document.querySelector('dialog[open]')`, 'bewerkvenster gesloten (telefoon)');
  await clickText('Shared');
  await waitFor(`document.querySelector('dialog[open] h2')?.textContent === 'Share: Thuis'`, 'deelvenster (telefoon)');
  await fits('telefoon: deelvenster');
  await shot('engels-telefoon-delen');
  await clickText('Close', `document.querySelector('dialog[open]')`);
  await click('#menu-button');
  await sleep(350);
  await nav('Alice');
  await waitFor(`document.querySelector('dialog[open] .menu')`, 'instellingenmenu (telefoon)');
  await fits('telefoon: instellingen');
  await shot('engels-telefoon-instellingen');
  await clickText('Close', `document.querySelector('dialog[open]')`);
  await click('#scrim');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
  await sleep(200);

  // offline in het Engels: de statusregel met het juiste meervoud
  await stopServer();
  await quickAdd('Written offline 31-12');
  await waitFor(`document.getElementById('sync-status').textContent === 'Offline · 1 change waiting'`, 'status offline (Engels, enkelvoud)', 45_000);
  await quickAdd('Written offline too');
  await waitFor(`document.getElementById('sync-status').textContent === 'Offline · 2 changes waiting'`, 'status offline (Engels, meervoud)', 45_000);
  await noDutch('offline');
  await shot('engels-offline');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(300);
  await fits('telefoon: offline met wachtende wijzigingen');
  assert.equal(await evaluate(`(() => { const s = document.getElementById('sync-status').getBoundingClientRect(); return s.left >= 0 && s.right <= window.innerWidth; })()`), true, 'de statusregel past op de telefoon');
  await shot('engels-telefoon-offline');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
  await sleep(200);
  await evaluate(`[...document.querySelectorAll('.nav-item')].find((b) => b.querySelector('.nav-label')?.textContent === 'Alice').click()`);
  await waitFor(`document.querySelector('dialog[open] .menu')`, 'instellingenmenu (offline)');
  await clickText('Sign out and clear local data');
  await waitFor(`[...document.querySelectorAll('dialog[open] h2')].some((e) => e.textContent === 'Sign out?')`, 'bevestiging afmelden (Engels)');
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('dialog[open] p, dialog[open] button')].map((e) => e.textContent)`),
    ["2 changes are still waiting and haven't been sent to the server. They will be lost.", 'Cancel', 'Sign out']);
  await noDutch('afmelden met wachtende wijzigingen');
  await clickText('Cancel', `document.querySelector('dialog[open]')`);
  await waitFor(`!document.querySelector('dialog[open]')`, 'bevestiging gesloten');
  await startServer();
  await click('#sync-status');
  await waitFor(`await ${SYNCED_EN}`, 'weer bijgewerkt (Engels)', 15_000);
  assert.equal(serverTask('Written offline').due.date, nextFixed(12, 31));
  for (const content of ['Written offline', 'Written offline too']) {
    await openTask(content);
    await clickText('Delete', `document.querySelector('#task-dialog')`);
    await waitFor(`document.querySelectorAll('dialog[open]').length === 2`, 'bevestiging');
    await evaluate(`[...document.querySelectorAll('dialog[open]')].at(-1).querySelector('.button-danger').click()`);
    await waitFor(`!document.querySelector('dialog[open]')`, 'taak verwijderd');
  }
  await waitFor(`document.querySelectorAll('.task').length === 6 && await ${SYNCED_EN}`, 'opgeruimd (Engels)');

  // terug naar Nederlands: alles staat er weer zoals voorheen, en ook dat blijft bewaard
  await openMenu('Alice');
  await clickText('Taal / Language');
  await waitFor(`document.querySelector('dialog[open] h2')?.textContent === 'Taal / Language'`, 'taalkeuze (Engels)');
  assert.deepEqual(await buttons(), ['Nederlands', 'English ✓', 'Close']);
  await clickText('Nederlands');
  await waitFor(`!document.querySelector('dialog[open]') && document.documentElement.lang === 'nl'`, 'terug naar Nederlands');
  assert.equal(await evaluate(`localStorage.getItem('tickory.lang')`), 'nl');
  assert.deepEqual(await texts('.nav-item .nav-label'), ['Inbox', 'Vandaag', 'Binnenkort', 'Voltooid', 'Meldingen', 'Thuis', 'Alice']);
  assert.deepEqual(await texts('.nav-heading span, .sidebar-footer .nav-count'), ['Projecten', 'Instellingen']);
  assert.deepEqual(await buttons('.view-actions'), ['Lijst', 'Bord', 'Kalender', 'Opmerkingen', 'Gedeeld', 'Project…']);
  assert.deepEqual(await buttons('.toolbar'), ['Sectie toevoegen']);
  assert.deepEqual(await evaluate(`[document.getElementById('quick-input').placeholder, document.getElementById('quick-input').getAttribute('aria-label'), document.querySelector('#quick-add button[type=submit]').textContent, document.getElementById('sync-status').title, document.getElementById('sidebar').getAttribute('aria-label')]`),
    ['Nieuwe taak, bv. Bellen morgen p1', 'Taak toevoegen', 'Toevoegen', 'Klik om nu bij te werken', 'Navigatie']);
  assert.deepEqual(await taskMeta('Gordijnen ophangen'), ['voor Bob']);
  await waitFor(`await ${SYNCED}`, 'bijgewerkt (Nederlands)');
  step(`Engels: wisselen via Instellingen werkt direct en blijft bewaard (ook na herladen, in een browser die op Nederlands staat); ${checked.length} schermen zonder Nederlandse tekst van de app (${checked.join(', ')}); datums, meervouden en foutmeldingen in het Engels; niets afgekapt, ook niet op telefoonformaat; daarna terug naar Nederlands`);

  // ---- 8d. herinneringen ----
  await nav('Thuis');
  await waitFor(`document.getElementById('view-title').textContent === 'Thuis'`, 'scherm Thuis');
  const remindersOfServer = (content: string) => {
    const id = serverTask(content)?.id;
    return (serverState().reminders as any[]).filter((r) => r.task_id === id);
  };
  const remindersOf = (content: string) => remindersOfServer(content).map(({ minute_offset, type }) => ({ minute_offset, type }));
  await typeInto('#quick-input', 'Vergadering voorbereiden morgen om 10 uur !1u !(een kwartier ervoor) !(morgen om 8 uur)');
  await waitFor(`document.querySelectorAll('#quick-preview .chip-bell').length === 3`, 'drie herinneringen in het voorbeeld');
  assert.deepEqual(await evaluate<string[]>(`[...document.querySelectorAll('#quick-preview .chip-bell')].map((c) => c.textContent)`), ['🔔 1 uur vooraf', '🔔 15 minuten vooraf', '🔔 morgen 08:00']);
  await submit('#quick-add');
  await waitFor(`document.getElementById('quick-input').value === ''`, 'invoerveld leeg');
  await waitFor(`[...document.querySelectorAll('.task-title')].some((e) => e.textContent === 'Vergadering voorbereiden')`, 'taak in beeld');
  assert.ok((await taskMeta('Vergadering voorbereiden'))!.includes('🔔'), 'het belletje staat bij de taak');
  await waitFor(SYNCED, 'gesynchroniseerd');
  const vg = remindersOfServer('Vergadering voorbereiden');
  assert.deepEqual(vg.map((r) => r.type === 'absolute' ? r.due.date : r.minute_offset).sort(), [15, 60, `${tomorrow}T08:00`].sort());
  assert.ok(vg.every((r) => r.owner_id === alice.id), 'de herinneringen zijn van Alice');
  assert.equal(serverTask('Vergadering voorbereiden').due.date, `${tomorrow}T10:00`, 'het uitroepteken en de haakjes zijn uit de titel');
  step('snel toevoegen met "!1u", "!(een kwartier ervoor)" en "!(morgen om 8 uur)": de voorvertoning toont ze, ze komen als eigen herinneringen van Alice op de server, en de taak krijgt een belletje');

  // een taak met een tijd, zonder zelf een herinnering op te geven: de automatische van 30 minuten
  await quickAdd('Tuin besproeien morgen om 19 uur');
  await waitFor(SYNCED, 'gesynchroniseerd');
  await waitFor(`[...document.querySelectorAll('.task-title')].some((e) => e.textContent === 'Tuin besproeien')`, 'taak in beeld');
  assert.deepEqual(remindersOf('Tuin besproeien'), [{ minute_offset: 30, type: 'relative' }]);
  await quickAdd('Zonder tijd morgen');
  await waitFor(SYNCED, 'gesynchroniseerd');
  assert.deepEqual(remindersOf('Zonder tijd'), []);
  step('een taak met een tijd krijgt vanzelf een herinnering van 30 minuten vooraf; een taak zonder tijd niet');

  // het taakvenster: lijst, verwijderen, toevoegen met een keuze en met een eigen datum en tijd
  await openTask('Vergadering voorbereiden');
  await waitFor(`document.querySelector('#task-dialog[open] section[aria-label="Herinneringen"]')`, 'herinneringen in het taakvenster');
  const reminderLines = () => evaluate<string[]>(`[...document.querySelectorAll('#task-dialog section[aria-label="Herinneringen"] li.device .device-info')].map((e) => e.textContent)`);
  assert.deepEqual(await reminderLines(), ['Op een vast tijdstip · morgen 08:00', '1 uur vooraf · morgen 09:00', '15 minuten vooraf · morgen 09:45'], 'op volgorde van afgaan: de vroegste eerst');
  await shot('herinneringen-taakvenster');
  await evaluate(`[...document.querySelectorAll('#task-dialog section[aria-label="Herinneringen"] li.device')].find((l) => l.textContent.includes('15 minuten')).querySelector('button').click()`);
  await waitFor(`document.querySelectorAll('#task-dialog section[aria-label="Herinneringen"] li.device').length === 2`, 'herinnering verwijderd');
  await evaluate(`(() => { const s = document.querySelector('#task-dialog select[aria-label="Wanneer?"]'); s.value = '0'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await clickText('Herinnering toevoegen', `document.querySelector('#task-dialog')`);
  await waitFor(`document.querySelectorAll('#task-dialog section[aria-label="Herinneringen"] li.device').length === 3`, 'herinnering op het tijdstip toegevoegd');
  // een tweede keer dezelfde keuze maakt er geen dubbele van
  await clickText('Herinnering toevoegen', `document.querySelector('#task-dialog')`);
  await sleep(300);
  assert.equal((await reminderLines()).length, 3);
  // een eigen datum en tijd
  await evaluate(`(() => { const s = document.querySelector('#task-dialog select[aria-label="Wanneer?"]'); s.value = 'custom'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  assert.match(await evaluate<string>(`document.querySelector('#task-dialog input[type="datetime-local"]').value`), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'het veld is alvast ingevuld met een uur later');
  await typeInto('#task-dialog input[type="datetime-local"]', '');
  await clickText('Herinnering toevoegen', `document.querySelector('#task-dialog')`);
  await waitFor(`document.querySelector('#task-dialog [data-role="reminder-error"]')?.textContent === 'Kies een datum en een tijd.'`, 'melding bij een lege datum');
  await typeInto('#task-dialog input[type="datetime-local"]', `${tomorrow}T07:15`);
  await clickText('Herinnering toevoegen', `document.querySelector('#task-dialog')`);
  await waitFor(`document.querySelectorAll('#task-dialog section[aria-label="Herinneringen"] li.device').length === 4`, 'eigen herinnering toegevoegd');
  await click('#task-dialog form .dialog-buttons button[type="submit"]');
  await waitFor(`!document.querySelector('dialog[open]')`, 'taakvenster gesloten');
  await waitFor(SYNCED, 'gesynchroniseerd');
  assert.deepEqual(remindersOfServer('Vergadering voorbereiden').map((r) => r.type === 'absolute' ? r.due.date : r.minute_offset).sort(), [0, 60, `${tomorrow}T07:15`, `${tomorrow}T08:00`].sort());
  step('taakvenster: de herinneringen op volgorde van afgaan, verwijderen, toevoegen met een keuze (dezelfde twee keer telt één keer) en met een eigen datum en tijd (zonder datum een melding)');

  await openTask('Zonder tijd');
  await waitFor(`document.querySelector('#task-dialog section[aria-label="Herinneringen"] p.hint')?.textContent.includes('mét tijd')`, 'uitleg bij een taak zonder tijd');
  await clickText('Annuleren', `document.querySelector('#task-dialog')`);
  await waitFor(`!document.querySelector('dialog[open]')`, 'taakvenster gesloten');

  // instellingen: automatische herinnering, tijdzone en meldingen op dit apparaat
  const deviceZone = await evaluate<string>(`Intl.DateTimeFormat().resolvedOptions().timeZone`);
  const mySettings = () => (serverState().settings as any[])[0];
  assert.equal(mySettings().timezone, deviceZone, 'de tijdzone van dit apparaat is vanzelf vastgelegd');
  await nav('Alice');
  await waitFor(`document.querySelector('dialog[open] .menu')`, 'instellingenmenu');
  await clickText('Herinneringen en meldingen');
  await waitFor(`document.querySelector('dialog[open] h2')?.textContent === 'Herinneringen en meldingen'`, 'scherm herinneringen en meldingen');
  assert.equal(await evaluate(`document.querySelector('dialog[open] select[aria-label="Automatische herinnering"]').value`), '30');
  assert.ok(await evaluate(`document.querySelector('dialog[open]').textContent.includes(${js(deviceZone)})`), 'de tijdzone staat in het scherm');
  await evaluate(`(() => { const s = document.querySelector('dialog[open] select[aria-label="Automatische herinnering"]'); s.value = '10'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await waitFor(SYNCED, 'gesynchroniseerd');
  assert.equal(mySettings().auto_reminder, 10);
  await shot('meldingen-instellingen');
  // meldingen in de browser: in een headless browser kan dit niet echt, maar het scherm moet netjes reageren
  await send('Browser.grantPermissions', { permissions: ['notifications'], origin: BASE }).catch(() => {});
  const supported = await evaluate<boolean>(`document.querySelector('dialog[open]').textContent.includes('Meldingen staan uit op dit apparaat.')`);
  let pushOutcome = 'de browser ondersteunt geen pushmeldingen: het scherm legt uit waarom';
  if (supported) {
    await clickText('Meldingen aanzetten');
    await waitFor(`document.querySelector('dialog[open] [role="status"]')?.textContent.length > 0 || document.querySelector('dialog[open]').textContent.includes('Meldingen staan aan op dit apparaat.')`, 'uitkomst van het aanzetten', 20_000);
    const enabled = await evaluate<boolean>(`document.querySelector('dialog[open]').textContent.includes('Meldingen staan aan op dit apparaat.')`);
    pushOutcome = enabled
      ? 'de browser meldde zich echt aan; de server heeft de aanmelding'
      : `de headless browser kon zich niet aanmelden bij zijn pushdienst; het scherm toont: "${await evaluate<string>(`document.querySelector('dialog[open] [role="status"]').textContent`)}"`;
    if (enabled) {
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?').get(alice.id) as any).n, 1);
      await clickText('Meldingen uitzetten');
      await waitFor(`document.querySelector('dialog[open]').textContent.includes('Meldingen staan uit op dit apparaat.')`, 'meldingen weer uit');
    }
  } else {
    assert.ok(await evaluate(`document.querySelector('dialog[open]').textContent.includes('Deze browser kan geen meldingen ontvangen')`));
  }
  await clickText('Sluiten', `document.querySelector('dialog[open]')`);
  await waitFor(`!document.querySelector('dialog[open]')`, 'scherm gesloten');
  // een nieuwe taak met een tijd krijgt nu 10 minuten vooraf
  await quickAdd('Bellen met de buren morgen om 11 uur');
  await waitFor(SYNCED, 'gesynchroniseerd');
  await waitFor(`[...document.querySelectorAll('.task-title')].some((e) => e.textContent === 'Bellen met de buren')`, 'taak in beeld');
  assert.deepEqual(remindersOf('Bellen met de buren'), [{ minute_offset: 10, type: 'relative' }]);
  step(`instellingen: de tijdzone van het apparaat is vanzelf vastgelegd; de automatische herinnering is te wijzigen (daarna 10 minuten vooraf); meldingen in de browser: ${pushOutcome}`);

  // de Android-app: de brug (window.TickoryAndroid) nagebootst, zoals de app die aanbiedt
  const stub = await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    (() => {
      const log = (name, args) => { const l = JSON.parse(sessionStorage.getItem('android-calls') || '[]'); l.push([name, ...args]); sessionStorage.setItem('android-calls', JSON.stringify(l)); };
      window.TickoryAndroid = {
        setSession: (t) => log('setSession', [t]), remindersChanged: () => log('remindersChanged', []),
        notificationStatus: () => JSON.stringify({ notifications: false, exactAlarms: false, batteryOptimized: true, appVersion: '0.3.0-test' }),
        requestNotificationPermission: () => log('requestNotificationPermission', []), openNotificationSettings: () => log('openNotificationSettings', []),
        openBatterySettings: () => log('openBatterySettings', []), changeServer: () => log('changeServer', []),
      };
    })();` });
  await evaluate(`sessionStorage.removeItem('android-calls')`);
  await send('Page.reload');
  await waitFor(`document.body.classList.contains('ready')`, 'app opnieuw gestart met de Android-brug');
  await waitFor(SYNCED, 'gesynchroniseerd');
  const calls = () => evaluate<any[][]>(`JSON.parse(sessionStorage.getItem('android-calls') || '[]')`);
  assert.ok((await calls()).some((c) => c[0] === 'setSession' && String(c[1]).startsWith('tky_')), 'bij het starten krijgt de Android-app het sessietoken');
  await nav('Alice');
  await waitFor(`document.querySelector('dialog[open] .menu')`, 'instellingenmenu');
  await clickText('Herinneringen en meldingen');
  await waitFor(`document.querySelector('dialog[open]').textContent.includes('Meldingen zijn uitgeschakeld voor Tickory')`, 'Android-uitleg over meldingen');
  const panel = await evaluate<string>(`document.querySelector('dialog[open]').textContent`);
  assert.ok(panel.includes('Exacte alarmen staan uit') && panel.includes('Batterijbesparing staat aan') && panel.includes('Versie van de app: 0.3.0-test'));
  assert.ok(!panel.includes('Meldingen aanzetten'), 'in de Android-app geen aanmelding voor meldingen in de browser');
  await shot('meldingen-android');
  await clickText('Meldingen toestaan');
  await clickText('Batterij-instellingen');
  assert.deepEqual((await calls()).filter((c) => c[0].startsWith('request') || c[0].startsWith('open')).map((c) => c[0]), ['requestNotificationPermission', 'openBatterySettings']);
  await clickText('Sluiten', `document.querySelector('dialog[open]')`);
  await waitFor(`!document.querySelector('dialog[open]')`, 'scherm gesloten');
  // een wijziging aan een herinnering: Android hoort het (kort uitgesteld, één keer)
  await evaluate(`sessionStorage.removeItem('android-calls')`);
  await openTask('Bellen met de buren');
  await waitFor(`document.querySelector('#task-dialog[open] section[aria-label="Herinneringen"]')`, 'taakvenster');
  await evaluate(`(() => { const s = document.querySelector('#task-dialog select[aria-label="Wanneer?"]'); s.value = '1440'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await clickText('Herinnering toevoegen', `document.querySelector('#task-dialog')`);
  await clickText('Annuleren', `document.querySelector('#task-dialog')`);
  await waitFor(`JSON.parse(sessionStorage.getItem('android-calls') || '[]').some((c) => c[0] === 'remindersChanged')`, 'Android is gewaarschuwd', 8000);
  await sleep(2500);
  assert.equal((await calls()).filter((c) => c[0] === 'remindersChanged').length, 1, 'één waarschuwing, niet één per wijziging');
  // een melding aangetikt: de app opent de taak via #task=…
  const buren = serverTask('Bellen met de buren').id;
  await evaluate(`location.hash = ${js(`#task=${buren}`)}`);
  await waitFor(`document.querySelector('#task-dialog[open] textarea')?.value === 'Bellen met de buren'`, 'taak geopend vanuit de melding');
  assert.equal(await evaluate(`location.hash`), '', 'het adres is weer schoon');
  await clickText('Annuleren', `document.querySelector('#task-dialog')`);
  await waitFor(`!document.querySelector('dialog[open]')`, 'taakvenster gesloten');
  // een onbekende of vreemde waarde in het adres doet niets
  await evaluate(`location.hash = '#task=<script>alert(1)</script>'`);
  await sleep(300);
  assert.equal(await evaluate(`Boolean(document.querySelector('#task-dialog'))`), false);
  // tekst uit een andere app gedeeld (#share=…): het venster Taak toevoegen, voorgevuld en in de Inbox
  const shared = Buffer.from(JSON.stringify({ title: 'Fietsroute Texel', text: 'https://example.org/route' }), 'utf8').toString('base64url');
  await evaluate(`location.hash = ${js(`#share=${shared}`)}`);
  await waitFor(`document.querySelector('.dialog-quick[open] input[type=text]')?.value === 'Fietsroute Texel'`, 'gedeelde tekst als titel');
  assert.equal(await evaluate(`document.querySelector('.dialog-quick[open] textarea').value`), 'https://example.org/route', 'de link staat in de beschrijving');
  assert.equal(await evaluate(`document.querySelector('.dialog-quick[open] select').selectedOptions[0].textContent.trim()`), 'Inbox', 'gedeelde tekst komt in de Inbox');
  assert.equal(await evaluate(`location.hash`), '', 'het adres is weer schoon');
  await clickText('Annuleren', `document.querySelector('.dialog-quick')`);
  await waitFor(`!document.querySelector('dialog[open]')`, 'venster gesloten');
  assert.equal(serverTask('Fietsroute Texel'), undefined, 'annuleren maakt geen taak');
  // een kapot of vreemd #share=… doet niets
  await evaluate(`location.hash = '#share=@@@'`);
  await evaluate(`location.hash = '#share=e30'`);
  await sleep(300);
  assert.equal(await evaluate(`Boolean(document.querySelector('dialog[open]'))`), false);
  await evaluate(`history.replaceState(null, '', location.pathname)`);
  await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: stub.identifier });
  await evaluate(`sessionStorage.removeItem('android-calls')`);
  await send('Page.reload');
  await waitFor(`document.body.classList.contains('ready')`, 'app opnieuw gestart zonder brug');
  await waitFor(SYNCED, 'gesynchroniseerd');
  step('Android-brug: de app krijgt het sessietoken, de uitleg over meldingen, alarmen en batterij verschijnt met werkende knoppen, een wijziging aan herinneringen geeft één waarschuwing, en #task=… opent de taak, en #share=… opent Taak toevoegen met de gedeelde tekst (een vreemde waarde niet)');

  // ---- 8d2. herinneringen op een locatie: plaatsen, de huidige positie (nagebootst), het taakvenster en de Android-brug ----
  await geoScenario({ send, evaluate, waitFor, step, shot, sleep, js, SYNCED, alice, serverState, typeInto, clickText, click, nav, BASE });

  // ---- 8d3. sjablonen: een project of taken uit een sjabloon, bewaren, delen, importeren ----
  await templatesScenario({ send, evaluate, waitFor, step, shot, sleep, js, SYNCED, alice, serverState, typeInto, clickText, click, submit, nav, workDir, BASE });

  // ---- 8e. het uiterlijk: projectenboom met kleur, favoriet, subproject, in- en uitklappen en archief ----
  const projectOnServer = (name: string) => (serverState().projects as any[]).find((p) => p.name === name);
  const labelsOfNav = () => texts('.nav-item .nav-label');
  const closeToasts = () => evaluate(`document.querySelectorAll('.toast-close').forEach((b) => b.click())`);
  /** Een toetsaanslag zoals een echt toetsenbord: via het DevTools-protocol, dus met dezelfde gevolgen als bij een mens. */
  const press = async (key: string, options: { ctrl?: boolean } = {}) => {
    const named: Record<string, [string, number]> = { Enter: ['Enter', 13], Escape: ['Escape', 27], Tab: ['Tab', 9], '?': ['Slash', 191], '/': ['Slash', 191], ArrowDown: ['ArrowDown', 40], ArrowUp: ['ArrowUp', 38] };
    const [code, vk] = named[key] ?? [`Key${key.toUpperCase()}`, key.toUpperCase().charCodeAt(0)];
    const modifiers = (options.ctrl ? 2 : 0) | (key === '?' ? 8 : 0);
    const text = key.length === 1 && !options.ctrl ? key : key === 'Enter' && !options.ctrl ? '\r' : undefined;
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, modifiers, text });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers });
  };
  const cssColor = (variable: string) => evaluate<string>(`(() => { const e = document.createElement('i'); e.style.color = 'var(${variable})'; document.body.append(e); const c = getComputedStyle(e).color; e.remove(); return c; })()`);
  const row = (content: string) => `[...document.querySelectorAll('.task')].find((l) => l.querySelector('.task-title').textContent === ${js(content)})`;
  const noDialog = () => waitFor(`!document.querySelector('dialog[open]')`, 'alle vensters gesloten');

  await nav('Thuis');
  await waitFor(`document.getElementById('view-title').textContent === 'Thuis'`, 'Thuis');
  assert.deepEqual(await labelsOfNav(), ['Inbox', 'Vandaag', 'Binnenkort', 'Voltooid', 'Meldingen', 'Thuis', 'Alice'], 'de Inbox staat bovenaan, dan Vandaag en Binnenkort (en Meldingen: Thuis is gedeeld), dan de projecten');
  await click('.nav-heading button');
  await waitFor(`document.querySelector('dialog[open] h2')?.textContent === 'Nieuw project'`, 'projectvenster');
  assert.equal(await evaluate(`document.querySelectorAll('dialog[open] input[name="project-color"]').length`), 16, 'zestien kleuren');
  assert.equal(await evaluate(`document.querySelector('dialog[open] input[name="project-color"]:checked').value`), 'charcoal', 'standaard antraciet, zoals de server');
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('dialog[open] select option')].map((o) => o.textContent.replace(/\\u00a0/g, '_'))`), ['(geen: hoofdniveau)', 'Thuis'], 'de Inbox kan geen subprojecten hebben');
  await typeInto('dialog[open] input[type=text]', 'Tuin');
  await click('dialog[open] input[name="project-color"][value="green"]');
  await click('dialog[open] .check-row input');
  await evaluate(`(() => { const s = document.querySelector('dialog[open] select'); s.value = ${js(thuisId)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await shot('projectvenster-nieuw');
  await submit('dialog[open] form');
  await waitFor(`document.getElementById('view-title').textContent === 'Tuin'`, 'het nieuwe project is geopend');
  await waitFor(SYNCED, 'gesynchroniseerd');
  const tuin = projectOnServer('Tuin');
  assert.deepEqual([tuin.color, tuin.is_favorite, tuin.parent_id], ['green', true, thuisId], 'kleur, favoriet en bovenliggend project staan op de server');
  assert.deepEqual(await texts('.nav-heading span'), ['Favorieten', 'Projecten']);
  assert.deepEqual(await labelsOfNav(), ['Inbox', 'Vandaag', 'Binnenkort', 'Voltooid', 'Meldingen', 'Tuin', 'Thuis', 'Tuin', 'Alice'], 'Tuin staat bij de favorieten en onder Thuis');
  assert.ok(await evaluate(`document.querySelector('.nav-row[data-depth="1"] .dot').classList.contains('pc-green')`), 'het bolletje heeft de kleur van het project');
  assert.equal(await evaluate(`document.querySelector('#view-lead .dot').classList.contains('pc-green')`), true, 'ook in de kop');
  await shot('zijbalk-projecten');
  // in- en uitklappen van het bovenliggende project (is_collapsed, ook op de server)
  assert.equal(await evaluate(`document.querySelector('button.nav-toggle').getAttribute('aria-label')`), 'Subprojecten van Thuis verbergen');
  await click('button.nav-toggle');
  await waitFor(SYNCED, 'gesynchroniseerd');
  assert.equal(projectOnServer('Thuis').is_collapsed, true);
  assert.deepEqual(await labelsOfNav(), ['Inbox', 'Vandaag', 'Binnenkort', 'Voltooid', 'Meldingen', 'Tuin', 'Thuis', 'Alice'], 'Tuin is niet meer onder Thuis te zien');
  assert.equal(await evaluate(`document.querySelector('button.nav-toggle').getAttribute('aria-expanded')`), 'false');
  await click('button.nav-toggle');
  await waitFor(SYNCED, 'gesynchroniseerd');
  assert.equal(projectOnServer('Thuis').is_collapsed, false);
  assert.equal((await labelsOfNav()).length, 9);
  // bewerken via het projectmenu: kleur en favoriet
  await clickText('Project…');
  await waitFor(`document.querySelector('dialog[open] .menu')`, 'projectmenu');
  assert.deepEqual(await buttons(), ['Bewerken…', 'Subproject toevoegen', 'Taak uit sjabloon…', 'Opslaan als sjabloon…', 'Uit favorieten halen', 'Voltooide taken bekijken', 'Activiteit', 'Delen…', 'Archiveren', 'Project verwijderen', 'Sluiten']);
  await clickText('Bewerken…');
  await waitFor(`document.querySelector('dialog[open] h2')?.textContent === 'Project bewerken'`, 'projectvenster (bewerken)');
  assert.equal(await evaluate(`document.querySelector('dialog[open] input[name="project-color"]:checked').value`), 'green');
  assert.equal(await evaluate(`document.querySelector('dialog[open] .check-row input').checked`), true);
  assert.equal(await evaluate(`Boolean(document.querySelector('dialog[open] select'))`), false, 'verhuizen hoort hier niet bij (alleen de eigenaar mag dat, en het is voor een nieuw project)');
  await click('dialog[open] input[name="project-color"][value="rose"]');
  await click('dialog[open] .check-row input');
  await submit('dialog[open] form');
  await waitFor(`!document.querySelector('dialog[open]')`, 'venster gesloten');
  await waitFor(SYNCED, 'gesynchroniseerd');
  assert.deepEqual([projectOnServer('Tuin').color, projectOnServer('Tuin').is_favorite], ['rose', false]);
  assert.deepEqual(await texts('.nav-heading span'), ['Projecten'], 'zonder favorieten geen kopje');
  await clickText('Project…');
  await waitFor(`document.querySelector('dialog[open] .menu')`, 'projectmenu');
  await clickText('Aan favorieten toevoegen');
  await waitFor(`!document.querySelector('dialog[open]')`, 'menu gesloten');
  await waitFor(SYNCED, 'gesynchroniseerd');
  assert.equal(projectOnServer('Tuin').is_favorite, true);
  // een subproject via het menu van Thuis
  await nav('Thuis');
  await clickText('Project…');
  await waitFor(`document.querySelector('dialog[open] .menu')`, 'projectmenu');
  await clickText('Subproject toevoegen');
  await waitFor(`document.querySelector('dialog[open] h2')?.textContent === 'Nieuw subproject'`, 'venster voor een subproject');
  assert.equal(await evaluate(`document.querySelector('dialog[open] select').value`), thuisId, 'het bovenliggende project staat al goed');
  await typeInto('dialog[open] input[type=text]', 'Schuur');
  await submit('dialog[open] form');
  await waitFor(`document.getElementById('view-title').textContent === 'Schuur'`, 'subproject geopend');
  await waitFor(SYNCED, 'gesynchroniseerd');
  assert.equal(projectOnServer('Schuur').parent_id, thuisId);
  // archiveren en terugzetten
  await clickText('Project…');
  await waitFor(`document.querySelector('dialog[open] .menu')`, 'projectmenu');
  await clickText('Archiveren');
  await waitFor(`document.getElementById('view-title').textContent === 'Inbox'`, 'na het archiveren naar de Inbox');
  await waitFor(SYNCED, 'gesynchroniseerd');
  assert.equal(projectOnServer('Schuur').is_archived, true);
  assert.ok(!(await labelsOfNav()).includes('Schuur'), 'een gearchiveerd project staat niet in de zijbalk');
  assert.ok(await evaluate(`[...document.querySelectorAll('.nav-link')].some((b) => b.textContent.trim() === 'Gearchiveerde projecten')`), 'de regel "Gearchiveerde projecten" verschijnt');
  assert.deepEqual(await buttons('.view-actions'), ['Lijst', 'Bord', 'Kalender', 'Opmerkingen'], 'de Inbox heeft geen menu, delen of archiveren');
  await closeToasts();
  await click('.nav-link');
  await waitFor(`document.querySelector('dialog[open] h2')?.textContent === 'Gearchiveerde projecten'`, 'archief');
  assert.deepEqual(await texts('dialog[open] .archive-name'), ['Schuur']);
  await shot('archief');
  await clickText('Terugzetten');
  await waitFor(SYNCED, 'gesynchroniseerd');
  assert.equal(projectOnServer('Schuur').is_archived, false);
  await waitFor(`document.querySelector('dialog[open] .comment-none')?.textContent === 'Er zijn geen gearchiveerde projecten.'`, 'archief leeg');
  await clickText('Sluiten', `document.querySelector('dialog[open]')`);
  await noDialog();
  assert.ok((await labelsOfNav()).includes('Schuur'));
  assert.ok(!(await evaluate(`Boolean(document.querySelector('.nav-link'))`)), 'zonder gearchiveerde projecten geen regel');
  // het project weer weg, zodat de rest van de test hetzelfde blijft
  await nav('Schuur');
  await clickText('Project…');
  await waitFor(`document.querySelector('dialog[open] .menu')`, 'projectmenu');
  await clickText('Project verwijderen');
  await waitFor(`[...document.querySelectorAll('dialog[open] h2')].some((e) => e.textContent === 'Project verwijderen?')`, 'bevestiging');
  await evaluate(`[...document.querySelectorAll('dialog[open]')].at(-1).querySelector('.button-danger').click()`);
  await waitFor(`document.getElementById('view-title').textContent === 'Inbox'`, 'naar de Inbox');
  await waitFor(SYNCED, 'gesynchroniseerd');
  assert.equal(projectOnServer('Schuur'), undefined);
  step('projecten: kleur kiezen (16 kleuren, standaard antraciet), favoriet, subproject (ook via het menu), in- en uitklappen met is_collapsed op de server, bewerken, archiveren en terugzetten; de Inbox heeft geen menu');

  // ---- 8f. de takenlijst: subtaken en secties in- en uitklappen, snelle knoppen ----
  await nav('Thuis');
  await waitFor(`document.getElementById('view-title').textContent === 'Thuis'`, 'Thuis');
  const afwasId = serverTask('Afwasmachine uitruimen').id;
  const keukenId = (serverState().sections as any[]).find((s) => s.name === 'Keuken').id;
  assert.equal(await evaluate(`${row('Afwasmachine uitruimen')}.querySelector('.chip-toggle').getAttribute('aria-expanded')`), 'true');
  await evaluate(`${row('Afwasmachine uitruimen')}.querySelector('.chip-toggle').click()`);
  await waitFor(`!document.querySelector('.task[data-depth="1"]')`, 'subtaak verborgen');
  await waitFor(SYNCED, 'gesynchroniseerd');
  assert.equal(serverTask('Afwasmachine uitruimen').is_collapsed, true);
  assert.equal(await evaluate(`${row('Afwasmachine uitruimen')}.querySelector('.chip-toggle').getAttribute('aria-expanded')`), 'false');
  await evaluate(`${row('Afwasmachine uitruimen')}.querySelector('.chip-toggle').click()`);
  await waitFor(`document.querySelector('.task[data-depth="1"]')`, 'subtaak weer zichtbaar');
  await waitFor(SYNCED, 'gesynchroniseerd');
  assert.equal(serverTask('Afwasmachine uitruimen').is_collapsed, false);
  const sectionToggle = `[...document.querySelectorAll('.group')].find((g) => g.querySelector('.group-title')?.textContent === 'Keuken').querySelector('.group-toggle')`;
  assert.equal(await evaluate(`${sectionToggle}.getAttribute('aria-label')`), 'Sectie Keuken inklappen');
  await evaluate(`${sectionToggle}.click()`);
  await waitFor(`![...document.querySelectorAll('.task-title')].some((e) => e.textContent === 'Afwasmachine uitruimen')`, 'sectie ingeklapt');
  await waitFor(SYNCED, 'gesynchroniseerd');
  assert.equal((serverState().sections as any[]).find((s) => s.id === keukenId).is_collapsed, true);
  assert.equal(await evaluate(`${sectionToggle}.getAttribute('aria-label')`), 'Sectie Keuken uitklappen');
  assert.equal(await evaluate(`${sectionToggle}.getAttribute('aria-expanded')`), 'false');
  await evaluate(`${sectionToggle}.click()`);
  await waitFor(`${row('Afwasmachine uitruimen')}`, 'sectie weer uitgeklapt');
  await waitFor(SYNCED, 'gesynchroniseerd');
  // snelle knoppen: dag kiezen en verwijderen, en de prioriteitskleur van de cirkel
  await quickAdd('Wegwerptaak p3');
  await waitFor(row('Wegwerptaak'), 'wegwerptaak in beeld');
  assert.equal(await evaluate(`${row('Wegwerptaak')}.classList.contains('prio-3')`), true);
  assert.equal(await evaluate(`getComputedStyle(${row('Wegwerptaak')}.querySelector('.check'), '::before').borderTopColor`), await cssColor('--p3'), 'de cirkel heeft de kleur van prioriteit 3 (blauw)');
  await evaluate(`${row('Wegwerptaak')}.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))`);
  assert.deepEqual(await evaluate(`[...${row('Wegwerptaak')}.querySelectorAll('.task-actions button')].map((b) => b.getAttribute('aria-label'))`),
    ['Bewerken: Wegwerptaak', 'Andere dag kiezen voor: Wegwerptaak', 'Verwijderen: Wegwerptaak']);
  await evaluate(`${row('Wegwerptaak')}.querySelector('[data-act="date"]').click()`);
  await waitFor(`document.querySelector('dialog[open] h2')?.textContent === 'Andere dag kiezen'`, 'dagkeuze');
  assert.deepEqual(await buttons(), ['Vandaag · vandaag', 'Morgen · morgen', `Dit weekend · ${formatDate(quickDates(today).weekend, today)}`, `Volgende week · ${formatDate(quickDates(today).nextWeek, today)}`, 'Sluiten']);
  await clickText('Morgen · morgen');
  await waitFor(SYNCED, 'gesynchroniseerd');
  assert.equal(serverTask('Wegwerptaak').due.date, tomorrow);
  assert.deepEqual(await taskMeta('Wegwerptaak'), ['morgen']);
  // het taakvenster vanuit de snelle knop; afvinken in het venster sluit het en meldt het
  await evaluate(`${row('Wegwerptaak')}.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))`);
  await evaluate(`${row('Wegwerptaak')}.querySelector('[data-act="edit"]').click()`);
  await waitFor(`document.querySelector('#task-dialog[open]')`, 'taakvenster via de snelle knop');
  await click('#task-dialog .check-large');
  await waitFor(`!document.querySelector('dialog[open]')`, 'venster dicht na afvinken');
  await waitFor(SYNCED, 'gesynchroniseerd');
  assert.equal(serverTask('Wegwerptaak').checked, true);
  await waitFor(`[...document.querySelectorAll('.toast-text')].some((e) => e.textContent === 'Taak voltooid')`, 'melding');
  await closeToasts();
  await waitFor(`!(${row('Wegwerptaak')})`, 'voltooide taak uit de lijst');
  // heropenen vanuit het taakvenster (een voltooide taak zie je via "Voltooide taken tonen")
  await evaluate(`[...document.querySelectorAll('.link-button')].find((b) => b.textContent.startsWith('Voltooide taken tonen')).click()`);
  await waitFor(row('Wegwerptaak'), 'voltooide taak zichtbaar');
  assert.equal(await evaluate(`${row('Wegwerptaak')}.classList.contains('task-done')`), true);
  await openTask('Wegwerptaak');
  assert.equal(await evaluate(`document.querySelector('#task-dialog .check-large').getAttribute('aria-pressed')`), 'true');
  await click('#task-dialog .check-large');
  await waitFor(`document.querySelector('#task-dialog .check-large').getAttribute('aria-pressed') === 'false'`, 'heropend in het taakvenster');
  await waitFor(SYNCED, 'gesynchroniseerd');
  assert.equal(serverTask('Wegwerptaak').checked, false, 'de taak is heropend');
  await click('#task-dialog .task-top .icon-button');
  await noDialog();
  await waitFor(`!document.querySelector('.link-button')`, 'geen voltooide taken meer');
  // verwijderen met de snelle knop (een nieuwe wegwerptaak)
  await quickAdd('Wegwerptaak twee');
  await waitFor(row('Wegwerptaak twee'), 'tweede wegwerptaak');
  await evaluate(`${row('Wegwerptaak twee')}.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))`);
  await evaluate(`${row('Wegwerptaak twee')}.querySelector('[data-act="delete"]').click()`);
  await waitFor(`document.querySelector('dialog[open] h2')?.textContent === 'Taak verwijderen?'`, 'bevestiging');
  await evaluate(`[...document.querySelectorAll('dialog[open]')].at(-1).querySelector('.button-danger').click()`);
  await waitFor(SYNCED, 'gesynchroniseerd');
  assert.equal(serverTask('Wegwerptaak twee'), undefined);
  // de voltooide wegwerptaak opruimen (direct op de server)
  await syncAs(otherToken, 'ander-apparaat', [{ type: 'task_delete', uuid: 'e2e-opruimen-0001', args: { id: serverTask('Wegwerptaak').id } }]);
  await waitFor(`await ${SYNCED}`, 'opgeruimd');
  step('takenlijst: subtaken en secties in- en uitklappen (met is_collapsed op de server), de cirkel heeft de kleur van de prioriteit, snelle knoppen voor bewerken, een andere dag kiezen en verwijderen, afvinken vanuit het taakvenster');

  // ---- 8g. opmerkingen bij een taak en een project ----
  await openTask('Afwasmachine uitruimen');
  assert.equal(await evaluate(`document.querySelector('#task-dialog .comments .subheading').textContent`), 'Opmerkingen');
  assert.equal(await evaluate(`document.querySelector('#task-dialog .comment-none').textContent`), 'Nog geen opmerkingen.');
  assert.equal(await evaluate(`document.querySelector('#task-dialog .comment-form .button-primary').disabled`), true, 'zonder tekst valt er niets te plaatsen');
  await typeInto('#task-dialog .comment-input', 'Eerst de glazen.\nZie https://voorbeeld.nl/handleiding.');
  assert.equal(await evaluate(`document.querySelector('#task-dialog .comment-form .button-primary').disabled`), false);
  await click('#task-dialog .comment-form .button-primary');
  await waitFor(`document.querySelectorAll('#task-dialog .comment').length === 1`, 'opmerking in beeld');
  assert.equal(await evaluate(`document.querySelector('#task-dialog .comment-input').value`), '', 'het veld is weer leeg');
  assert.equal(await evaluate(`document.querySelector('#task-dialog .comment-author').textContent`), 'Alice');
  assert.equal(await evaluate(`document.querySelector('#task-dialog .comment-time').textContent`), 'zojuist');
  assert.equal(await evaluate(`document.querySelector('#task-dialog .comment-text').textContent`), 'Eerst de glazen.\nZie https://voorbeeld.nl/handleiding.', 'regeleinden blijven');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('#task-dialog .comment-text')).whiteSpace`), 'pre-wrap');
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('#task-dialog .comment-text a')].map((a) => [a.textContent, a.href, a.rel, a.target])`),
    [['https://voorbeeld.nl/handleiding', 'https://voorbeeld.nl/handleiding', 'noopener noreferrer nofollow', '_blank']], 'een webadres is een gewone link (zonder punt eraan)');
  // tekst met HTML blijft tekst
  await typeInto('#task-dialog .comment-input', '<img src=x onerror="window.__pwn=1"> <b>vet</b> javascript:alert(1)');
  await press('Enter', { ctrl: true });
  await waitFor(`document.querySelectorAll('#task-dialog .comment').length === 2`, 'tweede opmerking (Ctrl+Enter plaatst hem)');
  assert.equal(await evaluate(`document.querySelectorAll('#task-dialog .comment-text img, #task-dialog .comment-text b, #task-dialog .comment-text a[href^="javascript"]').length`), 0, 'geen HTML uit een opmerking');
  assert.equal(await evaluate(`window.__pwn === undefined`), true);
  assert.equal(await evaluate(`document.querySelectorAll('#task-dialog .comment-text')[1].textContent`), '<img src=x onerror="window.__pwn=1"> <b>vet</b> javascript:alert(1)');
  await waitFor(SYNCED, 'gesynchroniseerd');
  const aliceComments = () => (serverState().comments as any[]).filter((c) => c.task_id === afwasId);
  assert.deepEqual(aliceComments().map((c) => c.author_id), [alice.id, alice.id], 'de schrijver is Alice');
  // bewerken
  await sleep(2200); // een opmerking telt pas als bewerkt na een paar seconden
  await evaluate(`document.querySelector('#task-dialog .comment [aria-label="Opmerking bewerken"]').click()`);
  await waitFor(`document.querySelector('#task-dialog .comment-edit textarea')`, 'bewerkveld');
  await typeInto('#task-dialog .comment-edit textarea', 'Eerst de glazen, dan het bestek.');
  await click('#task-dialog .comment-edit .button-primary');
  await waitFor(`document.querySelector('#task-dialog .comment-text').textContent === 'Eerst de glazen, dan het bestek.'`, 'opmerking aangepast');
  await waitFor(SYNCED, 'gesynchroniseerd');
  assert.equal(aliceComments().some((c) => c.content === 'Eerst de glazen, dan het bestek.'), true);
  assert.equal(await evaluate(`document.querySelector('#task-dialog .comment-edited')?.textContent`), '(bewerkt)');
  // een tweede gebruiker (Bob) reageert; Alice ziet het zonder te herladen, en kan het niet wijzigen of verwijderen
  const bobComment = await syncAs(bobToken, 'bob-telefoon', [{ type: 'comment_add', uuid: 'e2e-bob-opmerking-1', args: { id: 'e2ebobopmerking01', task_id: afwasId, content: 'Ik help morgen mee.' } }]);
  assert.equal(bobComment.status, 200);
  await waitFor(`[...document.querySelectorAll('#task-dialog .comment-author')].some((e) => e.textContent === 'Bob')`, 'opmerking van Bob verschijnt vanzelf', 6000);
  assert.equal(await evaluate(`document.querySelectorAll('#task-dialog .comment').length`), 3);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('#task-dialog .comment')].map((c) => c.querySelectorAll('.comment-tools button').length)`), [2, 2, 0], 'bewerken en verwijderen alleen bij je eigen opmerkingen');
  await shot('opmerkingen');
  // verwijderen (met bevestiging)
  await evaluate(`document.querySelectorAll('#task-dialog .comment')[1].querySelector('[aria-label="Opmerking verwijderen"]').click()`);
  await waitFor(`[...document.querySelectorAll('dialog[open] h2')].some((e) => e.textContent === 'Opmerking verwijderen?')`, 'bevestiging');
  await evaluate(`[...document.querySelectorAll('dialog[open]')].at(-1).querySelector('.button-danger').click()`);
  await waitFor(`document.querySelectorAll('#task-dialog .comment').length === 2`, 'opmerking verwijderd');
  await waitFor(SYNCED, 'gesynchroniseerd');
  assert.equal(aliceComments().length, 2);
  // Esc sluit het venster zonder iets te bewaren
  await typeInto('#task-dialog textarea[aria-label="Taak"]', 'Niet bewaard');
  await press('Escape');
  await noDialog();
  await sleep(300);
  assert.equal(serverTask('Afwasmachine uitruimen').content, 'Afwasmachine uitruimen', 'Esc verwerpt de wijzigingen');
  // de teller in de lijst
  await waitFor(`${row('Afwasmachine uitruimen')}.querySelector('.chip-comments')?.textContent === '2'`, 'teller van opmerkingen in de lijst');
  assert.deepEqual(await taskMeta('Afwasmachine uitruimen'), [await evaluate(`${row('Afwasmachine uitruimen')}.querySelector('.chip').textContent`), '0/1', '2']);
  // een opmerking bij het project
  await click('.btn-comments');
  await waitFor(`document.querySelector('dialog[open] h2')?.textContent === 'Opmerkingen: Thuis'`, 'opmerkingen bij het project');
  await typeInto('dialog[open] .comment-input', 'Schoonmaakmiddel is bijna op.');
  await click('dialog[open] .comment-form .button-primary');
  await waitFor(`document.querySelectorAll('dialog[open] .comment').length === 1`, 'projectopmerking');
  await waitFor(SYNCED, 'gesynchroniseerd');
  assert.equal((serverState().comments as any[]).filter((c) => c.project_id === thuisId).length, 1);
  await clickText('Sluiten', `document.querySelector('dialog[open]')`);
  await noDialog();
  assert.deepEqual(await buttons('.view-actions'), ['Lijst', 'Bord', 'Kalender', 'Opmerkingen (1)', 'Gedeeld', 'Project…']);
  step('opmerkingen: toevoegen (ook met Ctrl+Enter), regeleinden en webadressen als gewone link, HTML blijft tekst, bewerken en verwijderen alleen van jezelf, een opmerking van Bob verschijnt vanzelf, teller in de lijst, opmerkingen bij een project');

  // ---- 8g1. meldingen bij samenwerken en @-vermeldingen (scripts/e2e-notify.ts) ----
  await notifyScenario(notifyCtx());

  // ---- 8g1b. rollen (alleen lezen) en het activiteitenlogboek (scripts/e2e-roles.ts) ----
  await rolesScenario({ ...notifyCtx(), openTask, noDialog, buttons, texts });
  step('rollen en activiteit: alles in scripts/e2e-roles.ts');

  // ---- 8g2. bijlagen (scripts/e2e-attachments.ts) ----
  await attachmentScenario({
    send, evaluate, waitFor, sleep, js, shot, step, serverState, startServer, stopServer, workDir, BASE, bobToken, alice, aliceToken: createSession(db, alice.id, 'Controle bijlagen').token,
    openTask, click, clickText, noDialog, SYNCED, attachments,
    strangerToken: createSession(db, createUser(db, { username: 'eve', name: 'Eve', passwordHash: 'x' }).id, 'Vreemde').token, // geen lid van Thuis
  });

  // ---- 8h. het taakvenster: prioriteitsknoppen, snelle datums, labels, Ctrl+Enter, Esc ----
  await openTask('Afwasmachine uitruimen');
  assert.equal(await evaluate(`document.querySelector('#task-dialog .task-created').textContent`), 'Gemaakt door Alice, vandaag', 'wie de taak maakte en wanneer');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('#task-dialog .task-columns')).display`), 'grid', 'twee kolommen op een breed scherm');
  assert.equal(await evaluate(`new Set([...document.querySelectorAll('#task-dialog .task-col-main, #task-dialog .task-col-side')].map((c) => Math.round(c.getBoundingClientRect().top))).size`), 1, 'de kolommen staan naast elkaar');
  await shot('taakvenster');
  await click('#task-dialog .prio-option.prio-2 input');
  await clickText('Morgen', `document.querySelector('#task-dialog')`);
  await waitFor(`document.querySelector('#task-dialog .hint').textContent.startsWith('Wordt:')`, 'uitleg bij de snelle datum');
  assert.equal(await evaluate(`document.querySelector('#task-dialog input[placeholder^="bv. morgen"]').value`), formatDateInput({ date: tomorrow }));
  await typeInto('#task-dialog .label-input', 'schoonmaak');
  await press('Enter');
  await waitFor(`[...document.querySelectorAll('#task-dialog .label-chips .chip')].some((c) => c.textContent === '@schoonmaak')`, 'label als chip');
  assert.equal(await evaluate(`Boolean(document.querySelector('#task-dialog[open]'))`), true, 'Enter in het labelveld sluit het venster niet');
  await evaluate(`(() => { const s = document.querySelector('#task-dialog select[aria-label="Toegewezen aan"]'); s.value = ${js(bob.id)}; })()`);
  await evaluate(`document.querySelector('#task-dialog textarea[aria-label="Taak"]').focus()`);
  await press('Enter', { ctrl: true });
  await noDialog();
  await waitFor(SYNCED, 'gesynchroniseerd');
  const afwasNu = serverTask('Afwasmachine uitruimen');
  assert.deepEqual([afwasNu.priority, afwasNu.due.date, afwasNu.assignee_id], [2, tomorrow, bob.id], 'Ctrl+Enter heeft alles bewaard');
  assert.equal((serverState().labels as any[]).filter((l) => l.name === 'schoonmaak').length, 1);
  assert.equal(afwasNu.labels.length, 1);
  assert.deepEqual(await taskMeta('Afwasmachine uitruimen'), ['morgen', '0/1', '2', '4', '@schoonmaak', 'voor Bob']);
  assert.equal(await evaluate(`${row('Afwasmachine uitruimen')}.classList.contains('prio-2')`), true);
  // datum zonder snelle knoppen, en "Geen datum"
  await openTask('Afwasmachine uitruimen');
  await clickText('Geen datum', `document.querySelector('#task-dialog')`);
  await click('#task-dialog .prio-option.prio-4 input');
  await click('#task-dialog .label-chips .chip-x');
  await press('Enter', { ctrl: true });
  await noDialog();
  await waitFor(SYNCED, 'gesynchroniseerd');
  const afwasLeeg = serverTask('Afwasmachine uitruimen');
  assert.deepEqual([afwasLeeg.priority, afwasLeeg.due, afwasLeeg.labels], [4, null, []]);
  step('taakvenster: twee kolommen, wie de taak maakte, vier prioriteitsknoppen, snelle datums en "Geen datum", labels als chips, toewijzen, Ctrl+Enter bewaart, Esc verwerpt');

  // ---- 8i. sneltoetsen en het venster "Taak toevoegen" ----
  await evaluate(`document.activeElement?.blur()`);
  await evaluate(`window.__keys = []; document.addEventListener('keydown', (e) => window.__keys.push([e.key, e.ctrlKey, e.defaultPrevented]))`);
  await press('/');
  await press('k', { ctrl: true });
  await sleep(150);
  assert.deepEqual(await evaluate(`window.__keys`), [['/', false, true], ['k', true, true]], '/ en Ctrl+K zijn voor zoeken (zie 9c): de toets is opgeëist');
  assert.equal(await evaluate(`document.querySelectorAll('dialog[open]').length`), 1, 'het zoekvenster staat open (de tweede toets vindt het al open)');
  await press('Escape');
  await noDialog();
  await waitFor(`!document.querySelector('dialog')`, 'het zoekvenster is opgeruimd'); // pas daarna geeft de pagina de focus terug
  await press('?');
  await waitFor(`document.querySelector('dialog[open] h2')?.textContent === 'Sneltoetsen'`, 'overzicht van sneltoetsen');
  assert.deepEqual(await texts('dialog[open] .shortcut dd'), ['Taak toevoegen', 'Naar Vandaag', 'Naar Binnenkort', 'Naar de Inbox', 'Dit overzicht tonen', 'Zoeken', 'Zoeken', 'Een venster sluiten', 'De taak onder de aanwijzer of focus selecteren', 'Alle taken in beeld selecteren', 'Selecteren stoppen', 'De laatste wijziging ongedaan maken', 'De taak opslaan in het taakvenster', 'Een taak of project een plek omhoog of omlaag zetten', 'Een taak of project onder het vorige hangen (subtaak) of er weer uit halen']);
  await shot('sneltoetsen');
  await press('q');
  await sleep(150);
  assert.equal(await evaluate(`document.querySelectorAll('dialog[open]').length`), 1, 'terwijl een venster open is, doen de toetsen niets');
  await press('Escape');
  await noDialog();
  await press('q');
  await waitFor(`document.querySelector('.dialog-quick[open]')`, 'venster Taak toevoegen met q');
  assert.equal(await evaluate(`document.activeElement === document.querySelector('.dialog-quick[open] input[type=text]')`), true, 'het invoerveld heeft meteen de focus');
  assert.equal(await evaluate(`document.querySelector('.dialog-quick[open] select').selectedOptions[0].textContent.trim()`), 'Thuis', 'in een project komt de taak standaard in dat project');
  await typeInto('.dialog-quick[open] input[type=text]', 'Tandenborstel kopen morgen p2 @bellen');
  await waitFor(`document.querySelectorAll('.dialog-quick[open] .chip').length === 4`, 'voorvertoning in het venster');
  assert.deepEqual(await texts('.dialog-quick[open] .chip'), ['Tandenborstel kopen', 'morgen', '@bellen', 'P2']);
  await typeInto('.dialog-quick[open] textarea', 'Een zachte.');
  await shot('taak-toevoegen');
  await submit('.dialog-quick[open] form');
  await noDialog();
  await waitFor(SYNCED, 'gesynchroniseerd');
  const tand = serverTask('Tandenborstel kopen');
  assert.deepEqual([tand.project_id, tand.priority, tand.due.date, tand.description], [thuisId, 2, tomorrow, 'Een zachte.']);
  // spraakinvoer: met een nagebootste spraakherkenner van de browser komt de herkende tekst in het veld (en er wordt niets aangemaakt)
  await evaluate(`window.SpeechRecognition = class { start() { this.lang0 = this.lang; setTimeout(() => this.onresult({ results: [[{ transcript: 'Bel de tandarts morgen p1' }]] }), 30); } stop() { this.onend?.(); } }`);
  await press('q');
  await waitFor(`document.querySelector('.dialog-quick[open] .voice-button')`, 'microfoonknop in het venster Taak toevoegen');
  assert.equal(await evaluate(`document.querySelector('.voice-button').getAttribute('aria-label')`), 'Spreek een taak in');
  await click('.dialog-quick[open] .voice-button');
  await waitFor(`document.querySelector('.dialog-quick[open] input[type=text]').value === 'Bel de tandarts morgen p1'`, 'de gesproken tekst staat in het veld');
  await waitFor(`document.querySelectorAll('.dialog-quick[open] .chip').length === 3`, 'voorvertoning van de gesproken taak');
  assert.deepEqual(await texts('.dialog-quick[open] .chip'), ['Bel de tandarts', 'morgen', 'P1']);
  assert.equal(await evaluate(`document.querySelector('.voice-button').getAttribute('aria-pressed')`), 'false', 'de knop is weer uit');
  assert.equal(serverTask('Bel de tandarts'), undefined, 'er is nog niets aangemaakt');
  await clickText('Annuleren', `document.querySelector('.dialog-quick')`);
  await noDialog();
  await evaluate(`delete window.SpeechRecognition`);
  // een letter in een invoerveld is gewoon een letter
  await evaluate(`document.getElementById('quick-input').focus()`);
  await press('q');
  assert.equal(await evaluate(`document.getElementById('quick-input').value`), 'q');
  assert.equal(await evaluate(`Boolean(document.querySelector('dialog[open]'))`), false);
  await typeInto('#quick-input', '');
  await evaluate(`document.activeElement?.blur()`);
  // g en dan t, u of i
  for (const [second, title] of [['t', 'Vandaag'], ['u', 'Binnenkort'], ['i', 'Inbox']] as const) {
    await press('g');
    await press(second);
    await waitFor(`document.getElementById('view-title').textContent === ${js(title)}`, `g ${second}: ${title}`);
  }
  // de knop in de zijbalk en de knop onder een sectie
  await click('.sidebar-add');
  await waitFor(`document.querySelector('.dialog-quick[open]')`, 'venster via de knop');
  assert.equal(await evaluate(`document.querySelector('.dialog-quick[open] select').selectedOptions[0].textContent.trim()`), 'Inbox');
  await clickText('Annuleren', `document.querySelector('dialog[open]')`);
  await noDialog();
  await nav('Thuis');
  await waitFor(`document.getElementById('view-title').textContent === 'Thuis'`, 'Thuis');
  await evaluate(`[...document.querySelectorAll('.group')].find((g) => g.querySelector('.group-title')?.textContent === 'Keuken').querySelector('.add-inline').click()`);
  await waitFor(`document.querySelector('.dialog-quick[open]')`, 'venster via de knop onder een sectie');
  await typeInto('.dialog-quick[open] input[type=text]', 'Pannen schoonmaken');
  await submit('.dialog-quick[open] form');
  await noDialog();
  await waitFor(SYNCED, 'gesynchroniseerd');
  assert.deepEqual([serverTask('Pannen schoonmaken').project_id, serverTask('Pannen schoonmaken').section_id], [thuisId, keukenId], 'de taak komt in de sectie waaronder je op de knop drukte');
  for (const content of ['Pannen schoonmaken', 'Tandenborstel kopen']) {
    await evaluate(`${row(content)}.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))`);
    await evaluate(`${row(content)}.querySelector('[data-act="delete"]').click()`);
    await waitFor(`document.querySelector('dialog[open] h2')?.textContent === 'Taak verwijderen?'`, 'bevestiging');
    await evaluate(`[...document.querySelectorAll('dialog[open]')].at(-1).querySelector('.button-danger').click()`);
    await waitFor(SYNCED, 'gesynchroniseerd');
  }
  step('sneltoetsen: q (venster Taak toevoegen met voorvertoning, project en sectie als standaard), g t / g u / g i, ? (overzicht), in een invoerveld of bij een open venster niets; ook de knoppen in de zijbalk en onder een sectie');

  // ---- 8j. prestaties: een lijst van 2000 taken ----
  const bigId = 'e2egrootproject01';
  await syncAs(otherToken, 'ander-apparaat', [{ type: 'project_add', uuid: 'e2e-groot-project-1', args: { id: bigId, name: 'Groot', color: 'violet' } }]);
  for (let b = 0; b < 20; b++) {
    const commands = Array.from({ length: 100 }, (_, i) => {
      const k = b * 100 + i;
      return {
        type: 'task_add', uuid: `e2e-groot-taak-${String(k).padStart(5, '0')}`,
        args: { id: `e2egroottaak${String(k).padStart(5, '0')}`, project_id: bigId, content: `Taak ${k} met een redelijk lange naam om af te kappen`, priority: 1 + (k % 4), ...(k % 3 === 0 ? { due: { date: addDays(today, (k % 20) - 5) } } : {}), ...(k % 4 === 0 ? { description: 'Een korte beschrijving onder de titel.' } : {}) },
      };
    });
    assert.equal((await syncAs(otherToken, 'ander-apparaat', commands)).status, 200);
  }
  await waitFor(`[...document.querySelectorAll('.nav-item')].some((b) => b.querySelector('.nav-label')?.textContent === 'Groot' && b.querySelector('.nav-count')?.textContent === '2000')`, 'het grote project is binnen', 30_000);
  await waitFor(SYNCED, 'gesynchroniseerd');
  const timing = `(() => { const t0 = performance.now(); [...document.querySelectorAll('.nav-item')].find((b) => b.querySelector('.nav-label')?.textContent === 'Groot').click(); const t1 = performance.now(); document.body.offsetHeight; return { js: Math.round(t1 - t0), total: Math.round(performance.now() - t0), rows: document.querySelectorAll('.task').length }; })()`;
  const cold: number[] = [];
  for (let i = 0; i < 3; i++) {
    await nav('Inbox');
    await sleep(500);
    const m = await evaluate<{ js: number; total: number; rows: number }>(timing);
    assert.equal(m.rows, 2000);
    cold.push(m.total);
  }
  const warm = await evaluate<{ total: number }>(timing); // dezelfde lijst nog eens: de getekende regels worden hergebruikt
  await shot('groot-project');
  assert.ok(Math.min(...cold) < 150, `2000 taken tekenen duurde ${JSON.stringify(cold)} ms (de bedoeling is minder dan 150)`);
  assert.ok(Math.max(...cold) < 400, `2000 taken tekenen duurde ${JSON.stringify(cold)} ms`);
  assert.ok(warm.total < Math.max(...cold) + 20);
  perf = `2000 taken tekenen (zijbalk, kop en lijst, inclusief opmaak): ${cold.join(', ')} ms vanaf een lege lijst en ${warm.total} ms met bewaarde regels`;
  await syncAs(otherToken, 'ander-apparaat', [{ type: 'project_delete', uuid: 'e2e-groot-weg-0001', args: { id: bigId } }]);
  await nav('Thuis');
  await waitFor(`![...document.querySelectorAll('.nav-item .nav-label')].some((e) => e.textContent === 'Groot')`, 'het grote project is weer weg', 30_000);
  await waitFor(SYNCED, 'gesynchroniseerd');
  step(perf);

  // ---- 8k. de nieuwe schermen in het Engels: alles vertaald, niets afgekapt ----
  const mine = ['Bellen met de buren', 'Tuin besproeien', 'Vergadering voorbereiden', 'Zonder tijd', 'Gordijnen ophangen', 'Van mijn telefoon', 'Planten water geven', 'Offline bedacht', 'Eerst de glazen, dan het bestek.', 'Ik help morgen mee.', 'Glazen apart', 'Afwasmachine uitruimen']; // wat Alice zelf typte
  await evaluate(`localStorage.setItem('tickory.lang', 'en')`);
  await send('Page.reload');
  await waitFor(`document.body.classList.contains('ready') && document.getElementById('sync-status').textContent === 'Up to date'`, 'Engels na herladen', 15_000);
  await nav('Thuis');
  await waitFor(`document.getElementById('view-title').textContent === 'Thuis'`, 'Thuis (Engels)');
  assert.deepEqual(await texts('.nav-heading span'), ['Favorites', 'Projects']);
  assert.equal(await evaluate(`document.querySelector('.sidebar-add').textContent`), 'Add task');
  assert.deepEqual(await buttons('.view-actions'), ['List', 'Board', 'Calendar', 'Comments (1)', 'Shared', 'Project…']);
  assert.equal(await evaluate(`document.querySelector('#view-count').textContent`), `${(serverState().tasks as any[]).filter((x) => x.project_id === thuisId && !x.checked).length} tasks`, 'het aantal open taken in de kop');
  assert.equal(await evaluate(`document.querySelector('button.nav-toggle').getAttribute('aria-label')`), 'Hide subprojects of Thuis');
  assert.equal(await evaluate(`${row('Afwasmachine uitruimen')}.querySelector('.chip-toggle').getAttribute('aria-label')`), 'Subtasks: 0/1 done');
  assert.equal(await evaluate(`${row('Afwasmachine uitruimen')}.querySelector('.chip-comments').title`), '2 comments');
  await noDutch('nieuwe zijbalk en lijst', mine);
  await fits('nieuwe lijst');
  await shot('engels-nieuwe-lijst');
  await press('?');
  await waitFor(`document.querySelector('dialog[open] h2')?.textContent === 'Keyboard shortcuts'`, 'sneltoetsen (Engels)');
  assert.deepEqual(await texts('dialog[open] .shortcut dd'), ['Add task', 'Go to Today', 'Go to Upcoming', 'Go to Inbox', 'Show this overview', 'Search', 'Search', 'Close a window', 'Select the task under the pointer or focus', 'Select all tasks in view', 'Stop selecting', 'Undo the last change', 'Save the task in the task window', 'Move a task or project one place up or down', 'Put a task or project under the previous one (subtask) or take it out again']);
  assert.deepEqual(await texts('dialog[open] .keys-then'), ['then', 'then', 'then', '+', '+', '+', '+', '+', '+']);
  await noDutch('sneltoetsen', mine);
  await press('Escape');
  await noDialog();
  await press('q');
  await waitFor(`document.querySelector('.dialog-quick[open]')`, 'Taak toevoegen (Engels)');
  assert.equal(await evaluate(`document.querySelector('.dialog-quick[open] h2').textContent`), 'Add task');
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('.dialog-quick[open] [placeholder]')].map((e) => e.placeholder)`), [en['quick.placeholder'], 'Description']);
  await noDutch('venster Taak toevoegen', mine);
  await fits('venster Taak toevoegen');
  await press('Escape');
  await noDialog();
  await clickText('Project…');
  await waitFor(`document.querySelector('dialog[open] .menu')`, 'projectmenu (Engels)');
  assert.deepEqual(await buttons(), ['Edit…', 'Add subproject', 'Add tasks from template…', 'Save as template…', 'Add to favorites', 'View completed tasks', 'Activity', 'Share…', 'Archive', 'Delete project', 'Close']);
  await clickText('Edit…');
  await waitFor(`document.querySelector('dialog[open] h2')?.textContent === 'Edit project'`, 'projectvenster (Engels)');
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('dialog[open] input[name="project-color"]')].map((e) => e.getAttribute('aria-label'))`),
    ['Charcoal', 'Red', 'Orange', 'Amber', 'Olive', 'Green', 'Mint', 'Teal', 'Sky blue', 'Blue', 'Indigo', 'Violet', 'Magenta', 'Rose', 'Brown', 'Grey']);
  assert.equal(await evaluate(`document.querySelector('dialog[open] legend').textContent`), 'Colour');
  await noDutch('projectvenster', mine);
  await fits('projectvenster');
  await shot('engels-projectvenster');
  await press('Escape');
  await noDialog();
  await openTask('Afwasmachine uitruimen');
  assert.equal(await evaluate(`document.querySelector('#task-dialog .comments .subheading').textContent`), 'Comments (2)');
  assert.ok((await texts('#task-dialog .comment-time')).every((x) => /^(just now|\d+ minutes? ago)$/.test(x)), `tijden in het Engels: ${JSON.stringify(await texts('#task-dialog .comment-time'))}`);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('#task-dialog .quick-dates button')].map((b) => b.textContent)`), ['Today', 'Tomorrow', 'This weekend', 'Next week', 'No date']);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('#task-dialog .prop-label')].filter((l) => !l.closest('[hidden]')).map((l) => l.textContent)`), ['Project', 'Section', 'Due date', 'Priority', 'Labels', 'Assigned to', 'Duration', 'Deadline']);
  assert.match(await evaluate(`document.querySelector('#task-dialog .task-created').textContent`), /^Created by Alice, today$/);
  await noDutch('taakvenster met opmerkingen', mine);
  await fits('taakvenster met opmerkingen');
  await shot('engels-taakvenster');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(300);
  await fits('taakvenster op een telefoon (Engels)');
  await shot('engels-telefoon-taakvenster-nieuw');
  await click('#task-dialog .task-top .icon-button');
  await noDialog();
  await fits('lijst op een telefoon (Engels)');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
  await sleep(200);
  await evaluate(`localStorage.setItem('tickory.lang', 'nl')`);
  await send('Page.reload');
  await waitFor(`document.body.classList.contains('ready') && document.getElementById('sync-status').textContent === 'Bijgewerkt'`, 'weer Nederlands', 15_000);
  step('Engels: de nieuwe schermen (zijbalk, lijst, sneltoetsen, Taak toevoegen, projectmenu en -venster met kleurnamen, taakvenster met opmerkingen en snelle datums) zonder Nederlandse tekst en zonder afgekapte tekst, ook op een telefoon');

  // ---- 8l. bord en kalender: de weergave van een project kiezen, kolommen en kaarten, maand en week, toetsenbord, telefoon ----
  const viewButton = (style: string) => `document.querySelector('.view-actions .view-switch [data-view-style="${style}"]')`;
  const serverProject = (id: string) => (serverState().projects as any[]).find((p) => p.id === id);
  const cards = (column: string) => evaluate<string[]>(`[...document.querySelectorAll('.board-column[data-column=${js(column)}] .task-card .task-title')].map((e) => e.textContent)`);
  const columnTitles = () => texts('.board-column:not(.board-column-new) .board-column-title');
  const viewsCtx = { send, evaluate, waitFor, step, shot, sleep, js, SYNCED, serverState, serverTask, syncAs, otherToken, thuisId, keukenId, today, addDays };
  const sideScroll = () => evaluate<boolean>(`document.documentElement.scrollWidth <= window.innerWidth + 1`);
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }); // de schermafbeeldingen hier eerst licht, dan donker
  await nav('Thuis');
  await waitFor(`document.getElementById('view-title').textContent === 'Thuis'`, 'Thuis voor de weergaven');
  assert.equal(await evaluate(`${viewButton('list')}.getAttribute('aria-pressed')`), 'true', 'een project begint als lijst');
  assert.equal(serverProject(thuisId).view_style, 'list');

  // het bord
  await evaluate(`${viewButton('board')}.click()`);
  await waitFor(`document.querySelector('.board')`, 'bord getekend');
  await waitFor(SYNCED, 'weergavekeuze gesynchroniseerd');
  assert.equal(serverProject(thuisId).view_style, 'board', 'de keuze staat in het project op de server');
  assert.equal(await evaluate(`${viewButton('board')}.getAttribute('aria-pressed')`), 'true');
  assert.deepEqual(await columnTitles(), ['Zonder sectie', 'Keuken'], 'kolommen: eerst "Zonder sectie", dan de secties');
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('.board-column[data-column]')].map((c) => [c.dataset.column, c.dataset.sectionId, c.dataset.projectId])`), [['none', '', thuisId], [keukenId, keukenId, thuisId]], 'aanhaakpunten voor slepen: data-column, data-section-id en data-project-id');
  assert.ok(await evaluate(`[...document.querySelectorAll('.board-column .task-card')].every((c) => c.dataset.taskId && c.dataset.id === c.dataset.taskId && c.dataset.sectionId !== undefined && c.closest('.board-cards'))`), 'elke kaart heeft data-task-id en data-section-id en staat in een .board-cards');
  assert.ok((await cards('none')).includes('Planten water geven') && !(await cards('none')).includes('Glazen apart'), 'de kaarten van een kolom, zonder subtaken');
  assert.ok((await cards(keukenId)).includes('Afwasmachine uitruimen') && !(await cards(keukenId)).includes('Glazen apart'));
  assert.deepEqual(await taskMeta('Planten water geven'), ['↻ morgen'], 'een kaart heeft dezelfde chips als een regel in de lijst');
  assert.ok(await evaluate(`${row('Afwasmachine uitruimen')}.querySelector('.check') && ${row('Afwasmachine uitruimen')}.querySelector('.chip-subtasks')`), 'cirkel en teller van subtaken op de kaart');
  await shot('bord');

  // een taak toevoegen in een kolom
  await evaluate(`document.querySelector('.board-column[data-column=${js(keukenId)}] .add-inline').click()`);
  await waitFor(`document.querySelector('.dialog-quick[open]')`, 'venster Taak toevoegen vanuit een kolom');
  await typeInto('.dialog-quick[open] input[type=text]', 'Vaatdoeken wassen morgen p2');
  await submit('.dialog-quick[open] form');
  await noDialog();
  await waitFor(SYNCED, 'gesynchroniseerd');
  assert.deepEqual([serverTask('Vaatdoeken wassen').section_id, serverTask('Vaatdoeken wassen').project_id], [keukenId, thuisId], 'de taak staat in de sectie van de kolom');
  assert.equal((await cards(keukenId)).at(-1), 'Vaatdoeken wassen', 'een nieuwe taak komt onderaan de kolom');

  // openen en afvinken
  await evaluate(`${row('Vaatdoeken wassen')}.querySelector('.task-body').click()`);
  await waitFor(`document.querySelector('#task-dialog[open]')`, 'taakvenster vanaf een kaart');
  assert.equal(await evaluate(`document.querySelector('#task-dialog textarea[aria-label="Taak"]').value`), 'Vaatdoeken wassen');
  await press('Escape');
  await noDialog();
  await evaluate(`${row('Vaatdoeken wassen')}.querySelector('.check').click()`);
  await waitFor(`!${row('Vaatdoeken wassen')}`, 'kaart verdwijnt na afvinken');
  await waitFor(SYNCED, 'gesynchroniseerd');
  assert.equal(serverTask('Vaatdoeken wassen').checked, true);
  await evaluate(`[...document.querySelectorAll('.link-button')].find((b) => b.textContent.startsWith('Voltooide taken tonen'))?.click()`);
  await waitFor(`${row('Vaatdoeken wassen')}`, 'voltooide kaart op verzoek zichtbaar');
  await evaluate(`${row('Vaatdoeken wassen')}.querySelector('.check').click()`);
  await waitFor(SYNCED, 'gesynchroniseerd');
  assert.equal(serverTask('Vaatdoeken wassen').checked, false, 'ongedaan maken vanaf de kaart');
  await evaluate(`[...document.querySelectorAll('.link-button')].find((b) => b.textContent.startsWith('Voltooide taken verbergen'))?.click()`);

  // secties toevoegen, hernoemen, kaarten verplaatsen met het menu, verwijderen
  await click('.board-add-section');
  await promptAnswer('Berging');
  await waitFor(`[...document.querySelectorAll('.board-column-title')].some((e) => e.textContent === 'Berging')`, 'nieuwe kolom');
  await waitFor(SYNCED, 'gesynchroniseerd');
  const bergingId = (serverState().sections as any[]).find((x) => x.name === 'Berging').id;
  assert.deepEqual(await columnTitles(), ['Zonder sectie', 'Keuken', 'Berging'], 'de nieuwe sectie komt achteraan');
  await evaluate(`document.querySelector('.board-column[data-column=${js(bergingId)}] .group-more').click()`);
  await waitFor(`document.querySelector('dialog[open] .menu')`, 'kolommenu');
  await clickText('Naam wijzigen', `document.querySelector('dialog[open]')`);
  await promptAnswer('Bijkeuken én zolder');
  await waitFor(`[...document.querySelectorAll('.board-column-title')].some((e) => e.textContent === 'Bijkeuken én zolder')`, 'kolom hernoemd');
  await evaluate(`${row('Planten water geven')}.querySelector('.card-move').click()`);
  await waitFor(`document.querySelector('dialog[open] .menu')`, 'menu Verplaats naar');
  assert.equal(await evaluate(`document.querySelector('dialog[open] h2').textContent`), 'Verplaats "Planten water geven" naar');
  assert.deepEqual(await texts('dialog[open] .menu-item'), ['Zonder sectie ✓', 'Keuken', 'Bijkeuken én zolder'], 'alle kolommen, de huidige met een vinkje');
  await shot('bord-verplaats-menu');
  await clickText('Bijkeuken én zolder', `document.querySelector('dialog[open]')`);
  await noDialog();
  await waitFor(SYNCED, 'gesynchroniseerd');
  assert.equal(serverTask('Planten water geven').section_id, bergingId, 'verplaatst naar de gekozen sectie');
  assert.deepEqual(await cards(bergingId), ['Planten water geven']);
  assert.ok(!(await cards('none')).includes('Planten water geven'));
  await evaluate(`${row('Planten water geven')}.querySelector('.card-move').click()`);
  await waitFor(`document.querySelector('dialog[open] .menu')`, 'menu Verplaats naar (terug)');
  await clickText('Zonder sectie', `document.querySelector('dialog[open]')`);
  await noDialog();
  await waitFor(SYNCED, 'gesynchroniseerd');
  assert.equal(serverTask('Planten water geven').section_id ?? null, null, 'terug naar "Zonder sectie"');
  await evaluate(`document.querySelector('.board-column[data-column=${js(bergingId)}] .group-more').click()`);
  await waitFor(`document.querySelector('dialog[open] .menu')`, 'kolommenu (verwijderen)');
  await clickText('Sectie verwijderen', `document.querySelector('dialog[open]')`);
  await waitFor(`document.querySelector('dialog[open] h2')?.textContent === 'Sectie verwijderen?'`, 'bevestiging');
  await evaluate(`document.querySelector('dialog[open] .button-danger').click()`);
  await noDialog();
  await waitFor(`![...document.querySelectorAll('.board-column-title')].some((e) => e.textContent === 'Bijkeuken én zolder')`, 'kolom weg');
  assert.deepEqual(await columnTitles(), ['Zonder sectie', 'Keuken']);

  // de keuze komt via de server van een ander apparaat; een onbekende weergave wordt geweigerd
  assert.equal((await syncAs(otherToken, 'ander-apparaat', [{ type: 'project_update', uuid: 'e2e-weergave-lijst-1', args: { id: thuisId, view_style: 'list' } }])).status, 200);
  await waitFor(`document.querySelector('.group-title') && !document.querySelector('.board')`, 'de lijst komt vanzelf terug na een wijziging op een ander apparaat', 15_000);
  assert.equal(await evaluate(`${viewButton('list')}.getAttribute('aria-pressed')`), 'true');
  const bad = await syncAs(otherToken, 'ander-apparaat', [{ type: 'project_update', uuid: 'e2e-weergave-fout-01', args: { id: thuisId, view_style: 'gantt' } }]);
  assert.notEqual(((await bad.json()) as any).sync_status['e2e-weergave-fout-01'], 'ok', 'een onbekende weergave wordt door de server geweigerd');
  assert.equal(serverProject(thuisId).view_style, 'list');
  await evaluate(`${viewButton('board')}.click()`);
  await waitFor(`document.querySelector('.board')`, 'bord weer');
  await waitFor(SYNCED, 'gesynchroniseerd');
  await send('Page.reload');
  await waitFor(`document.body.classList.contains('ready') && document.querySelector('.board')`, 'het bord blijft na herladen', 15_000);
  step('bord: de keuze Lijst / Bord / Kalender staat in het project (view_style) en komt via de server op andere apparaten, een onbekende waarde wordt geweigerd; kolommen = "Zonder sectie" + secties met aanhaakpunten (data-column, data-section-id, data-task-id); kaarten met cirkel, titel en chips; taak toevoegen in een kolom, openen, afvinken en terugzetten; sectie toevoegen, hernoemen en verwijderen; "Verplaats naar…"');

  await boardDragScenario(viewsCtx);

  // het bord op een telefoon
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(300);
  const boardPhone = await evaluate<any>(`(() => { const b = document.querySelector('.board'); const s = getComputedStyle(b); const c = document.querySelector('.board-column'); return { snap: s.scrollSnapType, overflow: s.overflowX, wide: b.scrollWidth > b.clientWidth, col: Math.round(c.getBoundingClientRect().width), move: Math.round(document.querySelector('.card-move').getBoundingClientRect().height), moveVisible: getComputedStyle(document.querySelector('.card-move')).opacity }; })()`);
  assert.match(boardPhone.snap, /x mandatory/, 'op een telefoon springt het bord per kolom');
  assert.equal(boardPhone.overflow, 'auto');
  assert.ok(boardPhone.wide, 'de kolommen scrollen horizontaal binnen het bord');
  assert.ok(boardPhone.col >= 280 && boardPhone.col <= 350, `een kolom vult bijna het scherm: ${boardPhone.col} px`);
  assert.ok(boardPhone.move >= 44 && boardPhone.moveVisible === '1', 'het menu "Verplaats naar…" is op een telefoon altijd te zien en groot genoeg');
  assert.ok(await sideScroll(), 'de pagina zelf scrolt niet zijwaarts');
  await shot('bord-telefoon');
  await boardTouchScenario(viewsCtx);
  await evaluate(`document.querySelector('.board').scrollTo({ left: 400 })`);
  await sleep(500);
  const snappedAt = await evaluate<number>(`Math.round(document.querySelector('.board').scrollLeft)`);
  assert.ok(snappedAt > 100, `het bord is naar de volgende kolom gesprongen (${snappedAt})`);
  await shot('bord-telefoon-tweede-kolom');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await sleep(200);
  await shot('bord-telefoon-donker');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
  await sleep(200);
  await shot('bord-donker');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  step('bord op een telefoon: horizontaal scrollen met snap per kolom, kolom bijna schermbreed, "Verplaats naar…" altijd zichtbaar en groot genoeg, geen zijwaarts scrollen van de pagina; licht en donker bekeken');

  // de kalender
  const yesterday = addDays(today, -1);
  assert.equal((await syncAs(otherToken, 'ander-apparaat', [{ type: 'task_add', uuid: 'e2e-kalender-telaat-1', args: { id: 'e2ekalendertelaat01', project_id: thuisId, content: 'Belastingformulier invullen', due: { date: yesterday } } },
    { type: 'task_add', uuid: 'e2e-kalender-overleg-1', args: { id: 'e2ekalenderoverleg01', project_id: thuisId, content: 'Teamoverleg', due: { date: `${today}T10:00`, string: 'elke week', lang: 'nl', recurrence: { freq: 'weekly' } } } }])).status, 200);
  await evaluate(`${viewButton('calendar')}.click()`);
  await waitFor(`document.querySelector('.cal')`, 'kalender getekend');
  await waitFor(SYNCED, 'gesynchroniseerd');
  assert.equal(serverProject(thuisId).view_style, 'calendar');
  assert.equal(await evaluate(`document.querySelector('.cal').dataset.mode`), 'month');
  const titleOf = () => evaluate<string>(`document.querySelector('.cal-title').textContent`);
  assert.equal(await titleOf(), periodTitle('month', today, 'nl-NL'), 'de kop noemt de maand in het Nederlands');
  assert.deepEqual(await texts('.cal-table thead th:not(.cal-weekhead) abbr'), ['ma', 'di', 'wo', 'do', 'vr', 'za', 'zo'], 'de week begint op maandag');
  const first = await evaluate<string>(`document.querySelector('.cal-day').dataset.date`);
  assert.equal(await evaluate(`new Date(${js(first)} + 'T00:00:00Z').getUTCDay()`), 1, 'de eerste kolom is een maandag');
  assert.equal(await evaluate(`document.querySelector('.cal-weeknum').textContent`), `Week ${isoWeek(first).week}`, 'het ISO-weeknummer staat bij de rij');
  assert.equal(await evaluate(`document.querySelectorAll('.cal-today').length`), 1);
  assert.equal(await evaluate(`document.querySelector('.cal-today').dataset.date`), today, 'vandaag is gemarkeerd');
  assert.equal(await evaluate(`document.querySelector('.cal-today').getAttribute('aria-current')`), 'date');
  assert.deepEqual(await texts('.cal-overdue-list .cal-title-text'), ['Belastingformulier invullen'], 'wat te laat is, staat apart');
  assert.equal(await evaluate(`document.querySelector('.cal-day[data-date="${yesterday}"] .cal-item')`), null, 'en niet nog eens op zijn oude dag');
  assert.deepEqual(await texts(`.cal-day[data-date="${today}"] .cal-title-text`).then((x) => x.filter((y) => y === 'Teamoverleg')), ['Teamoverleg'], 'een taak staat op haar dag');
  assert.equal(await evaluate(`document.querySelector('.cal-day[data-date="${today}"] .cal-item[data-task-id="e2ekalenderoverleg01"] .cal-time').textContent`), '10:00', 'met haar tijd');
  // een herhaling staat ook op de komende voorkomens, zonder dat er iets bewaard wordt
  const plantenDue = serverTask('Planten water geven').due.date;
  const planten = await evaluate<any>(`(() => { const items = [...document.querySelectorAll('.cal-item')].filter((i) => i.querySelector('.cal-title-text').textContent === 'Planten water geven'); return { n: items.length, real: items.filter((i) => i.dataset.real === 'true').length, virtualChecks: items.filter((i) => i.dataset.real === 'false' && i.querySelector('.cal-check')).length, dates: items.map((i) => i.dataset.date) }; })()`);
  assert.ok(planten.n > 1, 'de dagelijkse taak staat op meerdere dagen');
  assert.equal(planten.real, 1, 'alleen de eigen datum is echt');
  assert.equal(planten.virtualChecks, 0, 'een voorkomen dat nog niet aan de beurt is, kan niet worden afgevinkt');
  assert.equal(new Set(planten.dates).size, planten.n);
  assert.equal(planten.dates[0], plantenDue.slice(0, 10), 'het echte voorkomen staat op de eigen datum');
  assert.equal(serverTask('Planten water geven').due.date, plantenDue, 'op de server staat alleen de eigen datum');
  await shot('kalender-maand');

  // een taak toevoegen met de plus bij een dag, openen en afvinken
  const nextDay = await evaluate<string>(`(() => { const d = document.querySelector('.cal-day[data-date="${addDays(today, 1)}"]'); return d ? d.dataset.date : ${js(today)}; })()`);
  await evaluate(`document.querySelector('.cal-add[data-date="${nextDay}"]').click()`);
  await waitFor(`document.querySelector('.dialog-quick[open]')`, 'venster Taak toevoegen vanuit de kalender');
  assert.match(await evaluate(`document.querySelector('.dialog-quick[open] .quick-day').textContent`), /^Voor /, 'het venster zegt voor welke dag de taak is');
  assert.equal(await evaluate(`document.querySelector('.dialog-quick[open] select').selectedOptions[0].textContent.trim()`), 'Thuis');
  await typeInto('.dialog-quick[open] input[type=text]', 'Zoë uitnodigen p3');
  await submit('.dialog-quick[open] form');
  await noDialog();
  await waitFor(SYNCED, 'gesynchroniseerd');
  const lood = serverTask('Zoë uitnodigen');
  assert.deepEqual([lood.due.date, lood.project_id, lood.priority], [nextDay, thuisId, 3], 'de taak staat op de dag van de plus, in dit project');
  assert.ok((await texts(`.cal-day[data-date="${nextDay}"] .cal-title-text`)).includes('Zoë uitnodigen'));
  await evaluate(`document.querySelector('.cal-day[data-date="${nextDay}"] .cal-item[data-task-id="${lood.id}"] .cal-open').click()`);
  await waitFor(`document.querySelector('#task-dialog[open]')`, 'taakvenster vanuit de kalender');
  assert.equal(await evaluate(`document.querySelector('#task-dialog textarea[aria-label="Taak"]').value`), 'Zoë uitnodigen');
  await press('Escape');
  await noDialog();
  await evaluate(`document.querySelector('.cal-item[data-task-id="${lood.id}"] .cal-check').click()`);
  await waitFor(`!document.querySelector('.cal-item[data-task-id="${lood.id}"]')`, 'afgevinkte taak verdwijnt uit de kalender');
  await waitFor(SYNCED, 'gesynchroniseerd');
  assert.equal(serverTask('Zoë uitnodigen').checked, true);
  await evaluate(`document.querySelector('.cal-overdue-list .cal-check').click()`);
  await waitFor(`!document.querySelector('.cal-overdue')`, 'het blok "Te laat" verdwijnt als er niets meer te laat is');
  await waitFor(SYNCED, 'gesynchroniseerd');
  assert.equal(serverTask('Belastingformulier invullen').checked, true);

  // bladeren: vorige, volgende, vandaag, en de weekweergave
  await click('[data-fk="cal-next"]');
  await waitFor(`document.querySelector('.cal-title').textContent !== ${js(periodTitle('month', today, 'nl-NL'))}`, 'volgende maand');
  assert.equal(await titleOf(), periodTitle('month', addMonths(today, 1), 'nl-NL'));
  assert.equal(await evaluate(`document.querySelectorAll('.cal-today').length`), 0, 'vandaag staat niet in het scherm van volgende maand');
  assert.ok(await evaluate(`document.querySelectorAll('.cal-virtual').length > 0`), 'de herhaling loopt door in de volgende maand');
  await click('[data-fk="cal-prev"]');
  await click('[data-fk="cal-prev"]');
  assert.equal(await titleOf(), periodTitle('month', addMonths(today, -1), 'nl-NL'));
  assert.equal(await evaluate(`document.querySelectorAll('.cal-item').length`), 0, 'in het verleden staat niets meer open');
  await click('[data-fk="cal-today"]');
  assert.equal(await titleOf(), periodTitle('month', today, 'nl-NL'));
  await click('[data-fk="cal-mode:week"]');
  await waitFor(`document.querySelector('.cal').dataset.mode === 'week'`, 'weekweergave');
  assert.equal(await titleOf(), periodTitle('week', today, 'nl-NL'));
  assert.equal(await evaluate(`document.querySelectorAll('.cal-day').length`), 7);
  assert.equal(await evaluate(`localStorage.getItem('tickory.calendarMode')`), 'week', 'de keuze Maand of Week blijft op dit apparaat');
  assert.equal(await evaluate(`document.querySelector('.cal-weeknum').textContent`), `Week ${isoWeek(today).week}`);
  await shot('kalender-week');
  await click('[data-fk="cal-next"]');
  assert.equal(await titleOf(), periodTitle('week', addDays(today, 7), 'nl-NL'));
  assert.equal(await evaluate(`document.querySelector('.cal-weeknum').textContent`), `Week ${isoWeek(addDays(today, 7)).week}`);
  await click('[data-fk="cal-today"]');
  await click('[data-fk="cal-mode:month"]');
  await waitFor(`document.querySelector('.cal').dataset.mode === 'month'`, 'maandweergave');

  // het toetsenbord
  const activeDay = () => evaluate<string | null>(`document.activeElement?.closest?.('td.cal-day')?.dataset.date ?? null`);
  await evaluate(`document.querySelector('.cal-day[data-date="${today}"]').focus()`);
  assert.equal(await activeDay(), today);
  assert.equal(await evaluate(`document.querySelectorAll('td.cal-day[tabindex="0"]').length`), 1, 'precies één dag is met Tab bereikbaar');
  await press('ArrowRight');
  assert.equal(await activeDay(), addDays(today, 1), 'pijl rechts: volgende dag');
  await press('ArrowLeft');
  await press('ArrowDown');
  assert.equal(await activeDay(), addDays(today, 7), 'pijl omlaag: een week verder');
  await press('ArrowUp');
  assert.equal(await activeDay(), today);
  const ring = await evaluate<string>(`(() => { const s = getComputedStyle(document.activeElement); return s.outlineStyle + '|' + s.outlineWidth; })()`);
  assert.ok(!ring.startsWith('none'), `zichtbare focusring op een dag: ${ring}`);
  await press('PageDown');
  await waitFor(`document.querySelector('.cal-title').textContent === ${js(periodTitle('month', addMonths(today, 1), 'nl-NL'))}`, 'PageDown: volgende maand');
  await press('Home');
  await waitFor(`document.querySelector('.cal-title').textContent === ${js(periodTitle('month', today, 'nl-NL'))}`, 'Home: vandaag');
  await waitFor(`document.activeElement?.dataset?.date === ${js(today)}`, 'focus op vandaag');
  await press('Enter');
  await waitFor(`document.querySelector('.dialog-quick[open] .quick-day')`, 'Enter voegt een taak toe op de gekozen dag');
  await press('Escape');
  await noDialog();

  await calendarDragScenario(viewsCtx);

  // Binnenkort als kalender: taken uit alle projecten, de keuze hoort bij dit apparaat
  await nav('Binnenkort');
  await waitFor(`document.getElementById('view-title').textContent === 'Binnenkort'`, 'Binnenkort');
  assert.ok(await evaluate(`!document.querySelector('.cal')`));
  assert.deepEqual(await texts('.view-actions .view-switch button'), ['Lijst', 'Kalender'], 'Binnenkort kent geen bord');
  await evaluate(`document.querySelector('.view-switch [data-view-style="calendar"]').click()`);
  await waitFor(`document.querySelector('.cal[data-calendar="upcoming"]')`, 'kalender bij Binnenkort');
  const projectsOnCal = await evaluate<string[]>(`[...new Set([...document.querySelectorAll('.cal-item .cal-project-name')].map((e) => e.textContent))]`);
  assert.ok(projectsOnCal.length >= 2, `taken van meer projecten: ${JSON.stringify(projectsOnCal)}`);
  assert.equal(await evaluate(`localStorage.getItem('tickory.upcomingView')`), 'calendar');
  await shot('kalender-binnenkort');
  await evaluate(`document.querySelector('.view-switch [data-view-style="list"]').click()`);
  await waitFor(`!document.querySelector('.cal') && document.querySelector('.group-title')`, 'terug naar de lijst bij Binnenkort');
  assert.equal(serverProject(thuisId).view_style, 'calendar', 'Binnenkort verandert het project niet');
  step('kalender: maand en week (maandag eerst, Nederlandse namen, ISO-weeknummers), vandaag gemarkeerd, te late taken apart, herhaling op de komende voorkomens zonder opslag, plus bij een dag voegt toe op die dag, openen en afvinken, vorige / volgende / vandaag, Maand of Week bewaard op dit apparaat, toetsenbord (pijlen, PageUp/PageDown, Home, Enter), Binnenkort als kalender met taken van alle projecten');

  // telefoon: een lijst per dag in plaats van een maandtabel
  await nav('Thuis');
  await waitFor(`document.querySelector('.cal')`, 'kalender van Thuis');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(300);
  const calPhone = await evaluate<any>(`(() => { const q = (s) => document.querySelector(s); const h = (s) => Math.round(q(s).getBoundingClientRect().height); const w = (s) => Math.round(q(s).getBoundingClientRect().width);
    return { table: getComputedStyle(q('.cal-table')).display, head: getComputedStyle(q('.cal-table thead')).display, cell: getComputedStyle(q('.cal-today')).display, add: [w('.cal-today .cal-add'), h('.cal-today .cal-add')], check: [w('.cal-today .cal-check'), h('.cal-today .cal-check')], open: h('.cal-today .cal-open'),
      hiddenOut: [...document.querySelectorAll('.cal-out')].every((d) => getComputedStyle(d).display === 'none'), keys: getComputedStyle(q('.cal-keys')).display }; })()`);
  assert.deepEqual([calPhone.table, calPhone.head, calPhone.cell], ['block', 'none', 'block'], 'op een telefoon is de maandtabel een lijst per dag');
  assert.ok(calPhone.add[0] >= 44 && calPhone.add[1] >= 44 && calPhone.check[0] >= 44 && calPhone.check[1] >= 44 && calPhone.open >= 44, `alles aan te tikken is minstens 44 px: ${JSON.stringify(calPhone)}`);
  assert.ok(calPhone.hiddenOut, 'dagen van een andere maand worden niet getoond');
  assert.equal(calPhone.keys, 'none');
  assert.ok(await sideScroll(), 'geen zijwaarts scrollen van de pagina');
  await shot('kalender-telefoon');
  await calendarTouchScenario(viewsCtx);
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await sleep(200);
  await shot('kalender-telefoon-donker');
  await click('[data-fk="cal-mode:week"]');
  await waitFor(`document.querySelector('.cal').dataset.mode === 'week'`, 'week op telefoon');
  assert.equal(await evaluate(`[...document.querySelectorAll('.cal-day')].filter((d) => d.getBoundingClientRect().height > 0).length`), 7, 'in de weekweergave zijn alle zeven dagen te zien');
  assert.ok(await sideScroll());
  await shot('kalender-telefoon-week');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
  await sleep(200);
  await shot('kalender-week-donker');
  await click('[data-fk="cal-mode:month"]');
  await shot('kalender-maand-donker');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  step('kalender op een telefoon: een lijst per dag (geen maandtabel), dagen van andere maanden weg, alles minstens 44 px, geen zijwaarts scrollen; licht en donker bekeken');

  // Engels
  await evaluate(`localStorage.setItem('tickory.lang', 'en')`);
  await send('Page.reload');
  await waitFor(`document.body.classList.contains('ready') && document.querySelector('.cal') && document.getElementById('sync-status').textContent === 'Up to date'`, 'kalender in het Engels', 15_000);
  assert.equal(await titleOf(), periodTitle('month', today, 'en-GB'), 'maandnaam in de taal van de app');
  assert.deepEqual(await texts('.cal-table thead th:not(.cal-weekhead) abbr'), ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
  assert.equal(await evaluate(`document.querySelector('[data-fk="cal-today"]').textContent`), 'Today');
  assert.equal(await evaluate(`document.querySelector('[data-fk="cal-prev"]').getAttribute('aria-label')`), 'Previous month');
  assert.equal(await evaluate(`document.querySelector('.cal-add').getAttribute('aria-label').startsWith('Add a task on')`), true);
  assert.deepEqual(await texts('.view-actions .view-switch button'), ['List', 'Board', 'Calendar']);
  await noDutch('kalender', mine);
  await fits('kalender');
  await shot('kalender-engels');
  await evaluate(`${viewButton('board')}.click()`);
  await waitFor(`document.querySelector('.board')`, 'bord in het Engels');
  assert.deepEqual(await columnTitles(), ['No section', 'Keuken']);
  await noDutch('bord', mine);
  await fits('bord');
  await shot('bord-engels');
  await evaluate(`localStorage.setItem('tickory.lang', 'nl')`);
  await send('Page.reload');
  await waitFor(`document.body.classList.contains('ready') && document.querySelector('.board') && document.getElementById('sync-status').textContent === 'Bijgewerkt'`, 'weer Nederlands', 15_000);
  // opruimen: het project weer als lijst, en de taken van deze stap weg
  await evaluate(`${viewButton('list')}.click()`);
  await waitFor(`document.querySelector('.group-title')`, 'lijst terug');
  await waitFor(SYNCED, 'gesynchroniseerd');
  assert.equal(serverProject(thuisId).view_style, 'list');
  const opruim = ['e2ekalendertelaat01', 'e2ekalendertelaat02', 'e2ekalenderoverleg01', serverTask('Zoë uitnodigen').id, serverTask('Vaatdoeken wassen').id];
  assert.equal((await syncAs(otherToken, 'ander-apparaat', opruim.map((id, i) => ({ type: 'task_delete', uuid: `e2e-kalender-weg-${i}-aaa`, args: { id } })))).status, 200);
  await waitFor(`!${row('Vaatdoeken wassen')}`, 'taken opgeruimd');
  await waitFor(SYNCED, 'gesynchroniseerd');
  await evaluate(`localStorage.removeItem('tickory.upcomingView'); localStorage.removeItem('tickory.calendarMode')`);
  await send('Emulation.setEmulatedMedia', { features: [] });
  step('bord en kalender in het Engels: maand- en dagnamen volgen de taal van de app, geen Nederlandse tekst, niets afgekapt; daarna terug naar Nederlands en het project weer als lijst');

  // ---- 9. telefoonformaat en donkere modus ----
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await nav('Thuis');
  await sleep(300);
  await shot('telefoon-project');
  assert.equal(await evaluate(`getComputedStyle(document.getElementById('sidebar')).position`), 'fixed', 'op de telefoon is de zijbalk een uitschuifmenu');
  assert.equal(await evaluate(`document.documentElement.scrollWidth`), 390, 'geen horizontaal scrollen op de telefoon: de pagina is precies zo breed als het scherm');
  // grote tikvlakken: alles wat je met een vinger aantikt is minstens 44 bij 44 (en met de zijbalk dicht niet te bereiken met Tab)
  const smallest = (selector: string) => evaluate<{ w: number; h: number; n: number }>(`(() => { const list = [...document.querySelectorAll(${js(selector)})].filter((e) => e.offsetParent !== null || getComputedStyle(e).position === 'fixed'); return { w: Math.min(...list.map((e) => Math.round(e.getBoundingClientRect().width))), h: Math.min(...list.map((e) => Math.round(e.getBoundingClientRect().height))), n: list.length }; })()`);
  for (const selector of ['.check', '#menu-button', '.add-inline', '.group-toggle', '.view-actions button', '#quick-add button', '.task']) {
    const size = await smallest(selector);
    assert.ok(size.n > 0, `${selector}: niets gevonden`);
    assert.ok(size.h >= 44 && size.w >= 40, `${selector} is te klein om aan te tikken: ${size.w} bij ${size.h}`);
  }
  assert.equal(await evaluate(`[...document.querySelectorAll('.task')].every((l) => !l.querySelector('.task-actions') || getComputedStyle(l.querySelector('.task-actions')).display === 'none')`), true, 'op een telefoon geen snelle knoppen die een aanwijzer nodig hebben');
  await click('#menu-button');
  await sleep(350);
  await shot('telefoon-menu');
  const drawer = await smallest('.sidebar .nav-item, .sidebar .nav-link, .sidebar-add, .sidebar .nav-toggle');
  assert.ok(drawer.h >= 44, `een regel in het uitschuifmenu is te laag: ${drawer.h}`);
  await click('#scrim');
  await openTask('Afwasmachine uitruimen');
  const full = await evaluate<{ w: number; h: number }>(`(() => { const r = document.getElementById('task-dialog').getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })()`);
  assert.deepEqual(full, { w: 390, h: 844 }, 'het taakvenster vult op een telefoon het hele scherm');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('#task-dialog .task-columns')).display`), 'flex', 'één kolom op een telefoon');
  assert.equal(await evaluate(`document.documentElement.scrollWidth`), 390);
  assert.equal(await evaluate(`document.getElementById('task-dialog').scrollWidth <= document.getElementById('task-dialog').clientWidth`), true, 'het taakvenster scrolt niet zijwaarts');
  for (const selector of ['#task-dialog .prio-option span', '#task-dialog .chip-button', '#task-dialog .field', '#task-dialog .button']) {
    const size = await smallest(selector);
    assert.ok(size.h >= 44, `${selector} is te klein om aan te tikken: ${size.w} bij ${size.h}`);
  }
  await shot('telefoon-taakvenster');
  await click('#task-dialog .task-top .icon-button');
  await noDialog();
  // beweging beperken: afvinken gebeurt meteen, zonder animatie
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await quickAdd('Bewegingsproef');
  await waitFor(row('Bewegingsproef'), 'proeftaak');
  await evaluate(`${row('Bewegingsproef')}.querySelector('.check').click()`);
  assert.equal(await evaluate(`Boolean(${row('Bewegingsproef')}?.classList.contains('task-completing'))`), false, 'geen animatie bij "minder beweging"');
  await waitFor(`!(${row('Bewegingsproef')})`, 'taak meteen weg');
  await send('Emulation.setEmulatedMedia', { features: [] });
  await waitFor(SYNCED, 'gesynchroniseerd');
  await syncAs(otherToken, 'ander-apparaat', [{ type: 'task_delete', uuid: 'e2e-opruimen-0002', args: { id: serverTask('Bewegingsproef').id } }]);
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await sleep(200);
  await shot('telefoon-donker');
  await openTask('Afwasmachine uitruimen');
  await shot('telefoon-taakvenster-donker');
  await click('#task-dialog .task-top .icon-button');
  await noDialog();
  await send('Emulation.setEmulatedMedia', { features: [] });
  step('telefoonformaat: uitschuifmenu, geen horizontaal scrollen, alles aan te tikken is minstens 44 px, het taakvenster vult het scherm in één kolom, geen snelle knoppen die een aanwijzer vragen; "minder beweging" slaat de afvinkanimatie over; donkere modus werkt');

  // ---- 9b. toetsenbord: zichtbare focusring, en de taak openen met Enter ----
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
  await sleep(200);
  await nav('Thuis');
  await waitFor(`document.getElementById('view-title').textContent === 'Thuis'`, 'Thuis');
  await evaluate(`document.activeElement?.blur(); document.body.focus()`);
  const ringed: string[] = [];
  for (let i = 0; i < 6; i++) {
    await press('Tab');
    ringed.push(await evaluate<string>(`(() => { const e = document.activeElement; const s = getComputedStyle(e); return (e.className || e.tagName) + '|' + s.outlineStyle + '|' + s.outlineWidth; })()`));
  }
  assert.ok(ringed.every((r) => !r.includes('|none|')), `elke toets met focus heeft een zichtbare ring: ${JSON.stringify(ringed)}`);
  await evaluate(`${row('Planten water geven')}.querySelector('.task-body').focus()`);
  await press('Enter');
  await waitFor(`document.querySelector('#task-dialog[open]')`, 'taak geopend met het toetsenbord');
  assert.equal(await evaluate(`document.querySelector('#task-dialog textarea[aria-label="Taak"]').value`), 'Planten water geven');
  await press('Escape');
  await noDialog();
  step(`toetsenbord: Tab laat overal een zichtbare focusring zien (${ringed.length} keer gecontroleerd), Enter op een taak opent het venster, Esc sluit`);

  // ---- 9c. zoeken, filters en labels ----
  const aliceToken = await evaluate<string>(`localStorage.getItem('tickory.token')`);
  const inboxId = (serverState().me as any).inbox_project_id as string;
  const serverFilters = () => (serverState().filters as any[]).filter((f) => !f.is_deleted);
  const serverLabels = () => (serverState().labels as any[]).filter((l) => !l.is_deleted);
  const serverLabel = (name: string) => serverLabels().find((l) => l.name === name);
  // wat Alice zelf typte en wat Nederlands mag blijven in de Engelse schermen: de Nederlandse vormen van de filtertaal
  const dutchForms = [...FILTER_EXAMPLES.map((e) => e.nl), ...FILTER_TERM_GROUPS.flatMap((g) => g.terms.map((x) => x.nl))].sort((a, b) => b.length - a.length);
  const findItem = (label: string) => `[...document.querySelectorAll('.find-item')].find((b) => b.querySelector('.find-label')?.textContent === ${js(label)})`;
  const searchInput = '#search-dialog .search-input';
  const searchHits = () => evaluate<{ kind: string; title: string; marks: string[]; detail: string; active: boolean }[]>(`[...document.querySelectorAll('#search-dialog .search-hit')].map((li) => ({ kind: li.querySelector('.search-kind').textContent, title: li.querySelector('.search-title').textContent, marks: [...li.querySelectorAll('mark')].map((m) => m.textContent), detail: li.querySelector('.search-detail').textContent, active: li.getAttribute('aria-selected') === 'true' }))`);
  const searchFor = async (text: string) => {
    await typeInto(searchInput, text);
    await waitFor(`document.querySelector('#search-dialog .search-status').textContent !== ''`, `zoekresultaat voor ${text}`);
  };
  const openSearchWithSlash = async () => {
    await evaluate(`document.activeElement?.blur(); document.body.focus()`);
    await press('/');
    await waitFor(`document.querySelector('#search-dialog[open]')`, 'zoekvenster');
    assert.equal(await evaluate(`document.activeElement === document.querySelector(${js(searchInput)})`), true, 'het zoekveld heeft meteen de focus');
  };
  // gegevens om in te zoeken: een beschrijving met accenten, een opmerking bij een project, een taak met een Engelse en een Nederlandse term
  const aliceSync = (uuid: string, commands: object[]) => syncAs(aliceToken, 'zoek-test', commands.map((c: any, i) => ({ ...c, uuid: `${uuid}-${i}` })));
  assert.equal((await aliceSync('e2e-zoek-data', [
    { type: 'task_add', args: { id: 'e2ezoektaak0001', project_id: inboxId, content: 'Dessert kiezen', description: 'Vergeet de Crème brûlée niet, en het bestek.' } },
    { type: 'comment_add', args: { id: 'e2ezoekopm0001', project_id: thuisId, content: 'Het wachtwoord van de wifi staat op de koelkast' } },
  ])).status, 200);

  // `/` opent het zoekvenster, buiten invoervelden
  await openSearchWithSlash();
  await shot('zoeken-leeg');
  assert.match(await evaluate(`document.querySelector('#search-dialog .search-empty').textContent`), /Zoek in alles wat je hebt/);
  assert.equal(await evaluate(`document.querySelector(${js(searchInput)}).getAttribute('role')`), 'combobox');
  // hoofdletters en accenten: "CAFE" vindt "Café reserveren", de markering ligt over de oorspronkelijke letters
  await searchFor('CAFE');
  let hits = await searchHits();
  assert.deepEqual(hits.filter((x) => x.kind === 'Taak').map((x) => x.title), ['Café reserveren']);
  assert.deepEqual(hits.find((x) => x.title === 'Café reserveren')!.marks, ['Café']);
  // een los accent (zoals sommige toetsenborden het leveren) vindt hetzelfde
  await searchFor('Cafe\u0301');
  assert.deepEqual((await searchHits()).filter((x) => x.kind === 'Taak').map((x) => x.title), ['Café reserveren']);
  await searchFor('zoe');
  assert.deepEqual((await searchHits()).find((x) => x.title === 'Zoë bellen')?.marks, ['Zoë']);
  await searchFor('ijs');
  assert.deepEqual((await searchHits()).find((x) => x.title === 'IJs kopen')?.marks, ['IJs'], 'hoofdletter-IJ');
  // beschrijving en opmerking: een stuk tekst rond de treffer, met markering
  await searchFor('creme brulee');
  hits = await searchHits();
  const dessert = hits.find((x) => x.title === 'Dessert kiezen')!;
  assert.deepEqual(dessert.marks, ['Crème', 'brûlée'], 'de woorden zijn gemarkeerd, met hun accenten, in de beschrijving');
  assert.equal(await evaluate(`document.querySelector('#search-dialog .search-title mark')`), null, 'de titel zelf is niet gemarkeerd');
  assert.match(dessert.detail, /Crème brûlée/);
  assert.equal(await evaluate(`document.querySelector('#search-dialog .search-hit mark').textContent`), 'Crème');
  await searchFor('wachtwoord wifi');
  hits = await searchHits();
  assert.deepEqual(hits.map((x) => x.kind), ['Opmerking']);
  assert.deepEqual(hits[0].marks, ['wachtwoord', 'wifi']);
  assert.equal(hits[0].title, 'Thuis', 'een opmerking bij een project toont het project als titel');
  await searchFor('nietsdergelijks');
  assert.match(await evaluate(`document.querySelector('#search-dialog .search-empty').textContent`), /Niets gevonden voor "nietsdergelijks"/);
  assert.equal(await evaluate(`document.querySelector('#search-dialog .search-status').textContent`), 'Geen resultaten');
  // alle woorden in elke volgorde, en pijltjestoetsen + Enter
  await searchFor('bellen tandarts');
  hits = await searchHits();
  assert.equal(hits[0].title, 'Tandarts bellen');
  assert.equal(hits[0].active, true, 'de eerste treffer is meteen gekozen');
  await searchFor('bellen');
  hits = await searchHits();
  assert.ok(hits.length >= 4 && hits[0].kind === 'Label', `eerst het label, dan de taken: ${JSON.stringify(hits.map((x) => x.title))}`);
  const target = hits.findIndex((x) => x.title === 'Tandarts bellen');
  for (let i = 0; i < target; i++) await press('ArrowDown');
  assert.deepEqual((await searchHits()).map((x) => x.active), hits.map((_, i) => i === target), 'pijltje omlaag kiest de volgende treffer');
  assert.equal(await evaluate(`document.querySelector(${js(searchInput)}).getAttribute('aria-activedescendant') === document.querySelector('#search-dialog .search-hit[aria-selected=true]').id`), true);
  await shot('zoeken-resultaten');
  await press('ArrowUp');
  assert.equal((await searchHits()).findIndex((x) => x.active), target - 1, 'pijltje omhoog kiest de vorige treffer');
  await searchFor('bellen');
  await press('ArrowUp');
  assert.equal((await searchHits()).findIndex((x) => x.active), hits.length - 1, 'pijltje omhoog vanaf de eerste loopt rond naar de laatste');
  await press('ArrowDown');
  assert.equal((await searchHits()).findIndex((x) => x.active), 0, 'en pijltje omlaag vanaf de laatste naar de eerste');
  await searchFor('bellen tandarts');
  await press('Enter');
  await waitFor(`document.querySelector('#task-dialog[open]')`, 'Enter opent de taak');
  assert.equal(await evaluate(`document.querySelector('#task-dialog textarea[aria-label="Taak"]').value`), 'Tandarts bellen');
  assert.equal(await evaluate(`Boolean(document.querySelector('#search-dialog'))`), false, 'het zoekvenster is gesloten');
  await press('Escape');
  await noDialog();
  // Esc sluit het zoekvenster
  await openSearchWithSlash();
  await press('Escape');
  await noDialog();
  // Ctrl+K werkt ook vanuit een invoerveld, `/` in een invoerveld is gewoon een teken
  await evaluate(`document.getElementById('quick-input').focus()`);
  await press('/');
  assert.equal(await evaluate(`document.getElementById('quick-input').value`), '/');
  assert.equal(await evaluate(`Boolean(document.querySelector('dialog[open]'))`), false, '/ in een invoerveld opent niets');
  await typeInto('#quick-input', '');
  await evaluate(`document.getElementById('quick-input').focus()`);
  await press('k', { ctrl: true });
  await waitFor(`document.querySelector('#search-dialog[open]')`, 'Ctrl+K vanuit een invoerveld');
  await press('Escape');
  await noDialog();
  // een open taakvenster: `/` doet niets, Ctrl+K opent zoeken erbovenop
  await openTask('Planten water geven');
  await press('/');
  await sleep(150);
  assert.equal(await evaluate(`Boolean(document.querySelector('#search-dialog'))`), false, '/ bij een open venster opent niets');
  await press('Escape');
  await noDialog();
  await waitFor(`!document.querySelector('dialog')`, 'taakvenster opgeruimd');
  // ook als de focus niet in een invoerveld staat: het overzicht van sneltoetsen heeft alleen knoppen
  await typeInto('#quick-input', '');
  await evaluate(`document.activeElement?.blur(); document.body.focus()`);
  await press('?');
  await waitFor(`document.querySelector('dialog[open] h2')?.textContent === 'Sneltoetsen'`, 'overzicht van sneltoetsen');
  assert.equal(await evaluate(`document.activeElement?.tagName`), 'BUTTON', 'de focus staat op een knop, niet in een invoerveld');
  await press('/');
  await sleep(150);
  assert.equal(await evaluate(`Boolean(document.querySelector('#search-dialog'))`), false, '/ opent geen zoekvenster boven een ander venster');
  await press('Escape');
  await noDialog();
  await waitFor(`!document.querySelector('dialog')`, 'opgeruimd');
  // een opmerking vinden en de taak erbij openen; de knop in de zijbalk
  await click('.search-field');
  await waitFor(`document.querySelector('#search-dialog[open]')`, 'zoekveld in de zijbalk');
  await searchFor('bestek');
  hits = await searchHits();
  assert.deepEqual(hits.map((x) => x.kind).sort(), ['Opmerking', 'Taak'].sort(), 'de opmerking én de taak met het woord in de beschrijving');
  const commentHit = hits.findIndex((x) => x.kind === 'Opmerking');
  for (let i = 0; i < commentHit; i++) await press('ArrowDown');
  await press('Enter');
  await waitFor(`document.querySelector('#task-dialog[open]')`, 'taak bij de opmerking');
  assert.equal(await evaluate(`document.querySelector('#task-dialog textarea[aria-label="Taak"]').value`), 'Afwasmachine uitruimen');
  await press('Escape');
  await noDialog();
  // een project vinden
  await openSearchWithSlash();
  await searchFor('thuis');
  hits = await searchHits();
  assert.equal(hits[0].kind, 'Project');
  await press('Enter');
  await waitFor(`document.getElementById('view-title').textContent === 'Thuis'`, 'het project geopend');
  step('zoeken: / en Ctrl+K (ook vanuit een invoerveld), hoofdletters en accenten ("CAFE", losse accenten, IJ), treffers in titel, beschrijving en opmerkingen met markering, alle woorden in elke volgorde, pijltjes en Enter, Esc; niets gevonden geeft uitleg');

  // ---- filters: aanmaken met controle, kleur, favoriet, hulp ----
  const bellenId = serverLabel('bellen')!.id;
  const expectedMatches = (serverState().tasks as any[]).filter((x) => !x.is_deleted && !x.checked && x.labels?.includes(bellenId) && [today, tomorrow].includes(String(x.due?.date ?? '').slice(0, 10))).length;
  assert.ok(expectedMatches >= 1);
  await click('button[aria-label="Filter toevoegen"]');
  await waitFor(`document.querySelector('dialog[open] h2')?.textContent === 'Nieuw filter'`, 'filtervenster');
  assert.match(await evaluate(`document.querySelector('dialog[open] .filter-state').textContent`), /Typ een filter/);
  await typeInto('dialog[open] input[aria-label="Naam"]', 'Dringend bellen');
  await typeInto('dialog[open] .filter-input', '(vandaag | morgen) & #Bestaatniet');
  assert.equal(await evaluate(`document.querySelector('dialog[open] .filter-error-text').textContent`), 'Onbekend project: "Bestaatniet".');
  assert.equal(await evaluate(`document.querySelector('dialog[open] .filter-error-mark').textContent`), '#Bestaatniet', 'de plek van de fout is gemarkeerd');
  assert.equal(await evaluate(`document.querySelector('dialog[open] .filter-input').getAttribute('aria-invalid')`), 'true');
  await submit('dialog[open] form');
  await sleep(150);
  assert.equal(await evaluate(`document.querySelector('dialog[open] h2')?.textContent`), 'Nieuw filter', 'een filter met een fout wordt niet bewaard');
  assert.equal(serverFilters().length, 0);
  await typeInto('dialog[open] .filter-input', '(vandaag | morgen) &');
  assert.equal(await evaluate(`document.querySelector('dialog[open] .filter-error-text').textContent`), 'Hier ontbreekt een term.');
  await typeInto('dialog[open] .filter-input', '(vandaag | morgen) & "@bellen');
  assert.equal(await evaluate(`document.querySelector('dialog[open] .filter-error-text').textContent`), 'Deze aanhalingstekens worden niet gesloten.');
  await typeInto('dialog[open] .filter-input', 'vandaag morgen');
  assert.equal(await evaluate(`document.querySelector('dialog[open] .filter-error-text').textContent`), 'Hier hoort & (en) of | (of) te staan.');
  await typeInto('dialog[open] .filter-input', '');
  // de uitleg: een voorbeeld aantikken zet het in het veld
  await click('dialog[open] .filter-help > summary');
  await waitFor(`document.querySelector('dialog[open] .filter-help[open] .filter-code-button')`, 'uitleg open');
  await shot('filter-venster-hulp');
  await evaluate(`[...document.querySelectorAll('dialog[open] .filter-code-button')].find((b) => b.textContent === '(vandaag | morgen) & @bellen').click()`);
  assert.equal(await evaluate(`document.querySelector('dialog[open] .filter-input').value`), '(vandaag | morgen) & @bellen');
  assert.equal(await evaluate(`document.querySelector('dialog[open] .filter-ok').textContent`), expectedMatches === 1 ? 'Dit klopt: nu voldoet 1 taak.' : `Dit klopt: nu voldoen ${expectedMatches} taken.`);
  await click('dialog[open] .filter-help > summary');
  await click('dialog[open] .swatch input[value="red"]');
  await evaluate(`document.querySelector('dialog[open] .check-row input').click()`);
  await shot('filter-venster');
  await submit('dialog[open] form');
  await waitFor(`document.getElementById('view-title').textContent === 'Dringend bellen'`, 'het filter geopend');
  await waitFor(SYNCED, 'gesynchroniseerd');
  assert.deepEqual(serverFilters().map((f) => [f.name, f.query, f.color, f.is_favorite]), [['Dringend bellen', '(vandaag | morgen) & @bellen', 'red', true]]);
  assert.equal(await evaluate(`document.querySelectorAll('.task').length`), expectedMatches);
  assert.ok((await taskTitles()).includes('Tandarts bellen'));
  assert.equal(await evaluate(`document.getElementById('view-count').textContent`), expectedMatches === 1 ? '1 taak' : `${expectedMatches} taken`);
  assert.equal(await evaluate(`${findItem('Dringend bellen')}.classList.contains('active')`), true, 'het filter is gekozen in de zijbalk');
  assert.equal(await evaluate(`${findItem('Dringend bellen')}.querySelector('.find-count').textContent`), String(expectedMatches));
  assert.equal(await evaluate(`Boolean(${findItem('Dringend bellen')}.querySelector('.find-star'))`), true, 'favoriet is gemarkeerd');
  await shot('filter');
  // bewerken: dezelfde zoekopdracht met Engelse woorden geeft hetzelfde
  await click('.btn-edit');
  await waitFor(`document.querySelector('dialog[open] h2')?.textContent === 'Filter bewerken'`, 'bewerken');
  assert.equal(await evaluate(`document.querySelector('dialog[open] .filter-input').value`), '(vandaag | morgen) & @bellen');
  await typeInto('dialog[open] .filter-input', '(today | tomorrow) & @bellen');
  assert.match(await evaluate(`document.querySelector('dialog[open] .filter-ok').textContent`), new RegExp(`${expectedMatches} taa?k`));
  await submit('dialog[open] form');
  await noDialog();
  await waitFor(SYNCED, 'gesynchroniseerd');
  assert.equal(serverFilters()[0].query, '(today | tomorrow) & @bellen');
  assert.equal(await evaluate(`document.querySelectorAll('.task').length`), expectedMatches, 'Engelse woorden geven dezelfde taken als Nederlandse');
  // meerdere lijsten in één filter
  await click('button[aria-label="Filter toevoegen"]');
  await waitFor(`document.querySelector('dialog[open] h2')?.textContent === 'Nieuw filter'`, 'tweede filter');
  await typeInto('dialog[open] input[aria-label="Naam"]', 'Per plek');
  await typeInto('dialog[open] .filter-input', 'Thuis: #Thuis, Alles: alles');
  await submit('dialog[open] form');
  await waitFor(`document.getElementById('view-title').textContent === 'Per plek'`, 'filter met lijsten');
  assert.deepEqual(await texts('.group-title'), ['Thuis', 'Alles'], 'elke lijst heeft zijn eigen naam');
  assert.equal((await taskTitles()).filter((x) => x === 'Planten water geven').length, 2, 'een taak die in twee lijsten past, staat in allebei'); // een regel bestaat maar één keer: de tweede is een eigen regel
  assert.equal(await evaluate(`[...document.querySelectorAll('.group')].map((g) => g.querySelectorAll('.task').length > 0).join()`), 'true,true');
  // een filter dat niet meer klopt (bewaard zoals getypt, bijvoorbeeld na het verwijderen van een project)
  assert.equal((await aliceSync('e2e-kapot-filter', [{ type: 'filter_add', args: { id: 'e2efilterkapot01', name: 'Kapot', query: '#Verdwenen project & vandaag' } }])).status, 200);
  await waitFor(findItem('Kapot'), 'het kapotte filter staat in de zijbalk');
  assert.equal(await evaluate(`${findItem('Kapot')}.querySelector('.find-bad')?.textContent`), '!', 'een filter dat niet klopt heeft een uitroepteken');
  await evaluate(`${findItem('Kapot')}.click()`);
  await waitFor(`document.getElementById('view-title').textContent === 'Kapot'`, 'kapot filter');
  assert.equal(await evaluate(`document.querySelector('.filter-error-text').textContent`), 'Onbekend project: "Verdwenen project".');
  assert.equal(await evaluate(`document.querySelector('.filter-error-mark').textContent`), '#Verdwenen project');
  assert.equal(await evaluate(`document.querySelector('.filter-error').getAttribute('role')`), 'alert');
  assert.equal(await evaluate(`document.querySelectorAll('.task').length`), 0);
  await shot('filter-fout');
  // het overzicht van filters, met hulp
  await evaluate(`document.querySelector('[data-fk="find-head:filters"]').click()`);
  await waitFor(`document.getElementById('view-title').textContent === 'Filters'`, 'overzicht van filters');
  assert.deepEqual((await texts('.manage-name')).sort(), ['Dringend bellen', 'Kapot', 'Per plek']);
  assert.match(await evaluate(`document.querySelector('.manage-bad').textContent`), /Filter klopt niet: Onbekend project/);
  await shot('filters-overzicht');
  await click('.btn-help');
  await waitFor(`document.querySelector('dialog[open] .filter-help-body')`, 'hulp bij filters');
  assert.ok((await evaluate<number>(`document.querySelectorAll('dialog[open] .filter-help-row').length`)) > 30);
  await evaluate(`[...document.querySelectorAll('dialog[open] .filter-code-button')].find((b) => b.textContent === 'p1 & !subtaak').click()`);
  await waitFor(`document.querySelector('dialog[open] h2')?.textContent === 'Nieuw filter'`, 'voorbeeld als nieuw filter');
  assert.equal(await evaluate(`document.querySelector('dialog[open] .filter-input').value`), 'p1 & !subtaak');
  await clickText('Annuleren', `document.querySelector('dialog[open]')`);
  await noDialog();
  // het favorietsterretje, en verwijderen met bevestiging
  await evaluate(`document.querySelector('[aria-label="Favoriet: Per plek"]').click()`);
  await waitFor(SYNCED, 'gesynchroniseerd');
  assert.equal(serverFilters().find((f) => f.name === 'Per plek').is_favorite, true);
  assert.equal(await evaluate(`document.querySelector('[aria-label="Favoriet: Per plek"]').getAttribute('aria-pressed')`), 'true');
  for (const name of ['Kapot', 'Per plek', 'Dringend bellen']) {
    await evaluate(`[...document.querySelectorAll('button[aria-label]')].find((b) => b.getAttribute('aria-label') === ${js(`Filter "${name}" verwijderen`)}).click()`);
    await waitFor(`document.querySelector('dialog[open] h2')?.textContent === 'Filter verwijderen?'`, 'bevestiging');
    await evaluate(`[...document.querySelectorAll('dialog[open]')].at(-1).querySelector('.button-danger').click()`);
    await waitFor(SYNCED, 'gesynchroniseerd');
  }
  assert.equal(serverFilters().length, 0);
  assert.equal(await evaluate(`document.querySelectorAll('.manage-row').length`), 0);
  step('filters: nieuw filter met directe controle (onbekend project, ontbrekende term, open aanhalingstekens, vergeten operator, plek gemarkeerd; niet bewaard bij een fout), uitleg met voorbeelden, kleur en favoriet, Engelse en Nederlandse woorden, lijsten met een eigen naam, een filter dat niet meer klopt, overzicht, verwijderen');

  // ---- labels: zijbalk, openen via de taakregel, beheren ----
  const countOf = (name: string) => (serverState().tasks as any[]).filter((x) => !x.is_deleted && !x.checked && x.labels?.includes(serverLabel(name)!.id)).length;
  assert.equal(await evaluate(`${findItem('bellen')}.querySelector('.find-count').textContent`), String(countOf('bellen')), 'het aantal open taken staat bij het label');
  await evaluate(`${findItem('bellen')}.click()`);
  await waitFor(`document.getElementById('view-title').textContent === '@bellen'`, 'label geopend');
  assert.equal(await evaluate(`document.querySelectorAll('.task').length`), countOf('bellen'));
  assert.ok((await taskTitles()).includes('Tandarts bellen'));
  await shot('label');
  // "Taak toevoegen" onder een label begint met dat label
  await click('.add-inline');
  await waitFor(`document.querySelector('.dialog-quick[open]')`, 'Taak toevoegen vanuit het label');
  assert.equal(await evaluate(`document.querySelector('.dialog-quick[open] input[type=text]').value`), '@bellen ');
  assert.deepEqual(await texts('.dialog-quick[open] .chip'), ['(nog geen naam)', '@bellen']);
  await typeInto('.dialog-quick[open] input[type=text]', '@bellen Notaris bellen');
  await submit('.dialog-quick[open] form');
  await noDialog();
  await waitFor(SYNCED, 'gesynchroniseerd');
  assert.deepEqual(serverTask('Notaris bellen').labels, [bellenId]);
  await waitFor(`document.querySelectorAll('.task').length === ${countOf('bellen')}`, 'de nieuwe taak staat bij het label');
  await syncAs(aliceToken, 'zoek-test', [{ type: 'task_delete', uuid: 'e2e-zoek-opruimen-3', args: { id: serverTask('Notaris bellen').id } }]);
  // het label in een taakregel is een knop die het label opent
  await nav('Binnenkort');
  await waitFor(`document.getElementById('view-title').textContent === 'Binnenkort'`, 'Binnenkort');
  await evaluate(`${row('Tandarts bellen')}.querySelector('.chip-label').click()`);
  await waitFor(`document.getElementById('view-title').textContent === '@bellen'`, 'label via de taakregel');
  // overzicht van labels, toevoegen met controle op dubbele namen
  await evaluate(`document.querySelector('[data-fk="find-head:labels"]').click()`);
  await waitFor(`document.getElementById('view-title').textContent === 'Labels'`, 'overzicht van labels');
  assert.ok((await texts('.manage-name')).includes('@bellen'));
  assert.equal((await texts('.manage-detail'))[(await texts('.manage-name')).indexOf('@bellen')], countOf('bellen') === 1 ? '1 open taak' : `${countOf('bellen')} open taken`);
  await click('.btn-add');
  await waitFor(`document.querySelector('dialog[open] h2')?.textContent === 'Nieuw label'`, 'labelvenster');
  for (const [typed, message] of [['', 'Geef het label een naam.'], ['BELLEN', 'Er bestaat al een label met deze naam.'], ['één', 'Er bestaat al een label met deze naam.'], ['E\u0301E\u0301N', 'Er bestaat al een label met deze naam.'], ['a, b', 'Een labelnaam mag geen komma of stuurtekens bevatten.']]) {
    await typeInto('dialog[open] input[aria-label="Naam"]', typed);
    await submit('dialog[open] form');
    assert.equal(await evaluate(`document.querySelector('dialog[open] .error').textContent`), message, `label "${typed}"`);
  }
  await typeInto('dialog[open] input[aria-label="Naam"]', 'Uitgaan met Zoë');
  await click('dialog[open] .swatch input[value="green"]');
  await submit('dialog[open] form');
  await noDialog();
  await waitFor(SYNCED, 'gesynchroniseerd');
  assert.deepEqual([serverLabel('Uitgaan met Zoë')?.color, serverLabel('Uitgaan met Zoë')?.is_favorite], ['green', false]);
  assert.equal(await evaluate(`document.getElementById('view-title').textContent`), 'Labels', 'vanuit het overzicht blijf je in het overzicht');
  // een label met spaties is ook in snel toevoegen te typen (de langste passende naam wint)
  await typeInto('#quick-input', 'Taxi regelen @Uitgaan met Zoë');
  await waitFor(`document.querySelectorAll('#quick-preview .chip').length === 2`, 'voorbeeld met het label');
  assert.deepEqual(await texts('#quick-preview .chip'), ['Taxi regelen', '@Uitgaan met Zoë'], 'het bestaande label, niet een nieuw label "Uitgaan"');
  await typeInto('#quick-input', '');
  // het nieuwe label is te kiezen in het taakvenster
  await nav('Thuis');
  await openTask('Planten water geven');
  assert.ok((await evaluate<string[]>(`[...document.querySelectorAll('#task-dialog datalist option')].map((o) => o.value)`)).includes('Uitgaan met Zoë'));
  await typeInto('#task-dialog .label-input', 'Uitgaan met Zoë');
  await press('Enter');
  await submit('#task-dialog form');
  await noDialog();
  await waitFor(SYNCED, 'gesynchroniseerd');
  assert.deepEqual(serverTask('Planten water geven').labels, [serverLabel('Uitgaan met Zoë')!.id]);
  // hernoemen: de taken houden het label; een bestaande naam wordt geweigerd; kleur wisselen
  await evaluate(`document.querySelector('[data-fk="find-head:labels"]').click()`);
  await waitFor(`document.getElementById('view-title').textContent === 'Labels'`, 'overzicht');
  await evaluate(`document.querySelector('[aria-label="Label @bellen bewerken"]').click()`);
  await waitFor(`document.querySelector('dialog[open] h2')?.textContent === 'Label bewerken'`, 'label bewerken');
  assert.equal(await evaluate(`document.querySelector('dialog[open] input[aria-label="Naam"]').value`), 'bellen');
  await typeInto('dialog[open] input[aria-label="Naam"]', 'uitgaan met zoë');
  await submit('dialog[open] form');
  assert.equal(await evaluate(`document.querySelector('dialog[open] .error').textContent`), 'Er bestaat al een label met deze naam.', 'ook zonder hoofdletters en accent-vorm');
  await typeInto('dialog[open] input[aria-label="Naam"]', 'telefoneren');
  await click('dialog[open] .swatch input[value="violet"]');
  await submit('dialog[open] form');
  await noDialog();
  await waitFor(SYNCED, 'gesynchroniseerd');
  assert.deepEqual([serverLabel('telefoneren')?.id, serverLabel('telefoneren')?.color], [bellenId, 'violet'], 'hetzelfde label, nieuwe naam en kleur');
  assert.equal(serverLabel('bellen'), undefined);
  await nav('Binnenkort');
  await waitFor(`${row('Tandarts bellen')}`, 'Tandarts bellen');
  assert.deepEqual(await taskMeta('Tandarts bellen'), ['morgen 09:00', '@telefoneren', '🔔', 'Inbox'], 'de taak toont de nieuwe naam');
  await shot('labels-hernoemd');
  // verwijderen met bevestiging, ook met taken eraan
  await evaluate(`document.querySelector('[data-fk="find-head:labels"]').click()`);
  await waitFor(`document.getElementById('view-title').textContent === 'Labels'`, 'overzicht');
  await shot('labels-overzicht');
  const bellenCount = (serverState().tasks as any[]).filter((x) => !x.is_deleted && x.labels?.includes(bellenId)).length;
  await evaluate(`document.querySelector('[aria-label="Label @telefoneren verwijderen"]').click()`);
  await waitFor(`document.querySelector('dialog[open] h2')?.textContent === 'Label verwijderen?'`, 'bevestiging');
  assert.match(await evaluate(`document.querySelector('dialog[open] p').textContent`), new RegExp(`van ${bellenCount} taa?k`));
  await evaluate(`[...document.querySelectorAll('dialog[open]')].at(-1).querySelector('.button-danger').click()`);
  await waitFor(SYNCED, 'gesynchroniseerd');
  assert.equal(serverLabel('telefoneren'), undefined);
  assert.equal((serverState().tasks as any[]).some((x) => !x.is_deleted && x.labels?.includes(bellenId)), false, 'het label is van alle taken gehaald');
  assert.equal(await evaluate(`Boolean(${findItem('telefoneren')})`), false);
  await evaluate(`document.querySelector('[aria-label="Label @Uitgaan met Zoë verwijderen"]').click()`);
  await waitFor(`document.querySelector('dialog[open] .button-danger')`, 'bevestiging');
  await evaluate(`[...document.querySelectorAll('dialog[open]')].at(-1).querySelector('.button-danger').click()`);
  await waitFor(SYNCED, 'gesynchroniseerd');
  step('labels: aantal open taken in de zijbalk, openen (ook via het label in een taakregel), overzicht, toevoegen met controle (leeg, dubbel in hoofdletters en accenten, komma), kleur, in het taakvenster te kiezen, hernoemen (taken houden het label; bestaande naam geweigerd), kleur wisselen, verwijderen met bevestiging');

  // ---- 9d. zoeken, filters en labels: donker, Engels, telefoon en toegankelijkheid ----
  assert.equal((await aliceSync('e2e-zoek-data2', [
    { type: 'label_add', args: { id: 'e2elabel0000001', name: 'bellen', color: 'blue', is_favorite: true } },
    { type: 'task_update', args: { id: serverTask('Tandarts bellen').id, labels: ['e2elabel0000001'] } },
    { type: 'filter_add', args: { id: 'e2efilter0000001', name: 'Dringend bellen', query: '(vandaag | morgen) & @bellen', color: 'red', is_favorite: true } },
    { type: 'filter_add', args: { id: 'e2efilter0000002', name: 'Kapot', query: '#Verdwenen project & vandaag' } },
  ])).status, 200);
  await waitFor(findItem('Kapot'), 'de nieuwe filters en labels zijn binnen');
  await waitFor(findItem('bellen'), 'het label is binnen');
  await waitFor(SYNCED, 'gesynchroniseerd');
  const userTexts = ['Dringend bellen', 'Kapot', 'bellen', 'Dessert kiezen', 'Tandarts bellen', 'Vergeet de Crème brûlée niet, en het bestek.', 'Het wachtwoord van de wifi staat op de koelkast', '#Verdwenen project & vandaag', '(vandaag | morgen) & @bellen', ...mine, ...dutchForms];
  const scheme = (value: 'light' | 'dark' | null) => send('Emulation.setEmulatedMedia', { features: value ? [{ name: 'prefers-color-scheme', value }] : [] });
  const showFilter = async (name: string) => { await evaluate(`${findItem(name)}.click()`); await waitFor(`document.getElementById('view-title').textContent === ${js(name)}`, `filter ${name}`); };

  // licht en donker: dezelfde schermen, de tekst blijft leesbaar (het contrast zelf wordt in findStyle.test.js gemeten)
  for (const mode of ['light', 'dark'] as const) {
    await scheme(mode);
    await sleep(150);
    await showFilter('Dringend bellen');
    await shot(`filter-${mode}`);
    await showFilter('Kapot');
    await shot(`filter-fout-${mode}`);
    await openSearchWithSlash();
    await searchFor('bellen');
    await shot(`zoeken-${mode}`);
    await press('Escape');
    await noDialog();
    await evaluate(`document.querySelector('[data-fk="find-head:filters"]').click()`);
    await waitFor(`document.getElementById('view-title').textContent === 'Filters'`, 'filters');
    await shot(`filters-${mode}`);
    await evaluate(`document.querySelector('[data-fk="find-head:labels"]').click()`);
    await waitFor(`document.getElementById('view-title').textContent === 'Labels'`, 'labels');
    await shot(`labels-${mode}`);
  }
  await scheme(null);

  // toegankelijkheid van het zoekvenster: combobox met lijst, opties, actieve optie, melding van het aantal; focus terug na sluiten
  await evaluate(`document.querySelector('.search-field').focus()`);
  await press('Enter');
  await waitFor(`document.querySelector('#search-dialog[open]')`, 'zoekvenster met Enter op de zoekknop');
  await searchFor('bellen');
  const aria = await evaluate<Record<string, any>>(`(() => { const input = document.querySelector(${js(searchInput)}); const list = document.getElementById(input.getAttribute('aria-controls')); return { role: input.getAttribute('role'), expanded: input.getAttribute('aria-expanded'), listRole: list.getAttribute('role'), listLabel: list.getAttribute('aria-label'), options: [...list.children].every((li) => li.getAttribute('role') === 'option' && li.id), selected: list.querySelectorAll('[aria-selected=true]').length, live: document.querySelector('#search-dialog .search-status').getAttribute('role'), dialogLabel: document.getElementById('search-dialog').getAttribute('aria-label'), inputLabel: input.getAttribute('aria-label'), shortcuts: document.querySelector('.search-field')?.getAttribute('aria-keyshortcuts') }; })()`);
  assert.deepEqual(aria, { role: 'combobox', expanded: 'true', listRole: 'listbox', listLabel: 'Zoekresultaten', options: true, selected: 1, live: 'status', dialogLabel: 'Zoeken', inputLabel: 'Zoeken in taken, opmerkingen, projecten, labels en filters', shortcuts: '/ Control+K' });
  assert.match(await evaluate(`document.querySelector('#search-dialog .search-status').textContent`), /^\d+ resultaten?$/);
  await searchFor('nietsdergelijks');
  assert.equal(await evaluate(`document.querySelector(${js(searchInput)}).getAttribute('aria-expanded')`), 'false');
  await press('Escape');
  await noDialog();
  await waitFor(`!document.querySelector('dialog')`, 'opgeruimd');
  assert.equal(await evaluate(`document.activeElement?.classList.contains('search-field')`), true, 'na sluiten staat de focus weer op de zoekknop waar je vandaan kwam');
  // Tab door de zijbalk: overal een zichtbare focusring (zoekknop, kopjes, filters, labels)
  const ringed2: string[] = [];
  for (let i = 0; i < 12; i++) {
    await press('Tab');
    ringed2.push(await evaluate<string>(`(() => { const e = document.activeElement; const s = getComputedStyle(e); return (e.className || e.tagName) + '|' + s.outlineStyle + '|' + s.outlineWidth; })()`));
  }
  assert.ok(ringed2.some((r) => r.startsWith('find-item')) && ringed2.some((r) => r.startsWith('nav-section-link')), `Tab bereikt de lijsten Filters en Labels: ${JSON.stringify(ringed2)}`);
  assert.ok(ringed2.every((r) => !r.includes('|none|')), `elke knop met focus heeft een zichtbare ring: ${JSON.stringify(ringed2)}`);

  // Engels
  await evaluate(`localStorage.setItem('tickory.lang', 'en')`);
  await send('Page.reload');
  await waitFor(`document.body.classList.contains('ready') && document.getElementById('sync-status').textContent === 'Up to date'`, 'Engels na herladen', 15_000);
  assert.deepEqual(await texts('.nav-section-link'), ['Filters', 'Labels']);
  await openSearchWithSlash();
  assert.equal(await evaluate(`document.querySelector(${js(searchInput)}).placeholder`), 'Search tasks, comments, projects, labels…');
  assert.equal(await evaluate(`document.querySelector('#search-dialog .search-empty-title').textContent`), 'Search everything you have');
  await noDutch('zoekvenster', userTexts);
  await searchFor('wachtwoord wifi');
  assert.deepEqual((await searchHits()).map((x) => x.kind), ['Comment']);
  assert.equal(await evaluate(`document.querySelector('#search-dialog .search-status').textContent`), '1 result');
  await searchFor('bellen');
  hits = await searchHits();
  assert.equal(hits[0].kind, 'Label');
  assert.ok(hits.slice(1).every((x) => ['Task', 'Filter'].includes(x.kind)), JSON.stringify(hits.map((x) => x.kind)));
  await fits('zoekresultaten (Engels)');
  await noDutch('zoekresultaten', userTexts);
  await shot('engels-zoeken');
  await searchFor('nietsdergelijks');
  assert.match(await evaluate(`document.querySelector('#search-dialog .search-empty').textContent`), /Nothing found for "nietsdergelijks"/);
  assert.equal(await evaluate(`document.querySelector('#search-dialog .search-status').textContent`), 'No results');
  await noDutch('zoeken zonder resultaat', userTexts);
  await press('Escape');
  await noDialog();
  await showFilter('Kapot');
  assert.equal(await evaluate(`document.querySelector('.filter-broken-title').textContent`), 'This filter cannot be read');
  assert.equal(await evaluate(`document.querySelector('.filter-error-text').textContent`), 'Unknown project: "Verdwenen project".');
  await noDutch('kapot filter', userTexts);
  await fits('kapot filter (Engels)');
  await shot('engels-filter-fout');
  await showFilter('Dringend bellen');
  await noDutch('filter', userTexts);
  await evaluate(`document.querySelector('[data-fk="find-head:filters"]').click()`);
  await waitFor(`document.getElementById('view-title').textContent === 'Filters'`, 'filters (Engels)');
  assert.equal(await evaluate(`document.querySelector('.manage-bad').textContent`), 'Filter is not valid: Unknown project: "Verdwenen project".');
  assert.deepEqual(await buttons('.view-actions'), ['Filter help', 'Add filter']);
  await noDutch('filters-overzicht', userTexts);
  await fits('filters-overzicht (Engels)');
  await shot('engels-filters');
  await click('button[aria-label="Add filter"]');
  await waitFor(`document.querySelector('dialog[open] h2')?.textContent === 'New filter'`, 'filtervenster (Engels)');
  await typeInto('dialog[open] .filter-input', 'today & #Nowhere');
  assert.equal(await evaluate(`document.querySelector('dialog[open] .filter-error-text').textContent`), 'Unknown project: "Nowhere".');
  await typeInto('dialog[open] .filter-input', 'today &');
  assert.equal(await evaluate(`document.querySelector('dialog[open] .filter-error-text').textContent`), 'A term is missing here.');
  await typeInto('dialog[open] .filter-input', '(today | tomorrow) & @bellen');
  assert.match(await evaluate(`document.querySelector('dialog[open] .filter-ok').textContent`), /^This works: \d+ tasks? match(es)? now\.$/);
  await click('dialog[open] .filter-help > summary');
  await waitFor(`document.querySelector('dialog[open] .filter-help[open] .filter-code-button')`, 'uitleg (Engels)');
  assert.equal(await evaluate(`document.querySelector('dialog[open] .filter-help-example dt .filter-code').textContent`), 'today | overdue');
  assert.match(await evaluate(`document.querySelector('dialog[open] .filter-help-example dt .filter-help-other').textContent`), /^also: vandaag \| te laat$/);
  await noDutch('filtervenster met uitleg', userTexts);
  await fits('filtervenster (Engels)');
  await shot('engels-filter-venster');
  await clickText('Cancel', `document.querySelector('dialog[open]')`);
  await noDialog();
  await click('.btn-help');
  await waitFor(`document.querySelector('dialog[open] .filter-help-body')`, 'hulp (Engels)');
  await noDutch('hulp bij filters', userTexts);
  await fits('hulp bij filters (Engels)');
  await clickText('Close', `document.querySelector('dialog[open]')`);
  await noDialog();
  await evaluate(`document.querySelector('[data-fk="find-head:labels"]').click()`);
  await waitFor(`document.getElementById('view-title').textContent === 'Labels'`, 'labels (Engels)');
  await click('.btn-add');
  await waitFor(`document.querySelector('dialog[open] h2')?.textContent === 'New label'`, 'labelvenster (Engels)');
  await typeInto('dialog[open] input[aria-label="Name"]', 'BELLEN');
  await submit('dialog[open] form');
  assert.equal(await evaluate(`document.querySelector('dialog[open] .error').textContent`), 'A label with this name already exists.');
  await typeInto('dialog[open] input[aria-label="Name"]', '');
  await submit('dialog[open] form');
  assert.equal(await evaluate(`document.querySelector('dialog[open] .error').textContent`), 'Give the label a name.');
  await noDutch('labelvenster', userTexts);
  await clickText('Cancel', `document.querySelector('dialog[open]')`);
  await noDialog();
  await noDutch('labels-overzicht', userTexts);
  await fits('labels-overzicht (Engels)');
  await shot('engels-labels');
  await evaluate(`${findItem('bellen')}.click()`);
  await waitFor(`document.getElementById('view-title').textContent === '@bellen'`, 'label (Engels)');
  assert.deepEqual(await buttons('.view-actions'), ['Edit', 'More']);
  await noDutch('label', userTexts);

  // telefoon (Engels): zoekknop in de kop, zoekvenster over het hele scherm, zijbalk met lijsten
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(300);
  for (const selector of ['.topbar-search', '#menu-button']) {
    const size = await smallest(selector);
    assert.ok(size.n === 1 && size.h >= 44 && size.w >= 44, `${selector} is te klein om aan te tikken: ${size.w} bij ${size.h}`);
  }
  await click('.topbar-search');
  await waitFor(`document.querySelector('#search-dialog[open]')`, 'zoekvenster op een telefoon');
  await searchFor('bellen');
  const full2 = await evaluate<{ w: number; h: number }>(`(() => { const r = document.getElementById('search-dialog').getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })()`);
  assert.deepEqual(full2, { w: 390, h: 844 }, 'het zoekvenster vult op een telefoon het hele scherm');
  for (const selector of ['#search-dialog .search-hit', '#search-dialog .search-close', '#search-dialog .search-input']) {
    const size = await smallest(selector);
    assert.ok(size.n > 0 && size.h >= 44, `${selector} is te klein om aan te tikken: ${size.w} bij ${size.h}`);
  }
  await fits('zoekvenster op een telefoon');
  assert.equal(await evaluate(`document.documentElement.scrollWidth`), 390);
  await shot('engels-telefoon-zoeken');
  await scheme('dark');
  await sleep(150);
  await shot('telefoon-zoeken-donker');
  await scheme(null);
  await click('#search-dialog .search-close');
  await noDialog();
  await click('#menu-button');
  await sleep(350);
  const drawer2 = await smallest('.sidebar .find-item, .sidebar .nav-section-link, .sidebar .find-toggle, .sidebar .nav-section-head .icon-button, .sidebar .search-field');
  assert.ok(drawer2.h >= 44, `een regel in het uitschuifmenu is te laag: ${drawer2.h}`);
  await shot('engels-telefoon-menu');
  await click('button[aria-label="Add filter"]');
  await waitFor(`document.querySelector('dialog[open] h2')?.textContent === 'New filter'`, 'filtervenster op een telefoon');
  await click('dialog[open] .filter-help > summary');
  await waitFor(`document.querySelector('dialog[open] .filter-help[open] .filter-code-button')`, 'uitleg op een telefoon');
  await fits('filtervenster op een telefoon');
  assert.equal(await evaluate(`document.documentElement.scrollWidth`), 390);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('dialog[open] .filter-help-row')).gridTemplateColumns.split(' ').length`), 1, 'de uitleg staat op een telefoon in één kolom');
  for (const selector of ['dialog[open] .filter-code-button', 'dialog[open] .swatch', 'dialog[open] .field', 'dialog[open] .button']) {
    const size = await smallest(selector);
    assert.ok(size.n > 0 && size.h >= 44, `${selector} is te klein om aan te tikken: ${size.w} bij ${size.h}`);
  }
  await shot('engels-telefoon-filter-venster');
  await clickText('Cancel', `document.querySelector('dialog[open]')`);
  await noDialog();
  await evaluate(`document.querySelector('[data-fk="find-head:labels"]').click()`);
  await waitFor(`document.getElementById('view-title').textContent === 'Labels'`, 'labels op een telefoon');
  await fits('labels op een telefoon');
  for (const selector of ['.manage-open', '.manage-buttons .icon-button']) {
    const size = await smallest(selector);
    assert.ok(size.n > 0 && size.h >= 44 && size.w >= 44, `${selector} is te klein om aan te tikken: ${size.w} bij ${size.h}`);
  }
  await shot('engels-telefoon-labels');
  await showFilter('Kapot');
  await fits('kapot filter op een telefoon');
  await shot('engels-telefoon-filter-fout');
  await showFilter('Dringend bellen');
  await fits('filter op een telefoon');
  await shot('engels-telefoon-filter');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
  await sleep(200);
  await evaluate(`localStorage.setItem('tickory.lang', 'nl')`);
  await send('Page.reload');
  await waitFor(`document.body.classList.contains('ready') && document.getElementById('sync-status').textContent === 'Bijgewerkt'`, 'weer Nederlands', 15_000);

  // opruimen: wat deze stap aanmaakte
  await syncAs(aliceToken, 'zoek-test', [
    { type: 'filter_delete', uuid: 'e2e-zoek-opruimen-4', args: { id: 'e2efilter0000001' } },
    { type: 'filter_delete', uuid: 'e2e-zoek-opruimen-5', args: { id: 'e2efilter0000002' } },
    { type: 'label_delete', uuid: 'e2e-zoek-opruimen-6', args: { id: 'e2elabel0000001' } },
    { type: 'task_delete', uuid: 'e2e-zoek-opruimen-7', args: { id: 'e2ezoektaak0001' } },
    { type: 'comment_delete', uuid: 'e2e-zoek-opruimen-8', args: { id: 'e2ezoekopm0001' } },
  ]);
  await waitFor(`!(${findItem('Kapot')})`, 'opgeruimd');
  await nav('Thuis');
  await waitFor(SYNCED, 'gesynchroniseerd');
  step('zoeken, filters en labels: licht en donker, toegankelijkheid van het zoekvenster (combobox, lijst, actieve optie, aantal, focus terug), focusring in de zijbalk, Engels zonder Nederlandse tekst (zoeken, filterfouten, uitleg, labelmeldingen) en zonder afgekapte tekst, telefoon: zoekknop in de kop, zoekvenster over het hele scherm, zijbalk en vensters met tikvlakken van minstens 44 px');

  // ---- 9c. slepen en verplaatsen van taken en projecten: muis, aanraking en toetsenbord ----
  await dndScenario();

  // ---- 9d. meerdere taken selecteren en bewerken, ongedaan maken, Voltooid ----
  await bulkScenario(bulkCtx);

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
  await nav('Alice');
  await waitFor(`document.querySelector('dialog[open] .menu')`, 'instellingenmenu');
  await clickText('Afmelden en lokale gegevens wissen');
  await waitFor(`[...document.querySelectorAll('dialog[open] button')].some((b) => b.textContent === 'Afmelden')`, 'bevestiging');
  await clickText('Afmelden', `document.querySelector('dialog[open]')`);
  await waitFor(`document.querySelector('dialog[open] input[type=password]') && document.querySelectorAll('.task').length === 0`, 'na afmelden: leeg en inlogscherm', 15_000);
  assert.equal(await evaluate(`localStorage.getItem('tickory.token')`), null);
  const leftovers = await evaluate<number>(`new Promise((res, rej) => { const r = indexedDB.open('tickory'); r.onsuccess = () => { const tx = r.result.transaction(['rows', 'queue'], 'readonly'); const a = tx.objectStore('rows').count(); const b = tx.objectStore('queue').count(); tx.oncomplete = () => res(a.result + b.result); }; r.onerror = () => rej(r.error); })`);
  assert.equal(leftovers, 0, 'geen taken meer in de lokale opslag');
  assert.ok((serverState().tasks as any[]).length >= 6, 'op de server staat alles nog');
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND revoked_at IS NOT NULL").get(alice.id) as any).n, 1, 'de sessie van dit apparaat is op de server ingetrokken');
  step('afmelden: sessie ingetrokken, token en lokale kopie gewist, de server heeft alles nog');

  // ---- 12. een ander account op hetzelfde apparaat ----
  await typeInto('dialog[open] input[autocomplete=username]', 'bob');
  await typeInto('dialog[open] input[type=password]', PASSWORD_BOB);
  await submit('dialog[open] form');
  await waitFor(`!document.querySelector('dialog[open]') && await ${SYNCED}`, 'ingelogd als Bob');
  await waitFor(`[...document.querySelectorAll('.nav-label')].some((e) => e.textContent === 'Bob')`, 'naam Bob in de zijbalk');
  const bobProjects = await evaluate<string[]>(`[...document.querySelectorAll('.nav-item .nav-label')].map((e) => e.textContent)`);
  assert.ok(bobProjects.includes('Thuis') && bobProjects.includes('Inbox'), `Bob ziet zijn Inbox en het gedeelde project: ${JSON.stringify(bobProjects)}`);
  await nav('Thuis');
  await waitFor(`document.getElementById('view-title').textContent === 'Thuis'`, 'Thuis bij Bob');
  assert.deepEqual((await taskTitles()).sort(), ['Afwasmachine uitruimen', 'Gordijnen ophangen', 'Glazen apart', 'Planten water geven', 'Van mijn telefoon', 'Offline bedacht', 'Vergadering voorbereiden', 'Tuin besproeien', 'Zonder tijd', 'Bellen met de buren'].sort());
  assert.equal(await evaluate(`document.querySelector('.shared-with').textContent.startsWith('Gedeeld met Alice')`), true);
  // Bob is lid, geen eigenaar: hij kan het project niet archiveren of verwijderen, en ziet de opmerkingen van Alice (niet te wijzigen)
  await clickText('Project…');
  await waitFor(`document.querySelector('dialog[open] .menu')`, 'projectmenu van Bob');
  assert.deepEqual(await buttons(), ['Bewerken…', 'Subproject toevoegen', 'Taak uit sjabloon…', 'Opslaan als sjabloon…', 'Aan favorieten toevoegen', 'Voltooide taken bekijken', 'Activiteit', 'Leden bekijken', 'Project verlaten', 'Sluiten'], 'een lid ziet geen "Archiveren" en geen "Project verwijderen", zoals de server het ook weigert');
  await clickText('Sluiten', `document.querySelector('dialog[open]')`);
  await noDialog();
  assert.deepEqual(await buttons('.view-actions'), ['Lijst', 'Bord', 'Kalender', 'Opmerkingen (1)', 'Gedeeld', 'Project…']);
  await openTask('Afwasmachine uitruimen');
  assert.deepEqual(await texts('#task-dialog .comment-author'), ['Alice', 'Bob']);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('#task-dialog .comment')].map((c) => c.querySelectorAll('.comment-tools button').length)`), [0, 2], 'Bob kan alleen zijn eigen opmerking wijzigen of verwijderen');
  await shot('bob-opmerkingen');
  await clickText('Annuleren', `document.querySelector('#task-dialog')`);
  await noDialog();
  await nav('Inbox');
  await waitFor(`document.getElementById('view-title').textContent === 'Inbox'`, 'Inbox van Bob');
  assert.deepEqual(await taskTitles(), [], 'Bobs Inbox is leeg: Alice\' taken zijn niet te zien');
  await shot('bob');
  step('ander account: Bob ziet zijn eigen (lege) Inbox en het gedeelde project, en niets van Alice\' eigen taken');

  // ---- 13. sessie ingetrokken door de beheerder, en een ander account logt in: eerst de gegevens van Bob wissen ----
  await quickAdd('Bobs eigen taak');
  await waitFor(`await ${SYNCED}`, 'gesynchroniseerd');
  db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(new Date().toISOString(), bob.id);
  await click('#sync-status');
  await waitFor(`document.querySelector('dialog[open] input[type=password]') && document.getElementById('sync-status').textContent === 'Inloggen nodig'`, 'inlogscherm na intrekken van de sessie');
  assert.equal(await evaluate(`document.querySelector('dialog[open] input[autocomplete=username]').value`), 'bob', 'de gebruikersnaam is al ingevuld');
  assert.ok(await evaluate(`document.querySelector('dialog[open] .hint')?.textContent.includes('niet meer aangemeld')`));
  await typeInto('dialog[open] input[autocomplete=username]', 'alice');
  await typeInto('dialog[open] input[type=password]', PASSWORD_ALICE);
  await submit('dialog[open] form');
  await waitFor(`[...document.querySelectorAll('dialog[open] h2')].some((e) => e.textContent === 'Inloggen als Alice?')`, 'waarschuwing bij wisselen van account');
  assert.ok(await evaluate(`[...document.querySelectorAll('dialog[open] p')].some((e) => e.textContent.includes('gegevens van Bob'))`));
  await clickText('Wissen en inloggen');
  await waitFor(`document.body.classList.contains('ready') && [...document.querySelectorAll('.nav-label')].some((e) => e.textContent === 'Alice') && await ${SYNCED}`, 'ingelogd als Alice na het wissen', 20_000);
  const aliceProjects = await evaluate<string[]>(`[...document.querySelectorAll('.nav-item .nav-label')].map((e) => e.textContent)`);
  assert.ok(aliceProjects.includes('Thuis'));
  assert.equal((await evaluate<string[]>(`[...document.querySelectorAll('.task-title')].map((e) => e.textContent)`)).includes('Bobs eigen taak'), false);
  step('sessie ingetrokken: het inlogscherm komt vanzelf; een ander account wist eerst de gegevens van de vorige gebruiker (na waarschuwing)');

  // ---- fouten in de console ----
  const own = consoleErrors.filter((e) => !/adguard/i.test(e));
  // Een te kort wachtwoord of een ongeldige gebruikersnaam hoort hier niet meer bij: dat houdt de app zelf tegen vóór het versturen.
  const expected = own.filter((e) => /401|Failed to fetch|ERR_CONNECTION_REFUSED|net::ERR|status of 403 .*\/api\/v1\/auth\/password|status of 409 .*\/api\/v1\/admin\/users/i.test(e));
  const unexpected = own.filter((e) => !expected.includes(e));
  assert.deepEqual(unexpected, [], 'onverwachte fouten in de console van de browser');
  step(`console: geen onverwachte fouten (${expected.length} verwachte netwerkmeldingen: de offline-tests, de foute wachtwoorden, de bestaande gebruikersnaam en de ingetrokken sessie; ${consoleErrors.length - own.length} van AdGuard genegeerd)`);
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
      out.indexedDb = await limit(new Promise((res) => { const r = indexedDB.open('tickory'); r.onsuccess = () => { const tx = r.result.transaction('queue', 'readonly'); const c = tx.objectStore('queue').count(); tx.oncomplete = () => res('ok, ' + c.result + ' wachtend'); tx.onerror = () => res('fout'); }; r.onerror = () => res('fout bij openen'); r.onblocked = () => res('GEBLOKKEERD'); }), 4000);
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
