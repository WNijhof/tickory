// Meldingen in de browser (Web Push): bijhouden welke apparaten meldingen willen, elke paar seconden kijken welke
// herinneringen aan de beurt zijn, en ze versturen. De Android-app heeft dit niet nodig: die plant zijn meldingen zelf in.
//
// - Een apparaat meldt zich aan met het adres van zijn pushdienst en twee sleutels (uit de browser). Alleen bekende
//   pushdiensten zijn toegestaan (zie webpush.ts).
// - Een herinnering gaat af op een "zwevende" lokale tijd; de server rekent die om met de tijdzone uit de instellingen
//   van de gebruiker (of de standaardtijdzone van de server).
// - Elke herinnering wordt per tijdstip één keer verstuurd (tabel reminder_deliveries). Was de server even uit, dan gaat
//   wat hooguit een uur te laat is alsnog; ouder niet.
// - Het werk per ronde is begrensd (MAX_DUE_PER_OWNER_PER_ROUND per gebruiker, TICK_BUDGET_MS in totaal): de database kiest
//   per gebruiker alleen wat rond dit moment kan afgaan; een gebruiker met heel veel herinneringen houdt anderen niet op.
// - De knoppen in een melding ("Voltooien", "Over 10 minuten") werken zonder dat de browser is ingelogd: de melding
//   draagt daarvoor een ondertekend bewijsje (HMAC) dat precies die ene handeling op die ene taak toestaat, een dag lang.
//   Het wordt strikt gelezen (alleen exact de tekst die sign() maakte), het uuid van de handeling komt uit de handtekening
//   (dezelfde knop doet de handeling één keer, hoe het bewijs ook wordt aangeboden), en het werkt alleen zolang de
//   gebruiker een aangemeld apparaat met meldingen heeft: na uitloggen of een ingetrokken sessie is het bewijs waardeloos.

import type { DatabaseSync } from 'node:sqlite';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { epochToFloating, floatingToEpoch, reminderMoment } from '../shared/reminders.js';
import { b64u, fromB64u, generateVapidKeys, isAllowedEndpoint, isValidVapid, sendWebPush } from './webpush.ts';
import type { SendResult, VapidKeys } from './webpush.ts';
import { currentRev, fail, newId } from './rows.ts';
import type { Row } from './rows.ts';
import { handleSync } from './sync.ts';

/** Hoe lang na het tijdstip een herinnering nog verstuurd wordt (bijvoorbeeld na een herstart van de server). */
export const LATE_WINDOW_MS = 60 * 60_000;
const SNOOZE_MS = 10 * 60_000;
const ACTION_VALID_S = 24 * 3600;
const MAX_SUBSCRIPTIONS_PER_USER = 20;
/** Hoeveel herinneringen één gebruiker per ronde krijgt, en hoe lang een ronde hooguit werk begint (de rest volgt de volgende ronde). */
export const MAX_DUE_PER_OWNER_PER_ROUND = 200;
const TICK_BUDGET_MS = 20_000;

export interface PushConfig {
  db: DatabaseSync;
  /**
   * Contactadres van de beheerder van déze server voor de pushdienst: "mailto:…" of een https-adres (VAPID_SUBJECT).
   * Niet ingesteld of in een andere vorm: er gaat geen contactadres mee. Er is bewust geen standaardwaarde: het adres
   * van het project zou dan het contact zijn voor de servers van iedereen die Tickory installeert.
   */
  subject?: string;
  /** Tijdzone voor gebruikers die er (nog) geen hebben ingesteld. */
  defaultTimeZone?: string;
  extraAllowedHosts?: string[];
  fetch?: typeof fetch;
  now?: () => number;
}

export interface SubscriptionInput { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown }; lang?: unknown }
export interface SubscriptionInfo { id: string; device: string; current: boolean; created_at: string; last_success_at: string | null; last_error: string | null; last_error_at: string | null }
export interface TickResult { due: number; sent: number; failed: number; removed: number }
export type Push = ReturnType<typeof createPush>;

function meta(db: DatabaseSync, key: string, make: () => string): string {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  if (row) return row.value;
  const value = make();
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(key, value);
  return value;
}

export function createPush(cfg: PushConfig) {
  const db = cfg.db;
  const now = cfg.now ?? Date.now;
  const subject = cfg.subject && /^(mailto:[^\s@]+@[^\s@]+|https:\/\/[^\s]+)$/.test(cfg.subject) ? cfg.subject : null;
  const defaultZone = cfg.defaultTimeZone || 'Europe/Amsterdam';
  // Een tikfout in DEFAULT_TIMEZONE (bijvoorbeeld "Europa/Amsterdam") liet elke ronde van de herinneringen voor gebruikers zonder
  // eigen tijdzone mislukken. Daarom bij het opstarten een duidelijke fout in plaats van stilte later.
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: defaultZone });
  } catch {
    throw new Error(`DEFAULT_TIMEZONE "${defaultZone}" is geen bekende tijdzone; gebruik een IANA-naam zoals Europe/Amsterdam`);
  }

  // De sleutels van deze server: één keer aangemaakt, daarna uit de database (ze horen bij de aanmeldingen van de apparaten).
  let vapid: VapidKeys = { publicKey: meta(db, 'vapid_public', () => ''), privateKey: meta(db, 'vapid_private', () => '') };
  if (!isValidVapid(vapid)) {
    vapid = generateVapidKeys();
    db.prepare("UPDATE meta SET value = ? WHERE key = 'vapid_public'").run(vapid.publicKey);
    db.prepare("UPDATE meta SET value = ? WHERE key = 'vapid_private'").run(vapid.privateKey);
    db.exec('DELETE FROM push_subscriptions'); // aanmeldingen bij een oude sleutel werken niet meer
  }
  const secret = fromB64u(meta(db, 'push_secret', () => b64u(randomBytes(32))));

  // ---------- apparaten ----------

  function subscribe(userId: string, sessionId: string, input: SubscriptionInput): { id: string } {
    const endpoint = input.endpoint;
    if (typeof endpoint !== 'string' || endpoint.length > 2000 || !isAllowedEndpoint(endpoint, cfg.extraAllowedHosts)) {
      fail('INVALID_ARG', 'het adres van de pushdienst is niet toegestaan');
    }
    const p256dh = input.keys?.p256dh;
    const auth = input.keys?.auth;
    if (typeof p256dh !== 'string' || typeof auth !== 'string' || p256dh.length > 200 || auth.length > 100) fail('INVALID_ARG', 'de sleutels van het apparaat ontbreken');
    const pub = fromB64u(p256dh);
    if (pub.length !== 65 || pub[0] !== 0x04 || fromB64u(auth).length !== 16) fail('INVALID_ARG', 'de sleutels van het apparaat zijn ongeldig');
    const lang = input.lang === 'en' ? 'en' : 'nl';
    const at = new Date(now()).toISOString();
    // Hetzelfde apparaat opnieuw (ook onder een ander account): de oude aanmelding vervalt.
    db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
    const id = newId();
    db.prepare('INSERT INTO push_subscriptions (id, user_id, session_id, endpoint, p256dh, auth, lang, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, userId, sessionId, endpoint, p256dh, auth, lang, at);
    const extra = db.prepare('SELECT id FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC, id LIMIT -1 OFFSET ?').all(userId, MAX_SUBSCRIPTIONS_PER_USER) as { id: string }[];
    for (const old of extra) db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(old.id);
    return { id };
  }

  function unsubscribe(userId: string, endpoint: unknown): boolean {
    if (typeof endpoint !== 'string') return false;
    return db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(userId, endpoint).changes > 0;
  }

  /** Aanmeldingen van ingetrokken sessies en geblokkeerde accounts horen geen meldingen meer te krijgen. */
  function prune(): number {
    return Number(db.prepare(
      `DELETE FROM push_subscriptions WHERE session_id NOT IN (SELECT id FROM sessions WHERE revoked_at IS NULL)
         OR user_id IN (SELECT id FROM users WHERE is_disabled = 1)`,
    ).run().changes);
  }

  function list(userId: string, currentSessionId: string): SubscriptionInfo[] {
    prune();
    const rows = db.prepare(
      `SELECT p.id, p.session_id, p.created_at, p.last_success_at, p.last_error, p.last_error_at, s.name AS device
       FROM push_subscriptions p JOIN sessions s ON s.id = p.session_id WHERE p.user_id = ? ORDER BY p.created_at DESC, p.id`,
    ).all(userId) as Row[];
    return rows.map((r) => ({
      id: r.id as string, device: r.device as string, current: r.session_id === currentSessionId, created_at: r.created_at as string,
      last_success_at: (r.last_success_at as string | null) ?? null, last_error: (r.last_error as string | null) ?? null, last_error_at: (r.last_error_at as string | null) ?? null,
    }));
  }

  // ---------- versturen ----------

  async function deliver(sub: Row, payload: object, topic?: string): Promise<SendResult> {
    const result = await sendWebPush(
      { endpoint: sub.endpoint as string, keys: { p256dh: sub.p256dh as string, auth: sub.auth as string } },
      JSON.stringify({ ...payload, lang: sub.lang }),
      { vapid, subject, urgency: 'high', ttlSeconds: LATE_WINDOW_MS / 1000, topic, extraAllowedHosts: cfg.extraAllowedHosts, now, ...(cfg.fetch ? { fetch: cfg.fetch } : {}) },
    );
    const at = new Date(now()).toISOString();
    if (result.ok) db.prepare('UPDATE push_subscriptions SET last_success_at = ?, last_error = NULL, last_error_at = NULL WHERE id = ?').run(at, sub.id as string);
    else if (result.gone) db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(sub.id as string);
    else db.prepare('UPDATE push_subscriptions SET last_error = ?, last_error_at = ? WHERE id = ?').run((result.error ?? 'onbekende fout').slice(0, 300), at, sub.id as string);
    return result;
  }

  const subscriptionsOf = (userId: string): Row[] => db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId) as Row[];

  /** Een proefmelding naar alle apparaten van de gebruiker; geeft per apparaat de uitkomst. */
  async function sendTest(userId: string): Promise<{ sent: number; failed: number; errors: string[] }> {
    prune();
    const results = await Promise.all(subscriptionsOf(userId).map((s) => deliver(s, { v: 1, type: 'test' })));
    return { sent: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, errors: results.filter((r) => !r.ok).map((r) => r.error ?? 'onbekende fout') };
  }

  // ---------- handelingen vanuit een melding ----------

  function sign(data: object): string {
    const body = b64u(Buffer.from(JSON.stringify(data)));
    return `${body}.${b64u(createHmac('sha256', secret).update(body).digest())}`;
  }

  /**
   * Controleert een token en geeft zijn inhoud en handtekening terug. Strikt: alleen exact de tekst die `sign` maakt. Een
   * base64-lezer die spaties, regeleinden, '=' of losse staartbits negeert, laat van één token duizenden tekstvarianten toe
   * die allemaal dezelfde handtekening hebben; elke variant zou als een nieuwe handeling tellen.
   */
  function verify(token: unknown): { data: Record<string, unknown>; mac: string } | null {
    if (typeof token !== 'string' || token.length > 1000) return null;
    const [body, mac, ...rest] = token.split('.');
    if (!body || !mac || rest.length > 0) return null;
    if (!/^[A-Za-z0-9_-]+$/.test(body) || !/^[A-Za-z0-9_-]+$/.test(mac)) return null;
    const given = fromB64u(mac);
    if (b64u(given) !== mac || b64u(fromB64u(body)) !== body) return null; // niet-canoniek base64url (staartbits)
    const expected = createHmac('sha256', secret).update(body).digest();
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    try {
      const data = JSON.parse(fromB64u(body).toString('utf8')) as Record<string, unknown>;
      return typeof data.e === 'number' && data.e * 1000 >= now() ? { data, mac } : null;
    } catch {
      return null;
    }
  }

  const zoneOf = (userId: string): string => {
    const row = db.prepare('SELECT timezone FROM user_settings WHERE owner_id = ?').get(userId) as { timezone: string | null } | undefined;
    return row?.timezone || defaultZone;
  };

  /**
   * Voert de handeling uit die bij een knop in een melding hoort. Twee keer dezelfde knop doet het één keer.
   * @returns het id van de gebruiker (om diens apparaten te laten bijwerken) of null als het bewijsje niet klopt
   */
  function handleAction(token: unknown): { ok: boolean; userId: string | null; error?: string } {
    const checked = verify(token);
    if (!checked || typeof checked.data.u !== 'string' || typeof checked.data.t !== 'string') return { ok: false, userId: null, error: 'deze knop is verlopen of ongeldig' };
    const { data, mac } = checked;
    // Een bewijsje is bedoeld voor een apparaat dat meldingen krijgt. Is de aanmelding weg (uitgelogd, afgemeld, sessie
    // ingetrokken na een nieuw wachtwoord, account geblokkeerd), dan werkt het bewijsje niet meer, ook al is het een dag geldig.
    prune();
    if (!db.prepare('SELECT 1 FROM push_subscriptions WHERE user_id = ?').get(data.u as string)) return { ok: false, userId: null, error: 'deze knop is verlopen of ongeldig' };
    // Het uuid komt van de handtekening (de MAC), niet van de tekst van het token: dezelfde knop is daardoor altijd dezelfde handeling.
    const uuid = `push-${createHash('sha256').update(mac).digest('base64url').slice(0, 40)}`;
    const command = data.a === 'complete'
      ? { type: 'task_complete', uuid, args: { id: data.t } }
      : data.a === 'snooze'
        ? { type: 'reminder_add', uuid, args: { id: `sn${uuid.slice(5, 27)}`, task_id: data.t, type: 'absolute', due: { date: epochToFloating(now() + SNOOZE_MS, zoneOf(data.u)) } } }
        : null;
    if (!command) return { ok: false, userId: null, error: 'onbekende handeling' };
    try {
      const res = handleSync(db, { sync_token: String(currentRev(db)), resource_types: ['settings'], commands: [command] }, data.u);
      const status = res.sync_status[uuid];
      return status === 'ok' ? { ok: true, userId: data.u } : { ok: false, userId: data.u, error: status.error };
    } catch {
      return { ok: false, userId: null, error: 'dit account bestaat niet meer of is geblokkeerd' };
    }
  }

  // ---------- de klok ----------

  let running = false;

  /** Eén ronde: verstuurt alle herinneringen die nu aan de beurt zijn. Loopt er al een ronde, dan gebeurt er niets. */
  async function tick(): Promise<TickResult> {
    const out: TickResult = { due: 0, sent: 0, failed: 0, removed: 0 };
    if (running) return out;
    running = true;
    try {
      out.removed = prune();
      const at = now();
      const started = Date.now();
      db.prepare('DELETE FROM reminder_deliveries WHERE sent_at < ?').run(new Date(at - 7 * 86_400_000).toISOString());
      // Per gebruiker met een aangemeld apparaat. Het werk per ronde is begrensd: een gebruiker met heel veel herinneringen
      // vertraagt zo niemand anders. De database selecteert alleen wat rond dit moment aan de beurt kan zijn en nog niet is
      // verstuurd (op de zwevende tijd, met ruim genoeg speling voor zomer- en wintertijd); de precieze controle met de tijdzone
      // volgt hieronder. Wat een ronde niet meer haalt (grens van het aantal, of van de tijd), komt de volgende ronde aan de beurt.
      const owners = (db.prepare('SELECT DISTINCT user_id FROM push_subscriptions').all() as Row[]).map((r) => r.user_id as string);
      const pick = db.prepare(
        `SELECT * FROM (
           SELECT r.id, r.type, r.minute_offset, r.due, r.owner_id, t.id AS task_id, t.content, t.due AS task_due,
             CASE r.type
               WHEN 'absolute' THEN substr(json_extract(r.due, '$.date'), 1, 16)
               ELSE strftime('%Y-%m-%dT%H:%M', replace(substr(json_extract(t.due, '$.date'), 1, 16), 'T', ' '), '-' || r.minute_offset || ' minutes')
             END AS moment
           FROM reminders r JOIN tasks t ON t.id = r.task_id
           WHERE r.owner_id = ? AND r.is_deleted = 0 AND t.is_deleted = 0 AND t.checked = 0
             AND r.type IN ('relative', 'absolute') -- een herinnering op een plek (location) heeft geen tijdstip: de server weet niet waar je bent
             AND t.project_id IN (SELECT project_id FROM project_members m WHERE m.user_id = r.owner_id AND m.is_deleted = 0)
         ) c
         WHERE c.moment BETWEEN ? AND ?
           AND NOT EXISTS (SELECT 1 FROM reminder_deliveries d WHERE d.reminder_id = c.id AND d.moment = c.moment)
         ORDER BY c.moment DESC LIMIT ?`,
      );
      for (const owner of owners) {
        if (Date.now() - started > TICK_BUDGET_MS) break;
        const zone = zoneOf(owner);
        // een tijd in het "gat" van de zomertijd schuift naar voren, dus de ondergrens heeft een uur speling extra
        const hi = epochToFloating(at, zone);
        const lo = epochToFloating(at - LATE_WINDOW_MS - 2 * 3600_000, zone);
        const rows = pick.all(owner, lo, hi, MAX_DUE_PER_OWNER_PER_ROUND) as Row[];
        for (const r of rows) {
          if (Date.now() - started > TICK_BUDGET_MS) break;
          const taskDue = r.task_due ? (JSON.parse(r.task_due as string) as { date: string }) : null;
          const moment = reminderMoment(
            { type: r.type as string, minute_offset: r.minute_offset as number | null, due: r.due ? (JSON.parse(r.due as string) as { date: string }) : null },
            { due: taskDue, checked: false, is_deleted: false },
          );
          if (!moment) continue;
          const epoch = floatingToEpoch(moment, zone);
          if (epoch === null || epoch > at || at - epoch > LATE_WINDOW_MS) continue;
          if (db.prepare('SELECT 1 FROM reminder_deliveries WHERE reminder_id = ? AND moment = ?').get(r.id as string, moment)) continue;
          out.due += 1;
          const exp = Math.floor(at / 1000) + ACTION_VALID_S;
          const base = { u: owner, t: r.task_id as string, r: r.id as string, m: moment, e: exp };
          const payload = {
            v: 1, type: 'reminder', id: r.id, task_id: r.task_id, title: String(r.content).slice(0, 300), time: taskDue?.date ?? null, moment,
            complete: sign({ ...base, a: 'complete' }), snooze: sign({ ...base, a: 'snooze' }),
          };
          const topic = createHash('sha256').update(`${r.id as string}|${moment}`).digest('base64url').slice(0, 32);
          const results = await Promise.all(subscriptionsOf(owner).map((s) => deliver(s, payload, topic)));
          out.sent += results.filter((x) => x.ok).length;
          out.failed += results.filter((x) => !x.ok).length;
          // Klaar als het ergens is aangekomen, of als opnieuw proberen geen zin heeft. Anders (alleen tijdelijke fouten)
          // proberen we het de volgende ronde nog eens, tot het venster voorbij is.
          if (results.some((x) => x.ok) || !results.some((x) => x.retryable)) {
            db.prepare('INSERT OR IGNORE INTO reminder_deliveries (reminder_id, moment, user_id, sent_at) VALUES (?, ?, ?, ?)').run(r.id as string, moment, owner, new Date(at).toISOString());
          }
        }
      }
      return out;
    } finally {
      running = false;
    }
  }

  return { publicKey: vapid.publicKey, subscribe, unsubscribe, prune, list, sendTest, handleAction, tick, sign };
}
