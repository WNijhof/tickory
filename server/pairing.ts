// Koppelcodes: een apparaat aanmelden vanuit een sessie die al is ingelogd, zonder op dat apparaat een wachtwoord in te typen.
//
// Bedoeld voor de browserextensie ("Pagina als taak opslaan", zie extension/) op een server waar inloggen alleen via SSO kan
// (OIDC_ONLY): een extensie kan de inlogpagina van de provider niet zelf veilig afhandelen. In de web-app maak je onder Account,
// Apparaten een code; die typ of plak je in de extensie, en de extensie krijgt een eigen sessie (zichtbaar en in te trekken in
// dezelfde lijst). Het werkt ook op een server met wachtwoorden.
//
// Regels:
// - Een code is 80 willekeurige bits in Crockford-base32 (16 tekens, in groepjes van vier: makkelijk over te typen; I, L, O en U
//   bestaan niet en worden bij het invoeren als 1, 1 en 0 gelezen), 10 minuten geldig en eenmalig. De database bewaart alleen de
//   SHA-256 (tabel login_codes, soort `pair`), samen met de sessie die hem maakte: wordt die sessie afgemeld, dan vervalt de code.
// - Alleen voor jezelf: de code geeft een sessie van de gebruiker die hem maakte, en wie hem maakt moet eerst bewijzen dat hij het
//   is (het wachtwoord als het account er een heeft, en de code van tweestapsverificatie als die aan staat), net als bij het
//   koppelen van SSO: een koppelcode is een nieuwe manier om binnen te komen. Een account zonder wachtwoord (via SSO gemaakt)
//   heeft dat bewijs niet; daar volstaat de sessie.
// - Per gebruiker één code tegelijk (een nieuwe vervangt de vorige) en hooguit 10 per uur. Inwisselen telt per adres mee in een
//   eigen limiet (10 foute per kwartier); een gelukte poging geeft haar plek terug. De code staat nooit in een adres of logregel.
//   Met 80 bits en die limiet is raden kansloos.

import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { createSession, describeDevice, getUserById, getUserByName, hasTwoFactor, LoginLimiter, publicMe, sessionValid } from './users.ts';
import type { SessionPolicy, UserRow } from './users.ts';
import { hasPassword, takeLoginCode } from './sso.ts';

/** Hoe lang een koppelcode geldt, en hoeveel een gebruiker er per uur mag maken. */
export const PAIR_MS = 10 * 60_000;
export const PAIR_CODES_PER_HOUR = 10;
/** Crockford-base32: cijfers en hoofdletters zonder I, L, O en U. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_CHARS = 16;
/** Wat de database onder de code verstaat: een vast voorvoegsel, zodat hij niet samenvalt met andere soorten inlogcodes. */
const stored = (normalized: string): string => `tkp_${normalized}`;
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** Een nieuwe code van 16 tekens (80 bits), als "ABCD-EFGH-JKMN-PQRS". */
export function newPairCode(bytes: Uint8Array = randomBytes(10)): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  return out.slice(0, CODE_CHARS).match(/.{4}/g)!.join('-');
}

/**
 * Een ingetypte code in de vaste vorm (16 tekens uit het alfabet), of null. Spaties en streepjes tellen niet, kleine letters
 * mogen, en wat op een cijfer lijkt (I en L, O) wordt dat cijfer, zoals Crockford voorschrijft.
 */
export function normalizePairCode(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > 64) return null;
  const s = input.toUpperCase().replace(/[\s-]+/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  return s.length === CODE_CHARS && [...s].every((c) => ALPHABET.includes(c)) ? s : null;
}

interface Caller { user: UserRow; sessionId: string }

export interface PairingDeps {
  db: DatabaseSync;
  clock: () => number;
  log: (line: string) => void;
  policy: SessionPolicy;
  /** Telt het inwisselen per adres. */
  limiter: LoginLimiter;
  send: (res: ServerResponse, status: number, body: unknown, extra?: Record<string, string>) => void;
  readJson: (req: IncomingMessage) => Promise<Record<string, unknown>>;
  authenticate: (req: IncomingMessage) => Caller | null;
  clientIp: (req: IncomingMessage) => string;
  confirmPassword: (req: IncomingMessage, res: ServerResponse, caller: Caller, given: unknown) => Promise<boolean>;
  confirmCode: (req: IncomingMessage, res: ServerResponse, user: { id: string; username: string }, given: unknown) => 'totp' | 'recovery' | null;
}

export function createPairing(deps: PairingDeps) {
  const { db, clock, log, send, limiter } = deps;
  /** Wanneer elke gebruiker het laatste uur een code maakte (in het geheugen; een herstart begint opnieuw). */
  const madeBy = new Map<string, number[]>();

  /** Wat er nodig is om een code te maken: het wachtwoord (als het account er een heeft) en de code bij tweestapsverificatie. */
  const needs = (user: UserRow) => ({
    password: hasPassword(getUserByName(db, user.username)?.password_hash),
    code: hasTwoFactor(db, user.id),
    expires_in: PAIR_MS / 1000,
  });

  // ---- POST /api/v1/auth/pair-code {password?, code?} (aangemeld) ----
  const create = async (req: IncomingMessage, res: ServerResponse, caller: Caller): Promise<void> => {
    const body = await deps.readJson(req);
    const recent = (madeBy.get(caller.user.id) ?? []).filter((t) => t > clock() - 3_600_000);
    if (recent.length >= PAIR_CODES_PER_HOUR) {
      const wait = Math.ceil((recent[0] + 3_600_000 - clock()) / 1000);
      return send(res, 429, { error_code: 'TOO_MANY_REQUESTS', error: `hooguit ${PAIR_CODES_PER_HOUR} koppelcodes per uur; probeer het over ${Math.ceil(wait / 60)} minuten opnieuw` }, { 'Retry-After': String(wait) });
    }
    const need = needs(caller.user);
    if (need.password && !(await deps.confirmPassword(req, res, caller, body.password))) return undefined;
    if (need.code && !deps.confirmCode(req, res, caller.user, body.code)) return undefined;
    madeBy.set(caller.user.id, [...recent, clock()]);
    if (madeBy.size > 10_000) madeBy.delete(madeBy.keys().next().value!);
    const code = newPairCode();
    const now = clock();
    // Eén code tegelijk: een nieuwe vervangt wat er nog openstond. In `device` staat bij een koppelcode de sessie die hem maakte.
    db.prepare("DELETE FROM login_codes WHERE user_id = ? AND kind = 'pair'").run(caller.user.id);
    db.prepare("INSERT INTO login_codes (code_hash, user_id, kind, binding_hash, device, created_at, expires_at) VALUES (?, ?, 'pair', NULL, ?, ?, ?)").run(
      sha256(stored(normalizePairCode(code)!)), caller.user.id, caller.sessionId, new Date(now).toISOString(), new Date(now + PAIR_MS).toISOString(),
    );
    return send(res, 200, { code, expires_in: PAIR_MS / 1000 });
  };

  // ---- POST /api/v1/auth/pair {code, device_name} (zonder aanmelding; de code is het bewijs) ----
  const redeem = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await deps.readJson(req);
    const { wait, attempt } = limiter.begin('pair', deps.clientIp(req));
    if (!attempt) {
      return send(res, 429, { error_code: 'TOO_MANY_ATTEMPTS', error: `te veel pogingen; probeer het over ${Math.ceil(wait / 60)} minuut of langer opnieuw` }, { 'Retry-After': String(wait) });
    }
    const normalized = normalizePairCode(body.code);
    // Verbruikt de code meteen, ook als er hierna iets niet klopt: een code werkt hooguit één keer.
    const row = normalized ? takeLoginCode(db, stored(normalized), clock(), ['pair']) : null;
    const user = row ? getUserById(db, row.user_id) : undefined;
    if (!row || !user || user.is_disabled || !sessionValid(db, row.user_id, row.device, clock(), deps.policy)) {
      return send(res, 401, { error_code: 'CODE_INVALID', error: 'deze koppelcode is onbekend, verlopen of al gebruikt; maak in Tickory een nieuwe' });
    }
    limiter.succeed(attempt);
    const device = typeof body.device_name === 'string' ? body.device_name : '';
    const { token, id } = createSession(db, user.id, device || 'Gekoppeld apparaat', describeDevice(req));
    log(`[beveiliging] "${user.username}" heeft een apparaat gekoppeld met een koppelcode`);
    return send(res, 200, { token, session_id: id, me: publicMe(user) });
  };

  /** Afhandelen als het pad hierbij hoort; geeft false als het pad niet over koppelcodes gaat. */
  const handle = async (req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> => {
    if (path !== '/api/v1/auth/pair' && path !== '/api/v1/auth/pair-code') return false;
    const allowed = path === '/api/v1/auth/pair' ? ['POST'] : ['GET', 'POST'];
    if (!allowed.includes(req.method ?? '')) {
      send(res, 405, { error_code: 'METHOD_NOT_ALLOWED', error: `gebruik ${allowed.join(' of ')}` });
      return true;
    }
    if (path === '/api/v1/auth/pair') {
      await redeem(req, res);
      return true;
    }
    const caller = deps.authenticate(req);
    if (!caller) send(res, 401, { error_code: 'UNAUTHORIZED', error: 'ongeldige of ontbrekende aanmelding' });
    else if (req.method === 'GET') send(res, 200, needs(caller.user));
    else await create(req, res, caller);
    return true;
  };

  return { handle };
}

export type Pairing = ReturnType<typeof createPairing>;
