// De SQL-kant van het datamodel. De entiteitsdefinities zelf staan in ../shared/schema.js (gedeeld met de client).
// Alle tabel- en kolomnamen in SQL komen uitsluitend uit die definities, nooit uit invoer van buiten.

import type { DatabaseSync } from 'node:sqlite';
import { ENTITIES as SHARED_ENTITIES, ENTITY_LIST as SHARED_LIST, ID_RE, INBOX_ID, INBOX_PREFIX, isInboxId, RESOURCE_NAMES, settingsId, validateValue as sharedValidate } from '../shared/schema.js';

export type EntityName = 'project' | 'section' | 'task' | 'label' | 'comment' | 'attachment' | 'reminder' | 'filter' | 'member' | 'settings' | 'place' | 'template' | 'notification';
export type ColType = 'text' | 'int' | 'real' | 'bool' | 'json';

export interface Col {
  name: string;
  type: ColType;
  required?: boolean;
  nullable?: boolean;
  default?: unknown;
  maxLen?: number;
  min?: number;
  max?: number;
  oneOf?: readonly (string | number)[];
  ref?: EntityName;
  orderKey?: boolean;
  immutable?: boolean;
  serverManaged?: boolean;
  stamp?: boolean;
  check?: (v: unknown) => string | null;
}

export interface Entity {
  name: EntityName;
  table: string;
  resource: string;
  cols: Col[];
  commands?: false | readonly ('add' | 'update' | 'delete')[];
}

export const ENTITIES = SHARED_ENTITIES as Record<EntityName, Entity>;
export const ENTITY_LIST = SHARED_LIST as Entity[];
export const validateValue = sharedValidate as (col: Col, v: unknown) => string | null;
export { ID_RE, INBOX_ID, INBOX_PREFIX, isInboxId, RESOURCE_NAMES, settingsId };

/** Versie van de tabelindeling; staat in `meta` zodat een nieuwere server een oudere database kan herkennen en bijwerken. */
// 3: plaatsen, 4: bijlagen, 5: sjablonen, 6: meldingen bij samenwerken, 7: rollen (lezer) en het activiteitenlogboek,
// 8: tweestapsverificatie en het soort apparaat per sessie (alle komen er met CREATE TABLE IF NOT EXISTS of een nieuwe, optionele kolom bij)
export const SCHEMA_VERSION = 8;

const SQL_TYPE: Record<ColType, string> = { text: 'TEXT', int: 'INTEGER', real: 'REAL', bool: 'INTEGER', json: 'TEXT' };

/**
 * Maakt alle tabellen en indexen aan (idempotent) en werkt een database uit een eerdere versie bij.
 * Een nieuwe database bevat daarna nog geen gebruikers en geen projecten: gebruikers komen uit `createUser`
 * (zie users.ts), en elke gebruiker krijgt daarbij een eigen Inbox.
 */
export function createSchema(db: DatabaseSync): void {
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000'); // de beheeropdrachten (user add) kunnen naast een draaiende server schrijven
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  db.exec("INSERT OR IGNORE INTO meta (key, value) VALUES ('rev', '0')");

  db.exec(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    username_key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    is_disabled INTEGER NOT NULL DEFAULT 0,
    inbox_project_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    password_changed_at TEXT NOT NULL
  )`);
  // Eén sessie per apparaat. Alleen de hash van het token staat in de database.
  db.exec(`CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    token_hash TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT NOT NULL,
    revoked_at TEXT
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id)');
  // Versie 8. Het soort apparaat ("browser/Firefox/Windows", zonder versienummers; zie describeUserAgent in users.ts).
  addColumnIfMissing(db, 'sessions', 'device', 'TEXT');
  // Tweestapsverificatie (zie totp.ts). Het geheim staat versleuteld; `totp_last_step` is het laatst gebruikte tijdvak (een code
  // geldt maar één keer); `totp_pending` is een nieuw geheim dat nog met een code moet worden bevestigd.
  for (const [col, type] of [['totp_secret', 'TEXT'], ['totp_enabled_at', 'TEXT'], ['totp_last_step', 'INTEGER'], ['totp_pending', 'TEXT'], ['totp_pending_at', 'TEXT']]) {
    addColumnIfMissing(db, 'users', col, type);
  }
  // Herstelcodes: alleen de HMAC staat erin; een gebruikte code houdt `used_at`.
  db.exec(`CREATE TABLE IF NOT EXISTS recovery_codes (
    user_id TEXT NOT NULL REFERENCES users(id),
    code_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    used_at TEXT,
    PRIMARY KEY (user_id, code_hash)
  )`);

  // Idempotentie: elk commando-uuid wordt per gebruiker precies één keer uitgevoerd; een herhaling krijgt dezelfde uitkomst.
  // Per gebruiker, zodat het uuid van de één nooit het commando van een ander kan overslaan.
  db.exec(`CREATE TABLE IF NOT EXISTS command_log (
    user_id TEXT NOT NULL, uuid TEXT NOT NULL, type TEXT NOT NULL, status TEXT NOT NULL, error_code TEXT, error TEXT, rev INTEGER NOT NULL, at TEXT NOT NULL,
    PRIMARY KEY (user_id, uuid)
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS command_log_at ON command_log (at)');
  // Een taak die naar een ander project verhuist, verdwijnt voor wie dat project niet ziet. Dit logboek laat de sync
  // vertellen wie de taak kende maar hem nu niet meer ziet (zie collectResources in sync.ts).
  // `at` (tijdstip van verhuizen) laat het logboek na verloop van tijd opruimen; zie pruneTaskMoves in sync.ts.
  db.exec('CREATE TABLE IF NOT EXISTS task_moves (task_id TEXT NOT NULL, from_project_id TEXT NOT NULL, rev INTEGER NOT NULL, at TEXT)');
  if (!(db.prepare('PRAGMA table_info(task_moves)').all() as { name: string }[]).some((c) => c.name === 'at')) {
    db.exec('ALTER TABLE task_moves ADD COLUMN at TEXT'); // database van vóór het opruimen: de bestaande regels tellen vanaf nu
    db.prepare('UPDATE task_moves SET at = ? WHERE at IS NULL').run(new Date().toISOString());
  }
  db.exec('CREATE INDEX IF NOT EXISTS task_moves_rev ON task_moves (rev)');
  db.exec('DROP TABLE IF EXISTS commands'); // versie 0.1: zonder gebruiker; alle apparaten moeten toch opnieuw inloggen

  // Apparaten die meldingen in de browser willen (Web Push), en welke herinneringen al verstuurd zijn (zie push.ts).
  db.exec(`CREATE TABLE IF NOT EXISTS push_subscriptions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    session_id TEXT NOT NULL,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    lang TEXT NOT NULL DEFAULT 'nl',
    created_at TEXT NOT NULL,
    last_success_at TEXT,
    last_error TEXT,
    last_error_at TEXT
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS push_user ON push_subscriptions (user_id)');
  db.exec(`CREATE TABLE IF NOT EXISTS reminder_deliveries (
    reminder_id TEXT NOT NULL, moment TEXT NOT NULL, user_id TEXT NOT NULL, sent_at TEXT NOT NULL,
    PRIMARY KEY (reminder_id, moment)
  )`);

  // De bestanden bij bijlagen (zie attachments.ts). Eén rij per geüpload bestand, vanaf de upload; `linked` wordt 1 zodra het
  // commando attachment_add het aan een bijlage heeft gekoppeld. Wat zo lang niet gekoppeld wordt, ruimt de server op.
  // `key` is de naam op schijf (willekeurig, nooit de naam van de gebruiker). De metagegevens van de bijlage zelf staan in `attachments`.
  db.exec(`CREATE TABLE IF NOT EXISTS attachment_files (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    mime TEXT NOT NULL,
    key TEXT NOT NULL UNIQUE,
    linked INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS attachment_files_user ON attachment_files (user_id)');
  db.exec('CREATE INDEX IF NOT EXISTS attachment_files_task ON attachment_files (task_id)');

  for (const e of ENTITY_LIST) {
    const cols = e.cols.map((c) => `${c.name} ${SQL_TYPE[c.type]}${c.required ? ' NOT NULL' : ''}`).join(', ');
    db.exec(`CREATE TABLE IF NOT EXISTS ${e.table} (
      id TEXT PRIMARY KEY, ${cols},
      rev INTEGER NOT NULL, is_deleted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
    addMissingColumns(db, e);
    db.exec(`CREATE INDEX IF NOT EXISTS ${e.table}_rev ON ${e.table} (rev)`);
  }
  db.exec('CREATE INDEX IF NOT EXISTS tasks_project ON tasks (project_id, is_deleted)');
  // De volgordesleutel van een nieuwe rij is "de hoogste van de lijst + 1" (nextKey in sync.ts). Met deze indexen is dat een
  // opzoeking in plaats van een scan van alle taken van het project, waardoor toevoegen niet langzamer wordt naarmate een lijst groeit.
  db.exec('CREATE INDEX IF NOT EXISTS tasks_order ON tasks (project_id, section_id, parent_id, is_deleted, order_key)');
  db.exec('CREATE INDEX IF NOT EXISTS sections_order ON sections (project_id, is_deleted, order_key)');
  db.exec('CREATE INDEX IF NOT EXISTS labels_order ON labels (owner_id, is_deleted, order_key)');
  db.exec('CREATE INDEX IF NOT EXISTS filters_order ON filters (owner_id, is_deleted, order_key)');
  db.exec('CREATE INDEX IF NOT EXISTS tasks_creator ON tasks (creator_id, is_deleted)'); // voor de limiet per gebruiker
  db.exec('CREATE INDEX IF NOT EXISTS comments_project ON comments (project_id, is_deleted)');
  db.exec('CREATE INDEX IF NOT EXISTS tasks_parent ON tasks (parent_id)');
  db.exec('CREATE INDEX IF NOT EXISTS comments_task ON comments (task_id)');
  db.exec('CREATE INDEX IF NOT EXISTS attachments_task ON attachments (task_id, is_deleted)');
  db.exec('CREATE INDEX IF NOT EXISTS reminders_task ON reminders (task_id)');
  db.exec('CREATE INDEX IF NOT EXISTS reminders_owner ON reminders (owner_id)');
  db.exec('CREATE INDEX IF NOT EXISTS reminders_place ON reminders (place_id)');
  db.exec('CREATE INDEX IF NOT EXISTS places_owner ON places (owner_id, is_deleted)');
  db.exec('CREATE INDEX IF NOT EXISTS labels_owner ON labels (owner_id)');
  db.exec('CREATE INDEX IF NOT EXISTS filters_owner ON filters (owner_id)');
  db.exec('CREATE INDEX IF NOT EXISTS members_user ON project_members (user_id, is_deleted)');
  db.exec('CREATE INDEX IF NOT EXISTS members_project ON project_members (project_id)');
  db.exec('CREATE INDEX IF NOT EXISTS settings_owner ON user_settings (owner_id)');
  // Meldingen bij samenwerken (versie 6; zie notify.ts). Opmerkingen van vóór de vermeldingen krijgen een lege lijst.
  db.exec("UPDATE comments SET mentions = '[]' WHERE mentions IS NULL");
  db.exec('CREATE INDEX IF NOT EXISTS notifications_owner ON notifications (owner_id, is_deleted, created_at)');
  db.exec('CREATE INDEX IF NOT EXISTS notifications_task ON notifications (task_id)');
  db.exec('CREATE INDEX IF NOT EXISTS notifications_comment ON notifications (comment_id)');
  db.exec('CREATE INDEX IF NOT EXISTS notifications_age ON notifications (is_deleted, created_at)');
  // Welke nieuwe meldingen nog als pushbericht naar de browsers van de ontvanger moeten (zie push.ts).
  db.exec('CREATE TABLE IF NOT EXISTS notification_outbox (notification_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL)');
  // Het activiteitenlogboek per project (versie 7; zie activity.ts). Geen entiteit: het gaat niet mee in de sync. `seq` is de cursor.
  db.exec(`CREATE TABLE IF NOT EXISTS activity (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, at TEXT NOT NULL, actor_id TEXT, kind TEXT NOT NULL,
    task_id TEXT, section_id TEXT, comment_id TEXT, attachment_id TEXT, user_id TEXT, title TEXT, extra TEXT
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS activity_project ON activity (project_id, seq)');
  db.exec('CREATE INDEX IF NOT EXISTS activity_at ON activity (at)');
  // het productiviteitsoverzicht (stats.ts) zoekt de eigen afvinkingen over alle projecten: per persoon, soort en tijdstip
  db.exec('CREATE INDEX IF NOT EXISTS activity_actor ON activity (actor_id, kind, at)');
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(SCHEMA_VERSION));
}

/** Voegt een (optionele) kolom toe aan een vaste tabel als die er nog niet is: een database uit een eerdere versie. */
function addColumnIfMissing(db: DatabaseSync, table: string, col: string, type: string): void {
  if ((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
}

/** Een database uit een eerdere versie mist kolommen die later bij een entiteit zijn gekomen: die voegen we toe. */
function addMissingColumns(db: DatabaseSync, e: Entity): void {
  const have = new Set((db.prepare(`PRAGMA table_info(${e.table})`).all() as { name: string }[]).map((c) => c.name));
  for (const c of e.cols) {
    if (have.has(c.name)) continue;
    // ALTER TABLE kan geen kolom zonder standaardwaarde als NOT NULL toevoegen; nieuwe kolommen zijn dus altijd optioneel.
    if (c.required) throw new Error(`kolom ${e.table}.${c.name} is verplicht en ontbreekt in de database; migratie nodig`);
    db.exec(`ALTER TABLE ${e.table} ADD COLUMN ${c.name} ${SQL_TYPE[c.type]}`);
  }
}

/** Rij uit SQLite naar de vorm van de API (booleans, JSON uitgepakt). */
export function toApi(e: Entity, row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { id: row.id };
  for (const c of e.cols) {
    const v = row[c.name];
    out[c.name] = v === null || v === undefined ? null : c.type === 'bool' ? v === 1 : c.type === 'json' ? JSON.parse(v as string) : v;
  }
  out.is_deleted = row.is_deleted === 1;
  out.created_at = row.created_at;
  out.updated_at = row.updated_at;
  return out;
}
