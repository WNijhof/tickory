// Tweestapsverificatie over HTTP: aanzetten (wachtwoord, geheim, bevestigen), inloggen in twee stappen, het tussentoken,
// hergebruik van een code, herstelcodes, de beperking op codes, uitzetten, nieuwe herstelcodes, en wat een beheerder mag.
// Elke test heeft een eigen server met een eigen klok. De codes rekent de test zelf uit (met node:crypto, los van totp.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp } from './main.ts';
import { createSchema, SCHEMA_VERSION } from './schema.ts';
import { DatabaseSync } from 'node:sqlite';
import { LoginLimiter, createUser, hashPassword, setPasswordCostForTests } from './users.ts';

setPasswordCostForTests(1024);
const PW = 'een-goed-wachtwoord';
const T0 = Date.parse('2026-11-14T10:00:10Z'); // 10 seconden in een tijdvak

/** Een eigen TOTP (RFC 6238, SHA-1, 6 cijfers), om niet met de code van de server zelf te controleren. */
function code(secretB32: string, ms: number, offsetSteps = 0): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secretB32) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(ms / 30_000) + offsetSteps));
  const mac = createHmac('sha1', key).update(counter).digest();
  const o = mac[19] & 15;
  return String((mac.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

async function world() {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const alice = createUser(db, { username: 'alice', name: 'Alice', passwordHash: await hashPassword(PW) }); // beheerder
  const bob = createUser(db, { username: 'bob', name: 'Bob', passwordHash: await hashPassword(PW) });
  const clock = { now: T0 };
  const lines: string[] = [];
  const secretKey = randomBytes(32);
  const app = createApp({
    db, clock: () => clock.now, log: (l) => lines.push(l), secretKey, backup: null, sessionSweepMs: 0,
    limiter: new LoginLimiter({ pair: 50, ip: 500, user: 500 }, 900_000, () => clock.now),
    passwordLimiter: new LoginLimiter({ pair: 50, ip: 500, user: 500 }, 900_000, () => clock.now),
    codeLimiter: new LoginLimiter({ pair: 5, ip: 20, user: 10 }, 900_000, () => clock.now),
  });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const call = async (path: string, body?: unknown, token?: string) => {
    const r = await fetch(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: r.status, body: await r.json() as any };
  };
  const login = (username: string, password = PW) => call('/api/v1/auth/login', { username, password, device_name: 'Test' });
  const tokenOf = async (u: string) => (await login(u)).body.token as string;
  /** Zet 2FA aan voor `u` en geeft het geheim en de herstelcodes; daarna loopt de klok een tijdvak door. */
  const enable = async (token: string) => {
    const setup = await call('/api/v1/auth/2fa/setup', { password: PW }, token);
    assert.equal(setup.status, 200);
    const done = await call('/api/v1/auth/2fa/enable', { code: code(setup.body.secret, clock.now) }, token);
    assert.equal(done.status, 200, JSON.stringify(done.body));
    clock.now += 30_000;
    return { secret: setup.body.secret as string, recovery: done.body.recovery_codes as string[] };
  };
  return { db, app, base, clock, lines, secretKey, alice, bob, call, login, tokenOf, enable, close: () => app.close() };
}

test('aanzetten: eerst het wachtwoord, dan een geheim met otpauth-adres, dan bevestigen met een code; daarna tien herstelcodes', async () => {
  const w = await world();
  try {
    const token = await w.tokenOf('alice');
    assert.deepEqual((await w.call('/api/v1/auth/2fa', undefined, token)).body, { enabled: false, enabled_at: null, recovery_codes_left: 0 });
    assert.equal((await w.call('/api/v1/auth/2fa/setup', { password: 'verkeerd-wachtwoord' }, token)).status, 403, 'fout wachtwoord');
    assert.equal((await w.call('/api/v1/auth/2fa/setup', {}, token)).status, 403, 'geen wachtwoord');
    assert.equal((await w.call('/api/v1/auth/2fa/setup', { password: PW })).status, 401, 'niet aangemeld');
    const setup = await w.call('/api/v1/auth/2fa/setup', { password: PW }, token);
    assert.equal(setup.status, 200);
    assert.match(setup.body.secret, /^[A-Z2-7]{32}$/);
    assert.equal(setup.body.uri, `otpauth://totp/Tickory:alice?secret=${setup.body.secret}&issuer=Tickory&algorithm=SHA1&digits=6&period=30`);
    // nog niet aan: inloggen gaat nog zonder code
    assert.ok((await w.login('alice')).body.token);
    assert.equal((await w.call('/api/v1/auth/2fa/enable', { code: '000000' === code(setup.body.secret, w.clock.now) ? '111111' : '000000' }, token)).status, 403, 'foute code');
    assert.equal((await w.call('/api/v1/auth/2fa/enable', { code: 'abc' }, token)).status, 403);
    const ok = await w.call('/api/v1/auth/2fa/enable', { code: code(setup.body.secret, w.clock.now) }, token);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.enabled, true);
    assert.equal(ok.body.recovery_codes.length, 10);
    assert.equal(ok.body.recovery_codes_left, 10);
    assert.equal((await w.call('/api/v1/auth/2fa/setup', { password: PW }, token)).status, 409, 'staat al aan');
    assert.ok(w.lines.some((l) => l.includes('tweestapsverificatie aangezet door "alice"')));
    // het geheim en de herstelcodes staan niet leesbaar in de database of in de logregels
    const dump = JSON.stringify([w.db.prepare('SELECT * FROM users').all(), w.db.prepare('SELECT * FROM recovery_codes').all()]);
    assert.ok(!dump.includes(setup.body.secret), 'geheim niet leesbaar in de database');
    for (const c of ok.body.recovery_codes) assert.ok(!dump.includes(c) && !dump.includes(c.replace('-', '')), 'herstelcode niet leesbaar in de database');
    assert.ok(!w.lines.join('\n').includes(setup.body.secret));
    assert.equal(Number((w.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as any).value), SCHEMA_VERSION);
  } finally { await w.close(); }
});

test('een nieuw geheim moet binnen een kwartier worden bevestigd; een nieuwe poging vervangt het vorige', async () => {
  const w = await world();
  try {
    const token = await w.tokenOf('alice');
    const first = (await w.call('/api/v1/auth/2fa/setup', { password: PW }, token)).body.secret;
    const second = (await w.call('/api/v1/auth/2fa/setup', { password: PW }, token)).body.secret;
    assert.notEqual(first, second);
    assert.equal((await w.call('/api/v1/auth/2fa/enable', { code: code(first, w.clock.now) }, token)).status, 403, 'het vorige geheim geldt niet meer');
    w.clock.now += 16 * 60_000;
    const late = await w.call('/api/v1/auth/2fa/enable', { code: code(second, w.clock.now) }, token);
    assert.equal(late.status, 409, 'te laat: opnieuw beginnen');
    assert.equal((await w.call('/api/v1/auth/2fa', undefined, token)).body.enabled, false);
  } finally { await w.close(); }
});

test('inloggen in twee stappen: het wachtwoord geeft alleen een tussentoken, de code geeft de sessie', async () => {
  const w = await world();
  try {
    const { secret } = await w.enable(await w.tokenOf('alice'));
    const first = await w.login('alice');
    assert.equal(first.status, 200);
    assert.equal(first.body.two_factor_required, true);
    assert.equal(first.body.token, undefined, 'nog geen sessie');
    assert.match(first.body.challenge, /^tkc_/);
    // het tussentoken is geen sessie
    assert.equal((await w.call('/api/v1/auth/me', undefined, first.body.challenge)).status, 401);
    assert.equal((await w.call('/api/v1/sync', { commands: [] }, first.body.challenge)).status, 401);
    // fout wachtwoord: gewoon de bekende melding, geen tussentoken
    const wrong = await w.login('alice', 'verkeerd-wachtwoord');
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.challenge, undefined);
    const bad = await w.call('/api/v1/auth/login/2fa', { challenge: first.body.challenge, code: code(secret, w.clock.now, 5) });
    assert.equal(bad.status, 401);
    assert.equal(bad.body.error_code, 'INVALID_CODE');
    const good = await w.call('/api/v1/auth/login/2fa', { challenge: first.body.challenge, code: code(secret, w.clock.now) });
    assert.equal(good.status, 200);
    assert.match(good.body.token, /^tky_/);
    assert.equal(good.body.me.username, 'alice');
    assert.equal((await w.call('/api/v1/auth/me', undefined, good.body.token)).status, 200);
    // het tussentoken is daarna verbruikt
    assert.equal((await w.call('/api/v1/auth/login/2fa', { challenge: first.body.challenge, code: code(secret, w.clock.now, 1) })).body.error_code, 'CHALLENGE_EXPIRED');
    assert.equal((await w.call('/api/v1/auth/login/2fa', { challenge: 'tkc_verzonnen', code: '123456' })).body.error_code, 'CHALLENGE_EXPIRED');
    // bob heeft geen 2FA: inloggen gaat als altijd
    assert.ok((await w.login('bob')).body.token);
  } finally { await w.close(); }
});

test('hergebruik en tijdvenster: dezelfde code geldt maar één keer, een oudere code na een nieuwere niet; één tijdvak ernaast mag', async () => {
  const w = await world();
  try {
    const { secret } = await w.enable(await w.tokenOf('alice'));
    const second = async (c: string) => w.call('/api/v1/auth/login/2fa', { challenge: (await w.login('alice')).body.challenge, code: c });
    // de code waarmee is bevestigd (een tijdvak terug) geldt niet meer: dat tijdvak is gebruikt
    assert.equal((await second(code(secret, w.clock.now, -1))).status, 401, 'de bevestigingscode nog een keer');
    const now = code(secret, w.clock.now);
    assert.equal((await second(now)).status, 200);
    assert.equal((await second(now)).status, 401, 'dezelfde code direct opnieuw (bijvoorbeeld afgekeken)');
    assert.equal((await second(code(secret, w.clock.now, 1))).status, 200, 'het volgende tijdvak (klok van de telefoon loopt voor) mag');
    assert.equal((await second(code(secret, w.clock.now))).status, 401, 'en daarna niet meer een eerder tijdvak');
    w.clock.now += 60_000;
    assert.equal((await second(code(secret, w.clock.now, 2))).status, 401, 'twee tijdvakken vooruit: te ver');
    assert.equal((await second(code(secret, w.clock.now, -1))).status, 401, 'één terug, maar dat tijdvak is al gebruikt');
    w.clock.now += 90_000;
    assert.equal((await second(code(secret, w.clock.now, -1))).status, 200, 'een tijdvak terug (klok loopt achter) mag');
    assert.equal((await second(code(secret, w.clock.now, -2))).status, 401, 'twee terug niet');
  } finally { await w.close(); }
});

test('herstelcodes: elk één keer bruikbaar, in hoofdletters of met spaties; nieuwe maken laat de oude vervallen', async () => {
  const w = await world();
  try {
    const token = await w.tokenOf('alice');
    const { secret, recovery } = await w.enable(token);
    const second = async (c: string) => w.call('/api/v1/auth/login/2fa', { challenge: (await w.login('alice')).body.challenge, code: c });
    const used = await second(recovery[0].toUpperCase().replace('-', ' '));
    assert.equal(used.status, 200);
    assert.equal(used.body.recovery_code_used, true);
    assert.equal(used.body.recovery_codes_left, 9);
    assert.equal((await second(recovery[0])).status, 401, 'dezelfde herstelcode nog een keer');
    assert.equal((await w.call('/api/v1/auth/2fa', undefined, token)).body.recovery_codes_left, 9);
    // nieuwe herstelcodes: wachtwoord en code nodig
    assert.equal((await w.call('/api/v1/auth/2fa/recovery-codes', { password: PW }, token)).status, 403, 'zonder code');
    assert.equal((await w.call('/api/v1/auth/2fa/recovery-codes', { password: 'fout-wachtwoord', code: code(secret, w.clock.now) }, token)).status, 403, 'fout wachtwoord');
    const fresh = await w.call('/api/v1/auth/2fa/recovery-codes', { password: PW, code: code(secret, w.clock.now) }, token);
    assert.equal(fresh.status, 200);
    assert.equal(fresh.body.recovery_codes.length, 10);
    assert.equal(fresh.body.recovery_codes_left, 10);
    assert.equal((await second(recovery[1])).status, 401, 'een oude herstelcode geldt niet meer');
    assert.equal((await second(fresh.body.recovery_codes[3])).status, 200);
    assert.ok(w.lines.some((l) => l.includes('nieuwe herstelcodes gemaakt door "alice"')));
  } finally { await w.close(); }
});

test('beperking: een tussentoken geeft vijf pogingen; per naam en adres hooguit vijf foute codes per kwartier', async () => {
  const w = await world();
  try {
    const { secret } = await w.enable(await w.tokenOf('alice'));
    const wrongCode = (c: string) => (c === '000000' ? '000001' : '000000');
    const ch = (await w.login('alice')).body.challenge;
    for (let i = 0; i < 4; i++) assert.equal((await w.call('/api/v1/auth/login/2fa', { challenge: ch, code: wrongCode(code(secret, w.clock.now)) })).body.error_code, 'INVALID_CODE');
    assert.equal((await w.call('/api/v1/auth/login/2fa', { challenge: ch, code: 'geen-code' })).body.error_code, 'INVALID_CODE', 'vijfde poging');
    assert.equal((await w.call('/api/v1/auth/login/2fa', { challenge: ch, code: code(secret, w.clock.now) })).body.error_code, 'CHALLENGE_EXPIRED', 'na vijf pogingen: eerst opnieuw het wachtwoord');
    // ook met een nieuw tussentoken: de teller per naam en adres staat op vijf
    const again = await w.call('/api/v1/auth/login/2fa', { challenge: (await w.login('alice')).body.challenge, code: code(secret, w.clock.now) });
    assert.equal(again.status, 429);
    assert.equal(again.body.error_code, 'TOO_MANY_ATTEMPTS');
    w.clock.now += 16 * 60_000; // het venster loopt af
    const later = await w.call('/api/v1/auth/login/2fa', { challenge: (await w.login('alice')).body.challenge, code: code(secret, w.clock.now) });
    assert.equal(later.status, 200);
  } finally { await w.close(); }
});

test('het tussentoken verloopt na vijf minuten, en geldt niet meer als het account intussen is geblokkeerd', async () => {
  const w = await world();
  try {
    const { secret } = await w.enable(await w.tokenOf('alice'));
    const ch = (await w.login('alice')).body.challenge;
    w.clock.now += 5 * 60_000 + 1;
    assert.equal((await w.call('/api/v1/auth/login/2fa', { challenge: ch, code: code(secret, w.clock.now) })).body.error_code, 'CHALLENGE_EXPIRED');
    // bob zet 2FA aan, wordt geblokkeerd tussen de twee stappen
    const bobToken = await w.tokenOf('bob');
    const bob = await w.enable(bobToken);
    const bobCh = (await w.login('bob')).body.challenge;
    w.db.prepare('UPDATE users SET is_disabled = 1 WHERE id = ?').run(w.bob.id);
    assert.equal((await w.call('/api/v1/auth/login/2fa', { challenge: bobCh, code: code(bob.secret, w.clock.now) })).status, 401);
  } finally { await w.close(); }
});

test('uitzetten: wachtwoord én code nodig (ook een herstelcode); daarna inloggen zonder code', async () => {
  const w = await world();
  try {
    const token = await w.tokenOf('alice');
    const { secret, recovery } = await w.enable(token);
    assert.equal((await w.call('/api/v1/auth/2fa/disable', { password: PW, code: '' }, token)).status, 403);
    assert.equal((await w.call('/api/v1/auth/2fa/disable', { password: 'fout-wachtwoord', code: code(secret, w.clock.now) }, token)).status, 403);
    assert.equal((await w.call('/api/v1/auth/2fa', undefined, token)).body.enabled, true);
    const off = await w.call('/api/v1/auth/2fa/disable', { password: PW, code: recovery[5] }, token);
    assert.equal(off.status, 200);
    assert.equal(off.body.enabled, false);
    assert.equal((w.db.prepare('SELECT COUNT(*) AS n FROM recovery_codes').get() as any).n, 0, 'herstelcodes weg');
    assert.equal((w.db.prepare('SELECT totp_secret FROM users WHERE id = ?').get(w.alice.id) as any).totp_secret, null);
    assert.ok((await w.login('alice')).body.token);
    assert.equal((await w.call('/api/v1/auth/2fa/disable', { password: PW, code: '123456' }, token)).status, 409, 'staat al uit');
    assert.ok(w.lines.some((l) => l.includes('tweestapsverificatie uitgezet door "alice"')));
  } finally { await w.close(); }
});

test('toegang: alles werkt op het eigen account; alleen een beheerder kan 2FA van een ander uitzetten, met een logregel', async () => {
  const w = await world();
  try {
    const aliceToken = await w.tokenOf('alice');
    const bobToken = await w.tokenOf('bob');
    const alice = await w.enable(aliceToken);
    // bob kan met een id van alice niets: de eindpunten kennen alleen het eigen account
    assert.equal((await w.call('/api/v1/auth/2fa/disable', { id: w.alice.id, password: PW, code: '123456' }, bobToken)).status, 409, 'bob heeft zelf geen 2FA');
    assert.equal((await w.call('/api/v1/auth/2fa', undefined, bobToken)).body.enabled, false);
    assert.equal((await w.call('/api/v1/admin/users/2fa-reset', { id: w.alice.id }, bobToken)).status, 403, 'geen beheerder');
    assert.equal((await w.call('/api/v1/auth/2fa', undefined, aliceToken)).body.enabled, true, 'nog steeds aan');
    const bob = await w.enable(bobToken);
    const users = (await w.call('/api/v1/admin/users', undefined, aliceToken)).body.users;
    assert.deepEqual(users.map((u: any) => [u.username, u.two_factor]), [['alice', true], ['bob', true]]);
    assert.equal((await w.call('/api/v1/admin/users/2fa-reset', { id: 'bestaat-niet' }, aliceToken)).status, 404);
    const reset = await w.call('/api/v1/admin/users/2fa-reset', { id: w.bob.id }, aliceToken);
    assert.equal(reset.status, 200);
    assert.equal(reset.body.user.two_factor, false);
    assert.ok(w.lines.some((l) => l === '[beheer] tweestapsverificatie van "bob" uitgezet door beheerder "alice"'));
    assert.ok((await w.login('bob')).body.token, 'bob logt weer in met alleen zijn wachtwoord');
    assert.equal((await w.call('/api/v1/auth/me', undefined, bobToken)).status, 200, 'en blijft aangemeld waar hij al was');
    assert.ok(!w.lines.join('\n').includes(bob.secret) && !w.lines.join('\n').includes(alice.secret), 'geen geheimen in de logregels');
  } finally { await w.close(); }
});

test('een geheim van een andere sleutel (verkeerd sleutelbestand) laat geen code door, met een logregel; herstelcodes ook niet', async () => {
  const w = await world();
  try {
    const { secret, recovery } = await w.enable(await w.tokenOf('alice'));
    await w.close();
    const other = createApp({ db: w.db, clock: () => w.clock.now, log: (l) => w.lines.push(l), secretKey: randomBytes(32), backup: null, sessionSweepMs: 0 });
    await new Promise<void>((r) => other.server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(other.server.address() as AddressInfo).port}`;
    const post = async (path: string, body: unknown) => (await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json() as any;
    const ch = (await post('/api/v1/auth/login', { username: 'alice', password: PW })).challenge;
    assert.equal((await post('/api/v1/auth/login/2fa', { challenge: ch, code: code(secret, w.clock.now) })).error_code, 'INVALID_CODE');
    assert.equal((await post('/api/v1/auth/login/2fa', { challenge: ch, code: recovery[0] })).error_code, 'INVALID_CODE');
    assert.ok(w.lines.some((l) => l.includes('niet te ontsleutelen')));
    await other.close();
  } finally { /* al gesloten */ }
});
