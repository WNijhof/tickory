// Inloggen via OpenID Connect (OIDC, "SSO"): de server is zelf de OIDC-client. Zonder bibliotheken: discovery, de sleutels
// van de identiteitsprovider (JWKS), het inwisselen van de code en het controleren van het ID-token doen we hier met
// node:crypto en fetch. Wat er met de uitkomst gebeurt (koppelen, account aanmaken, sessie) staat in sso.ts.
//
// De stroom is de Authorization Code Flow met PKCE (S256), `state` en `nonce`:
//   1. de server maakt per poging een willekeurige `state`, `nonce` en code_verifier en stuurt de browser naar de provider;
//   2. de provider stuurt de browser terug naar de callback met een code (en dezelfde `state`);
//   3. de server wisselt de code (met de code_verifier, en zo nodig het clientgeheim) in voor een ID-token en controleert dat:
//      handtekening (RS/PS/ES/EdDSA met een sleutel uit de JWKS), `iss`, `aud`/`azp`, `exp`/`iat`/`nbf` en `nonce`.
//
// Beveiliging: de adressen komen alleen uit de configuratie en de discovery van die ene issuer (nooit uit invoer van een
// gebruiker of uit het token zelf: `jku`, `x5u` en `jwk` in de kop worden genegeerd). Alleen https, behalve localhost (tests).
// Elk uitgaand verzoek heeft een tijdslimiet en een grens aan de grootte van het antwoord, en volgt geen omleidingen.

import { constants, createHash, createPublicKey, randomBytes, timingSafeEqual, verify } from 'node:crypto';
import type { JsonWebKey, KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';

// ---------- configuratie ----------

export interface OidcConfig {
  /** De issuer zoals ingesteld (zonder afsluitende schuine streep); de discovery moet dezelfde issuer noemen. */
  issuer: string;
  clientId: string;
  /** Leeg = een publieke client (alleen PKCE). */
  clientSecret: string;
  redirectUrl: string;
  scopes: string[];
  /** De naam op de knop: "Inloggen met …". */
  buttonName: string;
  /** Nieuwe gebruikers automatisch aanmaken (standaard uit). */
  autoCreate: boolean;
  /** Alleen deze groepen mogen inloggen (leeg = iedereen die de provider doorlaat). */
  allowedGroups: string[];
  /** Wie in een van deze groepen zit, is beheerder; wie er niet in zit niet (leeg = de provider bepaalt dat niet). */
  adminGroups: string[];
  /** De claim met de groepen (standaard `groups`). */
  groupsClaim: string;
  /** Inloggen met een wachtwoord staat uit (behalve een eenmalige code van de beheerder via de opdrachtregel). */
  only: boolean;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Mag de server dit adres aanroepen? Alleen https zonder gebruikersnaam of wachtwoord in het adres; http alleen naar het
 * toestel zelf (localhost) en alleen als `allowLoopback` (de issuer zelf is een http-adres op localhost: een test).
 */
export function safeUrl(raw: unknown, allowLoopback: boolean): URL | null {
  if (typeof raw !== 'string' || raw.length > 2000) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username || url.password || url.hash) return null;
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && allowLoopback && LOOPBACK.has(url.hostname)) return url;
  return null;
}

const isLoopbackHttp = (url: URL): boolean => url.protocol === 'http:' && LOOPBACK.has(url.hostname);

const list = (raw: string | undefined): string[] => (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const flag = (raw: string | undefined): boolean => /^(1|true|yes|ja|on)$/i.test((raw ?? '').trim());

/** Een geheim uit de omgeving of uit het bestand dat `<naam>_FILE` aanwijst (een Docker-secret); een eindregel telt niet mee. */
function secretFrom(env: Record<string, string | undefined>, name: string): string {
  if (env[name]) return env[name]!;
  const file = env[`${name}_FILE`];
  if (!file) return '';
  try {
    return readFileSync(file, 'utf8').replace(/\r?\n$/, '');
  } catch (err) {
    throw new Error(`${name}_FILE (${file}) is niet te lezen: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
  }
}

/**
 * De instellingen voor inloggen via OIDC uit de omgeving, of null als OIDC_ISSUER leeg is (dan staat het uit). Gooit met een
 * duidelijke melding bij een onvolledige of onveilige instelling, zodat de server niet half werkend start.
 */
export function oidcConfigFrom(env: Record<string, string | undefined>): OidcConfig | null {
  const rawIssuer = (env.OIDC_ISSUER ?? '').trim();
  if (!rawIssuer) return null;
  const issuerUrl = safeUrl(rawIssuer, true);
  if (!issuerUrl || issuerUrl.search) throw new Error('OIDC_ISSUER moet een https-adres zijn (zonder ? of #), bijvoorbeeld https://auth.voorbeeld.nl/application/o/tickory/');
  const clientId = (env.OIDC_CLIENT_ID ?? '').trim();
  if (!clientId || clientId.length > 500) throw new Error('OIDC_CLIENT_ID ontbreekt (de client-id die je bij de identiteitsprovider hebt aangemaakt)');
  const publicUrl = (env.PUBLIC_URL ?? '').trim().replace(/\/+$/, '');
  const rawRedirect = (env.OIDC_REDIRECT_URL ?? '').trim() || (publicUrl ? `${publicUrl}/api/v1/auth/oidc/callback` : '');
  if (!rawRedirect) throw new Error('zet PUBLIC_URL (het adres van Tickory, bijvoorbeeld https://taken.voorbeeld.nl) of OIDC_REDIRECT_URL');
  const redirect = safeUrl(rawRedirect, true) ?? (() => {
    // Tickory zelf mag op het eigen netwerk via http draaien (de provider moet dat adres dan wel toestaan)
    try {
      const u = new URL(rawRedirect);
      return u.protocol === 'http:' && !u.username && !u.password && !u.hash ? u : null;
    } catch {
      return null;
    }
  })();
  if (!redirect || redirect.pathname !== '/api/v1/auth/oidc/callback' || redirect.search) {
    throw new Error('OIDC_REDIRECT_URL moet eindigen op /api/v1/auth/oidc/callback (bijvoorbeeld https://taken.voorbeeld.nl/api/v1/auth/oidc/callback)');
  }
  const scopes = [...new Set(['openid', ...((env.OIDC_SCOPES ?? '').trim() || 'openid profile email').split(/[\s,]+/).filter(Boolean)])];
  if (scopes.some((s) => !/^[\x21\x23-\x5b\x5d-\x7e]{1,100}$/.test(s))) throw new Error('OIDC_SCOPES bevat een ongeldige scope');
  const buttonName = (env.OIDC_BUTTON_NAME ?? '').normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40) || 'SSO';
  const groupsClaim = (env.OIDC_GROUPS_CLAIM ?? '').trim() || 'groups';
  return {
    issuer: issuerUrl.href.replace(/\/$/, ''),
    clientId,
    clientSecret: secretFrom(env, 'OIDC_CLIENT_SECRET'),
    redirectUrl: redirect.href,
    scopes,
    buttonName,
    autoCreate: flag(env.OIDC_AUTO_CREATE),
    allowedGroups: list(env.OIDC_ALLOWED_GROUPS),
    adminGroups: list(env.OIDC_ADMIN_GROUPS),
    groupsClaim,
    only: flag(env.OIDC_ONLY),
  };
}

// ---------- uitgaande verzoeken ----------

export class OidcError extends Error {
  /** `UNAVAILABLE` (niet bereikbaar, te traag, te groot) of `PROVIDER` (een fout of ongeldig antwoord van de provider). */
  code: 'UNAVAILABLE' | 'PROVIDER';
  constructor(code: 'UNAVAILABLE' | 'PROVIDER', message: string) {
    super(message);
    this.code = code;
  }
}

/** Leest hooguit `max` bytes; is het antwoord groter, dan breken we af (een kwaadwillende of kapotte provider vult ons geheugen niet). */
async function readLimited(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => {});
    throw new OidcError('UNAVAILABLE', `antwoord te groot (${declared} bytes)`);
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new OidcError('UNAVAILABLE', `antwoord te groot (meer dan ${max} bytes)`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export interface FetchLimits { timeoutMs: number; maxBytes: number }

/** Een verzoek naar de provider dat JSON teruggeeft: met tijdslimiet en groottegrens, zonder omleidingen te volgen. */
async function fetchJson(url: string, init: RequestInit, limits: FetchLimits): Promise<{ status: number; body: unknown }> {
  let res: Response;
  const signal = AbortSignal.timeout(limits.timeoutMs);
  try {
    res = await fetch(url, { ...init, redirect: 'error', signal });
  } catch (err) {
    throw new OidcError('UNAVAILABLE', `${new URL(url).host} niet bereikbaar: ${(err as Error).name === 'TimeoutError' ? 'te traag' : (err as Error).message}`);
  }
  let text: string;
  try {
    text = await readLimited(res, limits.maxBytes);
  } catch (err) {
    if (err instanceof OidcError) throw err;
    throw new OidcError('UNAVAILABLE', `${new URL(url).host}: antwoord niet gelezen (${(err as Error).name === 'TimeoutError' ? 'te traag' : (err as Error).message})`);
  }
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch { /* geen JSON: de aanroeper beslist wat dat betekent */ }
  return { status: res.status, body };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// ---------- het ID-token ----------

interface AlgSpec { kty: 'RSA' | 'EC' | 'OKP'; hash: string | null; crv?: string[]; pss?: boolean; size?: number }
/** De algoritmen die we accepteren. Nooit `none`, nooit HMAC (HS256 en verwanten): een publieke sleutel is geen geheim. */
const ALGORITHMS: Record<string, AlgSpec> = {
  RS256: { kty: 'RSA', hash: 'sha256' }, RS384: { kty: 'RSA', hash: 'sha384' }, RS512: { kty: 'RSA', hash: 'sha512' },
  PS256: { kty: 'RSA', hash: 'sha256', pss: true }, PS384: { kty: 'RSA', hash: 'sha384', pss: true }, PS512: { kty: 'RSA', hash: 'sha512', pss: true },
  ES256: { kty: 'EC', hash: 'sha256', crv: ['P-256'], size: 64 }, ES384: { kty: 'EC', hash: 'sha384', crv: ['P-384'], size: 96 }, ES512: { kty: 'EC', hash: 'sha512', crv: ['P-521'], size: 132 },
  EdDSA: { kty: 'OKP', hash: null, crv: ['Ed25519', 'Ed448'] },
};
export const SUPPORTED_ALGORITHMS = Object.keys(ALGORITHMS);

/** Alleen de publieke delen van een sleutel; een sleutel met geheime delen (`d`, `k`, …) of een symmetrische sleutel nemen we niet. */
function publicJwk(jwk: Record<string, unknown>): JsonWebKey | null {
  if ('d' in jwk || 'k' in jwk || 'p' in jwk || 'q' in jwk) return null;
  const pick = (names: string[]): JsonWebKey | null => {
    const out: Record<string, string> = { kty: jwk.kty as string };
    for (const n of names) {
      if (typeof jwk[n] !== 'string') return null;
      out[n] = jwk[n] as string;
    }
    return out as JsonWebKey;
  };
  if (jwk.kty === 'RSA') return pick(['n', 'e']);
  if (jwk.kty === 'EC') return pick(['crv', 'x', 'y']);
  if (jwk.kty === 'OKP') return pick(['crv', 'x']);
  return null;
}

/** Past deze sleutel bij dit algoritme (soort, kromme, `alg` en `use` van de sleutel zelf)? */
function keyFits(jwk: Record<string, unknown>, alg: string): boolean {
  const spec = ALGORITHMS[alg];
  if (!spec || jwk.kty !== spec.kty) return false;
  if (spec.crv && !spec.crv.includes(jwk.crv as string)) return false;
  if (jwk.alg !== undefined && jwk.alg !== alg) return false;
  if (jwk.use !== undefined && jwk.use !== 'sig') return false;
  if (Array.isArray(jwk.key_ops) && !jwk.key_ops.includes('verify')) return false;
  return true;
}

/** Klopt de handtekening? Elke fout (kapotte sleutel, verkeerde lengte) is gewoon "nee". */
export function verifySignature(alg: string, jwk: Record<string, unknown>, signingInput: Buffer, signature: Buffer): boolean {
  const spec = ALGORITHMS[alg];
  const pub = publicJwk(jwk);
  if (!spec || !pub || !keyFits(jwk, alg)) return false;
  let key: KeyObject;
  try {
    key = createPublicKey({ key: pub, format: 'jwk' });
  } catch {
    return false;
  }
  try {
    if (spec.kty === 'RSA') {
      if ((key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) return false; // te korte RSA-sleutels vertrouwen we niet
      return spec.pss
        ? verify(spec.hash!, signingInput, { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST }, signature)
        : verify(spec.hash!, signingInput, key, signature);
    }
    if (spec.kty === 'EC') {
      if (signature.length !== spec.size) return false;
      return verify(spec.hash!, signingInput, { key, dsaEncoding: 'ieee-p1363' }, signature);
    }
    return verify(null, signingInput, key, signature);
  } catch {
    return false;
  }
}

const B64URL = /^[A-Za-z0-9_-]+$/;
const decodeJson = (part: string): Record<string, unknown> | null => {
  try {
    const v = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return isObject(v) ? v : null;
  } catch {
    return null;
  }
};

/** Een ID-token in zijn drie delen; null als het geen ondertekend JWT is (ook een token zonder handtekening, `alg: none`, is dat niet). */
export function decodeJwt(token: unknown): { header: Record<string, unknown>; payload: Record<string, unknown>; signingInput: Buffer; signature: Buffer } | null {
  if (typeof token !== 'string' || token.length > 16_384) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || !parts.every((p) => B64URL.test(p))) return null;
  const header = decodeJson(parts[0]);
  const payload = decodeJson(parts[1]);
  if (!header || !payload) return null;
  return { header, payload, signingInput: Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii'), signature: Buffer.from(parts[2], 'base64url') };
}

export interface ClaimChecks {
  issuer: string;
  clientId: string;
  nonce: string;
  /** Nu, in milliseconden. */
  nowMs: number;
  /** Toegestane afwijking van de klok, in seconden (standaard 60). */
  skewSeconds?: number;
  /** Hoe oud het token hooguit mag zijn (`iat`), in seconden (standaard 10 minuten). */
  maxAgeSeconds?: number;
}

const sameText = (a: string, b: string): boolean => {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * Controleert de inhoud van een (al als echt bevestigd) ID-token. Geeft de reden terug als het niet klopt, anders null.
 * De reden is voor de logregel; de gebruiker krijgt alleen "de inlogdienst gaf een ongeldig antwoord".
 */
export function claimProblem(c: Record<string, unknown>, checks: ClaimChecks): string | null {
  const now = checks.nowMs / 1000;
  const skew = checks.skewSeconds ?? 60;
  const maxAge = checks.maxAgeSeconds ?? 600;
  if (c.iss !== checks.issuer) return 'iss klopt niet';
  const aud = typeof c.aud === 'string' ? [c.aud] : Array.isArray(c.aud) && c.aud.every((a) => typeof a === 'string') ? (c.aud as string[]) : null;
  if (!aud || !aud.includes(checks.clientId)) return 'aud klopt niet';
  // Meer dan één ontvanger: dan moet `azp` zeggen dat het token voor ons is uitgegeven. Staat `azp` er, dan moet hij kloppen.
  if (aud.length > 1 && c.azp === undefined) return 'azp ontbreekt bij meerdere ontvangers';
  if (c.azp !== undefined && c.azp !== checks.clientId) return 'azp klopt niet';
  if (typeof c.exp !== 'number' || !Number.isFinite(c.exp)) return 'exp ontbreekt';
  if (now > c.exp + skew) return 'verlopen (exp)';
  if (typeof c.iat !== 'number' || !Number.isFinite(c.iat)) return 'iat ontbreekt';
  if (c.iat > now + skew) return 'iat ligt in de toekomst';
  if (now - c.iat > maxAge + skew) return 'te oud (iat)';
  if (c.nbf !== undefined && (typeof c.nbf !== 'number' || now < c.nbf - skew)) return 'nog niet geldig (nbf)';
  if (typeof c.nonce !== 'string' || !sameText(c.nonce, checks.nonce)) return 'nonce klopt niet';
  if (typeof c.sub !== 'string' || c.sub.length < 1 || c.sub.length > 255 || /[\u0000-\u001f\u007f]/.test(c.sub)) return 'sub ongeldig';
  return null;
}

// ---------- de provider: discovery, sleutels, code inwisselen ----------

export interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint: string | null;
  token_endpoint_auth_methods_supported: string[] | null;
  authorization_response_iss_parameter_supported: boolean;
}

export interface OidcClientOptions {
  /** Voor tests: de klok in milliseconden. */
  clock?: () => number;
  /** Voor tests: tijdslimiet en groottegrens van uitgaande verzoeken. */
  limits?: Partial<FetchLimits>;
  /** Hoe lang de discovery bewaard blijft (standaard een uur). */
  discoveryTtlMs?: number;
  /** Hoe snel de sleutels hooguit opnieuw worden opgehaald bij een onbekende `kid` (standaard 30 seconden). */
  jwksMinRefreshMs?: number;
}

export interface TokenResult {
  /** De claims uit het gecontroleerde ID-token, met daarbij (als die er is) wat het userinfo-eindpunt over dezelfde `sub` zegt. */
  claims: Record<string, unknown>;
}

export interface OidcClient {
  config: OidcConfig;
  /** De discovery (uit de cache als die vers is). Gooit OidcError. */
  discovery: () => Promise<Discovery>;
  /** Het adres bij de provider waar de browser heen gaat. */
  authorizationUrl: (p: { state: string; nonce: string; codeChallenge: string; lang?: string | null }) => Promise<string>;
  /** Wisselt de code in, controleert het ID-token en haalt zo nodig userinfo op. Gooit OidcError (de reden staat in de melding). */
  redeem: (code: string, verifier: string, nonce: string) => Promise<TokenResult>;
  /** Controleert een ID-token (handtekening en claims); voor tests ook los te gebruiken. */
  verifyIdToken: (token: unknown, nonce: string) => Promise<Record<string, unknown>>;
}

/** Een code_verifier (43 tekens) en de bijbehorende code_challenge (S256). */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export function createOidcClient(config: OidcConfig, options: OidcClientOptions = {}): OidcClient {
  const clock = options.clock ?? Date.now;
  const limits: FetchLimits = { timeoutMs: 10_000, maxBytes: 256 * 1024, ...options.limits };
  const discoveryTtl = options.discoveryTtlMs ?? 60 * 60_000;
  const jwksMinRefresh = options.jwksMinRefreshMs ?? 30_000;
  const loopback = isLoopbackHttp(new URL(config.issuer));
  let cached: { value: Discovery; at: number } | null = null;
  let keys: { list: Record<string, unknown>[]; at: number } | null = null;
  let loading: Promise<Discovery> | null = null;

  const endpoint = (raw: unknown, what: string): string => {
    const url = safeUrl(raw, loopback);
    if (!url) throw new OidcError('PROVIDER', `discovery: ${what} ontbreekt of is geen https-adres`);
    return url.href;
  };

  const loadDiscovery = async (): Promise<Discovery> => {
    const url = `${config.issuer}/.well-known/openid-configuration`;
    const { status, body } = await fetchJson(url, { headers: { Accept: 'application/json' } }, limits);
    if (status !== 200 || !isObject(body)) throw new OidcError(status >= 500 ? 'UNAVAILABLE' : 'PROVIDER', `discovery gaf HTTP ${status}`);
    // De issuer in de discovery moet die uit de configuratie zijn (een afsluitende schuine streep daargelaten: Authentik zet die er wel achter).
    if (typeof body.issuer !== 'string' || body.issuer.replace(/\/$/, '') !== config.issuer) throw new OidcError('PROVIDER', `discovery noemt een andere issuer (${String(body.issuer).slice(0, 200)})`);
    const methods = Array.isArray(body.token_endpoint_auth_methods_supported) ? body.token_endpoint_auth_methods_supported.filter((m): m is string => typeof m === 'string') : null;
    return {
      issuer: body.issuer,
      authorization_endpoint: endpoint(body.authorization_endpoint, 'authorization_endpoint'),
      token_endpoint: endpoint(body.token_endpoint, 'token_endpoint'),
      jwks_uri: endpoint(body.jwks_uri, 'jwks_uri'),
      userinfo_endpoint: body.userinfo_endpoint === undefined || body.userinfo_endpoint === null ? null : endpoint(body.userinfo_endpoint, 'userinfo_endpoint'),
      token_endpoint_auth_methods_supported: methods,
      authorization_response_iss_parameter_supported: body.authorization_response_iss_parameter_supported === true,
    };
  };

  const discovery = async (): Promise<Discovery> => {
    if (cached && clock() - cached.at < discoveryTtl) return cached.value;
    loading ??= loadDiscovery().finally(() => { loading = null; });
    try {
      const value = await loading;
      cached = { value, at: clock() };
      return value;
    } catch (err) {
      if (cached) return cached.value; // de provider is even weg: de vorige discovery blijft bruikbaar
      throw err;
    }
  };

  const loadKeys = async (): Promise<Record<string, unknown>[]> => {
    const d = await discovery();
    const { status, body } = await fetchJson(d.jwks_uri, { headers: { Accept: 'application/json' } }, limits);
    if (status !== 200 || !isObject(body) || !Array.isArray(body.keys)) throw new OidcError(status >= 500 ? 'UNAVAILABLE' : 'PROVIDER', `jwks gaf HTTP ${status}`);
    const list = body.keys.filter(isObject).slice(0, 100);
    keys = { list, at: clock() };
    return list;
  };

  /** De sleutels die bij dit token kunnen horen. Een onbekende `kid` laat de sleutels opnieuw ophalen (sleutelrotatie), maar niet vaker dan eens per halve minuut. */
  const candidates = async (kid: string | undefined, alg: string): Promise<Record<string, unknown>[]> => {
    const pick = (all: Record<string, unknown>[]) => all.filter((k) => keyFits(k, alg) && (kid === undefined || k.kid === kid));
    let found = keys ? pick(keys.list) : [];
    if (found.length === 0 && (!keys || clock() - keys.at >= jwksMinRefresh)) found = pick(await loadKeys());
    return found;
  };

  const verifyIdToken = async (token: unknown, nonce: string): Promise<Record<string, unknown>> => {
    const jwt = decodeJwt(token);
    if (!jwt) throw new OidcError('PROVIDER', 'ID-token is geen ondertekend JWT');
    const { header, payload } = jwt;
    const alg = header.alg;
    if (typeof alg !== 'string' || !Object.hasOwn(ALGORITHMS, alg)) throw new OidcError('PROVIDER', `ID-token: algoritme ${JSON.stringify(alg)?.slice(0, 40)} niet toegestaan`);
    if (header.crit !== undefined) throw new OidcError('PROVIDER', 'ID-token: onbekende kritieke kop (crit)');
    if (header.typ !== undefined && !(typeof header.typ === 'string' && ['jwt', 'application/jwt'].includes(header.typ.toLowerCase()))) throw new OidcError('PROVIDER', 'ID-token: verkeerd type');
    if (header.kid !== undefined && typeof header.kid !== 'string') throw new OidcError('PROVIDER', 'ID-token: ongeldige kid');
    const kid = header.kid as string | undefined;
    const keysFor = await candidates(kid, alg);
    if (keysFor.length === 0) throw new OidcError('PROVIDER', `ID-token: geen sleutel bij kid ${JSON.stringify(kid ?? null).slice(0, 80)}`);
    if (!keysFor.slice(0, 10).some((k) => verifySignature(alg, k, jwt.signingInput, jwt.signature))) throw new OidcError('PROVIDER', 'ID-token: handtekening klopt niet');
    const d = await discovery();
    const problem = claimProblem(payload, { issuer: d.issuer, clientId: config.clientId, nonce, nowMs: clock() });
    if (problem) throw new OidcError('PROVIDER', `ID-token: ${problem}`);
    return payload;
  };

  const authorizationUrl = async ({ state, nonce, codeChallenge, lang }: { state: string; nonce: string; codeChallenge: string; lang?: string | null }): Promise<string> => {
    const d = await discovery();
    const url = new URL(d.authorization_endpoint);
    const params: Record<string, string> = {
      response_type: 'code', client_id: config.clientId, redirect_uri: config.redirectUrl, scope: config.scopes.join(' '),
      state, nonce, code_challenge: codeChallenge, code_challenge_method: 'S256',
    };
    if (lang === 'nl' || lang === 'en') params.ui_locales = lang;
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return url.href;
  };

  const redeem = async (code: string, verifier: string, nonce: string): Promise<TokenResult> => {
    const d = await discovery();
    const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: config.redirectUrl, code_verifier: verifier });
    const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
    if (config.clientSecret) {
      // client_secret_basic, tenzij de provider alleen client_secret_post kent. Naam en geheim worden eerst form-gecodeerd (RFC 6749, 2.3.1).
      const methods = d.token_endpoint_auth_methods_supported;
      if (methods && !methods.includes('client_secret_basic') && methods.includes('client_secret_post')) {
        form.set('client_id', config.clientId);
        form.set('client_secret', config.clientSecret);
      } else {
        const enc = (s: string) => encodeURIComponent(s).replace(/%20/g, '+');
        headers.Authorization = `Basic ${Buffer.from(`${enc(config.clientId)}:${enc(config.clientSecret)}`).toString('base64')}`;
      }
    } else {
      form.set('client_id', config.clientId);
    }
    const { status, body } = await fetchJson(d.token_endpoint, { method: 'POST', headers, body: form.toString() }, limits);
    if (status !== 200 || !isObject(body)) {
      const error = isObject(body) && typeof body.error === 'string' ? body.error.slice(0, 60).replace(/[^\w.-]/g, '') : '';
      throw new OidcError(status >= 500 ? 'UNAVAILABLE' : 'PROVIDER', `tokeneindpunt gaf HTTP ${status}${error ? ` (${error})` : ''}`);
    }
    const claims = await verifyIdToken(body.id_token, nonce);
    const accessToken = typeof body.access_token === 'string' && body.access_token.length <= 16_384 ? body.access_token : null;
    if (!d.userinfo_endpoint || !accessToken) return { claims };
    // Sommige providers (Authelia) zetten naam, e-mail en groepen alleen in userinfo. Alleen als `sub` gelijk is (OIDC Core 5.3.2).
    let info: Record<string, unknown> = {};
    try {
      const r = await fetchJson(d.userinfo_endpoint, { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } }, { ...limits, maxBytes: Math.min(limits.maxBytes, 64 * 1024) });
      if (r.status === 200 && isObject(r.body) && r.body.sub === claims.sub) info = r.body;
    } catch { /* zonder userinfo gaan we verder met wat in het ID-token staat */ }
    const merged: Record<string, unknown> = { ...info, ...claims };
    if (claims[config.groupsClaim] === undefined && info[config.groupsClaim] !== undefined) merged[config.groupsClaim] = info[config.groupsClaim];
    return { claims: merged };
  };

  return { config, discovery, authorizationUrl, redeem, verifyIdToken };
}

// ---------- claims gebruiken ----------

/** De groepen uit de claim: een lijst tekst, één tekst, of een object waarvan de sleutels de groepen zijn (Zitadel geeft rollen zo). */
export function groupsOf(claims: Record<string, unknown>, claim: string): string[] {
  const v = claims[claim];
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v.filter((g): g is string => typeof g === 'string').slice(0, 500);
  if (isObject(v)) return Object.keys(v).slice(0, 500);
  return [];
}

/** Hoort iemand bij een van deze groepen? (Precies, met hoofdletters.) */
export const inAnyGroup = (groups: string[], wanted: string[]): boolean => wanted.some((g) => groups.includes(g));

/**
 * Een gebruikersnaam voor een nieuw account, uit `preferred_username`, anders het deel vóór de @ van het e-mailadres, anders de
 * naam: opgeschoond tot wat een gebruikersnaam mag zijn (letters, cijfers, punt, streepje, underscore; 2 tot 40 tekens) en uniek
 * gemaakt met -2, -3, … Het e-mailadres wordt nooit gebruikt om een bestaand account te vinden.
 */
export function usernameFromClaims(claims: Record<string, unknown>, taken: (username: string) => boolean): string {
  const clean = (raw: unknown): string => {
    if (typeof raw !== 'string') return '';
    const s = raw.normalize('NFC').trim().replace(/\s+/g, '.').replace(/[^\p{L}\p{N}._-]/gu, '').replace(/^[^\p{L}\p{N}]+/u, '').replace(/[._-]+$/, '');
    return [...s].slice(0, 34).join('');
  };
  const email = typeof claims.email === 'string' ? claims.email.split('@')[0] : '';
  const base = [clean(claims.preferred_username), clean(email), clean(claims.name), 'gebruiker'].find((s) => [...s].length >= 2)!;
  if (!taken(base)) return base;
  for (let i = 2; i < 1000; i++) if (!taken(`${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${randomBytes(3).toString('hex')}`;
}

/** De naam voor een nieuw account: `name`, anders voor- en achternaam samen, anders de gebruikersnaam. */
export function displayNameFromClaims(claims: Record<string, unknown>, fallback: string): string {
  const text = (v: unknown) => (typeof v === 'string' ? v.normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, '').trim().replace(/\s+/g, ' ') : '');
  const name = text(claims.name) || [text(claims.given_name), text(claims.family_name)].filter(Boolean).join(' ');
  return name && name.length <= 100 ? name : fallback;
}
