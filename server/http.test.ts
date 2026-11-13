import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createSchema } from './schema.ts';
import { createApp, resolveStatic, staticResponse } from './main.ts';
import type { App } from './main.ts';
import { createSession, createUser, setPasswordCostForTests } from './users.ts';

let TOKEN = '';
let app: App;
let base = '';
let port = 0;

before(async () => {
  setPasswordCostForTests(1024);
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const user = createUser(db, { username: 'alice', name: 'Alice', passwordHash: 'x' });
  TOKEN = createSession(db, user.id, 'test').token;
  app = createApp({ db });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  port = (app.server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
});
after(async () => { await app.close(); });

const post = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/v1/sync`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

/** Verzoek met een ongewijzigd pad (fetch zou ".." zelf al wegwerken). */
const rawGet = (path: string): Promise<{ status: number; body: string; headers: Record<string, unknown> }> =>
  new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });

test('/health is open', async () => {
  const r = await fetch(`${base}/health`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
});

test('zonder of met fout token: 401', async () => {
  for (const headers of [{}, { Authorization: 'Bearer fout' }, { Authorization: `Basic ${TOKEN}` }]) {
    const r = await fetch(`${base}/api/v1/sync`, { method: 'POST', headers, body: '{}' });
    assert.equal(r.status, 401);
    assert.equal((await r.json()).error_code, 'UNAUTHORIZED');
  }
});

test('een token in de URL wordt niet geaccepteerd (voorkomt lekken via logs)', async () => {
  const r = await fetch(`${base}/api/v1/events?token=${TOKEN}`);
  assert.equal(r.status, 401);
});

test('een geldige sync levert de verwachte vorm en veiligheidsheaders', async () => {
  const r = await post({ sync_token: '*', commands: [{ type: 'project_add', uuid: 'http-test-0001', args: { id: 'project-http-1111', name: 'HTTP' } }] });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const j = await r.json();
  assert.equal(j.sync_status['http-test-0001'], 'ok');
  assert.deepEqual(j.projects.map((p: { name: string }) => p.name).sort(), ['HTTP', 'Inbox']);
  assert.equal(typeof j.sync_token, 'string');
});

test('ongeldige JSON en ongeldige verzoeken: 400 met foutcode', async () => {
  const a = await post('{kapot');
  assert.equal(a.status, 400);
  assert.equal((await a.json()).error_code, 'INVALID_REQUEST');
  const b = await post({ sync_token: 'abc' });
  assert.equal(b.status, 400);
  assert.match((await b.json()).error, /sync_token/);
});

test('te grote body: 413', async () => {
  const r = await post({ pad: 'x'.repeat(1024 * 1024 + 10) });
  assert.equal(r.status, 413);
});

test('onbekend API-pad: 404, verkeerde methode: 405', async () => {
  assert.equal((await fetch(`${base}/api/v1/nergens`)).status, 404);
  const r = await fetch(`${base}/api/v1/sync`, { method: 'GET', headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(r.status, 405);
});

test('SSE: een wijziging van client A wordt aan luisteraars gemeld, met het client_id', async () => {
  const ac = new AbortController();
  const stream = await fetch(`${base}/api/v1/events`, { headers: { Authorization: `Bearer ${TOKEN}` }, signal: ac.signal });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type') ?? '', /text\/event-stream/);
  const reader = stream.body!.getReader();
  const dec = new TextDecoder();
  let seen = '';
  const readUntil = async (needle: string) => {
    const deadline = Date.now() + 5000;
    while (!seen.includes(needle)) {
      if (Date.now() > deadline) throw new Error(`geen "${needle}" ontvangen, wel: ${seen}`);
      const { value, done } = await reader.read();
      if (done) break;
      seen += dec.decode(value);
    }
  };
  await readUntil('event: hello');

  await post({ commands: [{ type: 'label_add', uuid: 'http-test-0002', args: { name: 'SSE' } }] }, { 'X-Client-Id': 'client-a' });
  await readUntil('event: sync_needed');
  assert.match(seen, /"client_id":"client-a"/);

  // een sync zonder wijzigingen geeft geen signaal
  const mark = seen.length;
  await post({ commands: [] });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(seen.length, mark);

  ac.abort();
});

// ---------- bestanden van de web-app ----------

const CLIENT_DIR = fileURLToPath(new URL('../client/', import.meta.url));
const SHARED_DIR = fileURLToPath(new URL('../shared/', import.meta.url));

test('de web-app krijgt een strikte Content-Security-Policy mee (gemeten aan de server zelf)', async () => {
  // Rechtstreeks, niet via het netwerk: een lokaal filter (AdGuard) herschrijft de header onderweg.
  const out = await staticResponse('/', CLIENT_DIR, SHARED_DIR);
  assert.ok(out);
  assert.equal(out.status, 200);
  assert.equal(
    out.headers['Content-Security-Policy'],
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
  assert.equal(out.headers['X-Frame-Options'], 'DENY');
  assert.equal(out.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(out.headers['Referrer-Policy'], 'no-referrer');
  const html = out.body!.toString('utf8');
  assert.match(html, /^<!doctype html>/i);
  assert.equal((html.match(/<script/gi) ?? []).length, 1, 'precies één script: de app zelf');
  assert.equal(await staticResponse('/bestaat-niet.js', CLIENT_DIR, SHARED_DIR), null);
  assert.equal((await staticResponse('/', CLIENT_DIR, SHARED_DIR, String(out.headers.ETag)))!.status, 304);
});

test('de web-app komt ook via het netwerk aan, met de kern van de beveiligingsheaders', async () => {
  const r = await fetch(`${base}/`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') ?? '', /text\/html/);
  const csp = r.headers.get('content-security-policy') ?? '';
  for (const part of ["default-src 'self'", "script-src 'self'", "frame-ancestors 'none'", "base-uri 'none'"]) assert.ok(csp.includes(part), part);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.match(await r.text(), /<!doctype html>/i);
});

test('gedeelde modules staan onder /shared/, met het juiste type', async () => {
  const r = await fetch(`${base}/shared/orderKey.js`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') ?? '', /text\/javascript/);
  assert.match(await r.text(), /export function keyBetween/);
});

/**
 * Eén verzoek, met één nieuwe poging als de verbinding onderweg wordt verbroken (ECONNRESET). De server breekt zelf geen
 * verbindingen af (gemeten: 3000 opeenvolgende verzoeken op één verbinding zonder fout); op een pc met een netwerkfilter
 * (AdGuard) gebeurt het wel, vooral als de machine druk is. Een tweede reset achter elkaar is wél een fout.
 */
async function fetchWithRetry(t: { diagnostic: (m: string) => void }, ...args: Parameters<typeof fetch>): Promise<Response> {
  try {
    return await fetch(...args);
  } catch (err) {
    if ((err as { cause?: { code?: string } }).cause?.code !== 'ECONNRESET') throw err;
    t.diagnostic('verbinding onderweg verbroken (ECONNRESET), één nieuwe poging');
    return fetch(...args);
  }
}

test('ETag: een ongewijzigd bestand geeft 304; HEAD geeft geen inhoud', async (t) => {
  const first = await fetchWithRetry(t, `${base}/shared/orderKey.js`);
  const etag = first.headers.get('etag');
  assert.ok(etag);
  await first.arrayBuffer();
  // Leg vast wat de server zelf ontvangt. Op een pc met een netwerkfilter (AdGuard) komt een header soms niet of anders
  // aan; dan valt de 304 hier niet te meten. Dat mag deze test niet laten falen, maar ook niet verbergen: komt de header
  // wel aan, dan moet het antwoord 304 zijn, en in CI (zonder filter) moet hij altijd aankomen.
  let received: string | undefined;
  const spy = (req: { url?: string; method?: string; headers: Record<string, unknown> }) => {
    if (req.url === '/shared/orderKey.js' && req.method === 'GET') received = req.headers['if-none-match'] as string | undefined;
  };
  app.server.on('request', spy);
  const second = await fetchWithRetry(t, `${base}/shared/orderKey.js`, { headers: { 'If-None-Match': etag! } });
  app.server.off('request', spy);
  if (received === etag || process.env.CI) {
    assert.equal(received, etag, 'de voorwaardelijke header komt ongewijzigd aan');
    assert.equal(second.status, 304);
  } else {
    assert.equal((await staticResponse('/shared/orderKey.js', CLIENT_DIR, SHARED_DIR, etag))!.status, 304, 'de regel zelf klopt');
    t.diagnostic(`If-None-Match kwam niet ongewijzigd bij de server aan (verstuurd ${etag}, ontvangen ${received ?? 'niets'}): iets tussen de test en de server paste het verzoek aan. De 304 is hier rechtstreeks gecontroleerd in plaats van via het netwerk.`);
  }
  const head = await fetchWithRetry(t, `${base}/shared/orderKey.js`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal((await head.text()).length, 0);
});

test('buiten de toegestane mappen komen lukt niet', async () => {
  for (const path of [
    '/../package.json', '/..%2fpackage.json', '/%2e%2e/package.json', '/shared/../server/main.ts', '/shared/..%2f..%2fpackage.json',
    '/shared/%2e%2e/server/sync.ts', '/..\\package.json', '/%5c..%5cpackage.json', '//etc/passwd', '/shared//orderKey.js',
    '/C:/Windows/win.ini', '/shared/orderKey.js%00.png', '/.gitignore', '/shared/.hidden.js', '/shared',
  ]) {
    const r = await rawGet(path);
    assert.equal(r.status, 404, `${path} gaf ${r.status}`);
    assert.ok(!/tickory|"scripts"/.test(r.body), `${path} lekte inhoud`);
  }
  // "/core/.." is na het wegwerken van de puntjes gewoon "/": de startpagina, niets daarbuiten
  const root = await rawGet('/core/..');
  assert.equal(root.status, 200);
  assert.match(root.body, /<!doctype html>/i);
});

test('tests, servercode en onbekende bestandstypen worden niet uitgeleverd', async () => {
  for (const path of ['/shared/orderKey.test.js', '/shared/schema.ts', '/package.json', '/server/main.ts', '/README.md', '/shared/nul.js', '/shared/CON.js']) {
    assert.equal((await rawGet(path)).status, 404, path);
  }
  const r = await fetch(`${base}/shared/orderKey.js`, { method: 'POST' });
  assert.equal(r.status, 405);
});

test('resolveStatic: alleen paden binnen de eigen mappen', () => {
  const client = fileURLToPath(new URL('../client/', import.meta.url));
  const shared = fileURLToPath(new URL('../shared/', import.meta.url));
  assert.ok(resolveStatic('/', client, shared)!.file.endsWith('index.html'));
  assert.ok(resolveStatic('/shared/schema.js', client, shared)!.file.endsWith('schema.js'));
  assert.equal(resolveStatic('/%E0%A4%A', client, shared), null, 'kapotte codering');
  assert.equal(resolveStatic('/a b.js', client, shared), null);
  assert.equal(resolveStatic('/x.js:stream', client, shared), null);
  assert.equal(resolveStatic('/core/a..b.js', client, shared), null);
});

test('testbestanden worden ook niet uitgeleverd met andere hoofdletters (hoofdletterongevoelige bestandssystemen: Windows, macOS)', () => {
  const client = fileURLToPath(new URL('../client/', import.meta.url));
  const shared = fileURLToPath(new URL('../shared/', import.meta.url));
  for (const path of ['/core/AUTH.TEST.JS', '/core/auth.Test.js', '/core/Auth.test.JS', '/shared/TEXT.test.js', '/shared/orderKey.TEST.js', '/core/auth.test.js']) {
    assert.equal(resolveStatic(path, client, shared), null, path);
  }
  assert.ok(resolveStatic('/ui/APP.JS', client, shared), 'gewone bestanden met hoofdletters zijn een zaak van het bestandssysteem');
});

test('zonder clientmap is er alleen een API', async () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const apiOnly = createApp({ db, clientDir: null });
  await new Promise<void>((r) => apiOnly.server.listen(0, '127.0.0.1', r));
  const p = (apiOnly.server.address() as AddressInfo).port;
  assert.equal((await fetch(`http://127.0.0.1:${p}/`)).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${p}/health`)).status, 200);
  await apiOnly.close();
});
