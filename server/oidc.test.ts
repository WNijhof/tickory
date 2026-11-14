// De losse onderdelen van inloggen via OIDC: de configuratie uit de omgeving, de controle van handtekeningen en claims, het
// opschonen van gebruikersnamen, groepen, de eenmalige codes en de migratie naar schemaversie 9. Sleutels maakt de test zelf.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { claimProblem, decodeJwt, displayNameFromClaims, groupsOf, inAnyGroup, oidcConfigFrom, pkcePair, safeUrl, usernameFromClaims, verifySignature } from './oidc.ts';
import { createLoginCode, hasPassword, linkIdentity, NO_PASSWORD, pruneLoginCodes, takeLoginCode, userForIdentity } from './sso.ts';
import { createSchema, SCHEMA_VERSION } from './schema.ts';
import { createUser } from './users.ts';
import { createHash } from 'node:crypto';

const base = { OIDC_ISSUER: 'https://auth.voorbeeld.test/application/o/tickory/', OIDC_CLIENT_ID: 'tickory', PUBLIC_URL: 'https://taken.voorbeeld.test/' };

test('configuratie: standaardwaarden, redirect uit PUBLIC_URL, scopes met openid, lijsten en vlaggen', () => {
  assert.equal(oidcConfigFrom({}), null, 'zonder OIDC_ISSUER staat het uit');
  const c = oidcConfigFrom(base)!;
  assert.equal(c.issuer, 'https://auth.voorbeeld.test/application/o/tickory');
  assert.equal(c.redirectUrl, 'https://taken.voorbeeld.test/api/v1/auth/oidc/callback');
  assert.deepEqual(c.scopes, ['openid', 'profile', 'email']);
  assert.equal(c.buttonName, 'SSO');
  assert.equal(c.clientSecret, '');
  assert.deepEqual([c.autoCreate, c.only, c.groupsClaim, c.allowedGroups, c.adminGroups], [false, false, 'groups', [], []]);
  const d = oidcConfigFrom({
    ...base, OIDC_SCOPES: 'profile email groups', OIDC_BUTTON_NAME: '  Authentik\u0007 ', OIDC_AUTO_CREATE: 'true', OIDC_ONLY: '1',
    OIDC_ALLOWED_GROUPS: 'tickory, familie ,', OIDC_ADMIN_GROUPS: 'beheer', OIDC_GROUPS_CLAIM: 'roles', OIDC_REDIRECT_URL: 'https://elders.voorbeeld.test/api/v1/auth/oidc/callback',
    OIDC_CLIENT_SECRET: 'geheim',
  })!;
  assert.deepEqual(d.scopes, ['openid', 'profile', 'email', 'groups']);
  assert.equal(d.buttonName, 'Authentik');
  assert.deepEqual([d.autoCreate, d.only, d.groupsClaim, d.allowedGroups, d.adminGroups], [true, true, 'roles', ['tickory', 'familie'], ['beheer']]);
  assert.equal(d.redirectUrl, 'https://elders.voorbeeld.test/api/v1/auth/oidc/callback');
  assert.equal(d.clientSecret, 'geheim');
  // een http-adres op het eigen netwerk voor Tickory zelf mag (de provider moet het toestaan), de issuer alleen https
  assert.equal(oidcConfigFrom({ ...base, PUBLIC_URL: 'http://192.168.1.10:8787' })!.redirectUrl, 'http://192.168.1.10:8787/api/v1/auth/oidc/callback');
  assert.equal(oidcConfigFrom({ ...base, OIDC_ISSUER: 'http://127.0.0.1:9000/realms/x' })!.issuer, 'http://127.0.0.1:9000/realms/x', 'localhost voor tests');
});

test('configuratie: onveilige of onvolledige instellingen stoppen de start met een duidelijke melding', () => {
  assert.throws(() => oidcConfigFrom({ ...base, OIDC_ISSUER: 'http://auth.voorbeeld.test' }), /https-adres/);
  assert.throws(() => oidcConfigFrom({ ...base, OIDC_ISSUER: 'https://gebruiker:wachtwoord@auth.voorbeeld.test' }), /https-adres/);
  assert.throws(() => oidcConfigFrom({ ...base, OIDC_ISSUER: 'https://auth.voorbeeld.test/?x=1' }), /https-adres/);
  assert.throws(() => oidcConfigFrom({ ...base, OIDC_CLIENT_ID: '' }), /OIDC_CLIENT_ID/);
  assert.throws(() => oidcConfigFrom({ ...base, PUBLIC_URL: '' }), /PUBLIC_URL/);
  assert.throws(() => oidcConfigFrom({ ...base, OIDC_REDIRECT_URL: 'https://taken.voorbeeld.test/elders' }), /eindigen op \/api\/v1\/auth\/oidc\/callback/);
  assert.throws(() => oidcConfigFrom({ ...base, OIDC_REDIRECT_URL: 'javascript:alert(1)' }), /OIDC_REDIRECT_URL/);
  assert.throws(() => oidcConfigFrom({ ...base, OIDC_SCOPES: 'openid "profiel"' }), /scope/);
  // het geheim uit een bestand (Docker-secret), zonder de eindregel
  const dir = mkdtempSync(join(tmpdir(), 'tickory-oidc-'));
  try {
    writeFileSync(join(dir, 'geheim'), 'uit-een-bestand\n');
    assert.equal(oidcConfigFrom({ ...base, OIDC_CLIENT_SECRET_FILE: join(dir, 'geheim') })!.clientSecret, 'uit-een-bestand');
    assert.throws(() => oidcConfigFrom({ ...base, OIDC_CLIENT_SECRET_FILE: join(dir, 'bestaat-niet') }), /OIDC_CLIENT_SECRET_FILE .* niet te lezen/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('safeUrl: alleen https zonder inloggegevens; http alleen naar localhost als dat mag', () => {
  assert.ok(safeUrl('https://auth.voorbeeld.test/token', false));
  for (const bad of ['http://auth.voorbeeld.test/token', 'https://a:b@auth.voorbeeld.test/', 'file:///etc/passwd', 'ftp://x', 'https://x/#frag', 42, null, `https://x/${'a'.repeat(2000)}`]) {
    assert.equal(safeUrl(bad, true), null, String(bad).slice(0, 40));
  }
  assert.ok(safeUrl('http://127.0.0.1:8080/token', true));
  assert.equal(safeUrl('http://127.0.0.1:8080/token', false), null);
  assert.equal(safeUrl('http://192.168.1.1/token', true), null, 'het eigen netwerk niet: alleen het toestel zelf');
});

const jwt = (header: object, payload: object, signer: (input: Buffer) => Buffer) => {
  const input = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  return `${input}.${signer(Buffer.from(input)).toString('base64url')}`;
};

test('handtekeningen: RS256, PS256, ES256, ES384 en EdDSA kloppen; de verkeerde sleutel, soort of lengte niet', () => {
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const ec384 = generateKeyPairSync('ec', { namedCurve: 'P-384' });
  const ed = generateKeyPairSync('ed25519');
  const jwk = (k: typeof rsa.publicKey, extra = {}) => ({ ...k.export({ format: 'jwk' }), ...extra }) as Record<string, unknown>;
  const cases: [string, Record<string, unknown>, (i: Buffer) => Buffer][] = [
    ['RS256', jwk(rsa.publicKey), (i) => sign('sha256', i, rsa.privateKey)],
    ['PS256', jwk(rsa.publicKey), (i) => sign('sha256', i, { key: rsa.privateKey, padding: 6, saltLength: 32 })],
    ['ES256', jwk(ec.publicKey), (i) => sign('sha256', i, { key: ec.privateKey, dsaEncoding: 'ieee-p1363' })],
    ['ES384', jwk(ec384.publicKey), (i) => sign('sha384', i, { key: ec384.privateKey, dsaEncoding: 'ieee-p1363' })],
    ['EdDSA', jwk(ed.publicKey), (i) => sign(null, i, ed.privateKey)],
  ];
  for (const [alg, key, signer] of cases) {
    const t = decodeJwt(jwt({ alg }, { sub: 'x' }, signer))!;
    assert.equal(verifySignature(alg, key, t.signingInput, t.signature), true, alg);
    const other = Buffer.from(t.signature);
    other[0] ^= 1;
    assert.equal(verifySignature(alg, key, t.signingInput, other), false, `${alg}: vervalst`);
    assert.equal(verifySignature(alg, key, Buffer.from(`${t.signingInput}x`), t.signature), false, `${alg}: andere inhoud`);
  }
  const t = decodeJwt(jwt({ alg: 'RS256' }, {}, (i) => sign('sha256', i, rsa.privateKey)))!;
  assert.equal(verifySignature('RS256', jwk(ec.publicKey), t.signingInput, t.signature), false, 'verkeerde soort sleutel');
  assert.equal(verifySignature('RS256', jwk(rsa.publicKey, { alg: 'RS512' }), t.signingInput, t.signature), false, 'de sleutel zegt een ander algoritme');
  assert.equal(verifySignature('RS256', jwk(rsa.publicKey, { use: 'enc' }), t.signingInput, t.signature), false, 'een sleutel voor versleutelen');
  assert.equal(verifySignature('RS256', { ...jwk(rsa.publicKey), d: 'geheim' }, t.signingInput, t.signature), false, 'een sleutel met privédelen nemen we niet');
  assert.equal(verifySignature('HS256', { kty: 'oct', k: 'geheim' }, t.signingInput, t.signature), false, 'HMAC nooit');
  assert.equal(verifySignature('none', jwk(rsa.publicKey), t.signingInput, Buffer.alloc(0)), false);
  // een te korte RSA-sleutel (1024 bits) vertrouwen we niet
  const weak = generateKeyPairSync('rsa', { modulusLength: 1024 });
  const tw = decodeJwt(jwt({ alg: 'RS256' }, {}, (i) => sign('sha256', i, weak.privateKey)))!;
  assert.equal(verifySignature('RS256', jwk(weak.publicKey), tw.signingInput, tw.signature), false);
  // ES256 met een handtekening van de verkeerde lengte (DER in plaats van r||s)
  const der = decodeJwt(jwt({ alg: 'ES256' }, {}, (i) => sign('sha256', i, ec.privateKey)))!;
  assert.equal(verifySignature('ES256', jwk(ec.publicKey), der.signingInput, der.signature), false);
});

test('decodeJwt: alleen drie base64url-delen met JSON-objecten, niet te groot; alg none zonder handtekening valt af', () => {
  for (const bad of ['', 'a.b', 'a.b.c.d', 'eyJ9.eyJ9.', `${'a'.repeat(17_000)}.b.c`, 'e30.W10.YQ', 42, null]) assert.equal(decodeJwt(bad), null, String(bad).slice(0, 20));
  assert.ok(decodeJwt('e30.e30.YQ'));
});

test('claims: iss, aud en azp, exp, iat, nbf met een klokspeling van 60 seconden, nonce en sub', () => {
  const now = Date.parse('2026-11-14T12:00:00Z');
  const s = now / 1000;
  const ok = { iss: 'https://i', aud: 'c', exp: s + 300, iat: s, nonce: 'n', sub: 'u' };
  const checks = { issuer: 'https://i', clientId: 'c', nonce: 'n', nowMs: now };
  assert.equal(claimProblem(ok, checks), null);
  const bad: [object, RegExp][] = [
    [{ iss: 'https://i/' }, /iss/], [{ aud: 'd' }, /aud/], [{ aud: ['d', 'e'] }, /aud/], [{ aud: [1] }, /aud/], [{ aud: ['c', 'd'] }, /azp ontbreekt/],
    [{ aud: ['c', 'd'], azp: 'd' }, /azp/], [{ azp: 'd' }, /azp/], [{ exp: s - 61 }, /verlopen/], [{ exp: '9999999999' }, /exp/],
    [{ iat: s + 61 }, /toekomst/], [{ iat: s - 661 }, /te oud/], [{ iat: undefined }, /iat/], [{ nbf: s + 61 }, /nbf/], [{ nbf: 'x' }, /nbf/],
    [{ nonce: 'm' }, /nonce/], [{ nonce: undefined }, /nonce/], [{ nonce: 'nn' }, /nonce/], [{ sub: '' }, /sub/], [{ sub: 'a\nb' }, /sub/], [{ sub: 'x'.repeat(256) }, /sub/], [{ sub: 5 }, /sub/],
  ];
  for (const [change, why] of bad) assert.match(claimProblem({ ...ok, ...change }, checks) ?? 'GEEN PROBLEEM', why, JSON.stringify(change));
  for (const fine of [{ exp: s - 59 }, { iat: s + 59 }, { nbf: s + 59 }, { aud: ['c', 'd'], azp: 'c' }, { aud: ['c'] }, { azp: 'c' }]) {
    assert.equal(claimProblem({ ...ok, ...fine }, checks), null, JSON.stringify(fine));
  }
});

test('PKCE: een verifier van 43 tekens en de S256-challenge daarvan', () => {
  const { verifier, challenge } = pkcePair();
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(challenge, createHash('sha256').update(verifier).digest('base64url'));
  assert.notEqual(pkcePair().verifier, verifier);
});

test('gebruikersnaam uit de claims: opgeschoond, uniek, nooit leeg; naam uit name of voor- en achternaam', () => {
  const none = () => false;
  assert.equal(usernameFromClaims({ preferred_username: 'anna' }, none), 'anna');
  assert.equal(usernameFromClaims({ preferred_username: 'Anna de Vries' }, none), 'Anna.de.Vries');
  assert.equal(usernameFromClaims({ preferred_username: '..@anna!!' }, none), 'anna');
  assert.equal(usernameFromClaims({ preferred_username: 'x', email: 'anna.devries@voorbeeld.test' }, none), 'anna.devries', 'te kort: dan het e-mailadres');
  assert.equal(usernameFromClaims({ name: 'Zoë IJsselmeer' }, none), 'Zoë.IJsselmeer');
  assert.equal(usernameFromClaims({}, none), 'gebruiker');
  assert.equal(usernameFromClaims({ preferred_username: '🙂🙂' }, none), 'gebruiker');
  assert.equal([...usernameFromClaims({ preferred_username: 'a'.repeat(80) }, none)].length, 34, 'ruimte voor -2 en verder binnen de 40 tekens');
  const taken = new Set(['anna', 'anna-2']);
  assert.equal(usernameFromClaims({ preferred_username: 'anna' }, (u) => taken.has(u)), 'anna-3');
  assert.match(usernameFromClaims({ preferred_username: 'anna' }, () => true), /^anna-[0-9a-f]{6}$/);
  assert.equal(displayNameFromClaims({ name: '  Anna   de Vries ' }, 'anna'), 'Anna de Vries');
  assert.equal(displayNameFromClaims({ given_name: 'Anna', family_name: 'de Vries' }, 'anna'), 'Anna de Vries');
  assert.equal(displayNameFromClaims({}, 'anna'), 'anna');
  assert.equal(displayNameFromClaims({ name: 'x'.repeat(101) }, 'anna'), 'anna');
});

test('groepen: een lijst, één tekst of een object (Zitadel); vergelijken is precies', () => {
  assert.deepEqual(groupsOf({ groups: ['a', 1, 'b'] }, 'groups'), ['a', 'b']);
  assert.deepEqual(groupsOf({ groups: 'a' }, 'groups'), ['a']);
  assert.deepEqual(groupsOf({ roles: { beheer: {}, lid: {} } }, 'roles'), ['beheer', 'lid']);
  assert.deepEqual(groupsOf({}, 'groups'), []);
  assert.equal(inAnyGroup(['Familie'], ['familie']), false);
  assert.equal(inAnyGroup(['familie', 'x'], ['familie']), true);
});

test('opslag: koppelingen zijn uniek (identiteit en account), eenmalige codes, opruimen; accounts zonder wachtwoord', () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const a = createUser(db, { username: 'anna', name: 'Anna', passwordHash: 'scrypt$1$1$1$x$y' });
  const b = createUser(db, { username: 'bert', name: 'Bert', passwordHash: NO_PASSWORD });
  const now = new Date().toISOString();
  linkIdentity(db, 'https://i', 'sub-a', a.id, now);
  assert.equal(userForIdentity(db, 'https://i', 'sub-a'), a.id);
  assert.equal(userForIdentity(db, 'https://ander', 'sub-a'), undefined, 'per issuer');
  assert.throws(() => linkIdentity(db, 'https://i', 'sub-a', b.id, now), /UNIQUE|PRIMARY/, 'een identiteit hoort bij één account');
  assert.throws(() => linkIdentity(db, 'https://i', 'sub-b', a.id, now), /UNIQUE/, 'een account heeft één identiteit per provider');
  assert.equal(hasPassword('scrypt$1$1$1$x$y'), true);
  assert.equal(hasPassword(NO_PASSWORD), false);
  const t = Date.now();
  const code = createLoginCode(db, { userId: a.id, kind: 'login', bindingHash: 'h', ttlMs: 60_000, nowMs: t });
  assert.match(code, /^tko_[A-Za-z0-9_-]{43}$/);
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM login_codes').all()).includes(code), 'alleen de hash in de database');
  assert.equal(takeLoginCode(db, code, t + 61_000), null, 'verlopen');
  assert.equal(takeLoginCode(db, code, t), null, 'en daarmee ook verbruikt');
  const c2 = createLoginCode(db, { userId: a.id, kind: 'emergency', bindingHash: null, ttlMs: 60_000, nowMs: t });
  assert.equal(takeLoginCode(db, c2, t)?.kind, 'emergency');
  assert.equal(takeLoginCode(db, c2, t), null, 'eenmalig');
  for (const bad of [undefined, 5, 'kort', 'x'.repeat(300)]) assert.equal(takeLoginCode(db, bad, t), null);
  createLoginCode(db, { userId: a.id, kind: 'login', bindingHash: null, ttlMs: 1000, nowMs: t - 5000 });
  createLoginCode(db, { userId: a.id, kind: 'login', bindingHash: null, ttlMs: 60_000, nowMs: t });
  assert.equal(pruneLoginCodes(db, t), 1);
});

test('migratie naar 9: een database van versie 8 krijgt de tabellen voor koppelingen en codes, de rest blijft', () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const a = createUser(db, { username: 'anna', name: 'Anna', passwordHash: 'scrypt$1$1$1$x$y' });
  db.exec('DROP TABLE oidc_identities; DROP TABLE login_codes');
  db.prepare("UPDATE meta SET value = '8' WHERE key = 'schema_version'").run();
  createSchema(db);
  createSchema(db);
  assert.equal(SCHEMA_VERSION, 9);
  assert.equal((db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as any).value, '9');
  linkIdentity(db, 'https://i', 'sub-a', a.id, new Date().toISOString());
  assert.equal(userForIdentity(db, 'https://i', 'sub-a'), a.id);
  assert.ok(createLoginCode(db, { userId: a.id, kind: 'login', bindingHash: null, ttlMs: 1000, nowMs: Date.now() }));
});
