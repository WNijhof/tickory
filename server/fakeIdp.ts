// Een nagebootste identiteitsprovider (OpenID Connect) voor de tests en de e2e: een kleine HTTP-server op localhost met discovery,
// JWKS (een RSA-, een EC- en een Ed25519-sleutel die hij bij het starten zelf maakt), authorize, token en userinfo. Geen echte
// gegevens, geen echte geheimen: alles is verzonnen en verdwijnt met het proces. Niet in de Docker-image (.dockerignore).
//
// De tests sturen hem met eigenschappen: wie er inlogt (`user`), met welke sleutel hij tekent (`signWith`), en `tweak` om de
// claims of de kop van het volgende ID-token te veranderen (verkeerde nonce, aud, iss, verlopen, alg none, …).

import { createHash, createHmac, createPublicKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeUser { sub: string; preferred_username?: string; name?: string; email?: string; groups?: string[]; [claim: string]: unknown }
interface Key { kid: string; alg: string; privateKey: KeyObject; jwk: Record<string, unknown>; published: boolean }
type Endpoint = 'discovery' | 'jwks' | 'token' | 'userinfo';

export interface FakeIdp {
  issuer: string;
  base: string;
  clientId: string;
  /** Verwacht clientgeheim (client_secret_basic of client_secret_post); null = een publieke client. */
  clientSecret: string | null;
  /** Wie er bij de volgende keer inloggen "inlogt". */
  user: FakeUser;
  /** Extra claims die alleen het userinfo-eindpunt geeft (bijvoorbeeld groepen, zoals bij Authelia). */
  userinfo: Record<string, unknown>;
  signWith: 'rsa' | 'ec' | 'ed';
  /** Past claims en kop van het volgende ID-token aan (één keer of blijvend, zie `tweakOnce`). */
  tweak: ((claims: Record<string, unknown>, header: Record<string, unknown>) => void) | null;
  tweakOnce: boolean;
  /** Een ID-token zonder handtekening (`alg: none`). */
  algNone: boolean;
  /** Eén teken van de handtekening veranderd. */
  tamper: boolean;
  /** Een token dat met HMAC (HS256) is "ondertekend" met de publieke RSA-sleutel als geheim: de bekende truc. */
  hmacWithPublicKey: boolean;
  /** De gebruiker weigert bij de provider (`error=access_denied`). */
  deny: boolean;
  /** Zet `iss` in de terugkeer (RFC 9207); `issParam` overschrijft de waarde. */
  addIss: boolean;
  issParam: string | null;
  /** Een tussenpagina met een link om door te gaan (voor de e2e in een echte browser). */
  interactive: boolean;
  /** Welke eindpunten niet (tijdig) antwoorden, of veel te veel terugsturen. */
  slow: Set<Endpoint>;
  huge: Set<Endpoint>;
  /** Welke eindpunten met een omleiding antwoorden (de server mag die niet volgen). */
  redirect: Set<Endpoint>;
  /** Een andere `sub` in userinfo dan in het ID-token (dan mag de server userinfo niet gebruiken). */
  userinfoSub: string | null;
  /** Een andere issuer in de discovery dan het adres waar die staat (dan mag de server de provider niet vertrouwen). */
  discoveryIssuer: string | null;
  /** Welke methoden voor het clientgeheim de discovery noemt. */
  authMethods: string[];
  /** Tellers en wat er binnenkwam. */
  seen: { discovery: number; jwks: number; token: number; userinfo: number; authorize: URLSearchParams[]; tokenAuth: string[] };
  keys: Key[];
  /** Een nieuwe sleutel (nog niet of meteen gepubliceerd); de provider tekent er daarna mee. */
  addKey: (opts?: { publish?: boolean; kind?: 'rsa' | 'ec' | 'ed' }) => Key;
  /** Sleutelrotatie: een nieuwe RSA-sleutel wordt gepubliceerd en gebruikt, de oude verdwijnt uit de JWKS. */
  rotate: () => Key;
  /** Het ID-token zoals de provider het nu zou maken (voor tests van de controle zelf). */
  idToken: (claims: Record<string, unknown>, header?: Record<string, unknown>) => string;
  close: () => Promise<void>;
}

const b64 = (v: unknown) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

function makeKey(kind: 'rsa' | 'ec' | 'ed'): Key {
  const pair = kind === 'rsa' ? generateKeyPairSync('rsa', { modulusLength: 2048 })
    : kind === 'ec' ? generateKeyPairSync('ec', { namedCurve: 'P-256' })
      : generateKeyPairSync('ed25519');
  const alg = kind === 'rsa' ? 'RS256' : kind === 'ec' ? 'ES256' : 'EdDSA';
  const kid = `${kind}-${randomBytes(4).toString('hex')}`;
  return { kid, alg, privateKey: pair.privateKey, jwk: { ...pair.publicKey.export({ format: 'jwk' }), kid, alg, use: 'sig' }, published: true };
}

function signWithKey(key: Key, input: string): Buffer {
  if (key.alg === 'RS256') return sign('sha256', Buffer.from(input), key.privateKey);
  if (key.alg === 'ES256') return sign('sha256', Buffer.from(input), { key: key.privateKey, dsaEncoding: 'ieee-p1363' });
  return sign(null, Buffer.from(input), key.privateKey);
}

export async function startFakeIdp(opts: { clientId?: string; clientSecret?: string | null; path?: string } = {}): Promise<FakeIdp> {
  const codes = new Map<string, { redirectUri: string; challenge: string; nonce: string; user: FakeUser; used: boolean }>();
  const tickets = new Map<string, string>();
  const access = new Map<string, FakeUser>();
  let server: Server;

  const idp: FakeIdp = {
    issuer: '', base: '', clientId: opts.clientId ?? 'tickory-test', clientSecret: opts.clientSecret === undefined ? 'geheim-van-de-test' : opts.clientSecret,
    user: { sub: 'sub-alice', preferred_username: 'alice', name: 'Alice', email: 'alice@voorbeeld.test' }, userinfo: {},
    signWith: 'rsa', tweak: null, tweakOnce: true, algNone: false, tamper: false, hmacWithPublicKey: false, deny: false, addIss: false, issParam: null,
    interactive: false, slow: new Set(), huge: new Set(), redirect: new Set(), userinfoSub: null, discoveryIssuer: null, authMethods: ['client_secret_basic', 'client_secret_post'],
    seen: { discovery: 0, jwks: 0, token: 0, userinfo: 0, authorize: [], tokenAuth: [] },
    keys: [makeKey('rsa'), makeKey('ec'), makeKey('ed')],
    addKey: ({ publish = true, kind = 'rsa' } = {}) => {
      const key = makeKey(kind);
      key.published = publish;
      idp.keys.push(key);
      idp.signWith = kind;
      return key;
    },
    rotate: () => {
      for (const k of idp.keys) if (k.alg === 'RS256') k.published = false;
      return idp.addKey({ publish: true, kind: 'rsa' });
    },
    idToken: (claims, header = {}) => {
      const alg = idp.signWith === 'rsa' ? 'RS256' : idp.signWith === 'ec' ? 'ES256' : 'EdDSA';
      // de nieuwste sleutel van die soort
      const key = [...idp.keys].reverse().find((k) => k.alg === alg)!;
      const h: Record<string, unknown> = { alg, kid: key.kid, typ: 'JWT', ...header };
      if (idp.algNone) {
        h.alg = 'none';
        return `${b64(h)}.${b64(claims)}.`;
      }
      if (idp.hmacWithPublicKey) {
        const rsa = idp.keys.find((k) => k.alg === 'RS256')!;
        const pub = createPublicKey(rsa.privateKey).export({ type: 'spki', format: 'pem' }).toString();
        h.alg = 'HS256';
        h.kid = rsa.kid;
        const input = `${b64(h)}.${b64(claims)}`;
        return `${input}.${createHmac('sha256', pub).update(input).digest('base64url')}`;
      }
      const input = `${b64(h)}.${b64(claims)}`;
      const sig = signWithKey(key, input);
      if (idp.tamper) sig[sig.length - 1] ^= 1;
      return `${input}.${sig.toString('base64url')}`;
    },
    close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections(); }),
  };

  const json = (res: ServerResponse, status: number, body: unknown, endpoint?: Endpoint) => {
    if (endpoint && idp.huge.has(endpoint)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(`{"padding":"${'x'.repeat(2_000_000)}"}`);
      return;
    }
    const text = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store' });
    res.end(text);
  };
  const readForm = (req: IncomingMessage): Promise<URLSearchParams> => new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => resolve(new URLSearchParams(raw)));
  });
  const formDecode = (s: string) => decodeURIComponent(s.replace(/\+/g, ' '));

  const finishAuthorize = (res: ServerResponse, q: URLSearchParams) => {
    const redirectUri = q.get('redirect_uri')!;
    const target = new URL(redirectUri);
    target.searchParams.set('state', q.get('state') ?? '');
    if (idp.deny) {
      target.searchParams.set('error', 'access_denied');
    } else {
      const code = `code-${randomBytes(12).toString('hex')}`;
      codes.set(code, { redirectUri, challenge: q.get('code_challenge') ?? '', nonce: q.get('nonce') ?? '', user: { ...idp.user }, used: false });
      target.searchParams.set('code', code);
    }
    if (idp.addIss) target.searchParams.set('iss', idp.issParam ?? idp.issuer);
    res.writeHead(302, { Location: target.href });
    res.end();
  };

  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', idp.base);
    const p = url.pathname;
    const path = opts.path ?? '/realms/test';
    const endpointOf: Record<string, Endpoint> = { [`${path.replace(/\/$/, '')}/.well-known/openid-configuration`]: 'discovery', '/jwks': 'jwks', '/token': 'token', '/userinfo': 'userinfo' };
    const ep = endpointOf[p];
    if (ep && idp.slow.has(ep)) return; // nooit antwoorden: de tijdslimiet van de server moet ingrijpen
    if (ep && idp.redirect.has(ep) && !url.searchParams.has('na-omleiding')) {
      res.writeHead(302, { Location: `${url.pathname}?na-omleiding=1` });
      return res.end();
    }
    if (ep === 'discovery') {
      idp.seen.discovery++;
      return json(res, 200, {
        issuer: idp.discoveryIssuer ?? idp.issuer, authorization_endpoint: `${idp.base}/authorize`, token_endpoint: `${idp.base}/token`, jwks_uri: `${idp.base}/jwks`,
        userinfo_endpoint: `${idp.base}/userinfo`, response_types_supported: ['code'], subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256', 'ES256', 'EdDSA'], code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: idp.authMethods, authorization_response_iss_parameter_supported: idp.addIss,
      }, 'discovery');
    }
    if (ep === 'jwks') {
      idp.seen.jwks++;
      return json(res, 200, { keys: idp.keys.filter((k) => k.published).map((k) => k.jwk) }, 'jwks');
    }
    if (p === '/authorize') {
      idp.seen.authorize.push(url.searchParams);
      const q = url.searchParams;
      if (q.get('client_id') !== idp.clientId || q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge') || !q.get('redirect_uri')) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        return res.end('ongeldig verzoek');
      }
      if (idp.interactive) {
        const ticket = randomBytes(8).toString('hex');
        tickets.set(ticket, q.toString());
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(`<!doctype html><title>Nep-inlogdienst</title><h1>Nep-inlogdienst</h1><p>Inloggen als ${idp.user.name ?? idp.user.sub}</p><a id="doorgaan" href="/approve?ticket=${ticket}">Doorgaan</a>`);
      }
      return finishAuthorize(res, q);
    }
    if (p === '/approve') {
      const q = tickets.get(url.searchParams.get('ticket') ?? '');
      if (!q) { res.writeHead(400); return res.end(); }
      tickets.delete(url.searchParams.get('ticket')!);
      return finishAuthorize(res, new URLSearchParams(q));
    }
    if (ep === 'token') {
      idp.seen.token++;
      const form = await readForm(req);
      const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? '');
      let clientId = form.get('client_id');
      let secret = form.get('client_secret');
      if (basic) {
        const [id, s] = Buffer.from(basic[1], 'base64').toString('utf8').split(':');
        clientId = formDecode(id);
        secret = formDecode(s ?? '');
        idp.seen.tokenAuth.push('basic');
      } else idp.seen.tokenAuth.push(secret ? 'post' : 'none');
      if (clientId !== idp.clientId || (idp.clientSecret !== null && secret !== idp.clientSecret)) return json(res, 401, { error: 'invalid_client' });
      const entry = codes.get(form.get('code') ?? '');
      if (!entry || entry.used || form.get('grant_type') !== 'authorization_code' || form.get('redirect_uri') !== entry.redirectUri) return json(res, 400, { error: 'invalid_grant' });
      entry.used = true;
      const verifier = form.get('code_verifier') ?? '';
      if (createHash('sha256').update(verifier).digest('base64url') !== entry.challenge) return json(res, 400, { error: 'invalid_grant' });
      const now = Math.floor(Date.now() / 1000);
      const claims: Record<string, unknown> = { iss: idp.issuer, aud: idp.clientId, exp: now + 300, iat: now, nonce: entry.nonce, ...entry.user };
      const header: Record<string, unknown> = {};
      if (idp.tweak) {
        idp.tweak(claims, header);
        if (idp.tweakOnce) idp.tweak = null;
      }
      const accessToken = `at-${randomBytes(12).toString('hex')}`;
      access.set(accessToken, entry.user);
      return json(res, 200, { access_token: accessToken, token_type: 'Bearer', expires_in: 300, id_token: idp.idToken(claims, header) }, 'token');
    }
    if (ep === 'userinfo') {
      idp.seen.userinfo++;
      const user = access.get((req.headers.authorization ?? '').replace(/^Bearer /, ''));
      if (!user) return json(res, 401, { error: 'invalid_token' });
      return json(res, 200, { sub: idp.userinfoSub ?? user.sub, ...idp.userinfo }, 'userinfo');
    }
    // een browser vraagt om een pictogram; zonder antwoord staat er een fout in de console van de e2e
    res.writeHead(p === '/favicon.ico' ? 204 : 404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  idp.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  idp.issuer = `${idp.base}${opts.path ?? '/realms/test'}`;
  return idp;
}
