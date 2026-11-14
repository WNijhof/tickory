// Inloggen via SSO aan de kant van de app: het fragment na de terugkeer, het bewaarde geheim van een poging, het begin van een
// poging (browser en Android-app) en de aanroepen naar de server.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSsoHash, PENDING_MS, savePending, SSO_ERRORS, ssoErrorText, startSso, takePending } from './sso.js';
import { createApi } from './auth.js';
import { androidBridge } from './android.js';
import { setLanguage } from './i18n.js';

const memory = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
};
const CODE = `tko_${'a'.repeat(43)}`;

test('het fragment na de terugkeer: een code, een fout of een noodcode; al het andere telt niet', () => {
  assert.deepEqual(parseSsoHash(`#oidc=${CODE}`), { kind: 'code', code: CODE });
  assert.deepEqual(parseSsoHash(`#signin=${CODE}`), { kind: 'signin', code: CODE });
  assert.deepEqual(parseSsoHash('#oidc-error=NO_ACCOUNT'), { kind: 'error', error: 'NO_ACCOUNT' });
  assert.deepEqual(parseSsoHash('#oidc-error=<script>'), { kind: 'error', error: 'PROVIDER' }, 'een rare fout wordt de algemene');
  for (const other of ['', '#', '#task=abc', '#oidc=kort', `#oidc=${CODE}&x=1`, `#oidc=${'a'.repeat(300)}`, `oidc=${CODE}`, null, undefined]) {
    assert.equal(parseSsoHash(other), null, String(other));
  }
});

test('foutteksten in de taal van de interface, zonder details; een onbekende code krijgt de algemene tekst', () => {
  try {
    setLanguage('nl');
    assert.match(ssoErrorText('NO_ACCOUNT'), /nog geen Tickory-account gekoppeld/);
    assert.equal(ssoErrorText('IETS_ANDERS'), ssoErrorText('PROVIDER'));
    assert.equal(ssoErrorText('__proto__'), ssoErrorText('PROVIDER'));
    setLanguage('en');
    assert.match(ssoErrorText('NOT_ALLOWED'), /has no access to Tickory/);
    const texts = SSO_ERRORS.map(ssoErrorText);
    assert.equal(new Set(texts).size, SSO_ERRORS.length, 'elke fout een eigen tekst');
    // dezelfde lijst als de server (server/sso.ts)
    assert.deepEqual(SSO_ERRORS, ['EXPIRED', 'CANCELLED', 'PROVIDER', 'UNAVAILABLE', 'NO_ACCOUNT', 'NOT_ALLOWED', 'DISABLED', 'ALREADY_LINKED', 'CREATE_FAILED', 'TOO_MANY_ATTEMPTS']);
  } finally { setLanguage('nl'); }
});

test('het geheim van een poging: eenmalig op te halen, verloopt na een kwartier, kapotte opslag geeft niets', () => {
  const s = memory();
  const t0 = 1_000_000;
  assert.equal(savePending(s, { binding: 'geheim', purpose: 'login' }, t0), true);
  assert.deepEqual(takePending(s, t0 + 1000), { binding: 'geheim', purpose: 'login' });
  assert.equal(takePending(s, t0 + 2000), null, 'eenmalig');
  savePending(s, { binding: 'geheim', purpose: 'link' }, t0);
  assert.equal(takePending(s, t0 + PENDING_MS + 1), null, 'te oud');
  s.setItem('tickory.sso', '{kapot');
  assert.equal(takePending(s), null);
  s.setItem('tickory.sso', JSON.stringify({ binding: 'x', purpose: 'iets', at: Date.now() }));
  assert.equal(takePending(s), null, 'onbekend doel');
  const broken = { getItem: () => { throw new Error('geen opslag'); }, setItem: () => { throw new Error('vol'); }, removeItem: () => {} };
  assert.equal(savePending(broken, { binding: 'x', purpose: 'login' }), false);
  assert.equal(takePending(broken), null);
});

test('een poging beginnen: in de browser een navigatie; in de Android-app via de brug; een oude app zegt "bijwerken"', async () => {
  const calls = [];
  const api = { sso: { start: async (input) => { calls.push(input); return { url: '/api/v1/auth/oidc/authorize?state=s', binding: 'b-1' }; } } };
  const storage = memory();
  const assigned = [];
  const location = { href: 'https://taken.voorbeeld.test/', assign: (u) => assigned.push(u) };
  assert.equal(await startSso({ api, purpose: 'login', bridge: androidBridge(undefined), storage, location, deviceName: 'Firefox op Windows', lang: 'nl' }), 'away');
  assert.deepEqual(calls[0], { purpose: 'login', client: 'web', device_name: 'Firefox op Windows', lang: 'nl' });
  assert.deepEqual(assigned, ['https://taken.voorbeeld.test/api/v1/auth/oidc/authorize?state=s']);
  assert.deepEqual(takePending(storage), { binding: 'b-1', purpose: 'login' });
  // koppelen geeft wachtwoord en code mee
  await startSso({ api, purpose: 'link', bridge: androidBridge(undefined), storage, location, password: 'pw', code: '123456' });
  assert.deepEqual(calls[1], { purpose: 'link', client: 'web', device_name: '', lang: 'nl', password: 'pw', code: '123456' });
  // de Android-app: de brug opent de pagina in de browser van het toestel, de server weet dat het om de app gaat
  const opened = [];
  const app = androidBridge({ openSignIn: (u) => opened.push(u), setSession() {} });
  assert.equal(app.canOpenSignIn(), true);
  assert.equal(await startSso({ api, purpose: 'login', bridge: app, storage, location }), 'away');
  assert.equal(calls[2].client, 'app');
  assert.deepEqual(opened, ['https://taken.voorbeeld.test/api/v1/auth/oidc/authorize?state=s']);
  assert.equal(assigned.length, 2, 'geen navigatie van de WebView zelf');
  // een oudere app zonder openSignIn: niets beginnen, wel zeggen dat de app moet worden bijgewerkt
  const before = calls.length;
  assert.equal(await startSso({ api, purpose: 'login', bridge: androidBridge({ setSession() {} }), storage, location }), 'update-app');
  assert.equal(calls.length, before);
  // de server weigert (fout wachtwoord bij koppelen): de fout komt bij de aanroeper, er wordt niets bewaard
  const failing = { sso: { start: async () => { throw new Error('geweigerd'); } } };
  const fresh = memory();
  await assert.rejects(startSso({ api: failing, purpose: 'link', bridge: androidBridge(undefined), storage: fresh, location }), /geweigerd/);
  assert.equal(fresh.m.size, 0);
});

test('de aanroepen naar de server: de juiste adressen, zonder token bij inloggen en inwisselen, met token bij koppelen', async () => {
  const seen = [];
  const fetch = async (url, init) => {
    seen.push({ url, method: init.method, auth: init.headers.Authorization ?? null, body: init.body ? JSON.parse(init.body) : null });
    return { ok: true, json: async () => ({}) };
  };
  const api = createApi({ fetch, getToken: () => 'tky_token' });
  await api.sso.methods();
  await api.sso.start({ purpose: 'login', client: 'web' });
  await api.sso.start({ purpose: 'link', client: 'web', password: 'pw' });
  await api.sso.handoff(CODE, 'b');
  await api.sso.handoff(CODE);
  await api.sso.status();
  await api.sso.unlink();
  await api.admin.unlinkSso('user-1');
  assert.deepEqual(seen.map((s) => [s.method, s.url, s.auth]), [
    ['GET', '/api/v1/auth/methods', null],
    ['POST', '/api/v1/auth/oidc/start', null],
    ['POST', '/api/v1/auth/oidc/start', 'Bearer tky_token'],
    ['POST', '/api/v1/auth/login/handoff', null],
    ['POST', '/api/v1/auth/login/handoff', null],
    ['GET', '/api/v1/auth/oidc/link', 'Bearer tky_token'],
    ['POST', '/api/v1/auth/oidc/unlink', 'Bearer tky_token'],
    ['POST', '/api/v1/admin/users/sso-unlink', 'Bearer tky_token'],
  ]);
  assert.deepEqual(seen[3].body, { code: CODE, binding: 'b' });
  assert.deepEqual(seen[4].body, { code: CODE });
});

test('foutmeldingen van de server bij SSO: in het Engels de eigen vertaling', async () => {
  const reply = (status, body) => async () => ({ ok: false, status, headers: { get: () => null }, json: async () => body });
  try {
    setLanguage('en');
    const off = createApi({ fetch: reply(403, { error_code: 'PASSWORD_LOGIN_OFF', error: 'inloggen met een wachtwoord staat op deze server uit' }) });
    await assert.rejects(off.login('a', 'b', 'c'), /Signing in with a password is turned off/);
    const expired = createApi({ fetch: reply(401, { error_code: 'CODE_INVALID', error: 'deze inlogpoging is verlopen' }) });
    await assert.rejects(expired.sso.handoff(CODE, 'x'), /has expired or was already used/);
    const wrong = createApi({ fetch: reply(403, { error_code: 'FORBIDDEN', error: 'het wachtwoord klopt niet' }) });
    await assert.rejects(wrong.sso.start({ purpose: 'link' }), /password is wrong|password is incorrect|not correct/i);
    const only = createApi({ fetch: reply(409, { error_code: 'CONFLICT', error: 'dit is de enige manier' }) });
    await assert.rejects(only.sso.unlink(), /only way you can sign in/);
    setLanguage('nl');
    await assert.rejects(off.login('a', 'b', 'c'), /^ApiError: Inloggen met een wachtwoord staat op deze server uit$/);
  } finally { setLanguage('nl'); }
});
