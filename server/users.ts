// Gebruikers, wachtwoorden en sessies.
//
// - Wachtwoorden: scrypt met eigen salt (in de hash zelf, met de gebruikte kosten, zodat die later omhoog kunnen).
// - Sessies: één per apparaat, met een willekeurig token. De database bewaart alleen de SHA-256 van het token, dus een
//   gelekte database (of back-up) geeft geen werkende sessies.
// - Elke gebruiker heeft een eigen Inbox en is daar eigenaar van.
// - Het eerste account is altijd beheerder. Bestond er al een database uit versie 0.1 (zonder gebruikers), dan neemt dat
//   eerste account alle bestaande gegevens over.

import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import { ENTITIES, INBOX_ID, settingsId } from './schema.ts';
import type { Entity } from './schema.ts';
import { bumpRev, fail, getRow, insertRow, newId } from './rows.ts';
import type { Ctx, Row } from './rows.ts';
import { keyAfter } from '../shared/orderKey.js';
import { nameKey } from '../shared/text.js';
import { WEAK_REASONS_NL, weakPasswordReason } from '../shared/password.js';
import { LIMITS } from './limits.ts';

// ---------- wachtwoorden ----------

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number, options: object) => Promise<Buffer>;
let cost = { N: 32768, r: 8, p: 1 };
/** Alleen voor tests: lagere kosten maken ze snel. In productie blijft de standaard staan. */
export function setPasswordCostForTests(N: number): void {
  cost = { ...cost, N };
}

/**
 * Scrypt kost per berekening 32 MiB en ongeveer 90 ms op een draad van de threadpool van Node (4 draden, gedeeld met
 * het lezen van bestanden). Zonder grens kan een stroom inlogverzoeken de hele server vertragen. Daarom lopen er hooguit
 * `parallel` berekeningen tegelijk (de rest wacht, tot `waiting` stuks) en laten we er twee draden vrij voor de rest.
 * Is ook de wachtrij vol, dan geeft het verzoek meteen BUSY (HTTP 503) in plaats van mee te wachten.
 */
const gate = { parallel: 2, waiting: 32, running: 0, queue: [] as (() => void)[] };
/** Alleen voor tests: andere grenzen voor het aantal gelijktijdige scrypt-berekeningen. */
export function setScryptGateForTests(parallel: number, waiting: number): void {
  gate.parallel = parallel;
  gate.waiting = waiting;
}
/** Hoeveel berekeningen lopen er nu en hoeveel wachten er (voor tests). */
export const scryptGateState = (): { running: number; waiting: number } => ({ running: gate.running, waiting: gate.queue.length });

async function gated<T>(work: () => Promise<T>): Promise<T> {
  if (gate.running >= gate.parallel) {
    if (gate.queue.length >= gate.waiting) fail('BUSY', 'de server is druk; probeer het over een paar seconden opnieuw');
    await new Promise<void>((resolve) => gate.queue.push(resolve)); // de plek wordt overgedragen: `running` blijft gelijk
  } else {
    gate.running++;
  }
  try {
    return await work();
  } finally {
    const next = gate.queue.shift();
    if (next) next();
    else gate.running--;
  }
}

const derive = (password: string, salt: Buffer, c: { N: number; r: number; p: number }): Promise<Buffer> =>
  gated(() => scryptAsync(password.normalize('NFC'), salt, 32, { ...c, maxmem: 256 * c.N * c.r + (1 << 20) }));

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, cost);
  return `scrypt$${cost.N}$${cost.r}$${cost.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const c = { N: Number(n), r: Number(r), p: Number(p) };
  // een beschadigde of vervalste hash mag nooit tot enorme geheugenvraag leiden
  if (!Number.isInteger(c.N) || c.N < 2 || c.N > 1 << 20 || (c.N & (c.N - 1)) !== 0 || !(c.r >= 1 && c.r <= 16) || !(c.p >= 1 && c.p <= 4)) return false;
  const expected = Buffer.from(hash, 'base64url');
  const actual = await derive(password, Buffer.from(salt, 'base64url'), c);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

let dummyHash: Promise<string> | null = null;
/** Voor een onbekende gebruikersnaam rekenen we toch een hash uit, zodat de antwoordtijd niet verraadt wie bestaat. */
export async function verifyAgainstDummy(password: string): Promise<void> {
  // Mislukt het aanmaken (de server is druk), dan niet de mislukte belofte bewaren: de volgende poging probeert opnieuw.
  dummyHash ??= hashPassword('onbekende-gebruiker').catch((err) => { dummyHash = null; throw err; });
  await verifyPassword(password, await dummyHash);
}

// ---------- invoer controleren ----------

export function validateUsername(raw: unknown): string {
  if (typeof raw !== 'string') fail('INVALID_ARG', 'gebruikersnaam moet tekst zijn');
  const s = raw.normalize('NFC').trim();
  if (!/^[\p{L}\p{N}][\p{L}\p{N}._-]{1,39}$/u.test(s)) fail('INVALID_ARG', 'gebruikersnaam: 2 tot 40 tekens, letters, cijfers, punt, streepje of underscore, beginnend met een letter of cijfer');
  return s;
}

export function validateDisplayName(raw: unknown): string {
  if (typeof raw !== 'string') fail('INVALID_ARG', 'naam moet tekst zijn');
  const s = raw.normalize('NFC').trim().replace(/\s+/g, ' ');
  if (s.length < 1 || s.length > 100 || /[\u0000-\u001f\u007f]/u.test(s)) fail('INVALID_ARG', 'naam: 1 tot 100 tekens, zonder stuurtekens');
  return s;
}

export const MIN_PASSWORD_LENGTH = 10;
export function validatePassword(raw: unknown, username?: string): string {
  if (typeof raw !== 'string') fail('INVALID_ARG', 'wachtwoord moet tekst zijn');
  if ([...raw].length < MIN_PASSWORD_LENGTH) fail('INVALID_ARG', `wachtwoord: minimaal ${MIN_PASSWORD_LENGTH} tekens`);
  if (raw.length > 200) fail('INVALID_ARG', 'wachtwoord: maximaal 200 tekens');
  if (username && nameKey(raw) === nameKey(username)) fail('INVALID_ARG', 'het wachtwoord mag niet gelijk zijn aan de gebruikersnaam');
  const weak = weakPasswordReason(raw, username);
  if (weak) fail('INVALID_ARG', `wachtwoord: te makkelijk te raden (${WEAK_REASONS_NL[weak]}); kies een langere zin of meer verschillende tekens`);
  return raw;
}

// ---------- gebruikers ----------

export interface UserRow {
  id: string;
  username: string;
  name: string;
  is_admin: boolean;
  is_disabled: boolean;
  inbox_project_id: string;
  created_at: string;
}

const toUser = (r: Row): UserRow => ({
  id: r.id as string, username: r.username as string, name: r.name as string, is_admin: r.is_admin === 1, is_disabled: r.is_disabled === 1,
  inbox_project_id: r.inbox_project_id as string, created_at: r.created_at as string,
});

/** Wat een gebruiker over zichzelf te zien krijgt. */
export const publicMe = (u: UserRow) => ({ id: u.id, username: u.username, name: u.name, is_admin: u.is_admin, inbox_project_id: u.inbox_project_id });
/** Wat anderen over een gebruiker te zien krijgen: alleen wat nodig is om iemand te herkennen. */
export const publicPeer = (u: { id: string; username: string; name: string }) => ({ id: u.id, username: u.username, name: u.name });

export const countUsers = (db: DatabaseSync): number => (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
export const getUserById = (db: DatabaseSync, id: string): UserRow | undefined => {
  const r = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Row | undefined;
  return r && toUser(r);
};
export const getUserByName = (db: DatabaseSync, username: string): (UserRow & { password_hash: string }) | undefined => {
  const r = db.prepare('SELECT * FROM users WHERE username_key = ?').get(nameKey(username)) as Row | undefined;
  return r && { ...toUser(r), password_hash: r.password_hash as string };
};
export const listUsers = (db: DatabaseSync): UserRow[] => (db.prepare('SELECT * FROM users ORDER BY username_key').all() as Row[]).map(toUser);

/** De gebruiker zelf plus iedereen met wie die een project deelt. */
export function peersOf(db: DatabaseSync, userId: string): { id: string; username: string; name: string }[] {
  return (
    db
      .prepare(
        `SELECT id, username, name FROM users WHERE id = ? OR id IN (
           SELECT user_id FROM project_members WHERE is_deleted = 0 AND project_id IN (
             SELECT project_id FROM project_members WHERE user_id = ? AND is_deleted = 0))
         ORDER BY username_key`,
      )
      .all(userId, userId) as { id: string; username: string; name: string }[]
  ).map(publicPeer);
}

function insertWithDefaults(ctx: Ctx, e: Entity, id: string, values: Row): void {
  const v: Row = { ...values };
  for (const c of e.cols) if (v[c.name] === undefined && c.default !== undefined) v[c.name] = c.default;
  insertRow(ctx, e, id, v);
}

/** Neemt de gegevens uit een database van versie 0.1 (één gebruiker, zonder eigenaren) over voor het eerste account. */
function claimLegacyData(ctx: Ctx): void {
  for (const table of ['labels', 'filters', 'reminders']) {
    ctx.db.prepare(`UPDATE ${table} SET owner_id = ?, rev = ?, updated_at = ? WHERE owner_id IS NULL`).run(ctx.userId, ctx.rev, ctx.now);
  }
  const projects = ctx.db.prepare('SELECT id FROM projects WHERE is_deleted = 0').all() as { id: string }[];
  for (const p of projects) insertWithDefaults(ctx, ENTITIES.member, newId(), { project_id: p.id, user_id: ctx.userId, role: 'owner' });
}

/**
 * Zorgt dat de gebruiker een rij met instellingen heeft (standaardwaarden). Geeft true als die er nog niet was.
 * Accounts van vóór deze instellingen krijgen hem bij hun eerstvolgende sync.
 */
export function ensureSettings(ctx: Ctx): boolean {
  if (ctx.db.prepare('SELECT 1 FROM user_settings WHERE owner_id = ?').get(ctx.userId)) return false;
  insertWithDefaults(ctx, ENTITIES.settings, settingsId(ctx.userId), { owner_id: ctx.userId });
  return true;
}

export interface NewUser { username: string; name: string; passwordHash: string; isAdmin?: boolean }

/** Maakt een gebruiker met een eigen Inbox. Het allereerste account wordt altijd beheerder. */
export function createUser(db: DatabaseSync, input: NewUser): UserRow {
  const username = validateUsername(input.username);
  const name = validateDisplayName(input.name);
  db.exec('BEGIN IMMEDIATE');
  try {
    const first = countUsers(db) === 0;
    if (db.prepare('SELECT 1 FROM users WHERE username_key = ?').get(nameKey(username))) fail('DUPLICATE', 'deze gebruikersnaam is al in gebruik');
    const id = newId();
    const now = new Date().toISOString();
    const ctx: Ctx = { db, rev: bumpRev(db), now, userId: id };
    const legacy = first && getRow(db, ENTITIES.project, INBOX_ID) !== undefined;
    let inbox = INBOX_ID;
    if (legacy) {
      claimLegacyData(ctx);
    } else {
      inbox = `inbox-${id}`;
      insertWithDefaults(ctx, ENTITIES.project, inbox, { name: 'Inbox', order_key: keyAfter(null) });
      insertWithDefaults(ctx, ENTITIES.member, newId(), { project_id: inbox, user_id: id, role: 'owner' });
    }
    ensureSettings(ctx);
    db.prepare(
      'INSERT INTO users (id, username, username_key, name, password_hash, is_admin, is_disabled, inbox_project_id, created_at, password_changed_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)',
    ).run(id, username, nameKey(username), name, input.passwordHash, first || input.isAdmin ? 1 : 0, inbox, now, now);
    db.exec('COMMIT');
    return getUserById(db, id)!;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function otherEnabledAdmins(db: DatabaseSync, exceptId: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND is_disabled = 0 AND id <> ?').get(exceptId) as { n: number }).n;
}

export interface UserChanges { name?: unknown; is_admin?: unknown; is_disabled?: unknown }

/** Beheerderswijzigingen. Er blijft altijd minstens één actieve beheerder over. */
export function updateUser(db: DatabaseSync, id: string, changes: UserChanges): UserRow {
  const user = getUserById(db, id);
  if (!user) fail('NOT_FOUND', 'gebruiker bestaat niet');
  const sets: string[] = [];
  const params: (string | number)[] = [];
  if (changes.name !== undefined) { sets.push('name = ?'); params.push(validateDisplayName(changes.name)); }
  if (changes.is_admin !== undefined) {
    if (typeof changes.is_admin !== 'boolean') fail('INVALID_ARG', 'is_admin moet true of false zijn');
    sets.push('is_admin = ?'); params.push(changes.is_admin ? 1 : 0);
  }
  if (changes.is_disabled !== undefined) {
    if (typeof changes.is_disabled !== 'boolean') fail('INVALID_ARG', 'is_disabled moet true of false zijn');
    sets.push('is_disabled = ?'); params.push(changes.is_disabled ? 1 : 0);
  }
  const willBeAdmin = changes.is_admin === undefined ? user.is_admin : (changes.is_admin as boolean);
  const willBeEnabled = changes.is_disabled === undefined ? !user.is_disabled : !(changes.is_disabled as boolean);
  if (user.is_admin && !user.is_disabled && !(willBeAdmin && willBeEnabled) && otherEnabledAdmins(db, id) === 0) {
    fail('CONFLICT', 'er moet minstens één actieve beheerder blijven');
  }
  if (sets.length > 0) db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
  if (changes.is_disabled === true) revokeSessions(db, id);
  return getUserById(db, id)!;
}

/** Zet een nieuw wachtwoord. Alle sessies behalve `keepSessionId` worden ingetrokken. */
export function setPasswordHash(db: DatabaseSync, userId: string, passwordHash: string, keepSessionId?: string): void {
  db.prepare('UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?').run(passwordHash, new Date().toISOString(), userId);
  revokeSessions(db, userId, keepSessionId);
}

// ---------- sessies ----------

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
/** "Laatst gebruikt" wordt hooguit eens per uur bijgewerkt: niet bij elk verzoek een schrijfactie. */
export const TOUCH_AFTER_MS = 60 * 60_000;
const DAY_MS = 86_400_000;

/**
 * Wanneer een sessie verloopt: na `idleDays` dagen zonder gebruik, en hoe dan ook `maxDays` dagen na het inloggen.
 * 0 zet de grens uit. "Gebruik" is gemeten met `last_used_at`, dat hooguit een uur achterloopt.
 */
export interface SessionPolicy { idleDays: number; maxDays: number }
export const DEFAULT_SESSION_POLICY: SessionPolicy = { idleDays: 90, maxDays: 365 };

/** Is deze sessie op `nowMs` verlopen volgens `policy`? */
export function sessionExpired(s: { created_at: string; last_used_at: string }, policy: SessionPolicy, nowMs: number): boolean {
  if (policy.idleDays > 0 && nowMs - Date.parse(s.last_used_at) > policy.idleDays * DAY_MS) return true;
  if (policy.maxDays > 0 && nowMs - Date.parse(s.created_at) > policy.maxDays * DAY_MS) return true;
  return false;
}

/** Het soort apparaat, voor in de lijst. Alleen vaste namen uit een korte lijst, nooit versienummers: geen vingerafdruk. */
export interface DeviceKind { kind: 'browser' | 'app' | 'other'; browser: string | null; os: string | null }

/** Leest het soort apparaat uit een User-Agent. De web-app in de Android-app (een WebView, "; wv)") telt als de app. */
export function describeUserAgent(ua: string | undefined): DeviceKind {
  const s = (ua ?? '').slice(0, 500);
  const os = /Android/i.test(s) ? 'Android'
    : /iPhone|iPad|iPod/i.test(s) ? 'iOS'
      : /CrOS/.test(s) ? 'ChromeOS'
        : /Windows/i.test(s) ? 'Windows'
          : /Mac OS X|Macintosh/i.test(s) ? 'macOS'
            : /Linux|X11/i.test(s) ? 'Linux'
              : null;
  if (/; wv\)|Tickory-Android\//.test(s)) return { kind: 'app', browser: null, os: os ?? 'Android' };
  if (!/^Mozilla\//.test(s)) return { kind: 'other', browser: null, os };
  const browser = /Edg(A|iOS)?\//.test(s) ? 'Edge'
    : /OPR\/|Opera/.test(s) ? 'Opera'
      : /SamsungBrowser\//.test(s) ? 'Samsung Internet'
        : /Firefox\/|FxiOS\//.test(s) ? 'Firefox'
          : /Chrome\/|CriOS\//.test(s) ? 'Chrome'
            : /Safari\//.test(s) ? 'Safari'
              : null;
  return { kind: 'browser', browser, os };
}

const encodeDevice = (d: DeviceKind): string => `${d.kind}/${d.browser ?? ''}/${d.os ?? ''}`;
const decodeDevice = (raw: unknown): DeviceKind => {
  const [kind, browser, os] = typeof raw === 'string' ? raw.split('/') : [];
  return { kind: kind === 'browser' || kind === 'app' ? kind : 'other', browser: browser || null, os: os || null };
};

export interface SessionInfo { id: string; name: string; created_at: string; last_used_at: string; device: DeviceKind }

export function createSession(db: DatabaseSync, userId: string, deviceName: string, device: DeviceKind = { kind: 'other', browser: null, os: null }): { token: string; id: string } {
  const token = `tky_${randomBytes(32).toString('base64url')}`;
  const id = newId();
  const now = new Date().toISOString();
  const name = deviceName.normalize('NFC').replace(/[\u0000-\u001f\u007f\s]+/gu, ' ').trim().slice(0, 100) || 'Onbekend apparaat';
  db.prepare('INSERT INTO sessions (id, user_id, token_hash, name, created_at, last_used_at, device) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, userId, sha256(token), name, now, now, encodeDevice(device));
  // Het aantal aangemelde apparaten is begrensd (zie limits.ts): bij het volgende inloggen wordt het langst ongebruikte afgemeld.
  const surplus = db
    .prepare('SELECT id FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND id <> ? ORDER BY last_used_at DESC, created_at DESC, rowid DESC LIMIT -1 OFFSET ?')
    .all(userId, id, LIMITS.sessionsPerUser - 1) as { id: string }[];
  for (const old of surplus) db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?').run(now, old.id);
  // Ingetrokken sessies hoeven niet eeuwig in de database te blijven staan.
  db.prepare('DELETE FROM sessions WHERE revoked_at IS NOT NULL AND revoked_at < ?').run(new Date(Date.parse(now) - 30 * 86_400_000).toISOString());
  return { token, id };
}

/**
 * De gebruiker en sessie bij een token, of null als het token onbekend, ingetrokken, verlopen of van een geblokkeerd account
 * is. Een verlopen sessie wordt meteen ingetrokken (dan ruimt ook de rest op wat bij die sessie hoort, zoals meldingen).
 */
export function findSession(
  db: DatabaseSync, token: string, nowMs: number = Date.now(), policy: SessionPolicy = DEFAULT_SESSION_POLICY,
): { user: UserRow; sessionId: string } | null {
  if (token.length < 20 || token.length > 200) return null;
  const r = db
    .prepare(
      `SELECT s.id AS session_id, s.last_used_at AS session_last_used_at, s.created_at AS session_created_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.revoked_at IS NULL AND u.is_disabled = 0`,
    )
    .get(sha256(token)) as Row | undefined;
  if (!r) return null;
  const lastUsed = r.session_last_used_at as string;
  if (sessionExpired({ created_at: r.session_created_at as string, last_used_at: lastUsed }, policy, nowMs)) {
    db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(new Date(nowMs).toISOString(), r.session_id as string);
    return null;
  }
  if (nowMs - Date.parse(lastUsed) >= TOUCH_AFTER_MS) {
    db.prepare('UPDATE sessions SET last_used_at = ? WHERE id = ?').run(new Date(nowMs).toISOString(), r.session_id as string);
  }
  return { user: toUser(r), sessionId: r.session_id as string };
}

/** Is de sessie met dit id nog geldig, voor deze gebruiker (zonder het token: voor een downloadbewijs dat aan een sessie hangt)? */
export function sessionValid(db: DatabaseSync, userId: string, sessionId: string, nowMs: number = Date.now(), policy: SessionPolicy = DEFAULT_SESSION_POLICY): boolean {
  const s = db.prepare(
    'SELECT s.created_at, s.last_used_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.user_id = ? AND s.revoked_at IS NULL AND u.is_disabled = 0',
  ).get(sessionId, userId) as { created_at: string; last_used_at: string } | undefined;
  return Boolean(s) && !sessionExpired(s!, policy, nowMs);
}

/** De aangemelde apparaten van een gebruiker: alleen geldige sessies, laatst gebruikt eerst. */
export function listSessions(db: DatabaseSync, userId: string, nowMs: number = Date.now(), policy: SessionPolicy = DEFAULT_SESSION_POLICY): SessionInfo[] {
  const rows = db.prepare('SELECT id, name, created_at, last_used_at, device FROM sessions WHERE user_id = ? AND revoked_at IS NULL ORDER BY last_used_at DESC, created_at DESC').all(userId) as Row[];
  return rows
    .filter((r) => !sessionExpired(r as { created_at: string; last_used_at: string }, policy, nowMs))
    .map((r) => ({ id: r.id as string, name: r.name as string, created_at: r.created_at as string, last_used_at: r.last_used_at as string, device: decodeDevice(r.device) }));
}

/**
 * Ruimt sessies op: verlopen sessies worden ingetrokken, en wat al 30 dagen ingetrokken is, verdwijnt uit de database.
 * Geeft het aantal zojuist ingetrokken sessies terug. De server doet dit elk uur (en een verlopen sessie geldt al eerder niet meer).
 */
export function pruneSessions(db: DatabaseSync, policy: SessionPolicy = DEFAULT_SESSION_POLICY, nowMs: number = Date.now()): number {
  const now = new Date(nowMs).toISOString();
  const idleCutoff = policy.idleDays > 0 ? new Date(nowMs - policy.idleDays * DAY_MS).toISOString() : '';
  const maxCutoff = policy.maxDays > 0 ? new Date(nowMs - policy.maxDays * DAY_MS).toISOString() : '';
  const expired = db.prepare('UPDATE sessions SET revoked_at = ? WHERE revoked_at IS NULL AND (last_used_at < ? OR created_at < ?)').run(now, idleCutoff, maxCutoff).changes;
  db.prepare('DELETE FROM sessions WHERE revoked_at IS NOT NULL AND revoked_at < ?').run(new Date(nowMs - 30 * DAY_MS).toISOString());
  return Number(expired);
}

/** Trekt één sessie in; alleen die van de gebruiker zelf. Geeft terug of er een sessie was. */
export function revokeSession(db: DatabaseSync, userId: string, sessionId: string): boolean {
  return db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL').run(new Date().toISOString(), sessionId, userId).changes > 0;
}

/** Trekt alle sessies van een gebruiker in, behalve `exceptSessionId`. Geeft het aantal ingetrokken sessies terug. */
export function revokeSessions(db: DatabaseSync, userId: string, exceptSessionId?: string): number {
  return Number(db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND id <> ?').run(new Date().toISOString(), userId, exceptSessionId ?? '').changes);
}

// ---------- tweestapsverificatie (de opslag; de codes zelf staan in totp.ts) ----------

export interface TwoFactorRow {
  /** Versleuteld geheim (zie totp.ts), of null als tweestapsverificatie uit staat. */
  secret: string | null;
  enabledAt: string | null;
  lastStep: number | null;
  pending: string | null;
  pendingAt: string | null;
  recoveryLeft: number;
}

export function getTwoFactor(db: DatabaseSync, userId: string): TwoFactorRow {
  const r = db.prepare('SELECT totp_secret, totp_enabled_at, totp_last_step, totp_pending, totp_pending_at FROM users WHERE id = ?').get(userId) as Row | undefined;
  const left = (db.prepare('SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL').get(userId) as { n: number }).n;
  return {
    secret: (r?.totp_secret as string | null) ?? null, enabledAt: (r?.totp_enabled_at as string | null) ?? null,
    lastStep: (r?.totp_last_step as number | null) ?? null, pending: (r?.totp_pending as string | null) ?? null,
    pendingAt: (r?.totp_pending_at as string | null) ?? null, recoveryLeft: left,
  };
}

/** Heeft deze gebruiker tweestapsverificatie aan? */
export const hasTwoFactor = (db: DatabaseSync, userId: string): boolean =>
  Boolean((db.prepare('SELECT totp_secret FROM users WHERE id = ?').get(userId) as Row | undefined)?.totp_secret);

/** Een nieuw geheim dat nog bevestigd moet worden (een vorig, onbevestigd geheim vervalt). */
export function setPendingSecret(db: DatabaseSync, userId: string, sealed: string, nowIso: string): void {
  db.prepare('UPDATE users SET totp_pending = ?, totp_pending_at = ? WHERE id = ?').run(sealed, nowIso, userId);
}

/** Zet tweestapsverificatie aan met het bevestigde geheim; `step` is het tijdvak van de code waarmee bevestigd is. */
export function enableTwoFactor(db: DatabaseSync, userId: string, sealed: string, step: number, codeHashes: string[], nowIso: string): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE users SET totp_secret = ?, totp_enabled_at = ?, totp_last_step = ?, totp_pending = NULL, totp_pending_at = NULL WHERE id = ?').run(sealed, nowIso, step, userId);
    replaceRecoveryCodesInTransaction(db, userId, codeHashes, nowIso);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Legt vast dat het tijdvak `step` gebruikt is, alleen als het later is dan het laatst gebruikte. Geeft false als een ander
 * verzoek dit tijdvak (of een later) al gebruikte: zo kan dezelfde code ook niet in twee gelijktijdige verzoeken gelden.
 */
export function consumeStep(db: DatabaseSync, userId: string, step: number): boolean {
  return db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ? AND totp_secret IS NOT NULL AND (totp_last_step IS NULL OR totp_last_step < ?)').run(step, userId, step).changes === 1;
}

/** Gebruikt een herstelcode (de HMAC ervan). Geeft false als die niet bestaat of al gebruikt is. */
export function consumeRecoveryCode(db: DatabaseSync, userId: string, codeHash: string, nowIso: string): boolean {
  return db.prepare('UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL').run(nowIso, userId, codeHash).changes === 1;
}

function replaceRecoveryCodesInTransaction(db: DatabaseSync, userId: string, codeHashes: string[], nowIso: string): void {
  db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(userId);
  const insert = db.prepare('INSERT INTO recovery_codes (user_id, code_hash, created_at) VALUES (?, ?, ?)');
  for (const h of codeHashes) insert.run(userId, h, nowIso);
}

/** Nieuwe herstelcodes; de oude vervallen allemaal. */
export function replaceRecoveryCodes(db: DatabaseSync, userId: string, codeHashes: string[], nowIso: string): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    replaceRecoveryCodesInTransaction(db, userId, codeHashes, nowIso);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Zet tweestapsverificatie uit: geheim, onbevestigd geheim en herstelcodes weg. Geeft true als hij aan stond. */
export function disableTwoFactor(db: DatabaseSync, userId: string): boolean {
  const was = hasTwoFactor(db, userId);
  db.prepare('UPDATE users SET totp_secret = NULL, totp_enabled_at = NULL, totp_last_step = NULL, totp_pending = NULL, totp_pending_at = NULL WHERE id = ?').run(userId);
  db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(userId);
  return was;
}

// ---------- inlogpogingen beperken ----------

/**
 * Het adres waarop de beperking telt. Een IPv6-aanvaller heeft doorgaans een heel /64-blok tot zijn beschikking; per
 * volledig adres tellen zou dus niets beperken. Daarom telt bij IPv6 de voorkant (de eerste 64 bits). Een IPv4-adres in
 * IPv6-schrijfwijze (::ffff:1.2.3.4) telt als dat IPv4-adres.
 */
export function ipBucket(address: string): string {
  const s = address.trim().toLowerCase().split('%')[0];
  if (!s.includes(':')) return s;
  const mapped = /^(?:0:0:0:0:0:ffff|::ffff):(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (mapped) return mapped[1];
  if (s.includes('.')) return s; // een andere vorm met ingebed IPv4-adres: laat zoals het is
  const parts = s.split('::');
  if (parts.length > 2) return s;
  const head = parts[0] ? parts[0].split(':') : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  const groups = parts.length === 1 ? head : [...head, ...Array<string>(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail];
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return s;
  return `${groups.slice(0, 4).map((g) => g.padStart(4, '0')).join(':')}::/64`;
}

/** Een geregistreerde poging; geef hem aan `succeed` (gelukt) of `cancel` (niet de schuld van de bezoeker) terug. */
export interface LoginAttempt { at: number; pair: string; ip: string; user: string }

/**
 * Beperkt inlogpogingen, met drie tellers per venster (standaard een kwartier):
 *  - per combinatie van gebruikersnaam en adres (`pair`, 8): wie het wachtwoord raadt, kan dat maar een paar keer;
 *  - per adres (`ip`, 40; bij IPv6 per /64): één bron kan niet eindeloos veel namen proberen;
 *  - per gebruikersnaam over alle adressen (`user`, 60): een verspreide aanval wordt ook begrensd.
 * Een aanvaller van één adres kan het account van een ander dus niet vergrendelen: hij komt niet verder dan zijn eigen
 * `pair`-limiet, en voor de algemene limiet van de naam heeft hij tientallen adressen nodig. Het eigen adres van de
 * eigenaar telt apart.
 *
 * De poging wordt geteld voordat het wachtwoord wordt gecontroleerd (`begin`), niet erna. Controleren duurt even en
 * gebeurt asynchroon; tellen na afloop liet honderden gelijktijdige pogingen door de controle voordat de eerste telde.
 * Het geheugen is begrensd (de oudste tellers gaan eerst weg); een herstart wist de tellers.
 */
export class LoginLimiter {
  hits = new Map<string, number[]>();
  limits: { pair: number; ip: number; user: number };
  windowMs: number;
  now: () => number;
  maxKeys = 10_000;

  constructor(limits: Partial<{ pair: number; ip: number; user: number }> = {}, windowMs = 15 * 60_000, now: () => number = Date.now) {
    this.limits = { pair: 8, ip: 40, user: 60, ...limits };
    this.windowMs = windowMs;
    this.now = now;
  }

  recent(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length > 0) this.hits.set(key, list);
    else this.hits.delete(key);
    return list;
  }

  /**
   * Mag deze poging? Zo ja, dan is hij nu geteld en komt er een `attempt` terug. Zo nee, dan is `wait` het aantal seconden
   * tot het weer mag; een geweigerde poging telt niet mee (anders houdt wie blijft proberen zichzelf buitengesloten).
   */
  begin(username: string, ip: string): { wait: number; attempt: LoginAttempt | null } {
    const name = nameKey(username);
    const bucket = ipBucket(ip);
    const keys = { pair: `p:${name}|${bucket}`, ip: `i:${bucket}`, user: `u:${name}` };
    let wait = 0;
    const lists = (['pair', 'ip', 'user'] as const).map((kind) => {
      const list = this.recent(keys[kind]);
      const limit = this.limits[kind];
      if (list.length >= limit) wait = Math.max(wait, Math.ceil((list[list.length - limit] + this.windowMs - this.now()) / 1000));
      return list;
    });
    if (wait > 0) return { wait, attempt: null };
    const at = this.now();
    (['pair', 'ip', 'user'] as const).forEach((kind, i) => {
      this.hits.delete(keys[kind]); // opnieuw achteraan zetten: de Map houdt de volgorde van laatst gebruikt bij
      this.hits.set(keys[kind], [...lists[i], at]);
    });
    this.trim();
    return { wait: 0, attempt: { at, ...keys } };
  }

  private take(key: string, at: number): void {
    const list = this.hits.get(key);
    if (!list) return;
    const i = list.indexOf(at);
    if (i >= 0) list.splice(i, 1);
    if (list.length === 0) this.hits.delete(key);
  }

  /** Het wachtwoord klopte: deze poging telt niet als mislukking, en de mislukkingen van deze naam vanaf dit adres vervallen. */
  succeed(attempt: LoginAttempt): void {
    this.take(attempt.ip, attempt.at);
    this.take(attempt.user, attempt.at);
    this.hits.delete(attempt.pair);
  }

  /** De poging is niet door de bezoeker mislukt (bijvoorbeeld: de server was druk): hij telt niet mee. */
  cancel(attempt: LoginAttempt): void {
    this.take(attempt.pair, attempt.at);
    this.take(attempt.ip, attempt.at);
    this.take(attempt.user, attempt.at);
  }

  /**
   * Houdt het geheugen begrensd. Eerst gaat wat verlopen is; is het dan nog te veel (een aanval met steeds nieuwe namen
   * en adressen), dan gaan de oudst gebruikte tellers weg tot 90% van het maximum. Nooit alles tegelijk: dat zou de
   * tellers van een lopende aanval ook wissen.
   */
  private trim(): void {
    if (this.hits.size <= this.maxKeys) return;
    for (const key of [...this.hits.keys()]) this.recent(key);
    const target = Math.floor(this.maxKeys * 0.9);
    for (const key of this.hits.keys()) {
      if (this.hits.size <= target) break;
      this.hits.delete(key);
    }
  }
}
