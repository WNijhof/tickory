// Je eigen account verwijderen over HTTP (accountDelete.ts): eerst zien of het mag, dan met wachtwoord en (bij tweestaps-
// verificatie) een code. Daarna werkt geen enkele sessie meer en kan de gebruikersnaam opnieuw worden aangemaakt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp } from './main.ts';
import { createSchema } from './schema.ts';
import { DatabaseSync } from 'node:sqlite';
import { LoginLimiter, createUser, hashPassword, setPasswordCostForTests } from './users.ts';

setPasswordCostForTests(1024);
const PW = 'een-goed-wachtwoord';
const T0 = Date.parse('2026-11-14T10:00:10Z');

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


test('Bob verwijdert zijn account: eerst de controle, fout wachtwoord geweigerd, daarna is alles weg en werkt zijn sessie niet meer', async () => {
  const w = await world();
  try {
    const bob = await w.tokenOf('bob');
    const second = await w.tokenOf('bob');
    const check = await w.call('/api/v1/auth/account/delete', undefined, bob);
    assert.deepEqual(check.body, { can_delete: true, shared_projects: [], last_admin: false });
    assert.equal((await w.call('/api/v1/auth/account/delete', { password: 'verkeerd-wachtwoord' }, bob)).status, 403);
    assert.equal((await w.call('/api/v1/auth/me', undefined, bob)).status, 200, 'na een fout wachtwoord nog gewoon ingelogd');
    const done = await w.call('/api/v1/auth/account/delete', { password: PW }, bob);
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal((await w.call('/api/v1/auth/me', undefined, bob)).status, 401);
    assert.equal((await w.call('/api/v1/auth/me', undefined, second)).status, 401, 'ook op zijn andere apparaat');
    assert.equal((await w.login('bob')).status, 401, 'inloggen lukt niet meer');
    assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM users WHERE username = 'bob'").get()!.n, 0);
    assert.ok(w.lines.some((l) => l.includes('eigen account verwijderd')), 'de beheerder ziet het in het logboek');
  } finally {
    await w.close();
  }
});

test('de laatste beheerder en de eigenaar van een gedeeld project kunnen niet; met tweestapsverificatie is een code nodig', async () => {
  const w = await world();
  try {
    const alice = await w.tokenOf('alice');
    const check = await w.call('/api/v1/auth/account/delete', undefined, alice);
    assert.equal(check.body.can_delete, false);
    assert.equal(check.body.last_admin, true);
    assert.equal((await w.call('/api/v1/auth/account/delete', { password: PW }, alice)).status, 409);

    const bob = await w.tokenOf('bob');
    const shared = await w.call('/api/v1/sync', { commands: [
      { type: 'project_add', uuid: 'acc-http-000001', args: { id: 'project-bob-0001', name: 'Gezin' } },
      { type: 'project_share', uuid: 'acc-http-000002', args: { project_id: 'project-bob-0001', username: 'alice', role: 'member' } },
    ] }, bob);
    assert.equal(shared.status, 200);
    const blocked = await w.call('/api/v1/auth/account/delete', undefined, bob);
    assert.deepEqual(blocked.body.shared_projects, [{ id: 'project-bob-0001', name: 'Gezin', members: 1 }]);
    assert.equal((await w.call('/api/v1/auth/account/delete', { password: PW }, bob)).status, 409);
    await w.call('/api/v1/sync', { commands: [{ type: 'project_delete', uuid: 'acc-http-000003', args: { id: 'project-bob-0001' } }] }, bob);

    const { secret } = await w.enable(bob);
    assert.equal((await w.call('/api/v1/auth/account/delete', { password: PW }, bob)).status, 403, 'zonder code');
    assert.equal((await w.call('/api/v1/auth/account/delete', { password: PW, code: '000000' }, bob)).status, 403, 'een verkeerde code');
    const done = await w.call('/api/v1/auth/account/delete', { password: PW, code: code(secret, w.clock.now) }, bob);
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM recovery_codes").get()!.n, 0, 'ook de herstelcodes');
  } finally {
    await w.close();
  }
});
