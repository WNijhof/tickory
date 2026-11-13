// Hulpmiddelen voor tests: een database met gebruikers, zonder dat tests zelf wachtwoorden hoeven te hashen.

import { DatabaseSync } from 'node:sqlite';
import { INBOX_ID } from '../shared/schema.js';
import { keyAfter } from '../shared/orderKey.js';
import { ENTITIES, createSchema } from './schema.ts';
import { bumpRev, insertRow } from './rows.ts';
import { createUser } from './users.ts';
import type { UserRow } from './users.ts';

const first = new WeakMap<DatabaseSync, UserRow>();

/** De Inbox zoals versie 0.1 hem aanmaakte: één gedeeld project met het vaste id `inbox-project`, zonder eigenaar. */
export function seedLegacyInbox(db: DatabaseSync): void {
  const rev = bumpRev(db);
  const now = new Date().toISOString();
  const v: Record<string, unknown> = { name: 'Inbox', order_key: keyAfter(null) };
  for (const c of ENTITIES.project.cols) if (v[c.name] === undefined && c.default !== undefined) v[c.name] = c.default;
  insertRow({ db, rev, now, userId: 'legacy' }, ENTITIES.project, INBOX_ID, v);
}

/**
 * Een database met één gebruiker ("tester", beheerder). Die heeft de Inbox `inbox-project`: de database is gemaakt zoals
 * een database uit versie 0.1, en het eerste account neemt die over. Zo testen alle bestaande tests meteen de migratie mee.
 */
export function mkdb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  seedLegacyInbox(db);
  first.set(db, createUser(db, { username: 'tester', name: 'Tester', passwordHash: 'x' }));
  return db;
}

/** Een lege database zonder gebruikers en zonder Inbox: voor tests van meerdere gebruikers (alle gebruikers krijgen een eigen Inbox). */
export function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  return db;
}

/** De eerste gebruiker van een met mkdb() gemaakte database. */
export const firstUser = (db: DatabaseSync): UserRow => first.get(db)!;

/** Nog een gebruiker (geen beheerder, met een eigen Inbox). */
export function addUser(db: DatabaseSync, username: string, name = username): UserRow {
  return createUser(db, { username, name, passwordHash: 'x' });
}
