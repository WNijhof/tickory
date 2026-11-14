// Verbinden: het adres en de regel voor http, de manieren van inloggen, de koppelcode (gelijk aan de server), en de hele weg tegen
// een echte server (server/main.ts in dit proces): inloggen met wachtwoord, de tweede stap, een koppelcode uit de web-app, de lijst
// met projecten, een taak toevoegen (opnieuw proberen geeft geen dubbele), uitloggen. Elk verzoek gaat alleen naar die ene server.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../../server/main.ts';
import { createSchema } from '../../server/schema.ts';
import { handleSync } from '../../server/sync.ts';
import { LoginLimiter, createUser, hashPassword, setPasswordCostForTests } from '../../server/users.ts';
import { normalizePairCode, newPairCode } from '../../server/pairing.ts';
import { parseQuickAdd } from '../../client/core/quickadd.js';
import { createClient, LIST_RESOURCES, TickoryError } from './api.js';
import { browserName, checkAddress, connectionFrom, deviceName, loginOptions, pairCodeInput } from './connect.js';
import { errorText } from './errors.js';
import { messageFormatter } from './i18n.js';
import { buildCommands, listsFromSync, newAttempt, outcomeOf, projectOptions, readTitle } from './model.js';

const nl = messageFormatter(JSON.parse(readFileSync(new URL('../_locales/nl/messages.json', import.meta.url), 'utf8')));
setPasswordCostForTests(1024);
const PW = 'een-goed-wachtwoord';

test('het adres: ongeldig, onveilig of goed, met het patroon voor de toestemming', () => {
  assert.deepEqual(checkAddress(''), { ok: false, code: 'EMPTY' });
  assert.deepEqual(checkAddress('ftp://a.nl'), { ok: false, code: 'SCHEME' });
  assert.deepEqual(checkAddress('https://anna@a.nl'), { ok: false, code: 'CREDENTIALS' });
  assert.deepEqual(checkAddress('https://a..nl'), { ok: false, code: 'INVALID' });
  assert.deepEqual(checkAddress('http://taken.voorbeeld.nl'), { ok: false, code: 'INSECURE' });
  assert.deepEqual(checkAddress('http://203.0.113.9:8787'), { ok: false, code: 'INSECURE' });
  const lan = checkAddress('http://192.168.1.10:8787/app');
  assert.equal(lan.ok, true);
  assert.equal(lan.address.origin, 'http://192.168.1.10:8787');
  assert.equal(lan.pattern, 'http://192.168.1.10/*');
  assert.equal(checkAddress('taken.voorbeeld.nl').pattern, 'https://taken.voorbeeld.nl/*');
  assert.equal(checkAddress('http://localhost:8787').ok, true);
});

test('de manieren van inloggen, de naam in de apparatenlijst en de browser', () => {
  assert.deepEqual(loginOptions({ password: true, sso: null }), { password: true, pairCode: true, sso: null });
  assert.deepEqual(loginOptions({ password: false, sso: { name: 'Pocket ID' } }), { password: false, pairCode: true, sso: 'Pocket ID' });
  assert.deepEqual(loginOptions(null), { password: false, pairCode: true, sso: null });
  assert.equal(deviceName('Firefox', nl), 'Browserextensie (Firefox)');
  assert.equal(browserName({ extensionUrl: 'moz-extension://abc/', userAgent: 'Mozilla/5.0 Firefox/150.0' }), 'Firefox');
  assert.equal(browserName({ extensionUrl: 'chrome-extension://abc/', userAgent: 'Mozilla/5.0 Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0' }), 'Edge');
  assert.equal(browserName({ extensionUrl: 'chrome-extension://abc/', userAgent: 'Mozilla/5.0 Chrome/150.0.0.0 Safari/537.36 OPR/120.0' }), 'Opera');
  assert.equal(browserName({ extensionUrl: 'chrome-extension://abc/', userAgent: 'Mozilla/5.0 Chrome/150.0.0.0 Safari/537.36 Vivaldi/7.0' }), 'Vivaldi');
  assert.equal(browserName({ extensionUrl: 'chrome-extension://abc/', userAgent: 'Mozilla/5.0 Chrome/150.0.0.0 Safari/537.36' }), 'Chrome');
  assert.equal(browserName(), 'Chrome');
});

test('een koppelcode lezen zoals de server: vergevingsgezind, en een tikfout meteen gezien', () => {
  for (let i = 0; i < 50; i++) {
    const code = newPairCode();
    for (const typed of [code, code.toLowerCase(), code.replace(/-/g, ''), ` ${code.replace(/-/g, ' ')} `]) {
      assert.equal(pairCodeInput(typed), code, typed);
      assert.equal(normalizePairCode(pairCodeInput(typed)), normalizePairCode(code), 'de server leest hetzelfde');
    }
  }
  for (const s of ['O0IL-1111-1111-1111', 'abcd efgh jkmn pqrs', 'ABCD-EFGH-JKMN-PQR', 'ABCD-EFGH-JKMN-PQRU', 'ABCD_EFGH_JKMN_PQRS', 'ABCD-EFGH-JKMN-PQRST', '', 'x'.repeat(70)]) {
    const mine = pairCodeInput(s);
    const server = normalizePairCode(s);
    assert.equal(mine === null, server === null, s);
    if (mine) assert.equal(mine.replace(/-/g, ''), server);
  }
  assert.equal(pairCodeInput(null), null);
});

test('wat er na het inloggen bewaard wordt, en een antwoord dat niet klopt', () => {
  const { address } = checkAddress('https://taken.voorbeeld.nl');
  const token = `tky_${'a'.repeat(43)}`;
  assert.deepEqual(connectionFrom({ token, session_id: 's1', me: { id: 'u1', username: 'anna', name: 'Anna' } }, address, 'Chrome'), {
    origin: 'https://taken.voorbeeld.nl', pattern: 'https://taken.voorbeeld.nl/*', token, sessionId: 's1', user: { id: 'u1', username: 'anna', name: 'Anna' }, browser: 'Chrome',
  });
  for (const bad of [null, {}, { token: 'geen-token', me: { id: 'u1' } }, { token, me: null }, { token: `tky_${'a'.repeat(10)}`, me: { id: 'u1' } }, { token: `tky_${'a'.repeat(43)}"`, me: { id: 'u1' } }]) {
    assert.throws(() => connectionFrom(bad, address, 'Chrome'), (e) => e.code === 'NOT_TICKORY');
  }
});

/** Een eigen TOTP (RFC 6238), los van server/totp.ts. */
function totp(secretB32, ms) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secretB32) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(ms / 30_000)));
  const mac = createHmac('sha1', key).update(counter).digest();
  const o = mac[19] & 15;
  return String((mac.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

async function realServer() {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const hash = await hashPassword(PW);
  const anna = createUser(db, { username: 'anna', name: 'Anna', passwordHash: hash });
  const bob = createUser(db, { username: 'bob', name: 'Bob', passwordHash: hash });
  const clock = { now: Date.parse('2026-11-14T10:00:10Z') };
  const loose = () => new LoginLimiter({ pair: 500, ip: 5000, user: 5000 }, 900_000, () => clock.now);
  const app = createApp({ db, clock: () => clock.now, log: () => {}, secretKey: randomBytes(32), backup: null, sessionSweepMs: 0, limiter: loose(), passwordLimiter: loose(), codeLimiter: loose(), pairLimiter: loose() });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  // elk verzoek van de extensie gaat via deze fetch: zo zien we waar het heen gaat
  const seen = [];
  const fetchSpy = (url, init) => {
    seen.push({ url: String(url), init });
    return fetch(url, init);
  };
  return { db, anna, bob, clock, app, origin, seen, fetchSpy };
}

test('de hele weg tegen een echte server: wachtwoord met tweede stap, lijsten, opslaan (twee keer versturen = één taak), uitloggen', async () => {
  const s = await realServer();
  try {
    const check = checkAddress(s.origin);
    assert.equal(check.ok, true);
    const client = createClient({ origin: check.address.origin, fetch: s.fetchSpy });
    assert.deepEqual(loginOptions(await client.methods()), { password: true, pairCode: true, sso: null });
    await assert.rejects(client.login('anna', 'fout-wachtwoord', 'x'), (e) => e instanceof TickoryError && e.code === 'INVALID_CREDENTIALS' && errorText(e, nl) === 'Gebruikersnaam of wachtwoord klopt niet.');

    // tweestapsverificatie aanzetten (als Anna in de web-app), daarna loopt de klok een tijdvak door
    const web = (await (await fetch(`${s.origin}/api/v1/auth/login`, { method: 'POST', body: JSON.stringify({ username: 'anna', password: PW }) })).json()).token;
    const post = (path, body, token) => fetch(`${s.origin}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body) }).then((r) => r.json());
    const { secret } = await post('/api/v1/auth/2fa/setup', { password: PW }, web);
    await post('/api/v1/auth/2fa/enable', { code: totp(secret, s.clock.now) }, web);
    s.clock.now += 30_000;

    const first = await client.login('anna', PW, deviceName('Chrome', nl));
    assert.equal(first.two_factor_required, true);
    await assert.rejects(client.loginCode(first.challenge, '000000'), (e) => e.code === 'INVALID_CODE');
    const done = await client.loginCode(first.challenge, totp(secret, s.clock.now));
    const conn = connectionFrom(done, check.address, 'Chrome');
    assert.equal(conn.user.username, 'anna');

    const authed = createClient({ origin: conn.origin, token: conn.token, fetch: s.fetchSpy });
    const lists = listsFromSync(await authed.lists());
    assert.deepEqual(projectOptions(lists).map((o) => o.name), ['Inbox']);
    const parsed = readTitle('Artikel over koffie morgen p2', { parse: parseQuickAdd, lists, prefilled: 'Artikel over koffie', defaultProjectId: lists.inboxId });
    const commands = buildCommands(parsed, { description: 'https://koffie.example/artikel', attempt: newAttempt(), autoReminder: lists.autoReminder });
    assert.deepEqual(outcomeOf(commands, await authed.send(commands)), { ok: true, warning: null });
    assert.deepEqual(outcomeOf(commands, await authed.send(commands)), { ok: true, warning: null }, 'opnieuw versturen (antwoord gemist)');
    const tasks = handleSync(s.db, { sync_token: '*' }, s.anna.id).tasks;
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].content, 'Artikel over koffie');
    assert.equal(tasks[0].priority, 2);
    assert.equal(tasks[0].description, 'https://koffie.example/artikel');

    // de apparatenlijst toont de extensie (de naam die ze meestuurde)
    const sessions = await (await fetch(`${s.origin}/api/v1/auth/sessions`, { headers: { Authorization: `Bearer ${web}` } })).json();
    assert.ok(sessions.sessions.some((x) => x.name === 'Browserextensie (Chrome)'));

    await authed.logout();
    await assert.rejects(authed.lists(), (e) => e.code === 'UNAUTHORIZED' && errorText(e, nl).includes('Verbind opnieuw'));

    // alleen verzoeken naar die ene server, het token alleen in de kop, nooit in een adres, nooit cookies
    assert.ok(s.seen.length >= 8);
    for (const r of s.seen) {
      assert.ok(r.url.startsWith(`${s.origin}/api/v1/`), r.url);
      assert.ok(!r.url.includes('tky_'), 'geen token in het adres');
      assert.equal(r.init.credentials, 'omit');
      assert.equal(r.init.redirect, 'error');
    }
    const syncBodies = s.seen.filter((r) => r.url.endsWith('/api/v1/sync')).map((r) => JSON.parse(r.init.body));
    assert.deepEqual(syncBodies[0].resource_types, LIST_RESOURCES, 'geen volledige sync: alleen wat de keuzelijst nodig heeft');
    assert.ok(syncBodies.every((b) => !b.resource_types.includes('all') && !b.resource_types.includes('tasks')));
  } finally {
    await s.app.close();
  }
});

test('de hele weg met een koppelcode uit de web-app, ook met de code in kleine letters', async () => {
  const s = await realServer();
  try {
    const web = (await (await fetch(`${s.origin}/api/v1/auth/login`, { method: 'POST', body: JSON.stringify({ username: 'bob', password: PW }) })).json()).token;
    const made = await (await fetch(`${s.origin}/api/v1/auth/pair-code`, { method: 'POST', headers: { Authorization: `Bearer ${web}` }, body: JSON.stringify({ password: PW }) })).json();
    const client = createClient({ origin: s.origin, fetch: s.fetchSpy });
    await assert.rejects(client.pair(newPairCode(), 'x'), (e) => e.code === 'CODE_INVALID' && /koppelcode/.test(errorText(e, nl)));
    const res = await client.pair(pairCodeInput(made.code.toLowerCase()), deviceName('Firefox', nl));
    const conn = connectionFrom(res, checkAddress(s.origin).address, 'Firefox');
    assert.equal(conn.user.username, 'bob');
    await assert.rejects(client.pair(pairCodeInput(made.code), 'x'), (e) => e.code === 'CODE_INVALID', 'eenmalig');
    const lists = listsFromSync(await createClient({ origin: s.origin, token: conn.token, fetch: s.fetchSpy }).lists());
    assert.equal(lists.user.username, 'bob');
  } finally {
    await s.app.close();
  }
});

test('fouten van de verbinding: geen server, geen Tickory, een foutpagina van een proxy, te laat', async () => {
  const offline = createClient({ origin: 'http://127.0.0.1:9', fetch: () => Promise.reject(new TypeError('Failed to fetch')) });
  await assert.rejects(offline.methods(), (e) => e.code === 'OFFLINE');
  const html = (status) => async () => new Response('<html>hallo</html>', { status, headers: { 'Content-Type': 'text/html' } });
  await assert.rejects(createClient({ origin: 'https://a.nl', fetch: html(200) }).methods(), (e) => e.code === 'NOT_TICKORY');
  await assert.rejects(createClient({ origin: 'https://a.nl', fetch: html(404) }).methods(), (e) => e.code === 'NOT_TICKORY');
  await assert.rejects(createClient({ origin: 'https://a.nl', fetch: html(502) }).methods(), (e) => e.code === 'HTTP_502' && e.status === 502);
  const json = (body) => async () => Response.json(body);
  await assert.rejects(createClient({ origin: 'https://a.nl', fetch: json({ hallo: true }) }).methods(), (e) => e.code === 'NOT_TICKORY', 'JSON, maar geen Tickory');
  await assert.rejects(createClient({ origin: 'https://a.nl', fetch: json([1]) }).lists(), (e) => e.code === 'NOT_TICKORY');
  const tooMany = async () => Response.json({ error_code: 'TOO_MANY_ATTEMPTS', error: 'te veel' }, { status: 429, headers: { 'Retry-After': '300' } });
  await assert.rejects(createClient({ origin: 'https://a.nl', fetch: tooMany }).login('a', 'b', 'c'), (e) => e.code === 'TOO_MANY_ATTEMPTS' && e.retryAfter === 300 && errorText(e, nl) === 'Te veel pogingen. Probeer het over 5 minuten opnieuw.');
  // een server die niet antwoordt: na de tijdslimiet afgebroken
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('afgebroken', 'AbortError'))));
  await assert.rejects(createClient({ origin: 'https://a.nl', fetch: hang, timeoutMs: 30 }).methods(), (e) => e.code === 'TIMEOUT');
});
