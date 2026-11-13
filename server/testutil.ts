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

// ---------- een nagebootst apparaat voor meldingen ----------

import { createDecipheriv, createECDH, createHmac, randomBytes } from 'node:crypto';

/**
 * Een "browser" die meldingen kan ontvangen: een eigen sleutelpaar en geheim, en een ontsleutelaar die de formules uit
 * RFC 8291 volgt met losse HMAC-stappen (dus niet met dezelfde code als de zender).
 */
export function pushDevice(name = 'apparaat', host = 'fcm.googleapis.com') {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const authSecret = randomBytes(16);
  const uaPublic = ecdh.getPublicKey();
  const subscription = {
    endpoint: `https://${host}/fcm/send/${name}-${randomBytes(6).toString('hex')}`,
    keys: { p256dh: uaPublic.toString('base64url'), auth: authSecret.toString('base64url') },
  };
  const decrypt = (body: Buffer): string => {
    const salt = body.subarray(0, 16);
    const idLen = body[20];
    const asPublic = body.subarray(21, 21 + idLen);
    const record = body.subarray(21 + idLen);
    const hmac = (key: Buffer, data: Buffer) => createHmac('sha256', key).update(data).digest();
    const prkKey = hmac(authSecret, ecdh.computeSecret(asPublic));
    const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
    const prk = hmac(salt, ikm);
    const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).subarray(0, 16);
    const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).subarray(0, 12);
    const d = createDecipheriv('aes-128-gcm', cek, nonce);
    d.setAuthTag(record.subarray(record.length - 16));
    const plain = Buffer.concat([d.update(record.subarray(0, record.length - 16)), d.final()]);
    return plain.subarray(0, plain.length - 1).toString('utf8');
  };
  return { subscription, decrypt };
}
