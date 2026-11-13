// De SQL-kant van het datamodel. De entiteitsdefinities zelf staan in ../shared/schema.js (gedeeld met de client).
// Alle tabel- en kolomnamen in SQL komen uitsluitend uit die definities, nooit uit invoer van buiten.

import type { DatabaseSync } from 'node:sqlite';
import { ENTITIES as SHARED_ENTITIES, ENTITY_LIST as SHARED_LIST, ID_RE, INBOX_ID, RESOURCE_NAMES, validateValue as sharedValidate } from '../shared/schema.js';
import { keyAfter } from '../shared/orderKey.js';

export type EntityName = 'project' | 'section' | 'task' | 'label' | 'comment' | 'reminder' | 'filter';
export type ColType = 'text' | 'int' | 'bool' | 'json';

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
  check?: (v: unknown) => string | null;
}

export interface Entity {
  name: EntityName;
  table: string;
  resource: string;
  cols: Col[];
}

export const ENTITIES = SHARED_ENTITIES as Record<EntityName, Entity>;
export const ENTITY_LIST = SHARED_LIST as Entity[];
export const validateValue = sharedValidate as (col: Col, v: unknown) => string | null;
export { ID_RE, INBOX_ID, RESOURCE_NAMES };

const SQL_TYPE: Record<ColType, string> = { text: 'TEXT', int: 'INTEGER', bool: 'INTEGER', json: 'TEXT' };

/** Maakt alle tabellen en indexen aan en zorgt dat de Inbox bestaat (idempotent). */
export function createSchema(db: DatabaseSync): void {
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  db.exec("INSERT OR IGNORE INTO meta (key, value) VALUES ('rev', '0')");
  // Idempotentie: elk commando-uuid wordt precies één keer uitgevoerd; een herhaling krijgt dezelfde uitkomst.
  db.exec(`CREATE TABLE IF NOT EXISTS commands (
    uuid TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL, error_code TEXT, error TEXT, rev INTEGER NOT NULL, at TEXT NOT NULL
  )`);
  for (const e of ENTITY_LIST) {
    const cols = e.cols.map((c) => `${c.name} ${SQL_TYPE[c.type]}${c.required ? ' NOT NULL' : ''}`).join(', ');
    db.exec(`CREATE TABLE IF NOT EXISTS ${e.table} (
      id TEXT PRIMARY KEY, ${cols},
      rev INTEGER NOT NULL, is_deleted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS ${e.table}_rev ON ${e.table} (rev)`);
  }
  db.exec('CREATE INDEX IF NOT EXISTS tasks_project ON tasks (project_id, is_deleted)');
  db.exec('CREATE INDEX IF NOT EXISTS tasks_parent ON tasks (parent_id)');
  db.exec('CREATE INDEX IF NOT EXISTS comments_task ON comments (task_id)');
  db.exec('CREATE INDEX IF NOT EXISTS reminders_task ON reminders (task_id)');
  seedInbox(db);
}

/** De Inbox is een gewoon project met een vast id. Hij krijgt versie 1, zodat elke client hem bij de eerste sync ontvangt. */
function seedInbox(db: DatabaseSync): void {
  if (db.prepare('SELECT 1 FROM projects WHERE id = ?').get(INBOX_ID)) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    const rev = Number((db.prepare("SELECT value FROM meta WHERE key = 'rev'").get() as { value: string }).value) + 1;
    db.prepare("UPDATE meta SET value = ? WHERE key = 'rev'").run(String(rev));
    const now = new Date().toISOString();
    const e = ENTITIES.project;
    const values: Record<string, unknown> = { name: 'Inbox', order_key: keyAfter(null) };
    for (const c of e.cols) if (values[c.name] === undefined && c.default !== undefined) values[c.name] = c.default;
    const names = e.cols.map((c) => c.name);
    db.prepare(`INSERT INTO projects (id, ${names.join(', ')}, rev, is_deleted, created_at, updated_at) VALUES (?, ${names.map(() => '?').join(', ')}, ?, 0, ?, ?)`).run(
      INBOX_ID,
      ...e.cols.map((c) => {
        const v = values[c.name];
        return v === null || v === undefined ? null : c.type === 'bool' ? (v ? 1 : 0) : c.type === 'json' ? JSON.stringify(v) : (v as string | number);
      }),
      rev, now, now,
    );
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
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
