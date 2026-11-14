// Tweestapsverificatie, de bouwstenen: base32, HOTP en TOTP met de testvectoren uit de RFC's, het tijdvenster en zijn grenzen,
// hergebruik, herstelcodes en het versleutelen van het geheim. De sleutels hieronder zijn die uit de RFC's of verzonnen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  base32Decode, base32Encode, cleanCode, cleanRecoveryCode, createSecretBox, hotp, matchStep, newRecoveryCodes, newSecret, otpauthUri, stepAt, totp,
} from './totp.ts';

test('base32 volgens de testvectoren van RFC 4648, en terug; spaties, kleine letters en opvulling mogen', () => {
  const vectors: [string, string][] = [['', ''], ['f', 'MY'], ['fo', 'MZXQ'], ['foo', 'MZXW6'], ['foob', 'MZXW6YQ'], ['fooba', 'MZXW6YTB'], ['foobar', 'MZXW6YTBOI']];
  for (const [plain, encoded] of vectors) {
    assert.equal(base32Encode(Buffer.from(plain)), encoded, plain);
    assert.equal(base32Decode(encoded)!.toString(), plain, encoded);
  }
  assert.equal(base32Decode('mzxw 6ytb oi======')!.toString(), 'foobar');
  assert.equal(base32Decode('MZXW1'), null, 'een 1 hoort niet in base32');
  const random = randomBytes(20);
  assert.deepEqual(base32Decode(base32Encode(random)), random);
  assert.equal(base32Encode(random).length, 32, '20 bytes worden 32 tekens');
});

test('HOTP volgens de testvectoren van RFC 4226 (bijlage D)', () => {
  const key = Buffer.from('12345678901234567890');
  const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
  expected.forEach((code, counter) => assert.equal(hotp(key, counter), code, `teller ${counter}`));
});

test('TOTP volgens de testvectoren van RFC 6238 (bijlage B): SHA-1, SHA-256 en SHA-512, 8 cijfers', () => {
  const keys = {
    sha1: Buffer.from('12345678901234567890'),
    sha256: Buffer.from('12345678901234567890123456789012'),
    sha512: Buffer.from('1234567890123456789012345678901234567890123456789012345678901234'),
  };
  const table: [number, string, string, string][] = [
    [59, '94287082', '46119246', '90693936'],
    [1111111109, '07081804', '68084774', '25091201'],
    [1111111111, '14050471', '67062674', '99943326'],
    [1234567890, '89005924', '91819424', '93441116'],
    [2000000000, '69279037', '90698825', '38618901'],
    [20000000000, '65353130', '77737706', '47863826'],
  ];
  for (const [seconds, sha1, sha256, sha512] of table) {
    assert.equal(totp(keys.sha1, seconds * 1000, { digits: 8, algorithm: 'sha1' }), sha1, `sha1 ${seconds}`);
    assert.equal(totp(keys.sha256, seconds * 1000, { digits: 8, algorithm: 'sha256' }), sha256, `sha256 ${seconds}`);
    assert.equal(totp(keys.sha512, seconds * 1000, { digits: 8, algorithm: 'sha512' }), sha512, `sha512 ${seconds}`);
  }
  // de standaard (6 cijfers, SHA-1) is het einde van dezelfde code
  assert.equal(totp(keys.sha1, 59_000), '287082');
  assert.equal(stepAt(59_000), 1);
  assert.equal(stepAt(1111111109_000), 37037036);
});

test('tijdvenster: het huidige tijdvak en één ervoor of erna gelden, twee ernaast niet; de grenzen van een tijdvak kloppen', () => {
  const key = Buffer.from('12345678901234567890');
  const now = 1_700_000_000_000;
  const step = stepAt(now);
  const at = (s: number) => hotp(key, s);
  assert.equal(matchStep(key, at(step), now, null), step);
  assert.equal(matchStep(key, at(step - 1), now, null), step - 1);
  assert.equal(matchStep(key, at(step + 1), now, null), step + 1);
  assert.equal(matchStep(key, at(step - 2), now, null), null, 'een minuut te laat');
  assert.equal(matchStep(key, at(step + 2), now, null), null, 'een minuut te vroeg');
  // precies op de grens: de laatste milliseconde van een tijdvak en de eerste van het volgende
  const start = (step + 5) * 30_000;
  assert.equal(stepAt(start - 1), step + 4);
  assert.equal(stepAt(start), step + 5);
  assert.equal(matchStep(key, at(step + 3), start - 1, null), step + 3, 'vlak voor de grens: tijdvak +4 is nu, +3 is één ervoor');
  assert.equal(matchStep(key, at(step + 3), start, null), null, 'vlak na de grens: +5 is nu, +3 is twee ervoor');
  assert.equal(matchStep(key, at(step + 6), start - 1, null), null, 'vlak voor de grens is +6 nog twee tijdvakken vooruit');
  assert.equal(matchStep(key, at(step + 6), start, null), step + 6);
});

test('hergebruik: een gebruikt tijdvak en elk eerder tijdvak gelden niet meer', () => {
  const key = Buffer.from('12345678901234567890');
  const now = 1_700_000_000_000;
  const step = stepAt(now);
  assert.equal(matchStep(key, hotp(key, step), now, step), null, 'dezelfde code nog een keer');
  assert.equal(matchStep(key, hotp(key, step - 1), now, step), null, 'een oudere code na een nieuwere');
  assert.equal(matchStep(key, hotp(key, step + 1), now, step), step + 1, 'de volgende code mag wel');
  assert.equal(matchStep(key, hotp(key, step), now, step - 1), step);
  assert.equal(matchStep(Buffer.from('een-ander-verzonnen-geheim'), hotp(key, step), now, null), null, 'een ander geheim');
});

test('codes en herstelcodes schoonmaken zoals iemand ze intypt', () => {
  assert.equal(cleanCode('123456'), '123456');
  assert.equal(cleanCode(' 123 456 '), '123456');
  assert.equal(cleanCode('123-456'), '123456');
  for (const bad of ['12345', '1234567', 'abcdef', '', null, 123456, '１２３４５６']) assert.equal(cleanCode(bad), null, String(bad));
  assert.equal(cleanRecoveryCode('abcde-12345'), 'abcde12345');
  assert.equal(cleanRecoveryCode(' ABCDE 12345 '), 'abcde12345');
  assert.equal(cleanRecoveryCode('oiL23-45678'), '01123' + '45678', 'o wordt 0, i en l worden 1 (Crockford)');
  for (const bad of ['abcde-1234', 'abcde-123456', 'abcde-1234u', '', null, 'x'.repeat(50)]) assert.equal(cleanRecoveryCode(bad), null, String(bad));
});

test('herstelcodes: tien verschillende, in de vorm xxxxx-xxxxx, zonder verwarrende tekens', () => {
  const codes = newRecoveryCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  for (const c of codes) {
    assert.match(c, /^[0-9a-hjkmnp-tv-z]{5}-[0-9a-hjkmnp-tv-z]{5}$/);
    assert.equal(cleanRecoveryCode(c), c.replace('-', ''), 'een code overleeft het schoonmaken ongewijzigd');
  }
});

test('het geheim versleutelen: terug te lezen met dezelfde sleutel en gebruiker, niet met een andere, en bestand tegen knoeien', () => {
  const master = randomBytes(32);
  const box = createSecretBox(master);
  const secret = newSecret();
  const sealed = box.seal(secret, 'gebruiker-a');
  assert.match(sealed, /^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
  assert.ok(!sealed.includes(base32Encode(secret)) && !sealed.includes(secret.toString('base64url')), 'het geheim staat er niet leesbaar in');
  assert.deepEqual(box.open(sealed, 'gebruiker-a'), secret);
  assert.notEqual(box.seal(secret, 'gebruiker-a'), sealed, 'elke keer een eigen IV');
  assert.equal(box.open(sealed, 'gebruiker-b'), null, 'naar een andere gebruiker gekopieerd: onleesbaar');
  assert.equal(createSecretBox(randomBytes(32)).open(sealed, 'gebruiker-a'), null, 'een andere sleutel');
  const [v, iv, ct, tag] = sealed.split('.');
  const flipped = Buffer.from(ct, 'base64url');
  flipped[0] ^= 1;
  assert.equal(box.open([v, iv, flipped.toString('base64url'), tag].join('.'), 'gebruiker-a'), null, 'gewijzigd');
  assert.equal(box.open('v2.a.b.c', 'gebruiker-a'), null);
  assert.equal(box.open('onzin', 'gebruiker-a'), null);
  assert.throws(() => createSecretBox(randomBytes(16)), /32 bytes/);
  // herstelcodes: per gebruiker een andere hash, en met een andere sleutel ook
  assert.equal(box.codeHash('abcde12345', 'a'), box.codeHash('abcde12345', 'a'));
  assert.notEqual(box.codeHash('abcde12345', 'a'), box.codeHash('abcde12345', 'b'));
  assert.notEqual(box.codeHash('abcde12345', 'a'), createSecretBox(randomBytes(32)).codeHash('abcde12345', 'a'));
  assert.ok(!box.codeHash('abcde12345', 'a').includes('abcde12345'));
});

test('het otpauth-adres: het geheim in base32, uitgever en account netjes gecodeerd', () => {
  const secret = Buffer.from('12345678901234567890');
  assert.equal(otpauthUri(secret, 'alice'), 'otpauth://totp/Tickory:alice?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Tickory&algorithm=SHA1&digits=6&period=30');
  assert.match(otpauthUri(secret, 'zoë de vries'), /^otpauth:\/\/totp\/Tickory:zo%C3%AB%20de%20vries\?/);
  assert.equal(newSecret().length, 20);
});
