// Koppelcodes over HTTP (pairing.ts): een code maken vanuit een ingelogde sessie (met wachtwoord en zo nodig de code van
// tweestapsverificatie), inwisselen voor een eigen sessie (de browserextensie), eenmalig, kort geldig, alleen voor jezelf, met
// grenzen; een server met alleen SSO; geen CORS voor extensies; en een toegangsfuzz met drie mensen en een gok-aanvaller.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from './main.ts';
import type { AppOptions } from './main.ts';
import { createSchema } from './schema.ts';
import { LoginLimiter, createUser, hashPassword, setPasswordCostForTests, updateUser } from './users.ts';
import { NO_PASSWORD, createLoginCode } from './sso.ts';
import { PAIR_CODES_PER_HOUR, PAIR_MS, newPairCode, normalizePairCode } from './pairing.ts';
import type { OidcClient } from './oidc.ts';

setPasswordCostForTests(1024);
const PW = 'een-goed-wachtwoord';
const T0 = Date.parse('2026-11-14T10:00:10Z');
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
const FIREFOX_UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:150.0) Gecko/20100101 Firefox/150.0';
const CODE_RE = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/;

/** Een eigen TOTP (RFC 6238), los van totp.ts. */
function totp(secretB32: string, ms: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secretB32) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(ms / 30_000)));
  const mac = createHmac('sha1', key).update(counter).digest();
  const o = mac[19] & 15;
  return String((mac.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

async function world(extra: Partial<AppOptions> = {}) {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const hash = await hashPassword(PW);
  const alice = createUser(db, { username: 'alice', name: 'Alice', passwordHash: hash });
  const bob = createUser(db, { username: 'bob', name: 'Bob', passwordHash: hash });
  const sso = createUser(db, { username: 'sanne', name: 'Sanne', passwordHash: NO_PASSWORD }); // gemaakt via SSO, zonder wachtwoord
  const clock = { now: T0 };
  const lines: string[] = [];
  const app = createApp({
    db, clock: () => clock.now, log: (l) => lines.push(l), secretKey: randomBytes(32), backup: null, sessionSweepMs: 0,
    limiter: new LoginLimiter({ pair: 500, ip: 5000, user: 5000 }, 900_000, () => clock.now),
    passwordLimiter: new LoginLimiter({ pair: 500, ip: 5000, user: 5000 }, 900_000, () => clock.now),
    codeLimiter: new LoginLimiter({ pair: 500, ip: 5000, user: 5000 }, 900_000, () => clock.now),
    pairLimiter: new LoginLimiter({ pair: 10, ip: 10, user: 1_000_000 }, 900_000, () => clock.now),
    ...extra,
  });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const call = async (path: string, body?: unknown, token?: string, headers: Record<string, string> = {}, method?: string) => {
    const r = await fetch(`${base}${path}`, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await r.text();
    return { status: r.status, headers: r.headers, body: (text ? JSON.parse(text) : null) as any };
  };
  const tokenOf = async (u: string) => {
    const r = await call('/api/v1/auth/login', { username: u, password: PW, device_name: 'Web' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.token as string;
  };
  /** Maakt een koppelcode (met het wachtwoord, zoals de web-app dat vraagt). */
  const makeCode = async (token: string, body: Record<string, unknown> = { password: PW }) => call('/api/v1/auth/pair-code', body, token);
  const redeem = (code: unknown, headers: Record<string, string> = { 'User-Agent': CHROME_UA, Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' }, device_name = 'Browserextensie (Chrome)') =>
    call('/api/v1/auth/pair', { code, device_name }, undefined, headers);
  return { db, app, alice, bob, sso, clock, lines, call, tokenOf, makeCode, redeem, close: () => app.close() };
}

test('een koppelcode heeft 16 tekens Crockford-base32 in groepjes van vier, en wordt bij invoeren vergevingsgezind gelezen', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const c = newPairCode();
    assert.match(c, CODE_RE);
    seen.add(c);
  }
  assert.equal(seen.size, 200, 'willekeurig');
  // de bits komen netjes over: tien nullen zijn zestien nullen, tien keer 0xff zestien keer Z
  assert.equal(newPairCode(new Uint8Array(10)), '0000-0000-0000-0000');
  assert.equal(newPairCode(new Uint8Array(10).fill(255)), 'ZZZZ-ZZZZ-ZZZZ-ZZZZ');
  assert.equal(newPairCode(Uint8Array.from([0x08, 0x42, 0x10, 0x84, 0x21, 0x08, 0x42, 0x10, 0x84, 0x21])), '1111-1111-1111-1111');
  assert.equal(normalizePairCode('ABCD-EFGH-JKMN-PQRS'), 'ABCDEFGHJKMNPQRS');
  assert.equal(normalizePairCode('  abcd efgh  jkmn-pqrs '), 'ABCDEFGHJKMNPQRS', 'kleine letters, spaties');
  assert.equal(normalizePairCode('O0IL-1111-1111-1111'), '0011111111111111', 'O is 0, I en L zijn 1');
  assert.equal(normalizePairCode('ABCD-EFGH-JKMN-PQR'), null, 'te kort');
  assert.equal(normalizePairCode('ABCD-EFGH-JKMN-PQRST'), null, 'te lang');
  assert.equal(normalizePairCode('ABCD-EFGH-JKMN-PQRU'), null, 'U bestaat niet');
  assert.equal(normalizePairCode('ABCD_EFGH_JKMN_PQRS'), null, 'alleen spaties en streepjes vallen weg');
  assert.equal(normalizePairCode(`ABCDEFGHJKMNPQRS${' '.repeat(60)}`), null, 'te lange invoer');
  for (const v of [null, undefined, 42, {}, ['ABCDEFGHJKMNPQRS']]) assert.equal(normalizePairCode(v), null);
});

test('koppelen: wachtwoord eerst, dan een code die één keer een eigen sessie geeft, zichtbaar als browserextensie', async () => {
  const w = await world();
  try {
    const web = await w.tokenOf('alice');
    assert.deepEqual((await w.call('/api/v1/auth/pair-code', undefined, web)).body, { password: true, code: false, expires_in: 600 });
    const noPassword = await w.makeCode(web, {});
    assert.equal(noPassword.status, 403);
    assert.equal(noPassword.body.error_code, 'FORBIDDEN');
    assert.equal((await w.makeCode(web, { password: 'verkeerd-wachtwoord' })).status, 403);
    const made = await w.makeCode(web);
    assert.equal(made.status, 200);
    assert.match(made.body.code, CODE_RE);
    assert.equal(made.body.expires_in, PAIR_MS / 1000);
    // alleen de hash staat in de database
    const rows = w.db.prepare("SELECT code_hash, kind, user_id FROM login_codes WHERE kind = 'pair'").all() as { code_hash: string; user_id: string }[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].user_id, w.alice.id);
    assert.ok(!JSON.stringify(rows).includes(normalizePairCode(made.body.code)!), 'de code zelf staat er niet in');
    assert.ok(!JSON.stringify(rows).includes(made.body.code));

    // inwisselen met kleine letters en spaties, zoals iemand hem overtypt
    const typed = made.body.code.toLowerCase().replace(/-/g, ' ');
    const r = await w.redeem(typed);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match(r.body.token, /^tky_/);
    assert.equal(r.body.me.username, 'alice');
    assert.equal(r.headers.get('access-control-allow-origin'), null, 'geen CORS: de extensie gebruikt haar toestemming voor de host');
    const sessions = (await w.call('/api/v1/auth/sessions', undefined, web)).body.sessions as any[];
    const ext = sessions.find((s) => s.id === r.body.session_id);
    assert.equal(ext.name, 'Browserextensie (Chrome)');
    assert.deepEqual(ext.device, { kind: 'extension', browser: 'Chrome', os: 'Windows' });
    assert.equal((await w.call('/api/v1/sync', { sync_token: '*', resource_types: ['projects'] }, r.body.token)).status, 200, 'de sessie werkt');

    // eenmalig
    const again = await w.redeem(made.body.code);
    assert.equal(again.status, 401);
    assert.equal(again.body.error_code, 'CODE_INVALID');
    assert.equal((w.db.prepare("SELECT COUNT(*) AS n FROM login_codes WHERE kind = 'pair'").get() as { n: number }).n, 0);
    // in de logregels staat wie, nooit de code
    assert.ok(w.lines.some((l) => l.includes('"alice" heeft een apparaat gekoppeld met een koppelcode')));
    assert.ok(w.lines.every((l) => !l.includes(made.body.code) && !l.includes(normalizePairCode(made.body.code)!)));

    // uitloggen in de extensie trekt alleen die sessie in
    assert.equal((await w.call('/api/v1/auth/logout', {}, r.body.token)).status, 200);
    assert.equal((await w.call('/api/v1/auth/me', undefined, r.body.token)).status, 401);
    assert.equal((await w.call('/api/v1/auth/me', undefined, web)).status, 200);
  } finally {
    await w.close();
  }
});

test('een koppelcode verloopt na 10 minuten, vervalt met de sessie die hem maakte, en er is er één tegelijk', async () => {
  const w = await world();
  try {
    const web = await w.tokenOf('alice');
    const late = (await w.makeCode(web)).body.code;
    w.clock.now += PAIR_MS + 1000;
    assert.equal((await w.redeem(late)).body.error_code, 'CODE_INVALID', 'verlopen');

    const almost = (await w.makeCode(web)).body.code;
    w.clock.now += PAIR_MS - 1000;
    assert.equal((await w.redeem(almost)).status, 200, 'net op tijd');

    // een nieuwe code vervangt de vorige
    const first = (await w.makeCode(web)).body.code;
    const second = (await w.makeCode(web)).body.code;
    assert.equal((await w.redeem(first)).status, 401);
    assert.equal((await w.redeem(second)).status, 200);

    // afmelden van de sessie die hem maakte, maakt de code waardeloos
    const other = await w.tokenOf('alice');
    const orphan = (await w.makeCode(other)).body.code;
    assert.equal((await w.call('/api/v1/auth/logout', {}, other)).status, 200);
    assert.equal((await w.redeem(orphan)).status, 401);

    // een geblokkeerd account koppelt niets
    const blocked = (await w.makeCode(await w.tokenOf('bob'))).body.code;
    updateUser(w.db, w.bob.id, { is_disabled: true });
    assert.equal((await w.redeem(blocked)).status, 401);
  } finally {
    await w.close();
  }
});

test('met tweestapsverificatie ook de code; een account zonder wachtwoord heeft alleen de sessie', async () => {
  const w = await world();
  try {
    const web = await w.tokenOf('alice');
    const { secret } = (await w.call('/api/v1/auth/2fa/setup', { password: PW }, web)).body;
    assert.equal((await w.call('/api/v1/auth/2fa/enable', { code: totp(secret, w.clock.now) }, web)).status, 200);
    w.clock.now += 30_000;
    assert.deepEqual((await w.call('/api/v1/auth/pair-code', undefined, web)).body, { password: true, code: true, expires_in: 600 });
    assert.equal((await w.makeCode(web, { password: PW })).body.error_code, 'INVALID_CODE', 'zonder code');
    assert.equal((await w.makeCode(web, { password: PW, code: '000000' })).body.error_code, 'INVALID_CODE');
    assert.equal((await w.makeCode(web, { password: 'fout-wachtwoord', code: totp(secret, w.clock.now) })).body.error_code, 'FORBIDDEN');
    const ok = await w.makeCode(web, { password: PW, code: totp(secret, w.clock.now) });
    assert.equal(ok.status, 200);
    assert.equal((await w.redeem(ok.body.code)).status, 200);

    // Sanne heeft geen wachtwoord (gemaakt via SSO): haar sessie is genoeg
    const sanneToken = 'tky_' + randomBytes(32).toString('base64url');
    const sessionId = 'sessie-sanne-1';
    w.db.prepare('INSERT INTO sessions (id, user_id, token_hash, name, created_at, last_used_at, device) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(sessionId, w.sso.id, createHash('sha256').update(sanneToken).digest('hex'), 'SSO', new Date(w.clock.now).toISOString(), new Date(w.clock.now).toISOString(), 'browser//');
    assert.deepEqual((await w.call('/api/v1/auth/pair-code', undefined, sanneToken)).body, { password: false, code: false, expires_in: 600 });
    const hers = await w.makeCode(sanneToken, {});
    assert.equal(hers.status, 200);
    const r = await w.redeem(hers.body.code, { 'User-Agent': FIREFOX_UA, Origin: 'moz-extension://0d3b7c1e-1111-4222-8333-444455556666' }, 'Browserextensie (Firefox)');
    assert.equal(r.status, 200);
    assert.equal(r.body.me.username, 'sanne', 'de code geeft een sessie van wie hem maakte');
    const sessions = (await w.call('/api/v1/auth/sessions', undefined, sanneToken)).body.sessions as any[];
    assert.deepEqual(sessions.find((s) => s.id === r.body.session_id).device, { kind: 'extension', browser: 'Firefox', os: 'Linux' });
  } finally {
    await w.close();
  }
});

test('op een server met alleen SSO (OIDC_ONLY) werkt koppelen, inloggen met een wachtwoord niet', async () => {
  const config = { issuer: 'https://idp.invalid', clientId: 'x', clientSecret: '', redirectUrl: 'https://tickory.invalid/api/v1/auth/oidc/callback', scopes: ['openid'], buttonName: 'Pocket ID', autoCreate: false, allowedGroups: [], adminGroups: [], groupsClaim: 'groups', only: true };
  const w = await world({ oidc: { config } as unknown as OidcClient });
  try {
    assert.equal((await w.call('/api/v1/auth/login', { username: 'alice', password: PW, device_name: 'x' })).body.error_code, 'PASSWORD_LOGIN_OFF');
    assert.deepEqual((await w.call('/api/v1/auth/methods')).body, { password: false, sso: { name: 'Pocket ID' } });
    // een sessie zoals SSO hem geeft (hier rechtstreeks via de noodcode)
    const emergency = createLoginCode(w.db, { userId: w.bob.id, kind: 'emergency', bindingHash: null, ttlMs: 60_000, nowMs: w.clock.now });
    const web = (await w.call('/api/v1/auth/login/handoff', { code: emergency })).body.token;
    const made = await w.makeCode(web);
    assert.equal(made.status, 200);
    const r = await w.redeem(made.body.code);
    assert.equal(r.status, 200);
    assert.equal(r.body.me.username, 'bob');
  } finally {
    await w.close();
  }
});

test('een koppelcode werkt alleen bij /pair, en de codes van SSO of de opdrachtregel niet bij /pair', async () => {
  const w = await world();
  try {
    const web = await w.tokenOf('alice');
    const code = (await w.makeCode(web)).body.code;
    const asHandoff = await w.call('/api/v1/auth/login/handoff', { code: `tkp_${normalizePairCode(code)}` });
    assert.equal(asHandoff.status, 401, 'niet via de terugkeer van SSO');
    assert.equal((await w.redeem(code)).status, 200, 'en daar ook niet verbruikt');
    const emergency = createLoginCode(w.db, { userId: w.alice.id, kind: 'emergency', bindingHash: null, ttlMs: 60_000, nowMs: w.clock.now });
    assert.equal((await w.redeem(emergency)).status, 401, 'een noodcode is geen koppelcode');
    assert.equal((await w.call('/api/v1/auth/login/handoff', { code: emergency })).status, 200, 'en blijft gewoon werken waar hij hoort');
  } finally {
    await w.close();
  }
});

test('grenzen: hooguit 10 codes per uur per gebruiker, 10 foute pogingen per adres per kwartier; aanmelding en methode', async () => {
  const w = await world();
  try {
    const web = await w.tokenOf('alice');
    for (let i = 0; i < PAIR_CODES_PER_HOUR; i++) assert.equal((await w.makeCode(web)).status, 200);
    w.clock.now += 120_000; // het telt per uur, niet per minuut
    const tooMany = await w.makeCode(web);
    assert.equal(tooMany.status, 429);
    assert.equal(tooMany.body.error_code, 'TOO_MANY_REQUESTS');
    assert.ok(Number(tooMany.headers.get('retry-after')) > 0);
    assert.equal((await w.makeCode(await w.tokenOf('bob'))).status, 200, 'per gebruiker');
    w.clock.now += 3_600_000 + 1000;
    const fresh = (await w.makeCode(web)).body.code;
    assert.match(fresh, CODE_RE, 'na een uur weer');

    // gokken: na 10 foute pogingen helpt ook de juiste code niet meer, tot het kwartier om is
    for (let i = 0; i < 9; i++) assert.equal((await w.redeem(newPairCode())).status, 401);
    const good = (await w.makeCode(web)).body.code;
    assert.equal((await w.redeem(good)).status, 200, 'een gelukte poging geeft haar plek terug');
    assert.equal((await w.redeem(newPairCode())).status, 401);
    const blockedCode = (await w.makeCode(web)).body.code;
    const blocked = await w.redeem(blockedCode);
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error_code, 'TOO_MANY_ATTEMPTS');
    assert.equal((w.db.prepare("SELECT COUNT(*) AS n FROM login_codes WHERE kind = 'pair' AND user_id = ?").get(w.alice.id) as { n: number }).n, 1, 'de geweigerde poging heeft de code niet verbruikt');
    w.clock.now += 900_000 + 1000;
    assert.equal((await w.redeem((await w.makeCode(web)).body.code)).status, 200, 'na het kwartier weer');

    // zonder aanmelding geen code; verkeerde methoden
    assert.equal((await w.call('/api/v1/auth/pair-code', { password: PW })).status, 401);
    assert.equal((await w.call('/api/v1/auth/pair-code', undefined, 'tky_onzin-onzin-onzin-onzin')).status, 401);
    assert.equal((await w.call('/api/v1/auth/pair')).status, 405);
    assert.equal((await w.call('/api/v1/auth/pair-code', undefined, web, {}, 'DELETE')).status, 405);
    assert.equal((await w.call('/api/v1/auth/pair', { code: 12 })).status, 401);
  } finally {
    await w.close();
  }
});

test('geen CORS voor extensies: geen Access-Control-kop, ook niet op een preflight; met CORS_ORIGIN alleen die ene oorsprong', async () => {
  const w = await world();
  try {
    const ext = { Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' };
    const web = await w.tokenOf('alice');
    for (const path of ['/api/v1/auth/methods', '/api/v1/auth/me']) {
      const r = await w.call(path, undefined, web, ext);
      assert.equal(r.status, 200);
      assert.equal(r.headers.get('access-control-allow-origin'), null, path);
    }
    const sync = await w.call('/api/v1/sync', { sync_token: '*', resource_types: ['projects'] }, web, ext);
    assert.equal(sync.headers.get('access-control-allow-origin'), null);
    const pre = await w.call('/api/v1/sync', undefined, undefined, { ...ext, 'Access-Control-Request-Method': 'POST' }, 'OPTIONS');
    assert.equal(pre.headers.get('access-control-allow-origin'), null);
    assert.notEqual(pre.status, 204);
  } finally {
    await w.close();
  }
  const withCors = await world({ corsOrigin: 'https://schil.example' });
  try {
    const r = await withCors.call('/api/v1/auth/methods', undefined, undefined, { Origin: 'moz-extension://x' });
    assert.equal(r.headers.get('access-control-allow-origin'), 'https://schil.example', 'nooit de oorsprong van de extensie teruggekaatst');
  } finally {
    await withCors.close();
  }
});

test('toegangsfuzz: willekeurige codes maken, doorgeven, gokken, afmelden en verlopen; een sessie hoort altijd bij wie de code maakte', async () => {
  const w = await world({ pairLimiter: new LoginLimiter({ pair: 1_000_000, ip: 1_000_000, user: 1_000_000 }) });
  try {
    let seed = 12345;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
    const people = ['alice', 'bob'] as const;
    const web: Record<string, string> = { alice: await w.tokenOf('alice'), bob: await w.tokenOf('bob') };
    const ids: Record<string, string> = { alice: w.alice.id, bob: w.bob.id };
    // het model: per persoon de code die nu geldig zou moeten zijn (of null), en alle codes die ooit zijn uitgegeven
    const live: Record<string, { code: string; until: number } | null> = { alice: null, bob: null };
    const issued: { code: string; by: string }[] = [];
    let redeemed = 0;
    for (let step = 0; step < 300; step++) {
      const who = people[rnd(2)];
      const action = rnd(7);
      if (action <= 1) {
        const made = await w.makeCode(web[who]);
        if (made.status === 429) { w.clock.now += 3_600_000; continue; }
        assert.equal(made.status, 200);
        live[who] = { code: made.body.code, until: w.clock.now + PAIR_MS };
        issued.push({ code: made.body.code, by: who });
      } else if (action === 2 && issued.length > 0) {
        // een oude of geldige code van iemand (doorgegeven, gelekt): alleen de geldige werkt, en alleen voor de maker
        const pick = live[who] && rnd(2) === 0 ? { code: live[who]!.code, by: who } : issued[rnd(issued.length)];
        const r = await w.redeem(pick.code);
        const valid = live[pick.by]?.code === pick.code && live[pick.by]!.until > w.clock.now;
        assert.equal(r.status, valid ? 200 : 401, `stap ${step}: ${pick.code} van ${pick.by}`);
        if (valid) {
          redeemed++;
          assert.equal(r.body.me.id, ids[pick.by]);
          live[pick.by] = null;
          const me = await w.call('/api/v1/auth/me', undefined, r.body.token);
          assert.equal(me.body.me.id, ids[pick.by]);
        }
      } else if (action === 3) {
        assert.equal((await w.redeem(newPairCode())).status, 401, 'gokken lukt niet');
      } else if (action === 4) {
        w.clock.now += rnd(4) * 120_000; // de tijd loopt
      } else if (action === 5 && rnd(4) === 0) {
        // de webversie meldt zich af: openstaande codes van die sessie vervallen
        await w.call('/api/v1/auth/logout', {}, web[who]);
        live[who] = null;
        web[who] = await w.tokenOf(who);
      } else if (action === 6) {
        // een handoff-poging met de koppelcode werkt nooit en verbruikt hem niet
        const mine = live[who];
        if (mine) assert.equal((await w.call('/api/v1/auth/login/handoff', { code: `tkp_${normalizePairCode(mine.code)}` })).status, 401);
      }
    }
    assert.ok(redeemed >= 5, `genoeg gelukte koppelingen in de fuzz (${redeemed})`);
    const rows = w.db.prepare("SELECT user_id FROM login_codes WHERE kind = 'pair'").all() as { user_id: string }[];
    assert.ok(rows.length <= 2, 'hooguit één openstaande code per persoon');
  } finally {
    await w.close();
  }
});

test('inloggen met een wachtwoord vanuit een extensie: de sessie staat als browserextensie in de lijst (de oorsprong telt, niet de naam)', async () => {
  const w = await world();
  try {
    const login = (headers: Record<string, string>) => w.call('/api/v1/auth/login', { username: 'alice', password: PW, device_name: 'Browserextensie (Edge)' }, undefined, headers);
    const ext = await login({ 'User-Agent': `${CHROME_UA} Edg/150.0.0.0`, Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' });
    const page = await login({ 'User-Agent': CHROME_UA, Origin: 'https://evil.example' });
    const sessions = (await w.call('/api/v1/auth/sessions', undefined, ext.body.token)).body.sessions as any[];
    assert.deepEqual(sessions.find((s) => s.id === ext.body.session_id).device, { kind: 'extension', browser: 'Edge', os: 'Windows' });
    assert.deepEqual(sessions.find((s) => s.id === page.body.session_id).device, { kind: 'browser', browser: 'Chrome', os: 'Windows' });
  } finally {
    await w.close();
  }
});
