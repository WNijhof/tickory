import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isWeakPassword, weakPasswordReason } from './password.js';

test('veelgebruikte wachtwoorden zijn te makkelijk, ook met cijfers of leestekens erachter en in andere hoofdletters', () => {
  for (const pw of ['1234567890', 'qwertyuiop', 'Wachtwoord123', 'WACHTWOORD2026!', 'password123456', 'Welkom12345', 'amsterdam2026', 'iloveyou2000', '1q2w3e4r5t', 'Tickory-2026', 'letmein12345']) {
    assert.ok(isWeakPassword(pw), pw);
  }
});

test('te weinig verschillende tekens en herhalingen zijn te makkelijk', () => {
  assert.equal(weakPasswordReason('aaaaaaaaaaaa'), 'few_characters');
  assert.equal(weakPasswordReason('abababababab'), 'few_characters');
  assert.equal(weakPasswordReason('1212121212'), 'few_characters');
  assert.ok(isWeakPassword('abcdeabcdeabcde'), 'een herhaald stuk');
  assert.ok(isWeakPassword('0123456789'), 'alleen cijfers');
  assert.ok(isWeakPassword('1357924680'), 'alleen cijfers, ook zonder rij');
  assert.ok(!isWeakPassword('83920174659203'), 'een lange cijferreeks mag');
});

test('een wachtwoord dat op de gebruikersnaam lijkt, is te makkelijk', () => {
  assert.ok(isWeakPassword('annadevries2026', 'annadevries'));
  assert.ok(isWeakPassword('ANNADEVRIES', 'annadevries'));
  assert.ok(!isWeakPassword('annadevries-heeft-een-hond', 'annadevries'), 'een zin waarin de naam voorkomt is prima');
});

test('zinnen en willekeurige wachtwoorden mogen', () => {
  for (const pw of ['een-goed-wachtwoord', 'carol-wachtwoord-1', 'nieuw-wachtwoord-1', 'paarse olifant fietst langzaam', 'k9#Tz!x2Lm@4', 'Mijn hond heet Bobbie en is 3', 'tandarts bellen morgen']) {
    assert.equal(weakPasswordReason(pw), null, pw);
  }
});
