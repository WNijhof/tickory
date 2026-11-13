// Inlogbeperking onder gelijktijdige belasting, via HTTP: de beperking moet ook werken als honderd pogingen tegelijk
// binnenkomen (de controle van het wachtwoord is asynchroon), en een stroom pogingen mag de server niet platleggen.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import type { AddressInfo } from 'node:net';
import { createSchema } from './schema.ts';
import { createApp } from './main.ts';
import type { App } from './main.ts';
import { LoginLimiter, createUser, hashPassword, scryptGateState, setPasswordCostForTests, setScryptGateForTests } from './users.ts';

let app: App;
let base = '';
const PW = 'een-goed-wachtwoord';

const login = async (username: string, password: string, headers: Record<string, string> = {}): Promise<number> => {
  const r = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ username, password, device_name: 'Test' }),
  });
  await r.arrayBuffer();
  return r.status;
};
const tally = (codes: number[]): Record<number, number> => codes.reduce<Record<number, number>>((acc, c) => ({ ...acc, [c]: (acc[c] ?? 0) + 1 }), {});

before(async () => {
  setPasswordCostForTests(4096); // ruim genoeg dat berekeningen elkaar overlappen, snel genoeg voor een test
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  createUser(db, { username: 'victim', name: 'Victim', passwordHash: await hashPassword(PW) });
  createUser(db, { username: 'other', name: 'Other', passwordHash: await hashPassword(PW) });
  // trustProxy: het adres komt uit X-Forwarded-For, zodat de test "verschillende bezoekers" kan nabootsen
  app = createApp({ db, trustProxy: true, limiter: new LoginLimiter({ pair: 8, ip: 40, user: 60 }) });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
after(async () => { await app.close(); });

test('100 gelijktijdige foute pogingen vanaf één adres op één naam: er komen er hooguit 8 door de beperking', async () => {
  const codes = await Promise.all(Array.from({ length: 100 }, (_, i) => login('victim', `fout-wachtwoord-${i}`, { 'X-Forwarded-For': '203.0.113.5' })));
  const t = tally(codes);
  assert.ok((t[401] ?? 0) <= 8, `${t[401]} pogingen kwamen door de beperking: ${JSON.stringify(t)}`);
  assert.equal((t[401] ?? 0) + (t[429] ?? 0), 100, JSON.stringify(t));
});

test('het goede wachtwoord midden in een stroom van foute pogingen van een ander adres blijft werken', async () => {
  const attacker = Array.from({ length: 80 }, (_, i) => login('other', `fout-wachtwoord-${i}`, { 'X-Forwarded-For': '203.0.113.99' }));
  const mine = login('other', PW, { 'X-Forwarded-For': '198.51.100.7' });
  assert.equal(await mine, 200, 'de eigenaar logt in vanaf zijn eigen adres, ook al is de naam onder vuur');
  const t = tally(await Promise.all(attacker));
  assert.ok((t[401] ?? 0) <= 8, JSON.stringify(t));
});

test('een stroom pogingen legt de server niet plat: er lopen hooguit twee scrypt-berekeningen tegelijk en de rest krijgt 503', async () => {
  setScryptGateForTests(1, 3);
  try {
    let maxRunning = 0;
    const sampler = setInterval(() => { maxRunning = Math.max(maxRunning, scryptGateState().running); }, 1);
    const unlimited = (i: number) => login(`onbekend${i}`, 'fout-wachtwoord-xx', { 'X-Forwarded-For': `192.0.2.${i}` }); // elk een eigen adres: de beperking telt niet
    const codes = await Promise.all(Array.from({ length: 30 }, (_, i) => unlimited(i)));
    clearInterval(sampler);
    const t = tally(codes);
    assert.ok(maxRunning <= 1, `er liepen ${maxRunning} berekeningen tegelijk`);
    assert.ok((t[503] ?? 0) > 0, `verwacht een 503 voor wie niet meer in de wachtrij past: ${JSON.stringify(t)}`);
    assert.ok((t[401] ?? 0) >= 1, JSON.stringify(t));
    assert.deepEqual(scryptGateState(), { running: 0, waiting: 0 }, 'de wachtrij is daarna leeg');
    assert.equal(await login('other', PW, { 'X-Forwarded-For': '198.51.100.8' }), 200, 'daarna kan een echte gebruiker gewoon inloggen');
  } finally {
    setScryptGateForTests(2, 32);
  }
});
