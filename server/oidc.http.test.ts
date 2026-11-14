// Inloggen via OIDC over HTTP, tegen een nagebootste identiteitsprovider (fakeIdp.ts) met sleutels die de test zelf maakt:
// koppelen, inloggen, automatisch aanmaken, groepen, OIDC_ONLY en de noodcode, en alles wat geweigerd moet worden (verkeerde
// state, nonce, aud, iss, een verlopen token, een vervalste handtekening, alg none, de HMAC-truc), sleutelrotatie, de
// eenmalige code met zijn binding, de terugkeer naar de Android-app, de beperking van pogingen en wat er in het log komt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { AddressInfo } from 'node:net';
import { createApp } from './main.ts';
import { createSchema } from './schema.ts';
import { LoginLimiter, createUser, enableTwoFactor, getUserByName, hashPassword, setPasswordCostForTests } from './users.ts';
import { createOidcClient, oidcConfigFrom } from './oidc.ts';
import { appReturnPage, createLoginCode, EMERGENCY_MS, linkIdentity } from './sso.ts';
import { createSecretBox, newSecret } from './totp.ts';
import { startFakeIdp } from './fakeIdp.ts';

setPasswordCostForTests(1024);
const PW = 'een-goed-wachtwoord';

/** TOTP (RFC 6238) los van totp.ts uitgerekend. */
function totpCode(key: Buffer, ms: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(ms / 30_000)));
  const mac = createHmac('sha1', key).update(counter).digest();
  return String((mac.readUInt32BE(mac[19] & 15) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

async function world(o: { env?: Record<string, string>; clientSecret?: string | null; idpPath?: string; ssoLimiter?: LoginLimiter; timeoutMs?: number } = {}) {
  const idp = await startFakeIdp({ clientSecret: o.clientSecret, path: o.idpPath });
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const alice = createUser(db, { username: 'alice', name: 'Alice', passwordHash: await hashPassword(PW) }); // beheerder
  const bob = createUser(db, { username: 'bob', name: 'Bob', passwordHash: await hashPassword(PW) });
  const time = { shift: 0 };
  const clock = () => Date.now() + time.shift;
  const lines: string[] = [];
  const secretKey = randomBytes(32);
  const config = oidcConfigFrom({
    OIDC_ISSUER: idp.issuer, OIDC_CLIENT_ID: idp.clientId, OIDC_CLIENT_SECRET: idp.clientSecret ?? '', PUBLIC_URL: 'http://127.0.0.1:1', OIDC_BUTTON_NAME: 'Nep-IdP', ...o.env,
  })!;
  const oidc = createOidcClient(config, { clock, limits: { timeoutMs: o.timeoutMs ?? 2000 } });
  const roomy = () => new LoginLimiter({ pair: 500, ip: 500, user: 500 }, 900_000, clock);
  const app = createApp({
    db, oidc, clock, log: (l) => lines.push(l), secretKey, backup: null, sessionSweepMs: 0,
    limiter: roomy(), passwordLimiter: roomy(), codeLimiter: roomy(), ssoLimiter: o.ssoLimiter ?? roomy(),
  });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  config.redirectUrl = `${base}/api/v1/auth/oidc/callback`; // de poort is pas na het starten bekend
  const call = async (path: string, body?: unknown, token?: string) => {
    const r = await fetch(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: r.status, body: await r.json().catch(() => null) as any, headers: r.headers };
  };
  const passwordToken = async (u: string) => (await call('/api/v1/auth/login', { username: u, password: PW, device_name: 'Test' })).body.token as string;
  /** Leest de terugkeer van de callback: in de browser een omleiding naar `/#oidc=…`, voor de app een pagina met `tickory://oidc?…`. */
  const readReturn = async (r: Response): Promise<{ code?: string; error?: string; html?: string }> => {
    if (r.status === 302) {
      const loc = r.headers.get('location') ?? '';
      const m = /^\/#oidc=([A-Za-z0-9_-]+)$/.exec(loc) ?? null;
      const e = /^\/#oidc-error=([A-Z_]+)$/.exec(loc) ?? null;
      return m ? { code: m[1] } : e ? { error: e[1] } : { error: `onverwacht: ${loc}` };
    }
    const html = await r.text();
    const m = /href="tickory:\/\/oidc\?(code|error)=([A-Za-z0-9_-]+)"/.exec(html);
    return m ? { [m[1]]: m[2], html } : { error: `onverwacht: ${r.status}`, html };
  };
  /** De hele stroom zoals een browser hem doorloopt: begin, naar de provider, terug naar de callback. */
  const flow = async (f: { purpose?: 'login' | 'link'; client?: 'web' | 'app'; token?: string; password?: string; code?: string; lang?: string } = {}) => {
    const start = await call('/api/v1/auth/oidc/start', { purpose: f.purpose ?? 'login', client: f.client ?? 'web', device_name: 'Testtoestel', password: f.password, code: f.code, lang: f.lang }, f.token);
    if (start.status !== 200) return { start, ret: null as null | { code?: string; error?: string; html?: string }, binding: '', toIdp: '', toCallback: '' };
    const r1 = await fetch(`${base}${start.body.url}`, { redirect: 'manual' });
    const toIdp = r1.headers.get('location') ?? '';
    const r2 = await fetch(toIdp, { redirect: 'manual' });
    const toCallback = r2.headers.get('location') ?? '';
    const r3 = await fetch(toCallback, { redirect: 'manual', headers: { 'Accept-Language': 'nl-NL' } });
    return { start, ret: await readReturn(r3), binding: start.body.binding as string, toIdp, toCallback, r3 };
  };
  const handoff = (code: string, binding: string | undefined) => call('/api/v1/auth/login/handoff', { code, binding });
  /** Inloggen via SSO tot en met de sessie. */
  const ssoLogin = async (f: Parameters<typeof flow>[0] = {}) => {
    const r = await flow(f);
    const h = r.ret?.code ? await handoff(r.ret.code, r.binding) : null;
    return { ...r, handoff: h, error: r.ret?.error ?? null };
  };
  /** Koppelt alice (met haar wachtwoord) aan de identiteit `idp.user`. */
  const linkAlice = async () => {
    const token = await passwordToken('alice');
    const r = await flow({ purpose: 'link', token, password: PW });
    assert.ok(r.ret?.code, `koppelen gelukt (${JSON.stringify(r.ret ?? r.start.body)})`);
    assert.deepEqual((await handoff(r.ret!.code!, r.binding)).body, { linked: true, name: 'Nep-IdP' });
    return token;
  };
  const close = async () => { await app.close(); await idp.close(); };
  return { idp, db, alice, bob, time, lines, config, call, flow, handoff, ssoLogin, linkAlice, passwordToken, base, secretKey, close };
}

test('koppelen vanuit Account (met wachtwoord) en daarna inloggen via de provider: een gewone sessie', async () => {
  const w = await world();
  try {
    const methods = await w.call('/api/v1/auth/methods');
    assert.deepEqual(methods.body, { password: true, sso: { name: 'Nep-IdP' } });
    const token = await w.passwordToken('alice');
    assert.deepEqual((await w.call('/api/v1/auth/oidc/link', undefined, token)).body, {
      enabled: true, name: 'Nep-IdP', linked: false, linked_at: null, has_password: true, two_factor: false, can_unlink: false,
    });
    // zonder (juist) wachtwoord geen koppeling
    assert.equal((await w.flow({ purpose: 'link', token })).start.status, 403);
    assert.equal((await w.flow({ purpose: 'link', token, password: 'verkeerd-wachtwoord' })).start.status, 403);
    assert.equal((await w.flow({ purpose: 'link', password: PW })).start.status, 401, 'koppelen kan alleen aangemeld');
    await w.linkAlice();
    const status = (await w.call('/api/v1/auth/oidc/link', undefined, token)).body;
    assert.equal(status.linked, true);
    assert.equal(status.can_unlink, true);
    assert.equal((await w.flow({ purpose: 'link', token, password: PW })).start.status, 409, 'al gekoppeld');

    // het verzoek aan de provider: PKCE met S256, state, nonce, de juiste client en redirect, en de taal van de app
    const login = await w.ssoLogin({ lang: 'nl' });
    const q = w.idp.seen.authorize.at(-1)!;
    assert.equal(q.get('code_challenge_method'), 'S256');
    assert.match(q.get('code_challenge')!, /^[A-Za-z0-9_-]{43}$/);
    assert.match(q.get('state')!, /^[A-Za-z0-9_-]{43}$/);
    assert.match(q.get('nonce')!, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(q.get('client_id'), 'tickory-test');
    assert.equal(q.get('redirect_uri'), `${w.base}/api/v1/auth/oidc/callback`);
    assert.equal(q.get('scope'), 'openid profile email');
    assert.equal(q.get('ui_locales'), 'nl');
    assert.ok(new URL(login.toIdp).searchParams.get('state') !== new URL(w.idp.seen.authorize[0].get('redirect_uri')!).searchParams.get('state'));
    assert.deepEqual(w.idp.seen.tokenAuth.at(-1), 'basic', 'clientgeheim via client_secret_basic');

    assert.equal(login.handoff!.status, 200);
    assert.match(login.handoff!.body.token, /^tky_/);
    assert.equal(login.handoff!.body.me.username, 'alice');
    const me = await w.call('/api/v1/auth/me', undefined, login.handoff!.body.token);
    assert.equal(me.body.me.id, w.alice.id);
    const sessions = (await w.call('/api/v1/auth/sessions', undefined, login.handoff!.body.token)).body.sessions;
    assert.ok(sessions.some((s: any) => s.current && s.name === 'Testtoestel'), 'de naam van het apparaat uit het begin van de poging');
    // de eenmalige code werkt maar één keer
    assert.equal((await w.handoff(login.ret!.code!, login.binding)).status, 401);
    // het log noemt wie, maar nooit codes of tokens
    const log = w.lines.join('\n');
    assert.match(log, /"alice" heeft het account gekoppeld/);
    assert.match(log, /"alice" logt in via de identiteitsprovider/);
    for (const secret of [login.ret!.code!, login.binding, login.handoff!.body.token, new URL(login.toCallback).searchParams.get('code')!]) assert.ok(!log.includes(secret), 'geen geheimen in het log');
  } finally { await w.close(); }
});

test('de eenmalige code hoort bij de app die de poging begon: zonder of met een ander geheim (binding) werkt hij niet', async () => {
  const w = await world();
  try {
    await w.linkAlice();
    const a = await w.flow();
    assert.equal((await w.handoff(a.ret!.code!, 'ander-geheim-van-iemand-anders-0123456789')).status, 401);
    assert.equal((await w.handoff(a.ret!.code!, a.binding)).status, 401, 'na een mislukte poging is de code verbruikt');
    const b = await w.flow();
    const noBinding = await w.handoff(b.ret!.code!, undefined);
    assert.equal(noBinding.status, 401);
    assert.equal(noBinding.body.error_code, 'CODE_INVALID');
    // verlopen na twee minuten
    const c = await w.flow();
    w.time.shift += 121_000;
    assert.equal((await w.handoff(c.ret!.code!, c.binding)).status, 401);
    w.time.shift = 0;
    // een verzonnen code
    assert.equal((await w.handoff(`tko_${randomBytes(32).toString('base64url')}`, 'x')).status, 401);
  } finally { await w.close(); }
});

test('terugkeer naar de Android-app: een pagina met tickory://oidc?code=…, strenge CSP; de code werkt met het geheim van de app', async () => {
  const w = await world();
  try {
    await w.linkAlice();
    const r = await w.flow({ client: 'app' });
    assert.equal(r.r3!.status, 200);
    assert.equal(r.r3!.headers.get('cache-control'), 'no-store');
    assert.match(r.ret!.html!, /Terug naar Tickory/);
    // de pagina zelf (los van het netwerk: een filter als AdGuard herschrijft HTML onderweg)
    const page = appReturnPage({ code: 'tko_abc' }, 'en-US,en;q=0.9');
    assert.equal(page.headers['Content-Security-Policy'], "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    assert.equal(page.headers['Cache-Control'], 'no-store');
    assert.match(page.body, /<meta http-equiv="refresh" content="0;url=tickory:\/\/oidc\?code=tko_abc">/);
    assert.match(page.body, /<a href="tickory:\/\/oidc\?code=tko_abc">Back to Tickory<\/a>/);
    assert.match(appReturnPage({ error: 'NO_ACCOUNT' }, 'nl').body, /href="tickory:\/\/oidc\?error=NO_ACCOUNT">Terug naar Tickory/);
    assert.equal((await w.handoff(r.ret!.code!, r.binding)).status, 200);
    // een fout gaat ook terug naar de app
    w.idp.user = { sub: 'sub-onbekend', preferred_username: 'onbekend' };
    const e = await w.flow({ client: 'app' });
    assert.equal(e.ret!.error, 'NO_ACCOUNT');
  } finally { await w.close(); }
});

test('geweigerd: verkeerde of hergebruikte state, geannuleerd bij de provider, een andere issuer in de terugkeer', async () => {
  const w = await world();
  try {
    await w.linkAlice();
    const r = await w.flow();
    assert.ok(r.ret!.code);
    // dezelfde terugkeer nog een keer (de state is verbruikt)
    const again = await fetch(r.toCallback, { redirect: 'manual' });
    assert.equal(again.headers.get('location'), '/#oidc-error=EXPIRED');
    // een verzonnen state
    const fake = new URL(r.toCallback);
    fake.searchParams.set('state', randomBytes(32).toString('base64url'));
    assert.equal((await fetch(fake, { redirect: 'manual' })).headers.get('location'), '/#oidc-error=EXPIRED');
    assert.equal((await fetch(`${w.base}/api/v1/auth/oidc/callback`, { redirect: 'manual' })).headers.get('location'), '/#oidc-error=EXPIRED');
    assert.equal((await fetch(`${w.base}/api/v1/auth/oidc/authorize?state=bestaat-niet-bestaat-niet-bestaat`, { redirect: 'manual' })).headers.get('location'), '/#oidc-error=EXPIRED');
    // de code van de ene poging met de state van een andere: de code_verifier past niet (PKCE), dus geen token
    const one = await w.flow();
    const s2 = await w.call('/api/v1/auth/oidc/start', { purpose: 'login', client: 'web' });
    const toIdp2 = (await fetch(`${w.base}${s2.body.url}`, { redirect: 'manual' })).headers.get('location')!;
    const state2 = new URL(toIdp2).searchParams.get('state')!;
    const injected = new URL(one.toCallback);
    injected.searchParams.set('state', state2);
    // de code van poging één is al gebruikt; maak een nieuwe code bij poging één en spuit die in bij poging twee
    const s3 = await w.call('/api/v1/auth/oidc/start', { purpose: 'login', client: 'web' });
    const toIdp3 = (await fetch(`${w.base}${s3.body.url}`, { redirect: 'manual' })).headers.get('location')!;
    const back3 = new URL((await fetch(toIdp3, { redirect: 'manual' })).headers.get('location')!);
    back3.searchParams.set('state', state2);
    assert.equal((await fetch(back3, { redirect: 'manual' })).headers.get('location'), '/#oidc-error=PROVIDER', 'code-injectie: PKCE houdt het tegen');
    // een poging verloopt na tien minuten: het startadres en de terugkeer zeggen dan EXPIRED (ook met een geldige code van de provider)
    const late = await w.call('/api/v1/auth/oidc/start', { purpose: 'login', client: 'web' });
    const lateIdp = (await fetch(`${w.base}${late.body.url}`, { redirect: 'manual' })).headers.get('location')!;
    const lateBack = (await fetch(lateIdp, { redirect: 'manual' })).headers.get('location')!;
    w.time.shift += 10 * 60_000 + 1000;
    assert.equal((await fetch(`${w.base}${late.body.url}`, { redirect: 'manual' })).headers.get('location'), '/#oidc-error=EXPIRED');
    assert.equal((await fetch(lateBack, { redirect: 'manual' })).headers.get('location'), '/#oidc-error=EXPIRED');
    w.time.shift = 0;
    // geannuleerd
    w.idp.deny = true;
    assert.equal((await w.flow()).ret!.error, 'CANCELLED');
    w.idp.deny = false;
    // RFC 9207: een andere issuer in de terugkeer
    w.idp.addIss = true;
    assert.ok((await w.flow()).ret!.code, 'met de juiste iss gaat het goed');
    w.idp.issParam = 'https://aanvaller.voorbeeld.test';
    assert.equal((await w.flow()).ret!.error, 'PROVIDER');
  } finally { await w.close(); }
});

test('het ID-token: verkeerde nonce, aud, azp, iss, verlopen, uit de toekomst, nog niet geldig: allemaal geweigerd', async () => {
  const w = await world();
  try {
    await w.linkAlice();
    const now = () => Math.floor(Date.now() / 1000);
    const cases: [string, (c: Record<string, unknown>) => void][] = [
      ['nonce', (c) => { c.nonce = 'een-andere-nonce'; }],
      ['zonder nonce', (c) => { delete c.nonce; }],
      ['aud', (c) => { c.aud = 'een-andere-client'; }],
      ['aud-lijst zonder azp', (c) => { c.aud = ['tickory-test', 'nog-iemand']; }],
      ['azp', (c) => { c.azp = 'een-andere-client'; }],
      ['iss', (c) => { c.iss = 'https://aanvaller.voorbeeld.test'; }],
      ['verlopen', (c) => { c.exp = now() - 120; }],
      ['iat in de toekomst', (c) => { c.iat = now() + 600; }],
      ['te oud', (c) => { c.iat = now() - 3600; }],
      ['nbf', (c) => { c.nbf = now() + 600; }],
      ['zonder sub', (c) => { delete c.sub; }],
    ];
    const headers: [string, (h: Record<string, unknown>) => void][] = [
      ['typ at+jwt (een toegangstoken, geen ID-token)', (h) => { h.typ = 'at+jwt'; }],
      ['een onbekende kritieke kop', (h) => { h.crit = ['iets']; }],
      ['kid geen tekst', (h) => { h.kid = 5; }],
    ];
    for (const [name, change] of headers) {
      w.idp.tweak = (_c, h) => change(h);
      assert.equal((await w.ssoLogin()).error, 'PROVIDER', name);
    }
    for (const [name, tweak] of cases) {
      w.idp.tweak = tweak;
      const r = await w.ssoLogin();
      assert.equal(r.error, 'PROVIDER', name);
      assert.equal(r.handoff, null, name);
    }
    assert.match(w.lines.join('\n'), /nonce klopt niet/);
    assert.match(w.lines.join('\n'), /verlopen \(exp\)/);
    // binnen de klokspeling (60 s) wel
    w.idp.tweak = (c) => { c.exp = now() - 30; };
    assert.equal((await w.ssoLogin()).handoff?.status, 200);
    // een lijst met ontvangers mét de juiste azp: goed
    w.idp.tweak = (c) => { c.aud = ['tickory-test', 'nog-iemand']; c.azp = 'tickory-test'; };
    assert.equal((await w.ssoLogin()).handoff?.status, 200);
  } finally { await w.close(); }
});

test('handtekening: alg none, vervalst, HMAC met de publieke sleutel, een sleutel in de kop: geweigerd; RS256, ES256 en EdDSA werken', async () => {
  const w = await world();
  try {
    await w.linkAlice();
    w.idp.algNone = true;
    assert.equal((await w.ssoLogin()).error, 'PROVIDER', 'alg none');
    w.idp.algNone = false;
    w.idp.tamper = true;
    assert.equal((await w.ssoLogin()).error, 'PROVIDER', 'vervalste handtekening');
    w.idp.tamper = false;
    w.idp.hmacWithPublicKey = true;
    assert.equal((await w.ssoLogin()).error, 'PROVIDER', 'HS256 met de publieke sleutel als geheim');
    w.idp.hmacWithPublicKey = false;
    // een aanvaller zet zijn eigen sleutel in de kop (jwk) en tekent daarmee: die sleutel wordt nooit gebruikt
    const attacker = w.idp.addKey({ publish: false });
    w.idp.tweak = (_c, h) => { h.jwk = attacker.jwk; h.jku = 'https://aanvaller.voorbeeld.test/jwks'; };
    assert.equal((await w.ssoLogin()).error, 'PROVIDER', 'sleutel in de kop');
    w.idp.keys = w.idp.keys.filter((k) => k !== attacker);
    for (const kind of ['rsa', 'ec', 'ed'] as const) {
      w.idp.signWith = kind;
      assert.equal((await w.ssoLogin()).handoff?.status, 200, kind);
    }
    assert.match(w.lines.join('\n'), /handtekening klopt niet|niet toegestaan/);
  } finally { await w.close(); }
});

test('sleutels: een onbekende kid laat de JWKS opnieuw ophalen (begrensd); na rotatie werkt de nieuwe sleutel en de oude niet meer', async () => {
  const w = await world();
  try {
    await w.linkAlice();
    assert.equal((await w.ssoLogin()).handoff?.status, 200);
    const fetched = w.idp.seen.jwks;
    assert.equal((await w.ssoLogin()).handoff?.status, 200);
    assert.equal(w.idp.seen.jwks, fetched, 'de sleutels komen uit de cache');
    // een nieuwe sleutel, nog niet in de cache: binnen een halve minuut na het vorige ophalen niet opnieuw ophalen
    w.idp.addKey();
    assert.equal((await w.ssoLogin()).error, 'PROVIDER');
    assert.equal(w.idp.seen.jwks, fetched, 'niet bij elke onbekende kid opnieuw ophalen');
    w.time.shift += 31_000;
    assert.equal((await w.ssoLogin()).handoff?.status, 200, 'na de halve minuut: opnieuw opgehaald en gevonden');
    assert.equal(w.idp.seen.jwks, fetched + 1);
    // rotatie: de oude RSA-sleutels verdwijnen uit de JWKS
    const oldKid = w.idp.keys.filter((k) => k.alg === 'RS256').at(-1)!.kid;
    w.idp.rotate();
    w.time.shift += 31_000;
    assert.equal((await w.ssoLogin()).handoff?.status, 200, 'de nieuwe sleutel');
    w.idp.tweak = (_c, h) => { h.kid = oldKid; };
    assert.equal((await w.ssoLogin()).error, 'PROVIDER', 'een token met de oude kid (niet meer gepubliceerd) telt niet');
  } finally { await w.close(); }
});

test('onbekende identiteit: zonder OIDC_AUTO_CREATE geen toegang; nooit vanzelf gekoppeld op e-mail of gebruikersnaam', async () => {
  const w = await world();
  try {
    // dezelfde naam en hetzelfde e-mailadres als alice, maar een andere identiteit: geen toegang tot alice
    w.idp.user = { sub: 'sub-iemand-anders', preferred_username: 'alice', email: 'alice@voorbeeld.test', name: 'Alice' };
    const r = await w.ssoLogin();
    assert.equal(r.error, 'NO_ACCOUNT');
    assert.match(w.lines.join('\n'), /geen account gekoppeld/);
    assert.equal((w.db.prepare('SELECT COUNT(*) AS n FROM users').get() as any).n, 2);
  } finally { await w.close(); }
});

test('OIDC_AUTO_CREATE: een nieuw account (naam opgeschoond en uniek, zonder wachtwoord), nooit het bestaande account met dezelfde naam', async () => {
  const w = await world({ env: { OIDC_AUTO_CREATE: '1' } });
  try {
    w.idp.user = { sub: 'sub-alice-elders', preferred_username: 'alice', email: 'alice@voorbeeld.test', name: 'Alice Elders' };
    const r = await w.ssoLogin();
    assert.equal(r.handoff?.status, 200);
    assert.equal(r.handoff!.body.me.username, 'alice-2', 'een eigen account, niet dat van alice');
    assert.notEqual(r.handoff!.body.me.id, w.alice.id);
    assert.equal(r.handoff!.body.me.name, 'Alice Elders');
    assert.equal(r.handoff!.body.me.is_admin, false);
    // een vreemde naam wordt opgeschoond
    w.idp.user = { sub: 'sub-zoe', preferred_username: ' Zoë  van der Berg!? ', name: 'Zoë' };
    const z = await w.ssoLogin();
    assert.equal(z.handoff!.body.me.username, 'Zoë.van.der.Berg');
    // geen preferred_username: het deel voor de @
    w.idp.user = { sub: 'sub-mail', email: 'kees.jansen@voorbeeld.test' };
    assert.equal((await w.ssoLogin()).handoff!.body.me.username, 'kees.jansen');
    // de tweede keer: hetzelfde account, geen nieuw
    const again = await w.ssoLogin();
    assert.equal(again.handoff!.body.me.username, 'kees.jansen');
    assert.equal((w.db.prepare('SELECT COUNT(*) AS n FROM users').get() as any).n, 5);
    // een account zonder wachtwoord kan niet met een wachtwoord inloggen, en niet ontkoppelen (de enige manier)
    const kees = getUserByName(w.db, 'kees.jansen')!;
    assert.equal(kees.password_hash, '!sso');
    assert.equal((await w.call('/api/v1/auth/login', { username: 'kees.jansen', password: '!sso', device_name: 'x' })).status, 401);
    const token = again.handoff!.body.token;
    const st = (await w.call('/api/v1/auth/oidc/link', undefined, token)).body;
    assert.equal(st.has_password, false);
    assert.equal(st.can_unlink, false);
    assert.equal((await w.call('/api/v1/auth/oidc/unlink', {}, token)).status, 409);
    assert.match(w.lines.join('\n'), /nieuw account "alice-2" aangemaakt/);
  } finally { await w.close(); }
});

test('groepen: OIDC_ALLOWED_GROUPS laat alleen leden binnen, OIDC_ADMIN_GROUPS maakt beheerder en neemt het af (de laatste beheerder blijft)', async () => {
  const w = await world({ env: { OIDC_AUTO_CREATE: '1', OIDC_ALLOWED_GROUPS: 'tickory, familie', OIDC_ADMIN_GROUPS: 'tickory-admins' } });
  try {
    w.idp.user = { sub: 'sub-buiten', preferred_username: 'buiten', groups: ['anders'] };
    assert.equal((await w.ssoLogin()).error, 'NOT_ALLOWED');
    w.idp.user = { sub: 'sub-zonder', preferred_username: 'zonder' };
    assert.equal((await w.ssoLogin()).error, 'NOT_ALLOWED', 'zonder groepen ook niet');
    assert.equal((w.db.prepare("SELECT COUNT(*) AS n FROM users WHERE username IN ('buiten', 'zonder')").get() as any).n, 0, 'geen account aangemaakt');
    w.idp.user = { sub: 'sub-carol', preferred_username: 'carol', groups: ['familie'] };
    const c = await w.ssoLogin();
    assert.equal(c.handoff!.body.me.is_admin, false);
    w.idp.user.groups = ['familie', 'tickory-admins'];
    assert.equal((await w.ssoLogin()).handoff!.body.me.is_admin, true, 'nu beheerder');
    w.idp.user.groups = ['familie'];
    assert.equal((await w.ssoLogin()).handoff!.body.me.is_admin, false, 'niet meer');
    assert.match(w.lines.join('\n'), /"carol" is nu beheerder/);
    // alice is de enige andere beheerder: zij blijft het, ook zonder de groep
    w.db.prepare("UPDATE users SET is_admin = 0 WHERE username = 'carol'").run();
    w.idp.user = { sub: 'sub-alice', preferred_username: 'alice', groups: ['tickory'] };
    linkIdentity(w.db, w.config.issuer, 'sub-alice', w.alice.id, new Date().toISOString());
    assert.equal((await w.ssoLogin()).handoff!.body.me.is_admin, true, 'de laatste beheerder blijft beheerder');
    assert.match(w.lines.join('\n'), /"alice" blijft beheerder/);
    // groepen die alleen in userinfo staan (zoals bij Authelia) tellen ook, maar alleen als userinfo over dezelfde sub gaat
    w.idp.user = { sub: 'sub-dirk', preferred_username: 'dirk' };
    w.idp.userinfo = { groups: ['tickory'] };
    w.idp.userinfoSub = 'sub-iemand-anders';
    assert.equal((await w.ssoLogin()).error, 'NOT_ALLOWED', 'userinfo van een andere sub telt niet');
    w.idp.userinfoSub = null;
    assert.equal((await w.ssoLogin()).handoff?.status, 200);
  } finally { await w.close(); }
});

test('koppelen: een identiteit die al bij een ander account hoort, kan niet; ontkoppelen zelf en door een beheerder', async () => {
  const w = await world();
  try {
    const aliceToken = await w.linkAlice();
    const bobToken = await w.passwordToken('bob');
    const r = await w.flow({ purpose: 'link', token: bobToken, password: PW });
    assert.equal(r.ret!.error, 'ALREADY_LINKED');
    assert.equal((await w.call('/api/v1/auth/oidc/link', undefined, bobToken)).body.linked, false);
    // beheer: de lijst toont de koppeling; een beheerder kan hem weghalen
    const users = (await w.call('/api/v1/admin/users', undefined, aliceToken)).body.users;
    assert.equal(users.find((u: any) => u.username === 'alice').sso, true);
    assert.equal(users.find((u: any) => u.username === 'bob').sso, false);
    // zelf ontkoppelen (alice heeft een wachtwoord)
    const un = await w.call('/api/v1/auth/oidc/unlink', {}, aliceToken);
    assert.equal(un.status, 200);
    assert.equal(un.body.linked, false);
    assert.equal((await w.ssoLogin()).error, 'NO_ACCOUNT', 'na ontkoppelen geen toegang meer via de provider');
    // nu kan bob de identiteit wel koppelen; de beheerder haalt het weer weg
    const rb = await w.flow({ purpose: 'link', token: bobToken, password: PW });
    assert.ok(rb.ret!.code);
    const admin = await w.call('/api/v1/admin/users/sso-unlink', { id: w.bob.id }, aliceToken);
    assert.equal(admin.body.user.sso, false);
    assert.match(w.lines.join('\n'), /koppeling met de identiteitsprovider van "bob" verwijderd door beheerder "alice"/);
    assert.equal((await w.call('/api/v1/admin/users/sso-unlink', { id: w.bob.id }, bobToken)).status, 403, 'alleen voor beheerders');
    // koppelen terwijl de sessie die het begon intussen is afgemeld: niet gekoppeld
    const s = await w.call('/api/v1/auth/oidc/start', { purpose: 'link', client: 'web', password: PW }, bobToken);
    const toIdp = (await fetch(`${w.base}${s.body.url}`, { redirect: 'manual' })).headers.get('location')!;
    const back = (await fetch(toIdp, { redirect: 'manual' })).headers.get('location')!;
    await w.call('/api/v1/auth/logout', {}, bobToken);
    assert.equal((await fetch(back, { redirect: 'manual' })).headers.get('location'), '/#oidc-error=EXPIRED');
    assert.equal((w.db.prepare('SELECT COUNT(*) AS n FROM oidc_identities WHERE user_id = ?').get(w.bob.id) as any).n, 0);
  } finally { await w.close(); }
});

test('koppelen met tweestapsverificatie vraagt ook de code; de 2FA van Tickory geldt niet bij inloggen via de provider', async () => {
  const w = await world();
  try {
    const box = createSecretBox(w.secretKey);
    const key = newSecret();
    enableTwoFactor(w.db, w.alice.id, box.seal(key, w.alice.id), 0, [], new Date().toISOString());
    // inloggen met wachtwoord geeft nu eerst een tussentoken; maak daarom zelf een sessie via de tweede stap
    const first = await w.call('/api/v1/auth/login', { username: 'alice', password: PW, device_name: 'Test' });
    assert.equal(first.body.two_factor_required, true);
    const token = (await w.call('/api/v1/auth/login/2fa', { challenge: first.body.challenge, code: totpCode(key, Date.now()) })).body.token;
    assert.equal((await w.call('/api/v1/auth/oidc/link', undefined, token)).body.two_factor, true);
    assert.equal((await w.flow({ purpose: 'link', token, password: PW })).start.status, 403, 'zonder code niet');
    const ok = await w.flow({ purpose: 'link', token, password: PW, code: totpCode(key, Date.now() + 30_000) }); // het volgende tijdvak: het huidige is gebruikt
    assert.ok(ok.ret?.code, JSON.stringify(ok.start.body));
    assert.equal((await w.handoff(ok.ret!.code!, ok.binding)).body.linked, true);
    const login = await w.ssoLogin();
    assert.equal(login.handoff?.status, 200, 'via de provider geen tweede stap van Tickory');
    assert.ok(login.handoff!.body.token);
  } finally { await w.close(); }
});

test('OIDC_ONLY: inloggen met een wachtwoord staat uit, ontkoppelen kan niet; de noodcode van de opdrachtregel werkt (eenmalig)', async () => {
  const w = await world({ env: { OIDC_ONLY: '1' } });
  try {
    assert.deepEqual((await w.call('/api/v1/auth/methods')).body, { password: false, sso: { name: 'Nep-IdP' } });
    const pw = await w.call('/api/v1/auth/login', { username: 'alice', password: PW, device_name: 'Test' });
    assert.equal(pw.status, 403);
    assert.equal(pw.body.error_code, 'PASSWORD_LOGIN_OFF');
    assert.equal((await w.call('/api/v1/auth/login/2fa', { challenge: 'x', code: '123456' })).body.error_code, 'PASSWORD_LOGIN_OFF');
    // de noodroute: `node server/main.ts user signin-code alice` maakt zo'n code
    const code = createLoginCode(w.db, { userId: w.alice.id, kind: 'emergency', bindingHash: null, device: 'Noodcode', ttlMs: EMERGENCY_MS, nowMs: Date.now() });
    const h = await w.handoff(code, undefined);
    assert.equal(h.status, 200);
    assert.equal(h.body.me.username, 'alice');
    assert.equal((await w.handoff(code, undefined)).status, 401, 'eenmalig');
    assert.match(w.lines.join('\n'), /"alice" is ingelogd met een noodcode/);
    const token = h.body.token;
    // koppelen kan (met wachtwoord), ontkoppelen niet: dan kan alice niet meer inloggen
    const link = await w.flow({ purpose: 'link', token, password: PW });
    assert.ok(link.ret?.code);
    const st = (await w.call('/api/v1/auth/oidc/link', undefined, token)).body;
    assert.equal(st.linked, true);
    assert.equal(st.can_unlink, false);
    assert.equal((await w.call('/api/v1/auth/oidc/unlink', {}, token)).status, 409);
    assert.equal((await w.ssoLogin()).handoff?.status, 200);
    // een verlopen noodcode
    const old = createLoginCode(w.db, { userId: w.alice.id, kind: 'emergency', bindingHash: null, ttlMs: EMERGENCY_MS, nowMs: Date.now() - EMERGENCY_MS - 1000 });
    assert.equal((await w.handoff(old, undefined)).status, 401);
  } finally { await w.close(); }
});

test('een geblokkeerd account komt er via de provider niet in; de terugkeer zegt dat zonder details', async () => {
  const w = await world();
  try {
    await w.linkAlice();
    const a = await w.flow();
    w.db.prepare('UPDATE users SET is_disabled = 1 WHERE id = ?').run(w.alice.id);
    assert.equal((await w.handoff(a.ret!.code!, a.binding)).status, 401, 'geblokkeerd na de terugkeer: de code werkt niet meer');
    assert.equal((await w.ssoLogin()).error, 'DISABLED');
  } finally { await w.close(); }
});

test('beperking: te veel mislukte terugkeren of pogingen vanaf één adres geven TOO_MANY_ATTEMPTS; een gelukte poging telt niet mee', async () => {
  const w = await world({ ssoLimiter: new LoginLimiter({ pair: 6, ip: 6, user: 1000 }, 900_000) });
  try {
    await w.linkAlice(); // begin, terugkeer en inwisselen: geven hun plek terug
    for (let i = 0; i < 3; i++) assert.equal((await w.ssoLogin()).handoff?.status, 200, `gelukte poging ${i}`);
    const bad = `${w.base}/api/v1/auth/oidc/callback?state=${randomBytes(32).toString('base64url')}&code=x`;
    for (let i = 0; i < 6; i++) assert.equal((await fetch(bad, { redirect: 'manual' })).headers.get('location'), '/#oidc-error=EXPIRED');
    assert.equal((await fetch(bad, { redirect: 'manual' })).headers.get('location'), '/#oidc-error=TOO_MANY_ATTEMPTS');
    const start = await w.call('/api/v1/auth/oidc/start', { purpose: 'login', client: 'web' });
    assert.equal(start.status, 429);
    assert.ok(Number(start.headers.get('retry-after')) > 0);
    assert.equal((await w.handoff('tko_xxxxxxxxxxxxxxxxxxxxxxxxxx', 'x')).status, 429);
  } finally { await w.close(); }
});

test('de provider: een publieke client (alleen PKCE), client_secret_post, een fout geheim, en een issuer met schuine streep', async () => {
  const pub = await world({ clientSecret: null });
  try {
    await pub.linkAlice();
    assert.equal(pub.idp.seen.tokenAuth.at(-1), 'none');
  } finally { await pub.close(); }
  const post = await world({ idpPath: '/application/o/tickory/' });
  try {
    post.idp.authMethods = ['client_secret_post'];
    await post.linkAlice();
    assert.equal(post.idp.seen.tokenAuth.at(-1), 'post', 'alleen client_secret_post: dan zo');
    post.idp.clientSecret = 'een-ander-geheim';
    assert.equal((await post.ssoLogin()).error, 'PROVIDER');
    assert.match(post.lines.join('\n'), /tokeneindpunt gaf HTTP 401 \(invalid_client\)/);
  } finally { await post.close(); }
});

test('een trage, onbereikbare of te grote provider: een tijdslimiet en een groottegrens; de app krijgt een nette melding', async () => {
  const w = await world({ timeoutMs: 300 });
  try {
    w.idp.slow.add('discovery');
    const s = await w.call('/api/v1/auth/oidc/start', { purpose: 'login', client: 'web' });
    assert.equal(s.status, 503);
    assert.equal(s.body.error_code, 'UNAVAILABLE');
    assert.match(w.lines.join('\n'), /te traag/);
    w.idp.slow.clear();
    w.idp.huge.add('discovery');
    assert.equal((await w.call('/api/v1/auth/oidc/start', { purpose: 'login', client: 'web' })).status, 503);
    assert.match(w.lines.join('\n'), /te groot/);
    w.idp.huge.clear();
    w.idp.discoveryIssuer = 'https://aanvaller.voorbeeld.test/realms/test';
    assert.equal((await w.call('/api/v1/auth/oidc/start', { purpose: 'login', client: 'web' })).status, 503, 'de discovery noemt een andere issuer');
    assert.match(w.lines.join('\n'), /discovery noemt een andere issuer/);
    w.idp.discoveryIssuer = null;
    w.idp.redirect.add('discovery');
    assert.equal((await w.call('/api/v1/auth/oidc/start', { purpose: 'login', client: 'web' })).status, 503, 'een omleiding wordt niet gevolgd');
    w.idp.redirect.clear();
    await w.linkAlice();
    w.idp.slow.add('token');
    assert.equal((await w.ssoLogin()).error, 'UNAVAILABLE');
    w.idp.slow.clear();
    w.idp.huge.add('jwks');
    w.time.shift += 31_000;
    w.idp.addKey();
    assert.equal((await w.ssoLogin()).error, 'UNAVAILABLE');
  } finally { await w.close(); }
});

test('zonder OIDC: methods zegt alleen wachtwoord, de eindpunten bestaan niet, de noodcode werkt wel', async () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const alice = createUser(db, { username: 'alice', name: 'Alice', passwordHash: await hashPassword(PW) });
  const app = createApp({ db, backup: null, sessionSweepMs: 0, log: () => {} });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  try {
    assert.deepEqual(await (await fetch(`${base}/api/v1/auth/methods`)).json(), { password: true, sso: null });
    assert.equal((await fetch(`${base}/api/v1/auth/oidc/start`, { method: 'POST', body: '{}' })).status, 401);
    assert.equal((await fetch(`${base}/api/v1/auth/oidc/callback`)).status, 401);
    const code = createLoginCode(db, { userId: alice.id, kind: 'emergency', bindingHash: null, ttlMs: EMERGENCY_MS, nowMs: Date.now() });
    const h = await fetch(`${base}/api/v1/auth/login/handoff`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    assert.equal(h.status, 200);
    const token = ((await h.json()) as any).token;
    assert.deepEqual(await (await fetch(`${base}/api/v1/auth/oidc/link`, { headers: { Authorization: `Bearer ${token}` } })).json(), { enabled: false });
  } finally { await app.close(); }
});
