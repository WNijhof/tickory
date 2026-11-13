// Basisfuncties voor rijen en versienummers, gedeeld door de sync-engine (sync.ts) en het gebruikersbeheer (users.ts).

import type { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import type { Col, Entity } from './schema.ts';

export type Row = Record<string, unknown>;

/** De context van één commando: de database, het versienummer dat het commando krijgt, het tijdstip en wie het uitvoert. */
export interface Ctx {
  db: DatabaseSync; rev: number; now: string; userId: string;
  /** Tellingen voor de limieten (limits.ts), gedeeld door de commando's van één verzoek zodat ze niet steeds opnieuw tellen. */
  counts?: Map<string, number>;
}

export class SyncError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SyncError';
    this.code = code;
  }
}

export function fail(code: string, message: string): never {
  throw new SyncError(code, message);
}

export const newId = (): string => randomBytes(12).toString('base64url');
export const has = (o: object, k: string): boolean => Object.hasOwn(o, k);
export const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

/**
 * SQLite staat hooguit 32766 gebonden waarden in één query. Een lijst `IN (?, ?, …)` die met de hoeveelheid gegevens meegroeit
 * (alle taken van een project, alle subtaken) hoort daarom in brokken van `size` tegelijk te worden gevraagd; een
 * project met meer dan 32766 taken liet anders het verwijderen, verlaten of een lid eruit halen mislukken.
 */
export const IN_CHUNK = 500;
export function chunked<T>(items: readonly T[], size: number = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ---------- versienummers ----------

export function currentRev(db: DatabaseSync): number {
  return Number((db.prepare("SELECT value FROM meta WHERE key = 'rev'").get() as Row).value);
}

export function bumpRev(db: DatabaseSync): number {
  const r = currentRev(db) + 1;
  db.prepare("UPDATE meta SET value = ? WHERE key = 'rev'").run(String(r));
  return r;
}

// ---------- rijen lezen en schrijven ----------

export function toDb(c: Col, v: unknown): string | number | null {
  if (v === null || v === undefined) return null;
  if (c.type === 'bool') return v ? 1 : 0;
  if (c.type === 'json') return JSON.stringify(v);
  return v as string | number;
}

export const getRow = (db: DatabaseSync, e: Entity, id: string): Row | undefined =>
  db.prepare(`SELECT * FROM ${e.table} WHERE id = ?`).get(id) as Row | undefined;

export function insertRow(ctx: Ctx, e: Entity, id: string, v: Row): void {
  const names = e.cols.map((c) => c.name);
  ctx.db
    .prepare(`INSERT INTO ${e.table} (id, ${names.join(', ')}, rev, is_deleted, created_at, updated_at) VALUES (?, ${placeholders(names.length)}, ?, 0, ?, ?)`)
    .run(id, ...e.cols.map((c) => toDb(c, v[c.name])), ctx.rev, ctx.now, ctx.now);
}

export function updateRow(ctx: Ctx, e: Entity, id: string, changes: Row): void {
  const cols = e.cols.filter((c) => has(changes, c.name));
  if (cols.length === 0) return;
  ctx.db
    .prepare(`UPDATE ${e.table} SET ${cols.map((c) => `${c.name} = ?`).join(', ')}, rev = ?, updated_at = ? WHERE id = ?`)
    .run(...cols.map((c) => toDb(c, changes[c.name])), ctx.rev, ctx.now, id);
}

/** Markeert rijen als verwijderd (ze blijven bestaan zodat de verwijdering in de delta meekomt). */
export function mark(ctx: Ctx, table: string, where: string, params: (string | number)[]): void {
  ctx.db.prepare(`UPDATE ${table} SET is_deleted = 1, rev = ?, updated_at = ? WHERE is_deleted = 0 AND (${where})`).run(ctx.rev, ctx.now, ...params);
}
