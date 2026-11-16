// Kijken of er een nieuwere Tickory op GitHub staat (updateCheck.ts): het antwoord van GitHub lezen, vergelijken, fouten, en het eindpunt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from './main.ts';
import { createSchema } from './schema.ts';
import { createSession, createUser } from './users.ts';
import { compareVersions, createUpdateCheck, parseRelease, RELEASES_API, serverVersion, updateCheckEnabled } from './updateCheck.ts';

const release = (extra: Record<string, unknown> = {}) => ({
  tag_name: 'v0.4.0', html_url: 'https://github.com/WNijhof/tickory/releases/tag/v0.4.0', published_at: '2026-11-20T10:00:00Z', draft: false, prerelease: false,
  assets: [
    { name: 'tickory-extension-0.4.0.zip', browser_download_url: 'https://github.com/WNijhof/tickory/releases/download/v0.4.0/tickory-extension-0.4.0.zip' },
    { name: 'tickory-0.4.0.apk', browser_download_url: 'https://github.com/WNijhof/tickory/releases/download/v0.4.0/tickory-0.4.0.apk' },
  ],
  ...extra,
});

test('versies vergelijken; de versie van deze server uit package.json', () => {
  assert.ok(compareVersions('0.4.0', '0.3.0') > 0);
  assert.ok(compareVersions('v0.3.10', '0.3.9') > 0, 'als getallen, niet als tekst');
  assert.equal(compareVersions('1.0.0', 'v1.0.0'), 0);
  assert.ok(compareVersions('onzin', '0.0.1') < 0);
  assert.match(serverVersion(), /^\d+\.\d+\.\d+$/);
  assert.equal(updateCheckEnabled({}), true, 'standaard aan');
  assert.equal(updateCheckEnabled({ UPDATE_CHECK: '0' }), false);
});

test('het antwoord van GitHub: versie, pagina en APK; alleen adressen van ons, geen concepten of voorversies', () => {
  assert.deepEqual(parseRelease(release()), {
    version: '0.4.0', url: 'https://github.com/WNijhof/tickory/releases/tag/v0.4.0', published_at: '2026-11-20T10:00:00.000Z',
    apk_url: 'https://github.com/WNijhof/tickory/releases/download/v0.4.0/tickory-0.4.0.apk',
  });
  assert.equal(parseRelease(release({ assets: [] }))?.apk_url, null, 'zonder APK: alleen de pagina');
  assert.equal(parseRelease(release({ html_url: 'https://kwaad.example/tickory' })), null, 'een vreemde pagina');
  assert.equal(parseRelease(release({ assets: [{ name: 'x.apk', browser_download_url: 'https://kwaad.example/x.apk' }] }))?.apk_url, null, 'een vreemde APK');
  assert.equal(parseRelease(release({ tag_name: 'nightly' })), null);
  assert.equal(parseRelease(release({ draft: true })), null);
  assert.equal(parseRelease(release({ prerelease: true })), null);
  assert.equal(parseRelease(null), null);
  assert.equal(parseRelease('<html>'), null);
});

test('kijken: één GET op de API zonder gegevens van de server; een nieuwere versie wordt gemeld; een fout laat de vorige uitkomst staan', async () => {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  let reply: () => Response = () => new Response(JSON.stringify(release()), { status: 200 });
  const lines: string[] = [];
  const check = createUpdateCheck({
    current: '0.3.0', log: (l) => lines.push(l), now: () => Date.parse('2026-11-21T08:00:00Z'),
    fetch: (async (url: string, init: { headers: Record<string, string> }) => { calls.push({ url, headers: init.headers }); return reply(); }) as unknown as typeof fetch,
  });
  assert.deepEqual(check.status(), { version: '0.3.0', latest: null, update_available: false, checked_at: null, enabled: true });
  await check.check();
  assert.equal(calls[0].url, RELEASES_API);
  assert.deepEqual(Object.keys(calls[0].headers).sort(), ['Accept', 'User-Agent']);
  assert.equal(calls[0].headers['User-Agent'], 'Tickory-update-check');
  const s = check.status();
  assert.equal(s.update_available, true);
  assert.equal(s.latest?.version, '0.4.0');
  assert.equal(s.checked_at, '2026-11-21T08:00:00.000Z');
  assert.equal(lines.length, 1, 'één regel in het logboek');
  await check.check();
  assert.equal(lines.length, 1, 'niet elke keer opnieuw');
  // GitHub is even niet bereikbaar: de vorige uitkomst blijft
  reply = () => { throw new Error('geen verbinding'); };
  await check.check();
  assert.equal(check.status().latest?.version, '0.4.0');
  reply = () => new Response('{}', { status: 500 });
  await check.check();
  assert.equal(check.status().update_available, true);
  // dezelfde versie als de server: niets te melden
  const same = createUpdateCheck({ current: '0.4.0', log: () => {}, fetch: (async () => new Response(JSON.stringify(release()))) as unknown as typeof fetch });
  await same.check();
  assert.equal(same.status().update_available, false);
  // nog geen enkele release (404)
  const none = createUpdateCheck({ current: '0.3.0', log: () => {}, fetch: (async () => new Response('{"message":"Not Found"}', { status: 404 })) as unknown as typeof fetch });
  await none.check();
  assert.deepEqual([none.status().latest, none.status().update_available], [null, false]);
});

test('GET /api/v1/version: voor wie is aangemeld; zonder controle de eigen versie en enabled: false', async () => {
  for (const withCheck of [false, true]) {
    const db = new DatabaseSync(':memory:');
    createSchema(db);
    const anna = createUser(db, { username: 'anna', name: 'Anna', passwordHash: 'x' });
    const updateCheck = withCheck ? createUpdateCheck({ current: '0.3.0', log: () => {}, fetch: (async () => new Response(JSON.stringify(release()))) as unknown as typeof fetch }) : null;
    if (updateCheck) await updateCheck.check();
    const app = createApp({ db, sessionSweepMs: 0, attachmentSweepMs: 0, backup: null, log: () => {}, updateCheck, updateCheckMs: 0 });
    await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
    try {
      const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
      assert.equal((await fetch(`${base}/api/v1/version`)).status, 401);
      const token = createSession(db, anna.id, 'Test').token;
      const body = await (await fetch(`${base}/api/v1/version`, { headers: { Authorization: `Bearer ${token}` } })).json() as any;
      if (withCheck) assert.deepEqual([body.version, body.latest.version, body.update_available, body.enabled], ['0.3.0', '0.4.0', true, true]);
      else assert.deepEqual([body.version, body.latest, body.update_available, body.enabled], [serverVersion(), null, false, false]);
    } finally {
      await app.close();
    }
  }
});
