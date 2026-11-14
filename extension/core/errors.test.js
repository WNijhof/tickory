// Foutmeldingen: elke foutcode die de server of de extensie kent, heeft een eigen tekst in het Nederlands en het Engels, en de
// (Nederlandse, technische) tekst van de server komt nooit in beeld.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ERROR_KEYS, errorText, needsReconnect } from './errors.js';
import { messageFormatter } from './i18n.js';

const load = (lang) => JSON.parse(readFileSync(new URL(`../_locales/${lang}/messages.json`, import.meta.url), 'utf8'));
const nl = messageFormatter(load('nl'));
const en = messageFormatter(load('en'));

test('elke foutcode heeft een tekst in beide talen', () => {
  for (const lang of ['nl', 'en']) {
    const messages = load(lang);
    for (const key of ERROR_KEYS) assert.ok(messages[key]?.message, `${lang}: ${key}`);
  }
});

test('codes van de server worden eigen teksten; de tekst van de server nooit', () => {
  const cases = {
    INVALID_CREDENTIALS: ['Gebruikersnaam of wachtwoord klopt niet.', 'Incorrect username or password.'],
    PASSWORD_LOGIN_OFF: ['Inloggen met een wachtwoord staat op deze server uit. Gebruik een koppelcode.', 'Signing in with a password is turned off on this server. Use a pairing code.'],
    INVALID_CODE: ['De code klopt niet (of is al gebruikt).', 'The code is incorrect (or has already been used).'],
    CODE_INVALID: ['Deze koppelcode is onbekend, verlopen of al gebruikt. Maak in Tickory een nieuwe.', 'This pairing code is unknown, expired or already used. Create a new one in Tickory.'],
    FORBIDDEN: ['Je kunt in dit project alleen lezen. Kies een ander project.', 'You can only read this project. Choose another project.'],
    UNAUTHORIZED: ['De verbinding met Tickory is verlopen of ingetrokken. Verbind opnieuw.', 'The connection to Tickory has expired or was revoked. Connect again.'],
  };
  for (const [code, [dutch, english]] of Object.entries(cases)) {
    const err = { code, status: 400, message: 'tekst van de server: iets met content_id' };
    assert.equal(errorText(err, nl), dutch);
    assert.equal(errorText(err, en), english);
  }
  for (const code of ['MISSING_ARG', 'UNKNOWN_ARG', 'INVALID_ARG', 'READONLY', 'ID_EXISTS', 'DUPLICATE', 'INVALID_REQUEST']) assert.equal(errorText({ code }, nl), nl('errInvalidTask'), code);
  assert.equal(errorText({ code: 'LIMIT_REACHED' }, en), 'Nothing more fits: a limit of the server has been reached.');
});

test('te veel pogingen: met de wachttijd in minuten (naar boven, minstens 1)', () => {
  assert.equal(errorText({ code: 'TOO_MANY_ATTEMPTS', retryAfter: 600 }, nl), 'Te veel pogingen. Probeer het over 10 minuten opnieuw.');
  assert.equal(errorText({ code: 'TOO_MANY_ATTEMPTS', retryAfter: 61 }, en), 'Too many attempts. Try again in 2 minutes.');
  assert.equal(errorText({ code: 'TOO_MANY_REQUESTS', retryAfter: 5 }, nl), 'Te veel pogingen. Probeer het over een minuut opnieuw.');
  assert.equal(errorText({ code: 'TOO_MANY_ATTEMPTS' }, en), 'Too many attempts. Try again in a minute.', 'zonder Retry-After');
});

test('niet bereikbaar: met een tip over http of https bij het verbinden', () => {
  assert.equal(errorText({ code: 'OFFLINE' }, nl), 'Tickory is niet bereikbaar.');
  assert.match(errorText({ code: 'OFFLINE' }, nl, { https: true }), /typ dan http:\/\/ ervoor/);
  assert.match(errorText({ code: 'OFFLINE' }, en, { https: false }), /can this computer reach your server/);
  assert.equal(errorText({ code: 'TIMEOUT' }, en), 'Tickory does not respond. Try again in a moment.');
});

test('fouten van de server zelf en onbekende codes', () => {
  assert.equal(errorText({ code: 'HTTP_502', status: 502 }, nl), nl('errServer'));
  assert.equal(errorText({ code: 'INTERNAL', status: 500 }, nl), nl('errServer'));
  assert.equal(errorText({ code: 'IETS_NIEUWS', status: 503 }, nl), nl('errServer'));
  assert.equal(errorText({ code: 'IETS_NIEUWS', status: 400 }, nl), 'Er ging iets mis (IETS_NIEUWS).');
  assert.equal(errorText(new Error('kapot'), en), 'Something went wrong (?).');
  assert.equal(errorText(null, en), 'Something went wrong (?).');
  assert.equal(needsReconnect({ code: 'UNAUTHORIZED' }), true);
  assert.equal(needsReconnect({ code: 'FORBIDDEN' }), false);
  assert.equal(needsReconnect(null), false);
});
