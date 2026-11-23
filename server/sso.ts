// Inloggen via OIDC ("SSO"): wat de server met een gecontroleerde identiteit doet (zie oidc.ts voor het protocol zelf).
//
// - Een identiteit is `issuer` + `subject` (de `sub` van de provider), in een eigen tabel gekoppeld aan één account. Koppelen doet
//   een gebruiker zelf vanuit Account, na het eigen wachtwoord (en de code van tweestapsverificatie als die aan staat). Nooit
//   vanzelf op e-mailadres of gebruikersnaam: dan zou wie bij de provider dat adres of die naam kiest, het account overnemen.
// - Met OIDC_AUTO_CREATE krijgt een onbekende identiteit een nieuw account (naam uit de claims, opgeschoond en uniek gemaakt).
// - De terugkeer van de provider levert nooit direct een sessie in het adres op. De callback maakt een eenmalige code (een paar
//   minuten geldig) die de app die de poging begon, inwisselt met een geheim (`binding`) dat alleen die app heeft. Zo heeft
//   een onderschepte terugkeerlink (`tickory://…` op Android, of een doorgestuurde link) geen waarde, en kan niemand een ander
//   ongemerkt in zijn eigen account laten inloggen.
// - De tweestapsverificatie van Tickory zelf geldt hier niet: bij inloggen via de provider gelden diens regels (en diens 2FA).

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import {
  createSession, createUser, describeDevice, getUserById, getUserByName, hasTwoFactor, LoginLimiter, publicMe, sessionValid, updateUser,
} from './users.ts';
import type { LoginAttempt, SessionPolicy, UserRow } from './users.ts';
import { displayNameFromClaims, groupsOf, inAnyGroup, OidcError, pkcePair, usernameFromClaims } from './oidc.ts';
import { deleteAccount } from './accountDelete.ts';
import type { OidcClient } from './oidc.ts';

/** De "hash" van een account zonder wachtwoord (gemaakt via SSO): past bij geen enkel wachtwoord. */
export const NO_PASSWORD = '!sso';
/** Heeft dit account een wachtwoord? */
export const hasPassword = (passwordHash: string | undefined): boolean => typeof passwordHash === 'string' && passwordHash.startsWith('scrypt$');

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const sameHash = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// ---------- de opslag ----------

export interface Identity { issuer: string; subject: string; created_at: string; last_login_at: string | null }

/** Het account bij deze identiteit, of undefined. */
export const userForIdentity = (db: DatabaseSync, issuer: string, subject: string): string | undefined =>
  (db.prepare('SELECT user_id FROM oidc_identities WHERE issuer = ? AND subject = ?').get(issuer, subject) as { user_id: string } | undefined)?.user_id;

/** De identiteit van dit account bij deze provider, of undefined. */
export const identityOf = (db: DatabaseSync, userId: string, issuer: string): Identity | undefined =>
  db.prepare('SELECT issuer, subject, created_at, last_login_at FROM oidc_identities WHERE user_id = ? AND issuer = ?').get(userId, issuer) as Identity | undefined;

/** Koppelt een identiteit aan een account. Gooit als de identiteit of het account al gekoppeld is (de database bewaakt beide). */
export function linkIdentity(db: DatabaseSync, issuer: string, subject: string, userId: string, nowIso: string): void {
  db.prepare('INSERT INTO oidc_identities (issuer, subject, user_id, created_at) VALUES (?, ?, ?, ?)').run(issuer, subject, userId, nowIso);
}

/** Haalt alle koppelingen van een account weg. Geeft het aantal. */
export const unlinkIdentities = (db: DatabaseSync, userId: string): number => Number(db.prepare('DELETE FROM oidc_identities WHERE user_id = ?').run(userId).changes);

export interface LoginCodeRow { user_id: string; kind: 'login' | 'linked' | 'emergency' | 'pair'; binding_hash: string | null; device: string; expires_at: string }

/**
 * Een eenmalige inlogcode (alleen de hash wordt bewaard). `kind`: `login` (na de provider, wordt een sessie), `linked` (na het
 * koppelen: alleen de melding dat het gelukt is) of `emergency` (de noodcode van de opdrachtregel).
 */
export function createLoginCode(db: DatabaseSync, p: { userId: string; kind: LoginCodeRow['kind']; bindingHash: string | null; device?: string; ttlMs: number; nowMs: number }): string {
  const code = `tko_${randomBytes(32).toString('base64url')}`;
  db.prepare('INSERT INTO login_codes (code_hash, user_id, kind, binding_hash, device, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    sha256(code), p.userId, p.kind, p.bindingHash, (p.device ?? '').slice(0, 100), new Date(p.nowMs).toISOString(), new Date(p.nowMs + p.ttlMs).toISOString(),
  );
  return code;
}

/**
 * Haalt een code op en verbruikt hem meteen (ook als hij daarna niet blijkt te kloppen). Null als hij onbekend of verlopen is, of
 * van een andere soort dan `kinds`: een koppelcode (`pair`, zie pairing.ts) werkt alleen bij het eigen eindpunt, en de codes van
 * SSO en de opdrachtregel werken daar niet.
 */
export function takeLoginCode(db: DatabaseSync, code: unknown, nowMs: number, kinds: LoginCodeRow['kind'][] = ['login', 'linked', 'emergency']): LoginCodeRow | null {
  if (typeof code !== 'string' || code.length < 20 || code.length > 200) return null;
  const row = db.prepare('DELETE FROM login_codes WHERE code_hash = ? AND kind IN (SELECT value FROM json_each(?)) RETURNING user_id, kind, binding_hash, device, expires_at')
    .get(sha256(code), JSON.stringify(kinds)) as LoginCodeRow | undefined;
  return row && Date.parse(row.expires_at) > nowMs ? row : null;
}

/** Ruimt verlopen codes op. */
export const pruneLoginCodes = (db: DatabaseSync, nowMs: number): number => Number(db.prepare('DELETE FROM login_codes WHERE expires_at < ?').run(new Date(nowMs).toISOString()).changes);

// ---------- de eindpunten ----------

/** Foutcodes van een terugkeer van de provider. De app toont ze in de taal van de gebruiker (client/core/sso.js), zonder details. */
export type SsoError = 'EXPIRED' | 'CANCELLED' | 'PROVIDER' | 'UNAVAILABLE' | 'NO_ACCOUNT' | 'NOT_ALLOWED' | 'DISABLED' | 'ALREADY_LINKED' | 'CREATE_FAILED' | 'TOO_MANY_ATTEMPTS';

interface Caller { user: UserRow; sessionId: string }

export interface SsoDeps {
  db: DatabaseSync;
  /** null: OIDC staat uit (alleen de noodcode van de opdrachtregel werkt dan). */
  client: OidcClient | null;
  clock: () => number;
  log: (line: string) => void;
  policy: SessionPolicy;
  limiter: LoginLimiter;
  send: (res: ServerResponse, status: number, body: unknown, extra?: Record<string, string>) => void;
  readJson: (req: IncomingMessage) => Promise<Record<string, unknown>>;
  authenticate: (req: IncomingMessage) => Caller | null;
  clientIp: (req: IncomingMessage) => string;
  confirmPassword: (req: IncomingMessage, res: ServerResponse, caller: Caller, given: unknown) => Promise<boolean>;
  confirmCode: (req: IncomingMessage, res: ServerResponse, user: { id: string; username: string }, given: unknown) => 'totp' | 'recovery' | null;
}

/** Hoe lang een poging bij de provider mag duren, en hoe lang de code na terugkeer geldt. */
const PENDING_MS = 10 * 60_000;
const HANDOFF_MS = 2 * 60_000;
export const EMERGENCY_MS = 15 * 60_000;
const MAX_PENDING = 2_000;
/** Het adres waarmee de provider terugkeert naar de Android-app (zie android/README.md). */
export const APP_RETURN = 'tickory://oidc';

interface Pending {
  purpose: 'login' | 'link';
  client: 'web' | 'app';
  nonce: string;
  verifier: string;
  bindingHash: string;
  device: string;
  userId: string | null;
  sessionId: string | null;
  authUrl: string;
  expires: number;
  attempt: LoginAttempt;
}

const STATE_RE = /^[A-Za-z0-9_-]{20,100}$/;
const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/** Wat in een logregel mag van een claim: kort, zonder stuurtekens. */
const loggable = (v: unknown): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f"]/g, '').slice(0, 80) : '');

/**
 * De pagina waarmee de browser (een Custom Tab op Android) terugkeert naar de app: een knop naar `tickory://oidc?code=…` (of
 * `?error=…`) en een poging om meteen terug te springen. Een browser springt niet altijd vanzelf naar een app (Chrome soms alleen
 * na een tik); de knop werkt altijd. Strenge CSP, niets in de cache. Los van de socket, zodat een test precies ziet wat er gaat
 * (een netwerkfilter als AdGuard herschrijft HTML onderweg).
 */
export function appReturnPage(outcome: { code: string } | { error: string }, acceptLanguage: string): { headers: Record<string, string | number>; body: string } {
  const target = `${APP_RETURN}?${'code' in outcome ? `code=${outcome.code}` : `error=${outcome.error}`}`;
  const en = /^\s*en\b/i.test(acceptLanguage);
  const body = `<!doctype html><html lang="${en ? 'en' : 'nl'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<meta http-equiv="refresh" content="0;url=${escapeHtml(target)}"><title>Tickory</title></head><body>`
    + `<p>${en ? 'Returning to the app…' : 'Terug naar de app…'}</p><p><a href="${escapeHtml(target)}">${en ? 'Back to Tickory' : 'Terug naar Tickory'}</a></p></body></html>`;
  return {
    headers: {
      'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    },
    body,
  };
}

export function createSso(deps: SsoDeps) {
  const { db, client, clock, log, send, limiter } = deps;
  const config = client?.config ?? null;
  const pending = new Map<string, Pending>();

  const forget = (): void => {
    for (const [k, v] of pending) if (v.expires <= clock()) pending.delete(k);
    while (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value!);
  };

  const tooMany = (res: ServerResponse, wait: number): void =>
    send(res, 429, { error_code: 'TOO_MANY_ATTEMPTS', error: `te veel pogingen; probeer het over ${Math.ceil(wait / 60)} minuut of langer opnieuw` }, { 'Retry-After': String(wait) });

  /** Terug naar de app: in de browser naar de web-app met de uitkomst achter de #, in de Android-app naar `tickory://oidc`. */
  const back = (req: IncomingMessage, res: ServerResponse, to: 'web' | 'app', outcome: { code: string } | { error: SsoError }): void => {
    const common = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
    if (to === 'web') {
      res.writeHead(302, { ...common, Location: 'code' in outcome ? `/#oidc=${outcome.code}` : `/#oidc-error=${outcome.error}` });
      res.end();
      return;
    }
    const page = appReturnPage(outcome, String(req.headers['accept-language'] ?? ''));
    res.writeHead(200, page.headers);
    res.end(page.body);
  };

  /** Koppelingen staan in de database onder de issuer uit de configuratie (zonder afsluitende schuine streep). */
  const linkedTo = (userId: string): ReturnType<typeof identityOf> => (config ? identityOf(db, userId, config.issuer) : undefined);

  /** Wat het accountscherm over SSO laat zien. */
  const status = (user: UserRow) => {
    if (!config) return { enabled: false };
    const id = linkedTo(user.id);
    const withPassword = hasPassword(getUserByName(db, user.username)?.password_hash);
    return {
      enabled: true, name: config.buttonName, linked: Boolean(id), linked_at: id?.created_at ?? null,
      has_password: withPassword, two_factor: hasTwoFactor(db, user.id), can_unlink: Boolean(id) && withPassword && !config.only,
    };
  };

  // ---- POST /api/v1/auth/oidc/start ----
  const start = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await deps.readJson(req);
    const purpose = body.purpose === 'login' || body.purpose === 'link' ? body.purpose : null;
    if (!purpose) return send(res, 400, { error_code: 'INVALID_REQUEST', error: 'purpose moet login of link zijn' });
    const to = body.client === 'app' ? 'app' : 'web';
    const { wait, attempt } = limiter.begin('sso', deps.clientIp(req));
    if (!attempt) return tooMany(res, wait);
    let caller: Caller | null = null;
    if (purpose === 'link') {
      caller = deps.authenticate(req);
      if (!caller) {
        limiter.cancel(attempt);
        return send(res, 401, { error_code: 'UNAUTHORIZED', error: 'ongeldige of ontbrekende aanmelding' });
      }
      if (linkedTo(caller.user.id)) {
        limiter.cancel(attempt);
        return send(res, 409, { error_code: 'CONFLICT', error: 'je account is al gekoppeld' });
      }
      // Koppelen geeft een nieuwe manier om in te loggen (zonder de tweestapsverificatie van Tickory): eerst bewijzen dat jij het bent.
      if (hasPassword(getUserByName(db, caller.user.username)?.password_hash) && !(await deps.confirmPassword(req, res, caller, body.password))) return limiter.cancel(attempt);
      if (hasTwoFactor(db, caller.user.id) && !deps.confirmCode(req, res, caller.user, body.code)) return limiter.cancel(attempt);
    }
    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const binding = randomBytes(32).toString('base64url');
    const { verifier, challenge } = pkcePair();
    let authUrl: string;
    try {
      authUrl = await client!.authorizationUrl({ state, nonce, codeChallenge: challenge, lang: typeof body.lang === 'string' ? body.lang : null });
    } catch (err) {
      limiter.cancel(attempt);
      log(`[sso] de identiteitsprovider is niet bereikbaar of gaf een ongeldige discovery: ${(err as Error).message}`);
      return send(res, 503, { error_code: 'UNAVAILABLE', error: 'de inlogdienst is nu niet bereikbaar; probeer het later opnieuw' }, { 'Retry-After': '30' });
    }
    const device = typeof body.device_name === 'string' ? body.device_name.slice(0, 100) : '';
    pending.set(state, {
      purpose, client: to, nonce, verifier, bindingHash: sha256(binding), device, userId: caller?.user.id ?? null, sessionId: caller?.sessionId ?? null,
      authUrl, expires: clock() + PENDING_MS, attempt,
    });
    forget();
    return send(res, 200, { url: `/api/v1/auth/oidc/authorize?state=${state}`, binding, expires_in: PENDING_MS / 1000 });
  };

  // ---- GET /api/v1/auth/oidc/authorize?state=… (op het eigen adres; de Android-app opent alleen dat in de browser) ----
  const authorize = (req: IncomingMessage, res: ServerResponse, url: URL): void => {
    const state = url.searchParams.get('state') ?? '';
    const p = STATE_RE.test(state) ? pending.get(state) : undefined;
    if (!p || p.expires <= clock()) return back(req, res, 'web', { error: 'EXPIRED' });
    res.writeHead(302, { Location: p.authUrl, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    res.end();
  };

  /** Beheerder volgens de groepen van de provider (alleen met OIDC_ADMIN_GROUPS). Er blijft altijd een actieve beheerder. */
  const syncAdmin = (user: UserRow, groups: string[]): void => {
    if (!config || config.adminGroups.length === 0) return;
    const want = inAnyGroup(groups, config.adminGroups);
    if (want === user.is_admin) return;
    try {
      updateUser(db, user.id, { is_admin: want });
      log(`[sso] "${user.username}" is ${want ? 'nu beheerder' : 'geen beheerder meer'} (groepen van de identiteitsprovider)`);
    } catch {
      log(`[sso] "${user.username}" blijft beheerder: er moet minstens één actieve beheerder blijven (zit niet in OIDC_ADMIN_GROUPS)`);
    }
  };

  /** Een nieuw account voor een onbekende identiteit (alleen met OIDC_AUTO_CREATE). */
  const createAccount = (claims: Record<string, unknown>, groups: string[], issuer: string, subject: string): UserRow => {
    const username = usernameFromClaims(claims, (u) => getUserByName(db, u) !== undefined);
    const isAdmin = config!.adminGroups.length > 0 && inAnyGroup(groups, config!.adminGroups);
    const user = createUser(db, { username, name: displayNameFromClaims(claims, username), passwordHash: NO_PASSWORD, isAdmin });
    try {
      linkIdentity(db, issuer, subject, user.id, new Date(clock()).toISOString());
    } catch (err) {
      // zonder koppeling kan niemand met dit nieuwe account inloggen (het heeft geen wachtwoord): weer weg, geen los account
      deleteAccount(db, user.id);
      throw err;
    }
    log(`[sso] nieuw account "${user.username}" aangemaakt bij de eerste keer inloggen via de identiteitsprovider${user.is_admin ? ' (beheerder)' : ''}`);
    return user;
  };

  // ---- GET /api/v1/auth/oidc/callback?code=…&state=… (de provider stuurt de browser hierheen) ----
  const callback = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    const state = url.searchParams.get('state') ?? '';
    const p = STATE_RE.test(state) ? pending.get(state) : undefined;
    if (p) pending.delete(state); // eenmalig, ook als er hierna iets misgaat
    const to = p?.client ?? 'web';
    const fail = (error: SsoError, why: string): void => {
      if (why) log(`[sso] inloggen via de identiteitsprovider geweigerd (${error}): ${why}`);
      back(req, res, to, { error });
    };
    const { wait, attempt } = limiter.begin('sso', deps.clientIp(req));
    if (!attempt) return fail('TOO_MANY_ATTEMPTS', `te veel pogingen vanaf dit adres (nog ${wait} s)`);
    if (!p || p.expires <= clock()) return fail('EXPIRED', p ? 'de poging duurde te lang' : 'onbekende of al gebruikte state');
    const providerError = url.searchParams.get('error');
    if (providerError !== null) return fail(providerError === 'access_denied' ? 'CANCELLED' : 'PROVIDER', `de provider meldt "${loggable(providerError).replace(/[^\w.-]/g, '')}"`);
    const issuer = config!.issuer;
    // RFC 9207: noemt de provider zichzelf in de terugkeer, dan moet dat dezelfde zijn (tegen het verwisselen van providers).
    const iss = url.searchParams.get('iss');
    if (iss !== null && iss.replace(/\/$/, '') !== issuer) return fail('PROVIDER', 'de terugkeer noemt een andere issuer');
    const code = url.searchParams.get('code') ?? '';
    if (!code || code.length > 4096) return fail('PROVIDER', 'geen code in de terugkeer');
    let claims: Record<string, unknown>;
    try {
      claims = (await client!.redeem(code, p.verifier, p.nonce)).claims;
    } catch (err) {
      return fail(err instanceof OidcError ? err.code : 'PROVIDER', (err as Error).message);
    }
    const subject = claims.sub as string;
    const who = loggable(claims.preferred_username) || loggable(claims.email) || 'onbekend';
    const groups = groupsOf(claims, config!.groupsClaim);
    if (config!.allowedGroups.length > 0 && !inAnyGroup(groups, config!.allowedGroups)) return fail('NOT_ALLOWED', `"${who}" zit niet in OIDC_ALLOWED_GROUPS`);
    const nowIso = new Date(clock()).toISOString();
    const owner = userForIdentity(db, issuer, subject);

    if (p.purpose === 'link') {
      const user = p.userId ? getUserById(db, p.userId) : undefined;
      if (!user || user.is_disabled || !sessionValid(db, user.id, p.sessionId!, clock(), deps.policy)) return fail('EXPIRED', 'de sessie die het koppelen begon, is niet meer geldig');
      if (owner && owner !== user.id) return fail('ALREADY_LINKED', `de identiteit van "${who}" is al aan een ander account gekoppeld`);
      if (!owner) {
        if (linkedTo(user.id)) return fail('ALREADY_LINKED', `"${user.username}" is intussen al gekoppeld`);
        try {
          linkIdentity(db, issuer, subject, user.id, nowIso);
        } catch {
          return fail('ALREADY_LINKED', `de identiteit van "${who}" is intussen al gekoppeld`); // een tweede terugkeer tegelijk
        }
      }
      log(`[sso] "${user.username}" heeft het account gekoppeld aan de identiteitsprovider ("${who}")`);
      limiter.succeed(attempt);
      limiter.succeed(p.attempt);
      return back(req, res, to, { code: createBound(user.id, 'linked', p) });
    }

    let user = owner ? getUserById(db, owner) : undefined;
    if (!user) {
      if (!config!.autoCreate) return fail('NO_ACCOUNT', `aan de identiteit van "${who}" is geen account gekoppeld (koppel eerst vanuit Account, of zet OIDC_AUTO_CREATE aan)`);
      try {
        user = createAccount(claims, groups, issuer, subject);
      } catch (err) {
        return fail('CREATE_FAILED', `het account voor "${who}" kon niet worden aangemaakt: ${(err as Error).message}`);
      }
    }
    if (user.is_disabled) return fail('DISABLED', `het account "${user.username}" is geblokkeerd`);
    syncAdmin(user, groups);
    db.prepare('UPDATE oidc_identities SET last_login_at = ? WHERE issuer = ? AND subject = ?').run(nowIso, issuer, subject);
    limiter.succeed(attempt);
    limiter.succeed(p.attempt);
    log(`[sso] "${user.username}" logt in via de identiteitsprovider`);
    return back(req, res, to, { code: createBound(user.id, 'login', p) });
  };

  /** De eenmalige code na een gelukte terugkeer, gebonden aan het geheim van de app die de poging begon. */
  const createBound = (userId: string, kind: 'login' | 'linked', p: Pending): string =>
    createLoginCode(db, { userId, kind, bindingHash: p.bindingHash, device: p.device, ttlMs: HANDOFF_MS, nowMs: clock() });

  // ---- POST /api/v1/auth/login/handoff {code, binding} ----
  const handoff = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await deps.readJson(req);
    const { wait, attempt } = limiter.begin('sso', deps.clientIp(req));
    if (!attempt) return tooMany(res, wait);
    const row = takeLoginCode(db, body.code, clock());
    const bindingOk = row && (row.binding_hash === null || (typeof body.binding === 'string' && body.binding.length <= 200 && sameHash(sha256(body.binding), row.binding_hash)));
    const user = row && bindingOk ? getUserById(db, row.user_id) : undefined;
    if (!row || !bindingOk || !user || user.is_disabled) {
      return send(res, 401, { error_code: 'CODE_INVALID', error: 'deze inlogpoging is verlopen of ongeldig; probeer het opnieuw' });
    }
    limiter.succeed(attempt);
    if (row.kind === 'linked') return send(res, 200, { linked: true, name: config?.buttonName ?? 'SSO' });
    if (row.kind === 'emergency') log(`[beveiliging] "${user.username}" is ingelogd met een noodcode van de opdrachtregel`);
    const { token, id } = createSession(db, user.id, row.device || (row.kind === 'emergency' ? 'Noodcode' : 'SSO'), describeDevice(req), { remember: body.remember !== false });
    return send(res, 200, { token, session_id: id, me: publicMe(user) });
  };

  /** Afhandelen als het pad hierbij hoort; geeft false als het pad niet van SSO is (of SSO uit staat). */
  const handle = async (req: IncomingMessage, res: ServerResponse, path: string, url: URL): Promise<boolean> => {
    const wants = (method: string): boolean => {
      if (req.method === method) return true;
      send(res, 405, { error_code: 'METHOD_NOT_ALLOWED', error: `gebruik ${method}` });
      return false;
    };
    if (path === '/api/v1/auth/login/handoff') {
      if (wants('POST')) await handoff(req, res);
      return true;
    }
    if (path === '/api/v1/auth/oidc/link') {
      if (!wants('GET')) return true;
      const caller = deps.authenticate(req);
      if (!caller) send(res, 401, { error_code: 'UNAUTHORIZED', error: 'ongeldige of ontbrekende aanmelding' });
      else send(res, 200, status(caller.user));
      return true;
    }
    if (!client || !path.startsWith('/api/v1/auth/oidc/')) return false;
    if (path === '/api/v1/auth/oidc/start') {
      if (wants('POST')) await start(req, res);
      return true;
    }
    if (path === '/api/v1/auth/oidc/authorize') {
      if (wants('GET')) authorize(req, res, url);
      return true;
    }
    if (path === '/api/v1/auth/oidc/callback') {
      if (wants('GET')) await callback(req, res, url);
      return true;
    }
    if (path === '/api/v1/auth/oidc/unlink') {
      if (!wants('POST')) return true;
      const caller = deps.authenticate(req);
      if (!caller) {
        send(res, 401, { error_code: 'UNAUTHORIZED', error: 'ongeldige of ontbrekende aanmelding' });
        return true;
      }
      const s = status(caller.user) as { linked: boolean; can_unlink: boolean };
      if (!s.linked) send(res, 409, { error_code: 'CONFLICT', error: 'je account is niet gekoppeld' });
      else if (!s.can_unlink) send(res, 409, { error_code: 'CONFLICT', error: 'dit is de enige manier waarop je kunt inloggen; vraag eerst een beheerder om een wachtwoord' });
      else {
        unlinkIdentities(db, caller.user.id);
        log(`[sso] "${caller.user.username}" heeft de koppeling met de identiteitsprovider verwijderd`);
        send(res, 200, status(caller.user));
      }
      return true;
    }
    return false;
  };

  return {
    handle,
    /** Staat inloggen met een wachtwoord uit (OIDC_ONLY)? */
    passwordOff: Boolean(config?.only),
    /** Wat het inlogscherm moet tonen. */
    methods: () => ({ password: !config?.only, sso: config ? { name: config.buttonName } : null }),
    /** Is dit account gekoppeld (voor gebruikersbeheer)? */
    isLinked: (userId: string): boolean => Boolean(db.prepare('SELECT 1 FROM oidc_identities WHERE user_id = ?').get(userId)),
    /** Koppeling weghalen door een beheerder (bijvoorbeeld een identiteit die per ongeluk een nieuw account kreeg). */
    unlinkUser: (userId: string): number => unlinkIdentities(db, userId),
    /** Opruimen: verlopen pogingen en codes. */
    sweep: (): void => {
      forget();
      pruneLoginCodes(db, clock());
    },
  };
}

export type Sso = ReturnType<typeof createSso>;
