// TRUST_PROXY: het aantal reverse proxy's voor Tickory. Bij twee proxy's achter elkaar (een CDN en nginx) moet de bezoeker zelf tellen
// in de inlogbeperking, niet de proxy: anders deelt iedereen één teller en kan één aanvaller de inlog voor allen vullen.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import type { AddressInfo } from 'node:net';
import { createSchema } from './schema.ts';
import { createApp, trustProxyFrom } from './main.ts';
import type { App } from './main.ts';
import { LoginLimiter, setPasswordCostForTests } from './users.ts';

test('trustProxyFrom: een aantal proxy\'s, of uit', () => {
  assert.equal(trustProxyFrom('1'), 1);
  assert.equal(trustProxyFrom('true'), 1);
  assert.equal(trustProxyFrom(' 2 '), 2);
  assert.equal(trustProxyFrom('99'), 10, 'hooguit 10');
  for (const off of [undefined, '', '0', '-1', '1.5', 'abc', 'false']) assert.equal(trustProxyFrom(off), false, String(off));
});

const start = async (trustProxy: boolean | number): Promise<{ app: App; base: string }> => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const app = createApp({ db, trustProxy, limiter: new LoginLimiter({ pair: 100, ip: 2, user: 100 }) });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  return { app, base: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}` };
};

const attempt = async (base: string, forwardedFor: string): Promise<number> => {
  const r = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': forwardedFor }, body: JSON.stringify({ username: 'niemand', password: 'fout-wachtwoord-xx', device_name: 'Test' }),
  });
  await r.arrayBuffer();
  return r.status;
};

let apps: App[] = [];
before(() => { setPasswordCostForTests(4096); });
after(async () => { for (const a of apps) await a.close(); });

test('twee proxy\'s (TRUST_PROXY=2): de bezoeker telt, niet de proxy die ervoor staat', async () => {
  const { app, base } = await start(2);
  apps.push(app);
  assert.equal(await attempt(base, '203.0.113.1, 10.0.0.9'), 401);
  assert.equal(await attempt(base, '203.0.113.1, 10.0.0.9'), 401);
  assert.equal(await attempt(base, '203.0.113.1, 10.0.0.9'), 429, 'dezelfde bezoeker: de beperking grijpt in');
  assert.equal(await attempt(base, '198.51.100.2, 10.0.0.9'), 401, 'een andere bezoeker achter dezelfde proxy wordt niet geraakt');
  // een bezoeker die zelf een adres vooraan meestuurt, wint er niets mee: alleen de waarde die de proxy's toevoegen telt
  assert.equal(await attempt(base, '1.2.3.4, 203.0.113.1, 10.0.0.9'), 429);
});

test('één proxy (TRUST_PROXY=1, zoals voorheen): de laatste waarde telt', async () => {
  const { app, base } = await start(1);
  apps.push(app);
  assert.equal(await attempt(base, '203.0.113.1, 10.0.0.9'), 401);
  assert.equal(await attempt(base, '203.0.113.1, 10.0.0.9'), 401);
  assert.equal(await attempt(base, '198.51.100.2, 10.0.0.9'), 429, 'alles achter de ene proxy deelt één teller: dat is wat TRUST_PROXY=2 oplost');
});

test('te weinig waarden voor het aantal proxy\'s: het adres van de verbinding zelf telt, niet iets wat de bezoeker kan verzinnen', async () => {
  const { app, base } = await start(3);
  apps.push(app);
  // twee waarden bij drie proxy's: de header klopt niet met de opstelling, dus alles valt terug op 127.0.0.1 (de testverbinding)
  assert.equal(await attempt(base, '203.0.113.1, 10.0.0.9'), 401);
  assert.equal(await attempt(base, '198.51.100.2, 10.0.0.9'), 401);
  assert.equal(await attempt(base, '192.0.2.77, 10.0.0.9'), 429, 'drie verschillende "bezoekers" tellen als één: het verbindingsadres');
});
