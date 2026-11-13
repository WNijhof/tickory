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
import { addDays, formatDate, formatDueLong, todayString } from '../client/core/format.js';
import { setLanguage } from '../client/core/i18n.js';
import dutchTexts from '../client/i18n/nl.js';
import en from '../client/i18n/en.js';

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
let app: App | null = null;
async function startServer() {
  // met meldingen in de browser, zoals de echte server; de klok staat uit (niets wordt verstuurd, er is ook geen apparaat aangemeld)
  app = createApp({ db, push: createPush({ db }), pushIntervalMs: 0 });
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
  assert.ok(dutchPieces.length > 150 && dutchPieces.includes('Vandaag') && dutchPieces.includes('lid') && !dutchPieces.includes('Project'), `de lijst met Nederlandse teksten klopt niet (${dutchPieces.length})`);
  const checked: string[] = [];
  /** Controleert dat er op dit scherm geen Nederlandse tekst van de app staat (gegevens van de gebruiker mogen Nederlands zijn). */
  const noDutch = async (screen: string) => {
    const text = await screenText();
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

  // wisselen via Instellingen
  await openMenu('Alice');
  assert.deepEqual(await buttons(), ['Account, wachtwoord en apparaten', 'Herinneringen en meldingen', 'Nu bijwerken', 'Taal / Language', 'Afmelden en lokale gegevens wissen', 'Sluiten']);
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
  assert.deepEqual(await texts('.nav-item .nav-label'), ['Today', 'Upcoming', 'Inbox', 'Thuis', 'Alice']);
  assert.deepEqual(await texts('.nav-heading span, .sidebar-footer .nav-count'), ['Projects', 'Settings']);
  assert.deepEqual(await evaluate(`[document.getElementById('sidebar').getAttribute('aria-label'), document.querySelector('.nav').getAttribute('aria-label'), document.getElementById('menu-button').getAttribute('aria-label'), document.querySelector('.nav-heading button').title, document.querySelector('.nav-shared').title, document.getElementById('sync-status').title]`),
    ['Navigation', 'Views', 'Menu', 'Add project', 'Shared project', 'Click to sync now']);
  assert.deepEqual(await evaluate(`[document.getElementById('quick-input').placeholder, document.getElementById('quick-input').getAttribute('aria-label'), document.querySelector('#quick-add button[type=submit]').textContent]`),
    [en['quick.placeholder'], 'Add task', 'Add']);
  assert.deepEqual(await buttons('.toolbar'), ['Add section', 'Shared', 'Project…']);
  assert.equal(await evaluate(`document.querySelector('.shared-with').textContent`), 'Shared with Bob');
  assert.equal(await evaluate(`document.title`), 'Thuis · Tickory');
  assert.deepEqual(await taskMeta('Gordijnen ophangen'), ['for Bob']);
  assert.deepEqual(await taskMeta('Planten water geven'), ['↻ tomorrow']);
  assert.deepEqual(await taskMeta('Afwasmachine uitruimen'), [inEnglish(() => formatDate(expectedThursday, today))]);
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
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('#task-dialog .field-label')].filter((l) => !l.hidden).map((l) => l.firstChild.textContent)`), ['Due date', 'Deadline', 'Priority', 'Labels', 'Project', 'Section']);
  assert.deepEqual(await buttons('#task-dialog'), ['Add reminder', 'Add', 'Delete', 'Cancel', 'Save']);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('#task-dialog [placeholder]')].map((e) => e.placeholder)`), ['Description', en['task.duePlaceholder'], 'e.g. calls, home', 'Add subtask']);
  assert.deepEqual(await texts('#task-dialog select:not([aria-label]) option'), ['P1 – highest', 'P2', 'P3', 'P4 – none', 'Inbox', 'Thuis', '(no section)']);
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
  await waitFor(`[...document.querySelectorAll('#task-dialog .hint')].some((e) => e.textContent === 'Subtask added: Bring the forms')`, 'subtaak toegevoegd (Engels)');
  await shot('engels-bewerken');
  await submit('#task-dialog form');
  await waitFor(`!document.querySelector('dialog[open]')`, 'bewerkvenster gesloten (Engels)');
  await waitFor(`await ${SYNCED_EN}`, 'gesynchroniseerd (Engels)');
  assert.equal(serverTask('Call the dentist').due.date, '2027-01-15T09:30');
  assert.deepEqual(await taskMeta('Call the dentist'), ['15 Jan 2027 09:30', '@calls', '🔔']);
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
  assert.deepEqual(await texts('dialog[open] .device-info'), ['Aliceyou@alice · owner', 'Bob@bob · member']);
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
  assert.deepEqual(await buttons(), ['Rename', 'Share…', 'Delete project', 'Close']);
  await clickText('Delete project');
  await waitFor(`[...document.querySelectorAll('dialog[open] h2')].some((e) => e.textContent === 'Delete project?')`, 'bevestiging project verwijderen');
  assert.ok(await evaluate(`document.querySelector('dialog[open] p').textContent === '"Thuis" will be deleted, along with all its sections, tasks and subprojects — also for the people you share it with.'`));
  await noDutch('project verwijderen');
  await clickText('Cancel', `document.querySelector('dialog[open]')`);
  await waitFor(`!document.querySelector('dialog[open]')`, 'bevestiging gesloten');

  // account en gebruikersbeheer; de controles vóór het versturen geven een Engelse melding
  await openMenu('Alice');
  assert.deepEqual(await buttons(), ['Account, password and devices', 'Reminders and notifications', 'Sync now', 'Taal / Language', 'Sign out and clear local data', 'Close']);
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
  assert.deepEqual(await texts('.nav-item .nav-label'), ['Vandaag', 'Binnenkort', 'Inbox', 'Thuis', 'Alice']);
  assert.deepEqual(await texts('.nav-heading span, .sidebar-footer .nav-count'), ['Projecten', 'Instellingen']);
  assert.deepEqual(await buttons('.toolbar'), ['Sectie toevoegen', 'Gedeeld', 'Project…']);
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
  await evaluate(`history.replaceState(null, '', location.pathname)`);
  await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: stub.identifier });
  await evaluate(`sessionStorage.removeItem('android-calls')`);
  await send('Page.reload');
  await waitFor(`document.body.classList.contains('ready')`, 'app opnieuw gestart zonder brug');
  await waitFor(SYNCED, 'gesynchroniseerd');
  step('Android-brug: de app krijgt het sessietoken, de uitleg over meldingen, alarmen en batterij verschijnt met werkende knoppen, een wijziging aan herinneringen geeft één waarschuwing, en #task=… opent de taak (een vreemde waarde niet)');

  // ---- 9. telefoonformaat en donkere modus ----
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await nav('Thuis');
  await sleep(300);
  await shot('telefoon-project');
  assert.equal(await evaluate(`getComputedStyle(document.getElementById('sidebar')).position`), 'fixed', 'op de telefoon is de zijbalk een uitschuifmenu');
  assert.equal(await evaluate(`document.documentElement.scrollWidth`), 390, 'geen horizontaal scrollen op de telefoon: de pagina is precies zo breed als het scherm');
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
