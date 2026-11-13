// Meldingen in de browser via HTTP: aanmelden, overzicht, proefmelding, de klok en een knop uit een melding.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import type { AddressInfo } from 'node:net';
import { createSchema } from './schema.ts';
import { createApp } from './main.ts';
import type { App } from './main.ts';
import { createPush } from './push.ts';
import type { Push } from './push.ts';
import { pushDevice } from './testutil.ts';
import { createSession, createUser } from './users.ts';

let app: App;
let plain: App;
let base = '';
let plainBase = '';
let push: Push;
let alice = '';
let bob = '';
let clock = Date.parse('2026-12-01T06:00:00Z');
const delivered: { url: string; body: Buffer }[] = [];

before(async () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const a = createUser(db, { username: 'alice', name: 'Alice', passwordHash: 'x' });
  const b = createUser(db, { username: 'bob', name: 'Bob', passwordHash: 'x' });
  alice = createSession(db, a.id, 'Laptop van Alice').token;
  bob = createSession(db, b.id, 'Telefoon van Bob').token;
  const fetchFn = (async (url: string, init: any) => {
    delivered.push({ url, body: init.body });
    return new Response(null, { status: 201 });
  }) as unknown as typeof fetch;
  push = createPush({ db, fetch: fetchFn, now: () => clock, defaultTimeZone: 'Europe/Amsterdam' });
  app = createApp({ db, push, pushIntervalMs: 0 });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  // een server zonder meldingen
  const db2 = new DatabaseSync(':memory:');
  createSchema(db2);
  plain = createApp({ db: db2 });
  await new Promise<void>((r) => plain.server.listen(0, '127.0.0.1', r));
  plainBase = `http://127.0.0.1:${(plain.server.address() as AddressInfo).port}`;
});
after(async () => { await app.close(); await plain.close(); });

const call = (path: string, token: string | null, body?: unknown, method = body === undefined ? 'GET' : 'POST') =>
  fetch(`${base}${path}`, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

test('alles onder /api/v1/push/ vraagt een aanmelding, behalve de knop uit een melding', async () => {
  for (const [path, method] of [['/api/v1/push/key', 'GET'], ['/api/v1/push/subscriptions', 'GET'], ['/api/v1/push/subscribe', 'POST'], ['/api/v1/push/unsubscribe', 'POST'], ['/api/v1/push/test', 'POST']] as const) {
    const r = await fetch(`${base}${path}`, { method, ...(method === 'POST' ? { body: '{}', headers: { 'Content-Type': 'application/json' } } : {}) });
    assert.equal(r.status, 401, `${method} ${path}`);
  }
  assert.equal((await call('/api/v1/push/key', alice, {})).status, 405);
  assert.equal((await call('/api/v1/push/subscribe', alice)).status, 405);
  assert.equal((await call('/api/v1/push/bestaat-niet', alice)).status, 404);
  assert.equal((await call('/api/v1/push/action', null, { token: 'onzin' })).status, 400);
  assert.equal((await fetch(`${base}/api/v1/push/action`)).status, 405);
});

test('aanmelden, overzicht en afmelden; een verboden adres wordt geweigerd', async () => {
  const key = await (await call('/api/v1/push/key', alice)).json();
  assert.equal(key.public_key, push.publicKey);
  const d = pushDevice('laptop');
  assert.equal((await call('/api/v1/push/subscribe', alice, { ...d.subscription, endpoint: 'https://192.168.1.1/x' })).status, 400);
  assert.equal((await call('/api/v1/push/subscribe', alice, { endpoint: d.subscription.endpoint })).status, 400);
  const ok = await call('/api/v1/push/subscribe', alice, { ...d.subscription, lang: 'en' });
  assert.equal(ok.status, 200);
  const list = await (await call('/api/v1/push/subscriptions', alice)).json();
  assert.deepEqual(list.subscriptions.map((s: any) => [s.device, s.current]), [['Laptop van Alice', true]]);
  assert.ok(!JSON.stringify(list).includes(d.subscription.endpoint), 'het adres van de pushdienst lekt niet');
  assert.deepEqual((await (await call('/api/v1/push/subscriptions', bob)).json()).subscriptions, [], 'bob ziet de apparaten van alice niet');
  assert.deepEqual(await (await call('/api/v1/push/unsubscribe', bob, { endpoint: d.subscription.endpoint })).json(), { ok: false });
  assert.deepEqual(await (await call('/api/v1/push/unsubscribe', alice, { endpoint: d.subscription.endpoint })).json(), { ok: true });
  assert.deepEqual((await (await call('/api/v1/push/subscriptions', alice)).json()).subscriptions, []);
});

test('van aanmelden tot melding tot knop: proefmelding, herinnering op tijd, en "Voltooien" vanuit de melding', async () => {
  const d = pushDevice('telefoon');
  assert.equal((await call('/api/v1/push/subscribe', bob, d.subscription)).status, 200);
  const received = () => delivered.filter((x) => x.url === d.subscription.endpoint).map((x) => JSON.parse(d.decrypt(x.body)));

  const t = await (await call('/api/v1/push/test', bob, {})).json();
  assert.deepEqual(t, { sent: 1, failed: 0, errors: [] });
  assert.deepEqual(received(), [{ v: 1, type: 'test', lang: 'nl' }]);

  const me = (await (await call('/api/v1/auth/me', bob)).json()).me;
  const add = await call('/api/v1/sync', bob, { commands: [
    { type: 'task_add', uuid: 'push-http-0001', args: { id: 'task-push-http1', project_id: me.inbox_project_id, content: 'Tandarts bellen', due: { date: '2026-12-01T09:00' } } },
    { type: 'reminder_add', uuid: 'push-http-0002', args: { id: 'remind-push-http', task_id: 'task-push-http1', type: 'relative', minute_offset: 30 } },
  ] });
  assert.equal((await add.json()).sync_status['push-http-0002'], 'ok');
  clock = Date.parse('2026-12-01T07:30:00Z');
  assert.equal((await push.tick()).sent, 1);
  const reminder = received()[1];
  assert.deepEqual([reminder.type, reminder.title, reminder.moment], ['reminder', 'Tandarts bellen', '2026-12-01T08:30']);

  // de knop "Voltooien": zonder aanmelding, met het token uit de melding; andere apparaten horen dat er iets veranderde
  const ac = new AbortController();
  const stream = await fetch(`${base}/api/v1/events`, { headers: { Authorization: `Bearer ${bob}` }, signal: ac.signal });
  const reader = stream.body!.getReader();
  await reader.read(); // hello
  const done = await call('/api/v1/push/action', null, { token: reminder.complete });
  assert.equal(done.status, 200);
  const chunk = new TextDecoder().decode((await reader.read()).value);
  assert.match(chunk, /event: sync_needed/);
  ac.abort();
  const tasks = (await (await call('/api/v1/sync', bob, {})).json()).tasks;
  assert.equal(tasks.find((x: any) => x.id === 'task-push-http1').checked, true);
  // een vervalst token doet niets
  assert.equal((await call('/api/v1/push/action', null, { token: `${reminder.snooze}x` })).status, 400);
});

test('op een server zonder meldingen bestaan de eindpunten niet', async () => {
  for (const path of ['/api/v1/push/key', '/api/v1/push/action', '/api/v1/push/subscribe']) {
    assert.equal((await fetch(`${plainBase}${path}`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } })).status, 404, path);
  }
});
