// Inloggen, apparaten en beheer via HTTP, op een eigen server met echte wachtwoorden.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import type { AddressInfo } from 'node:net';
import { createSchema } from './schema.ts';
import { createApp } from './main.ts';
import type { App } from './main.ts';
import { LoginLimiter, createUser, hashPassword, setPasswordCostForTests } from './users.ts';

let app: App;
let base = '';
let db: DatabaseSync;
let clock = 1_000_000;
const PW = 'een-goed-wachtwoord';

before(async () => {
  setPasswordCostForTests(1024);
  db = new DatabaseSync(':memory:');
  createSchema(db);
  createUser(db, { username: 'alice', name: 'Alice', passwordHash: await hashPassword(PW) });
  createUser(db, { username: 'bob', name: 'Bob', passwordHash: await hashPassword(PW) });
  app = createApp({ db, limiter: new LoginLimiter({ user: 4, ip: 100 }, 60_000, () => clock) });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
after(async () => { await app.close(); });

const json = (path: string, body: unknown, token?: string, method = 'POST') =>
  fetch(`${base}${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
  });
const get = (path: string, token?: string) => json(path, undefined, token, 'GET');
const login = async (username: string, password = PW, device_name = 'Test') => {
  const r = await json('/api/v1/auth/login', { username, password, device_name });
  return { status: r.status, body: await r.json(), retryAfter: r.headers.get('retry-after') };
};
const tokenOf = async (u: string) => (await login(u)).body.token as string;
const sync = (token: string, commands: unknown[] = []) => json('/api/v1/sync', { commands }, token);

test('inloggen geeft een token waarmee je kunt synchroniseren; zonder token of met een fout token niet', async () => {
  const r = await login('Alice'); // hoofdletters in de gebruikersnaam maken niet uit
  assert.equal(r.status, 200);
  assert.match(r.body.token, /^tky_/);
  assert.equal(r.body.me.username, 'alice');
  assert.equal(r.body.me.is_admin, true);
  assert.ok(!JSON.stringify(r.body).includes('password'), 'geen hash in het antwoord');
  const s = await sync(r.body.token);
  assert.equal(s.status, 200);
  assert.equal((await s.json()).me.username, 'alice');
  assert.equal((await sync('tky_verzonnen_verzonnen_verzonnen_12345')).status, 401);
  assert.equal((await json('/api/v1/sync', {})).status, 401);
});

test('fout wachtwoord, onbekende gebruiker en geblokkeerd account: dezelfde melding', async () => {
  const wrong = await login('alice', 'verkeerd wachtwoord');
  const unknown = await login('niemand', PW);
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.deepEqual(wrong.body, unknown.body);
  assert.equal(wrong.body.error_code, 'INVALID_CREDENTIALS');
  for (const body of [{}, { username: 'alice' }, { username: 5, password: 6 }, []]) {
    const r = await json('/api/v1/auth/login', body);
    assert.ok(r.status === 401 || r.status === 400, `${JSON.stringify(body)} gaf ${r.status}`);
  }
  assert.equal((await get('/api/v1/auth/login')).status, 405);
});

test('na te veel mislukte pogingen: 429 met Retry-After, ook voor het goede wachtwoord; later weer toegestaan', async () => {
  for (let i = 0; i < 4; i++) assert.equal((await login('bob', `fout-${i}-wachtwoord`)).status, 401);
  const blocked = await login('bob', PW);
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.retryAfter) > 0);
  assert.equal(blocked.body.error_code, 'TOO_MANY_ATTEMPTS');
  assert.equal((await login('alice')).status, 200, 'een ander account is niet geraakt');
  clock += 61_000;
  assert.equal((await login('bob', PW)).status, 200);
});

test('uitloggen trekt alleen de sessie van dit apparaat in; apparaten zijn te zien en in te trekken', async () => {
  const phone = await tokenOf('alice');
  const laptop = await tokenOf('alice');
  const list = await (await get('/api/v1/auth/sessions', phone)).json();
  assert.ok(list.sessions.length >= 2);
  assert.equal(list.sessions.filter((s: any) => s.current).length, 1);
  assert.ok(!JSON.stringify(list).includes(phone), 'het token staat niet in de lijst');

  const laptopId = (await (await get('/api/v1/auth/sessions', laptop)).json()).sessions.find((s: any) => s.current).id;
  const bobToken = await tokenOf('bob');
  assert.equal((await json('/api/v1/auth/sessions/revoke', { id: laptopId }, bobToken)).status, 404, 'andermans apparaat intrekken kan niet');
  assert.equal((await sync(laptop)).status, 200);
  assert.equal((await json('/api/v1/auth/sessions/revoke', { id: laptopId }, phone)).status, 200);
  assert.equal((await sync(laptop)).status, 401);

  assert.equal((await json('/api/v1/auth/logout', {}, phone)).status, 200);
  assert.equal((await sync(phone)).status, 401);
  assert.equal((await get('/api/v1/auth/me', phone)).status, 401);
});

test('uitloggen sluit ook de live-verbinding van dat apparaat', async () => {
  const token = await tokenOf('alice');
  const stream = await fetch(`${base}/api/v1/events`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(stream.status, 200);
  const reader = stream.body!.getReader();
  await reader.read(); // hello
  await json('/api/v1/auth/logout', {}, token);
  const end = await Promise.race([reader.read(), new Promise<{ done: string }>((r) => setTimeout(() => r({ done: 'time-out' }), 3000))]);
  assert.equal((end as { done: unknown }).done, true);
});

test('wachtwoord wijzigen: het huidige wachtwoord is nodig, andere apparaten worden afgemeld, het oude werkt niet meer', async () => {
  const mine = await tokenOf('bob');
  const other = await tokenOf('bob');
  assert.equal((await json('/api/v1/auth/password', { current_password: 'fout', new_password: 'nieuw-wachtwoord-1' }, mine)).status, 403);
  assert.equal((await json('/api/v1/auth/password', { current_password: PW, new_password: 'kort' }, mine)).status, 400);
  assert.equal((await sync(other)).status, 200);
  assert.equal((await json('/api/v1/auth/password', { current_password: PW, new_password: 'nieuw-wachtwoord-1' }, mine)).status, 200);
  assert.equal((await sync(other)).status, 401, 'het andere apparaat is afgemeld');
  assert.equal((await sync(mine)).status, 200, 'dit apparaat blijft ingelogd');
  assert.equal((await login('bob', PW)).status, 401);
  assert.equal((await login('bob', 'nieuw-wachtwoord-1')).status, 200);
  await json('/api/v1/auth/password', { current_password: 'nieuw-wachtwoord-1', new_password: PW }, mine);
});

test('beheer: alleen beheerders; aanmaken, blokkeren, wachtwoord herstellen', async () => {
  const admin = await tokenOf('alice');
  const user = await tokenOf('bob');
  for (const [path, method] of [['/api/v1/admin/users', 'GET'], ['/api/v1/admin/users', 'POST'], ['/api/v1/admin/users/update', 'POST'], ['/api/v1/admin/users/password', 'POST']] as const) {
    assert.equal((await json(path, {}, user, method)).status, 403, `${method} ${path}`);
    assert.equal((await json(path, {}, undefined, method)).status, 401);
  }
  const list = await (await get('/api/v1/admin/users', admin)).json();
  assert.deepEqual(list.users.map((u: any) => u.username), ['alice', 'bob']);
  assert.ok(!JSON.stringify(list).includes('scrypt'), 'geen hashes in het beheeroverzicht');

  const created = await json('/api/v1/admin/users', { username: 'carol', name: 'Carol', password: 'carol-wachtwoord-1' }, admin);
  assert.equal(created.status, 200);
  const carolId = (await created.json()).user.id;
  assert.equal((await login('carol', 'carol-wachtwoord-1')).status, 200);
  assert.equal((await json('/api/v1/admin/users', { username: 'CAROL', name: 'x', password: 'carol-wachtwoord-1' }, admin)).status, 409);
  assert.equal((await json('/api/v1/admin/users', { username: 'dave', name: 'Dave', password: 'kort' }, admin)).status, 400);
  assert.equal((await json('/api/v1/admin/users', { username: 'x', name: 'Dave', password: 'dave-wachtwoord-1' }, admin)).status, 400);

  const carolSession = (await login('carol', 'carol-wachtwoord-1')).body.token;
  assert.equal((await sync(carolSession)).status, 200);
  assert.equal((await json('/api/v1/admin/users/update', { id: carolId, is_disabled: true }, admin)).status, 200);
  assert.equal((await sync(carolSession)).status, 401, 'geblokkeerd: bestaande sessies werken niet meer');
  assert.equal((await login('carol', 'carol-wachtwoord-1')).status, 401);
  await json('/api/v1/admin/users/update', { id: carolId, is_disabled: false }, admin);
  assert.equal((await json('/api/v1/admin/users/password', { id: carolId, new_password: 'carol-nieuw-wachtwoord' }, admin)).status, 200);
  assert.equal((await login('carol', 'carol-wachtwoord-1')).status, 401);
  assert.equal((await login('carol', 'carol-nieuw-wachtwoord')).status, 200);

  assert.equal((await json('/api/v1/admin/users/update', { id: 'bestaat-niet' }, admin)).status, 404);
  // met een tweede beheerder geldt de laatste-beheerder-regel niet meer, maar jezelf blokkeren of degraderen blijft verboden
  assert.equal((await json('/api/v1/admin/users/update', { id: carolId, is_admin: true, name: 'Carol Beheerder' }, admin)).status, 200);
  const me = (await (await get('/api/v1/auth/me', admin)).json()).me;
  for (const change of [{ is_disabled: true }, { is_admin: false }]) {
    const r = await json('/api/v1/admin/users/update', { id: me.id, ...change }, admin);
    assert.equal(r.status, 409);
    assert.match((await r.json()).error, /jezelf/);
  }
});

/** Opent een live-verbinding en geeft een functie terug die wacht tot de server die sluit. */
async function openStream(token: string): Promise<() => Promise<boolean>> {
  const stream = await fetch(`${base}/api/v1/events`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(stream.status, 200);
  const reader = stream.body!.getReader();
  await reader.read(); // hello
  return async () => {
    const end = await Promise.race([reader.read(), new Promise<{ done: boolean }>((r) => setTimeout(() => r({ done: false }), 3000))]);
    return end.done;
  };
}

test('blokkeren of een nieuw wachtwoord door de beheerder sluit de live-verbindingen van die gebruiker', async () => {
  const admin = await tokenOf('alice');
  const created = await json('/api/v1/admin/users', { username: 'dave', name: 'Dave', password: 'dave-wachtwoord-1' }, admin);
  const daveId = (await created.json()).user.id;
  const dave = (await login('dave', 'dave-wachtwoord-1')).body.token;
  const closedByBlock = await openStream(dave);
  await json('/api/v1/admin/users/update', { id: daveId, is_disabled: true }, admin);
  assert.equal(await closedByBlock(), true, 'geblokkeerd: de verbinding is gesloten');
  await json('/api/v1/admin/users/update', { id: daveId, is_disabled: false }, admin);
  const dave2 = (await login('dave', 'dave-wachtwoord-1')).body.token;
  const closedByReset = await openStream(dave2);
  await json('/api/v1/admin/users/password', { id: daveId, new_password: 'dave-nieuw-wachtwoord' }, admin);
  assert.equal(await closedByReset(), true, 'wachtwoord hersteld: de verbinding is gesloten');
});

test('twee gebruikers via HTTP: gescheiden gegevens, en delen werkt', async () => {
  const a = await tokenOf('alice');
  const b = await tokenOf('bob');
  const mk = { type: 'project_add', uuid: 'http-share-0001', args: { id: 'project-http-sh1', name: 'Samen' } };
  const task = { type: 'task_add', uuid: 'http-share-0002', args: { id: 'task-http-sh-01', project_id: 'project-http-sh1', content: 'Pannen' } };
  const ra = await (await sync(a, [mk, task])).json();
  assert.equal(ra.sync_status['http-share-0002'], 'ok');
  assert.ok(!(await (await sync(b)).text()).includes('Pannen'));
  const share = { type: 'project_share', uuid: 'http-share-0003', args: { project_id: 'project-http-sh1', username: 'bob' } };
  assert.equal((await (await sync(a, [share])).json()).sync_status['http-share-0003'], 'ok');
  assert.ok((await (await sync(b)).text()).includes('Pannen'));
});
