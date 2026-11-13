import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, createApi, deviceName } from './auth.js';

/** Een nep-fetch die de verzoeken onthoudt en antwoordt zoals gevraagd. */
function fake(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const r = responses.shift();
    if (r instanceof Error) throw r;
    return { ok: r.status < 400, status: r.status, headers: new Headers(r.headers ?? {}), json: async () => { if (r.notJson) throw new Error('geen json'); return r.body; } };
  };
  return { fn, calls };
}

test('inloggen stuurt geen token mee en geeft token en gebruiker terug', async () => {
  const f = fake([{ status: 200, body: { token: 'tky_abc', me: { id: 'u1', name: 'Anna' } } }]);
  const api = createApi({ fetch: f.fn, getToken: () => 'oud-token-dat-niet-mee-mag' });
  const res = await api.login('anna', 'geheim-wachtwoord', 'Chrome op Android');
  assert.equal(res.token, 'tky_abc');
  assert.equal(f.calls[0].url, '/api/v1/auth/login');
  assert.equal(f.calls[0].init.method, 'POST');
  assert.equal(f.calls[0].init.headers.Authorization, undefined, 'bij inloggen hoort geen oud token mee');
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { username: 'anna', password: 'geheim-wachtwoord', device_name: 'Chrome op Android' });
});

test('overige aanroepen sturen het token mee, en de basis-URL is aan te passen', async () => {
  const f = fake([{ status: 200, body: { sessions: [] } }, { status: 200, body: {} }, { status: 200, body: { users: [] } }, { status: 200, body: {} }]);
  const api = createApi({ fetch: f.fn, getToken: () => 'tky_mijn', baseUrl: 'https://taken.example.nl' });
  await api.sessions();
  await api.changePassword('oud-wachtwoord-1', 'nieuw-wachtwoord-1');
  await api.admin.users();
  await api.logout('tky_ander');
  assert.equal(f.calls[0].url, 'https://taken.example.nl/api/v1/auth/sessions');
  assert.equal(f.calls[0].init.headers.Authorization, 'Bearer tky_mijn');
  assert.equal(f.calls[0].init.body, undefined);
  assert.deepEqual(JSON.parse(f.calls[1].init.body), { current_password: 'oud-wachtwoord-1', new_password: 'nieuw-wachtwoord-1' });
  assert.equal(f.calls[2].url, 'https://taken.example.nl/api/v1/admin/users');
  assert.equal(f.calls[3].init.headers.Authorization, 'Bearer tky_ander', 'uitloggen kan met een expliciet token');
});

test('fouten komen als begrijpelijke Nederlandse tekst, met status en code', async () => {
  const f = fake([
    { status: 401, body: { error_code: 'INVALID_CREDENTIALS', error: 'gebruikersnaam of wachtwoord klopt niet' } },
    { status: 429, body: { error_code: 'TOO_MANY_ATTEMPTS', error: 'te veel mislukte pogingen' }, headers: { 'retry-after': '600' } },
    { status: 502, notJson: true },
    new TypeError('Failed to fetch'),
  ]);
  const api = createApi({ fetch: f.fn });
  await assert.rejects(api.login('a', 'b'), (e) => e instanceof ApiError && e.status === 401 && e.code === 'INVALID_CREDENTIALS' && e.message === 'Gebruikersnaam of wachtwoord klopt niet');
  await assert.rejects(api.login('a', 'b'), (e) => e.status === 429 && e.retryAfter === 600);
  await assert.rejects(api.login('a', 'b'), (e) => e.status === 502 && e.message === 'De server gaf een fout (502).');
  await assert.rejects(api.login('a', 'b'), (e) => e.code === 'OFFLINE' && /Geen verbinding/.test(e.message));
});

test('de apparaatnaam vertelt welk toestel het is', () => {
  const ua = {
    chromeAndroid: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
    edgeWindows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
    firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0',
    safariMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    safariIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  };
  assert.equal(deviceName(ua.chromeAndroid), 'Chrome op Android');
  assert.equal(deviceName(ua.edgeWindows), 'Edge op Windows');
  assert.equal(deviceName(ua.firefoxLinux), 'Firefox op Linux');
  assert.equal(deviceName(ua.safariMac), 'Safari op Mac');
  assert.equal(deviceName(ua.safariIphone), 'Safari op iOS');
  assert.equal(deviceName(ua.chromeAndroid, { app: true }), 'Android-app');
  assert.equal(deviceName(''), 'Browser op Onbekend');
});
