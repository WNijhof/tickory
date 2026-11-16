import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateNotices } from './updates.js';
import { compareVersions, isVersion } from '../../shared/version.js';

const status = (extra = {}) => ({
  version: '0.3.0', update_available: true,
  latest: { version: '0.4.0', url: 'https://github.com/WNijhof/tickory/releases/tag/v0.4.0', apk_url: 'https://github.com/WNijhof/tickory/releases/download/v0.4.0/tickory-0.4.0.apk' },
  ...extra,
});

test('versies: als getallen vergeleken, met of zonder v', () => {
  assert.ok(compareVersions('0.10.0', '0.9.9') > 0);
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0);
  assert.equal(isVersion('1.2.3'), true);
  assert.equal(isVersion('1.2'), false);
  assert.equal(isVersion(null), false);
});

test('een beheerder hoort van een nieuwere server; een gewone gebruiker niet', () => {
  assert.deepEqual(updateNotices(status(), { isAdmin: true }), [{ kind: 'server', version: '0.4.0', current: '0.3.0', url: 'https://github.com/WNijhof/tickory/releases/tag/v0.4.0' }]);
  assert.deepEqual(updateNotices(status(), { isAdmin: false }), []);
  assert.deepEqual(updateNotices(status({ update_available: false }), { isAdmin: true }), []);
});

test('in de Android-app: een nieuwere app, met de APK; dezelfde of een nieuwere eigen versie niet', () => {
  assert.deepEqual(updateNotices(status(), { appVersion: '0.3.0' }), [{ kind: 'app', version: '0.4.0', current: '0.3.0', url: 'https://github.com/WNijhof/tickory/releases/download/v0.4.0/tickory-0.4.0.apk' }]);
  assert.deepEqual(updateNotices(status(), { appVersion: '0.4.0' }), []);
  assert.deepEqual(updateNotices(status(), { appVersion: '0.5.0' }), []);
  assert.equal(updateNotices(status({ latest: { ...status().latest, apk_url: null } }), { appVersion: '0.3.0' })[0].url, 'https://github.com/WNijhof/tickory/releases/tag/v0.4.0', 'zonder APK: de pagina');
  // een beheerder in de app krijgt beide
  assert.deepEqual(updateNotices(status(), { isAdmin: true, appVersion: '0.3.0' }).map((n) => n.kind), ['server', 'app']);
});

test('niets bekend, uit, of onzin: geen melding', () => {
  assert.deepEqual(updateNotices(null, { isAdmin: true, appVersion: '0.1.0' }), []);
  assert.deepEqual(updateNotices({ version: '0.3.0', latest: null, update_available: false }, { isAdmin: true, appVersion: '0.1.0' }), []);
  assert.deepEqual(updateNotices(status({ latest: { version: 'nachtelijk', url: 'x' } }), { isAdmin: true, appVersion: '0.1.0' }), []);
});
