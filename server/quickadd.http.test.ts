// POST /api/v1/quick-add over HTTP: aanmelding, methode, de vorm van antwoord en weigering (altijd met `quick_add`, zodat een app
// een oudere server herkent), de beperking per minuut, te grote verzoeken, en dat een gebruiker niets van een ander raakt.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import type { AddressInfo } from 'node:net';
import { createSchema } from './schema.ts';
import { createApp } from './main.ts';
import type { App } from './main.ts';
import { handleSync } from './sync.ts';
import { createSession, createUser } from './users.ts';
import { QuickAddLimiter } from './quickadd.ts';

let app: App;
let base = '';
let db: DatabaseSync;
let ANNA = '';
let BRAM = '';
let annaId = '';
let t = 0;
const limiter = new QuickAddLimiter({ add: 5, preview: 8 }, 60_000, () => t);

before(async () => {
  db = new DatabaseSync(':memory:');
  createSchema(db);
  const anna = createUser(db, { username: 'anna', name: 'Anna', passwordHash: 'x' });
  const bram = createUser(db, { username: 'bram', name: 'Bram', passwordHash: 'x' });
  annaId = anna.id;
  ANNA = createSession(db, anna.id, 'test').token;
  BRAM = createSession(db, bram.id, 'test').token;
  handleSync(db, { commands: [{ type: 'project_add', uuid: 'qa-http-00001', args: { id: 'project-anna-001', name: 'Thuis' } }] }, anna.id);
  app = createApp({ db, quickAddLimiter: limiter, clientDir: null });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
after(async () => { await app.close(); });

const post = (body: unknown, token: string | null = ANNA, method = 'POST') =>
  fetch(`${base}/api/v1/quick-add`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });

test('zonder of met een fout token: 401, en geen taak', async () => {
  for (const token of [null, 'fout']) {
    const r = await post({ text: 'Iets', uuid: 'tickory-q-http-401' }, token);
    assert.equal(r.status, 401);
    assert.equal((await r.json()).error_code, 'UNAUTHORIZED');
  }
  assert.equal(Number((db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE content = 'Iets'").get() as { n: number }).n), 0);
});

test('alleen POST; elk antwoord van het eindpunt heeft quick_add, een onbekend pad niet', async () => {
  const get = await post(null, ANNA, 'GET');
  assert.equal(get.status, 405);
  assert.equal((await get.json()).quick_add, 1);
  const other = await fetch(`${base}/api/v1/quick-add-x`, { method: 'POST', headers: { Authorization: `Bearer ${ANNA}` }, body: '{}' });
  assert.equal(other.status, 404);
  assert.equal((await other.json()).quick_add, undefined, 'zo herkent de app een server zonder dit eindpunt');
});

test('toevoegen en nog eens: 200, dezelfde taak, en de sync van de web-app ziet hem', async () => {
  t = 1_000_000;
  const body = { text: 'Brood halen morgen #Thuis p2', uuid: 'tickory-q-http-0001', typed_at: '2026-11-13T09:30:00+01:00', tz: 'Europe/Amsterdam' };
  const r = await post(body);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const a = await r.json();
  assert.equal(a.quick_add, 1);
  assert.equal(a.task.content, 'Brood halen');
  assert.equal(a.task.project_id, 'project-anna-001');
  assert.equal(a.task.priority, 2);
  const again = await (await post(body)).json();
  assert.equal(again.task.id, a.task.id);
  assert.equal(again.repeated, true);
  const sync = handleSync(db, { sync_token: '*', resource_types: ['tasks'] }, annaId);
  assert.equal((sync.tasks as { id: string }[]).filter((x) => x.id === a.task.id).length, 1);
});

test('weigeringen hebben de gewone foutcodes en HTTP-statussen, met quick_add', async () => {
  t = 2_000_000;
  const cases: [unknown, number, string][] = [
    [{ text: 'Iets', project_id: 'project-anna-001', uuid: 'tickory-q-http-0002' }, 200, ''],
    [{ text: 'Iets', project_id: 'project-weg-00001', uuid: 'tickory-q-http-0003' }, 404, 'NOT_FOUND'],
    [{ text: '', uuid: 'tickory-q-http-0004' }, 400, 'INVALID_ARG'],
    [{ text: 'Iets', uuid: 'tickory-q-http-0005', vreemd: 1 }, 400, 'UNKNOWN_ARG'],
    ['{kapot', 400, 'INVALID_REQUEST'],
    [[1, 2], 400, 'INVALID_REQUEST'],
  ];
  for (const [body, status, code] of cases) {
    const r = await post(body);
    assert.equal(r.status, status, JSON.stringify(body));
    const j = await r.json();
    if (code) assert.equal(j.error_code, code, JSON.stringify(body));
    if (status !== 200 && code !== 'INVALID_REQUEST') assert.equal(j.quick_add, 1);
  }
});

test('Bram kan niets in het project van Anna zetten of ervan zien: NOT_FOUND, en #Thuis is voor hem gewoon tekst', async () => {
  t = 3_000_000;
  const r = await post({ text: 'Inbreken', project_id: 'project-anna-001', uuid: 'tickory-q-http-0006' }, BRAM);
  assert.equal(r.status, 404);
  const p = await (await post({ text: 'Kijken #Thuis', dry_run: true }, BRAM)).json();
  assert.equal(p.preview.content, 'Kijken #Thuis');
  assert.equal(p.preview.project.inbox, true);
  assert.notEqual(p.preview.project.id, 'project-anna-001');
});

test('te veel per minuut: 429 met Retry-After; de voorvertoning heeft een eigen teller', async () => {
  t = 10_000_000;
  for (let i = 0; i < 5; i++) assert.equal((await post({ text: `Snel ${i}`, uuid: `tickory-q-http-r${i}0000` })).status, 200);
  const r = await post({ text: 'Een te veel', uuid: 'tickory-q-http-r9999' });
  assert.equal(r.status, 429);
  assert.equal(r.headers.get('retry-after'), '60');
  const j = await r.json();
  assert.equal(j.error_code, 'TOO_MANY_REQUESTS');
  assert.equal(j.quick_add, 1);
  assert.equal(Number((db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE content = 'Een te veel'").get() as { n: number }).n), 0);
  assert.equal((await post({ text: 'Kijken', dry_run: true })).status, 200, 'voorvertonen mag nog');
  assert.equal((await post({ text: 'Een te veel', uuid: 'tickory-q-http-r9999' }, BRAM)).status, 200, 'Bram heeft een eigen teller');
  t += 61_000;
  assert.equal((await post({ text: 'Een te veel', uuid: 'tickory-q-http-r9999' })).status, 200);
});

test('een te groot verzoek: 413', async () => {
  t = 20_000_000;
  const r = await post({ text: 'x'.repeat(2 * 1024 * 1024), uuid: 'tickory-q-http-big1' });
  assert.equal(r.status, 413);
});
