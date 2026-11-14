// Sessies die verlopen en het beheer per apparaat: na een periode zonder gebruik, na een maximale leeftijd (beide uit te zetten),
// opruimen, het soort apparaat uit de User-Agent (zonder versienummers), de lijst met "dit apparaat", "alle andere afmelden",
// de instellingen uit de omgeving, het sleutelbestand en de migratie van een oudere database.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp, daysFrom, loadSecretKey, sessionPolicyFrom } from './main.ts';
import { createSchema, SCHEMA_VERSION } from './schema.ts';
import { freshDb } from './testutil.ts';
import {
  DEFAULT_SESSION_POLICY, createSession, createUser, describeUserAgent, findSession, listSessions, pruneSessions, sessionExpired, sessionValid,
} from './users.ts';

const DAY = 86_400_000;
const mk = (db: DatabaseSync, username: string) => createUser(db, { username, name: username, passwordHash: 'x' });
const setTimes = (db: DatabaseSync, id: string, created: number, lastUsed: number) =>
  db.prepare('UPDATE sessions SET created_at = ?, last_used_at = ? WHERE id = ?').run(new Date(created).toISOString(), new Date(lastUsed).toISOString(), id);

test('verlopen: na de periode zonder gebruik en na de maximale leeftijd; precies op de grens nog niet; 0 zet een grens uit', () => {
  const now = Date.parse('2026-11-14T12:00:00Z');
  const s = (createdDaysAgo: number, idleDaysAgo: number) => ({ created_at: new Date(now - createdDaysAgo * DAY).toISOString(), last_used_at: new Date(now - idleDaysAgo * DAY).toISOString() });
  const p = { idleDays: 90, maxDays: 365 };
  assert.equal(sessionExpired(s(10, 1), p, now), false);
  assert.equal(sessionExpired(s(100, 90), p, now), false, 'precies 90 dagen: nog geldig');
  assert.equal(sessionExpired(s(100, 90.0001), p, now), true, 'net over de 90 dagen');
  assert.equal(sessionExpired(s(365, 0), p, now), false, 'precies een jaar oud: nog geldig');
  assert.equal(sessionExpired(s(365.0001, 0), p, now), true, 'dagelijks gebruikt, maar ouder dan een jaar');
  assert.equal(sessionExpired(s(400, 0), { idleDays: 90, maxDays: 0 }, now), false, 'zonder maximum');
  assert.equal(sessionExpired(s(400, 200), { idleDays: 0, maxDays: 0 }, now), false, 'zonder grenzen');
  assert.equal(sessionExpired(s(400, 200), { idleDays: 0, maxDays: 365 }, now), true);
  assert.deepEqual(DEFAULT_SESSION_POLICY, { idleDays: 90, maxDays: 365 });
});

test('een verlopen sessie geeft geen gebruiker meer, wordt ingetrokken en staat niet meer in de lijst; opruimen ruimt de rest', () => {
  const db = freshDb();
  const a = mk(db, 'alice');
  const now = Date.now();
  const fresh = createSession(db, a.id, 'Nieuw');
  const idle = createSession(db, a.id, 'Lang niet gebruikt');
  const old = createSession(db, a.id, 'Heel oud');
  const sleeping = createSession(db, a.id, 'Slapend');
  setTimes(db, idle.id, now - 100 * DAY, now - 91 * DAY);
  setTimes(db, old.id, now - 366 * DAY, now - DAY);
  setTimes(db, sleeping.id, now - 100 * DAY, now - 91 * DAY);
  assert.deepEqual(listSessions(db, a.id, now).map((x) => x.name), ['Nieuw'], 'alleen geldige sessies in de lijst');
  assert.equal(findSession(db, idle.token, now), null);
  assert.equal(findSession(db, old.token, now), null);
  assert.ok(findSession(db, fresh.token, now));
  assert.ok((db.prepare('SELECT revoked_at FROM sessions WHERE id = ?').get(idle.id) as any).revoked_at, 'bij gebruik meteen ingetrokken');
  assert.equal(sessionValid(db, a.id, sleeping.id, now), false);
  assert.equal(sessionValid(db, a.id, fresh.id, now), true);
  assert.equal(sessionValid(db, 'iemand-anders', fresh.id, now), false, 'alleen voor de eigen gebruiker');
  // met andere grenzen geldt de slapende sessie wel weer
  assert.ok(findSession(db, sleeping.token, now, { idleDays: 0, maxDays: 0 }), 'zonder grenzen geldig');
  setTimes(db, sleeping.id, now - 100 * DAY, now - 91 * DAY);
  assert.equal(pruneSessions(db, DEFAULT_SESSION_POLICY, now), 1, 'opruimen trekt de nog niet gebruikte, verlopen sessie in');
  assert.equal(pruneSessions(db, DEFAULT_SESSION_POLICY, now), 0, 'en daarna niets meer');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as any).n, 4, 'ingetrokken sessies blijven nog even bewaard');
  assert.equal(pruneSessions(db, DEFAULT_SESSION_POLICY, now + 91 * DAY), 1, 'drie maanden later is ook de nieuwe sessie verlopen');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as any).n, 1, 'na 30 dagen ingetrokken: weg; alleen de zojuist ingetrokken blijft');
  assert.equal(pruneSessions(db, { idleDays: 0, maxDays: 0 }, now + 400 * DAY), 0, 'zonder grenzen verloopt niets');
});

test('het soort apparaat uit de User-Agent: vaste namen, geen versienummers', () => {
  const cases: [string, ReturnType<typeof describeUserAgent>][] = [
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36', { kind: 'browser', browser: 'Chrome', os: 'Windows' }],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0', { kind: 'browser', browser: 'Edge', os: 'Windows' }],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0', { kind: 'browser', browser: 'Firefox', os: 'Linux' }],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', { kind: 'browser', browser: 'Safari', os: 'iOS' }],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15', { kind: 'browser', browser: 'Safari', os: 'macOS' }],
    ['Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/27.0 Chrome/125.0.0.0 Mobile Safari/537.36', { kind: 'browser', browser: 'Samsung Internet', os: 'Android' }],
    ['Mozilla/5.0 (Linux; Android 15; Pixel 9 Build/AP3A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/140.0.0.0 Mobile Safari/537.36', { kind: 'app', browser: null, os: 'Android' }],
    ['Tickory-Android/0.2.0', { kind: 'app', browser: null, os: 'Android' }],
    ['curl/8.0.1', { kind: 'other', browser: null, os: null }],
    ['', { kind: 'other', browser: null, os: null }],
  ];
  for (const [ua, expected] of cases) assert.deepEqual(describeUserAgent(ua), expected, ua);
  assert.deepEqual(describeUserAgent(undefined), { kind: 'other', browser: null, os: null });
  const all = JSON.stringify(cases.map(([ua]) => describeUserAgent(ua)));
  assert.ok(!/\d/.test(all), 'geen cijfers (versies, toestelnummers) in wat bewaard wordt');
});

async function server(policy = DEFAULT_SESSION_POLICY) {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const alice = mk(db, 'alice');
  const bob = mk(db, 'bob');
  const clock = { now: Date.now() };
  const app = createApp({ db, clock: () => clock.now, sessionPolicy: policy, backup: null, sessionSweepMs: 0 });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const call = async (path: string, token: string, body?: unknown) => {
    const r = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, body: await r.json() as any };
  };
  return { db, app, base, clock, alice, bob, call };
}

test('HTTP: een verlopen sessie geeft 401 op elk eindpunt; de lijst toont soort, aangemaakt, laatst gebruikt, "dit apparaat" en de grenzen', async () => {
  const w = await server({ idleDays: 30, maxDays: 0 });
  try {
    const firefox = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0';
    const mine = createSession(w.db, w.alice.id, 'Laptop', describeUserAgent(firefox));
    const phone = createSession(w.db, w.alice.id, 'Telefoon', describeUserAgent('Mozilla/5.0 (Linux; Android 15; wv) Chrome/140.0.0.0 Mobile'));
    const list = await w.call('/api/v1/auth/sessions', mine.token);
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.policy, { idle_days: 30, max_days: 0 });
    const byName = Object.fromEntries(list.body.sessions.map((s: any) => [s.name, s]));
    assert.deepEqual(byName.Laptop.device, { kind: 'browser', browser: 'Firefox', os: 'Windows' });
    assert.deepEqual(byName.Telefoon.device, { kind: 'app', browser: null, os: 'Android' });
    assert.equal(byName.Laptop.current, true);
    assert.equal(byName.Telefoon.current, false);
    assert.ok(byName.Laptop.created_at && byName.Laptop.last_used_at);
    assert.ok(!JSON.stringify(list.body).includes('token'), 'geen tokens of hashes in de lijst');
    // de telefoon blijft 31 dagen liggen
    w.clock.now += 31 * 86_400_000;
    w.db.prepare('UPDATE sessions SET last_used_at = ? WHERE id = ?').run(new Date(w.clock.now).toISOString(), mine.id);
    for (const path of ['/api/v1/auth/me', '/api/v1/auth/sessions', '/api/v1/events']) assert.equal((await w.call(path, phone.token)).status, 401, path);
    assert.equal((await w.call('/api/v1/sync', phone.token, { commands: [] })).status, 401);
    assert.equal((await w.call('/api/v1/auth/me', mine.token)).status, 200, 'de laptop is wel gebruikt');
    assert.deepEqual((await w.call('/api/v1/auth/sessions', mine.token)).body.sessions.map((s: any) => s.name), ['Laptop']);
  } finally { await w.app.close(); }
});

test('HTTP: "alle andere afmelden" trekt alle andere sessies van jezelf in, niet die van een ander, en sluit hun live-verbinding', async () => {
  const w = await server();
  try {
    const a1 = createSession(w.db, w.alice.id, 'Een');
    const a2 = createSession(w.db, w.alice.id, 'Twee');
    const a3 = createSession(w.db, w.alice.id, 'Drie');
    const b1 = createSession(w.db, w.bob.id, 'Bob');
    const stream = await fetch(`${w.base}/api/v1/events`, { headers: { Authorization: `Bearer ${a2.token}` } });
    assert.equal(stream.status, 200);
    const reader = stream.body!.getReader();
    await reader.read(); // hello
    const out = await w.call('/api/v1/auth/sessions/revoke-others', a1.token, {});
    assert.equal(out.status, 200);
    assert.equal(out.body.revoked, 2);
    const ended = await Promise.race([reader.read().then((x) => x.done), new Promise((r) => setTimeout(() => r('open'), 2000))]);
    assert.equal(ended, true, 'de live-verbinding van een ander apparaat is gesloten');
    assert.equal((await w.call('/api/v1/auth/me', a1.token)).status, 200, 'dit apparaat blijft aangemeld');
    assert.equal((await w.call('/api/v1/auth/me', a2.token)).status, 401);
    assert.equal((await w.call('/api/v1/auth/me', a3.token)).status, 401);
    assert.equal((await w.call('/api/v1/auth/me', b1.token)).status, 200, 'bob merkt er niets van');
    assert.equal((await w.call('/api/v1/auth/sessions/revoke-others', a1.token)).status, 405, 'alleen POST');
    // per stuk intrekken kan alleen een eigen sessie
    assert.equal((await w.call('/api/v1/auth/sessions/revoke', b1.token, { id: a1.id })).status, 404);
  } finally { await w.app.close(); }
});

test('instellingen uit de omgeving: SESSION_IDLE_DAYS en SESSION_MAX_DAYS, 0 = uit, ongeldig = standaard', () => {
  assert.deepEqual(sessionPolicyFrom({}), { idleDays: 90, maxDays: 365 });
  assert.deepEqual(sessionPolicyFrom({ SESSION_IDLE_DAYS: '30', SESSION_MAX_DAYS: '0' }), { idleDays: 30, maxDays: 0 });
  const warn = console.warn;
  console.warn = () => {};
  try {
    for (const bad of ['-1', '1.5', 'veel', '1e9']) assert.equal(daysFrom({ X: bad }, 'X', 7), 7, bad);
  } finally { console.warn = warn; }
  assert.equal(daysFrom({ X: ' ' }, 'X', 7), 7);
  assert.equal(daysFrom({ X: '0' }, 'X', 7), 0);
});

test('het sleutelbestand: wordt eenmalig gemaakt (alleen voor de eigenaar), daarna gelezen; een ongeldig bestand geeft een fout', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tickory-key-test-'));
  try {
    const path = join(dir, 'sub', 'secret.key');
    const key = loadSecretKey(path);
    assert.equal(key.length, 32);
    assert.deepEqual(loadSecretKey(path), key, 'dezelfde sleutel na een herstart');
    if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.match(readFileSync(path, 'utf8'), /^[\w-]{43}\n$/);
    writeFileSync(path, 'te kort\n');
    assert.throws(() => loadSecretKey(path), /geen geldige sleutel/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('migratie: een database van vóór versie 8 krijgt het soort apparaat, de kolommen voor 2FA en de tabel met herstelcodes', () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const a = mk(db, 'alice');
  const s = createSession(db, a.id, 'Oud apparaat');
  db.exec('ALTER TABLE sessions DROP COLUMN device; DROP TABLE recovery_codes');
  for (const col of ['totp_secret', 'totp_enabled_at', 'totp_last_step', 'totp_pending', 'totp_pending_at']) db.exec(`ALTER TABLE users DROP COLUMN ${col}`);
  db.prepare("UPDATE meta SET value = '6' WHERE key = 'schema_version'").run();
  createSchema(db);
  createSchema(db); // twee keer: niets dubbel
  assert.equal((db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as any).value, String(SCHEMA_VERSION));
  assert.equal(SCHEMA_VERSION, 8);
  const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
  assert.ok(cols('sessions').includes('device'));
  for (const c of ['totp_secret', 'totp_enabled_at', 'totp_last_step', 'totp_pending', 'totp_pending_at']) assert.ok(cols('users').includes(c), c);
  assert.ok(cols('recovery_codes').includes('code_hash'));
  // de oude sessie werkt nog, met een onbekend soort apparaat
  assert.ok(findSession(db, s.token));
  assert.deepEqual(listSessions(db, a.id)[0].device, { kind: 'other', browser: null, os: null });
});
