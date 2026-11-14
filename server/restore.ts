// Verwijderen ongedaan maken: `task_restore` en `section_restore`.
//
// Verwijderen is zacht: de rijen blijven met `is_deleted = 1` bestaan en houden hun inhoud (alleen de sync stuurt ze als
// `{ id, is_deleted }`). Een commando dat een taak of sectie verwijdert, geeft al zijn rijen (de taak, subtaken, opmerkingen,
// bijlagen, herinneringen) hetzelfde versienummer (`rev`): dat is hoe we weten wat bij die ene verwijdering hoorde en niet bij
// iets wat eerder los werd verwijderd. Terugzetten haalt precies die rijen terug, met een nieuw versienummer, zodat elke
// client de rijen als gewone wijziging krijgt (ook wie de verwijdering al had gehoord).
//
// Regels:
//   - alleen binnen `RESTORE.windowMs` (5 minuten) na het verwijderen; daarna `CONFLICT`;
//   - wie de taak mag zien (anders `NOT_FOUND`, geen bestaansorakel), en alleen wie hem verwijderde of de eigenaar van het project;
//   - een taak die al terug (of nooit weg) is: geen wijziging, geen fout (idempotent);
//   - de bovenliggende taak en de sectie moeten er nog zijn (`CONFLICT`: zet eerst die terug);
//   - de grenzen uit limits.ts tellen weer mee, labels die intussen weg zijn en toegewezen personen die intussen uit het project
//     zijn gehaald komen niet terug, en herinneringen alleen van wie nog lid is, met een bestaande plaats en binnen zijn grens.
// De bestanden van bijlagen blijven na het verwijderen van een taak nog even bewaard (attachments.ts, `purgeDeleted`), zodat een
// teruggezette taak zijn bijlagen houdt.

import type { DatabaseSync } from 'node:sqlite';
import { ENTITIES, ID_RE } from './schema.ts';
import { chunked, fail, getRow, placeholders, SyncError, updateRow } from './rows.ts';
import type { Ctx, Row } from './rows.ts';
import { LIMITS, RESTORE } from './limits.ts';
import { canEditRole } from '../shared/roles.js';
import * as activity from './activity.ts';

type Args = Record<string, unknown>;
export type RestoreHandler = (ctx: Ctx, args: Args) => void;

/** Wat dit bestand van sync.ts nodig heeft (zo hoeft sync.ts hier niet vanuit te worden geïmporteerd). */
export interface RestoreDeps {
  roleOf: (db: DatabaseSync, userId: string, projectId: unknown) => 'owner' | 'member' | 'viewer' | null;
  quota: (ctx: Ctx, key: string, limit: number, what: string, count: () => number) => void;
  countOf: (db: DatabaseSync, sql: string, ...params: string[]) => number;
}

const onlyId = (args: Args): string => {
  for (const k of Object.keys(args)) if (k !== 'id') fail('UNKNOWN_ARG', `onbekend argument "${k}"`);
  if (typeof args.id !== 'string' || !ID_RE.test(args.id)) fail('INVALID_ARG', 'ongeldig id');
  return args.id;
};

export function restoreHandlers(deps: RestoreDeps): Record<string, RestoreHandler> {
  const { roleOf, quota, countOf } = deps;

  /** Wie voerde het verwijder-commando met dit versienummer uit? (Het logboek bewaart 30 dagen, de termijn is veel korter.) */
  const deletedBy = (db: DatabaseSync, rev: number, types: string[]): string | null => {
    const r = db.prepare(`SELECT user_id FROM command_log WHERE rev = ? AND status = 'ok' AND type IN (${placeholders(types.length)})`).get(rev, ...types) as Row | undefined;
    return (r?.user_id as string | undefined) ?? null;
  };

  /** De algemene controles voor een rij die terug moet: zichtbaar (bij een verwijderd project zijn ook de leden weg, dus dan is het NOT_FOUND), binnen de termijn, en wie het mag. */
  function checkMayRestore(ctx: Ctx, row: Row, projectId: unknown, types: string[], what: string): void {
    const role = roleOf(ctx.db, ctx.userId, projectId);
    if (role === null) fail('NOT_FOUND', `${what} bestaat niet`);
    if (!canEditRole(role)) fail('FORBIDDEN', 'je kunt dit project alleen lezen'); // een lezer zet niets terug (shared/roles.js)
    if (Date.parse(ctx.now) - Date.parse(row.updated_at as string) > RESTORE.windowMs) {
      fail('CONFLICT', `${what} is te lang geleden verwijderd om terug te zetten (binnen ${Math.round(RESTORE.windowMs / 60_000)} minuten kan het nog)`);
    }
    if (role !== 'owner' && deletedBy(ctx.db, row.rev as number, types) !== ctx.userId) {
      fail('FORBIDDEN', 'alleen wie dit verwijderde, of de eigenaar van het project, kan het terugzetten');
    }
  }

  /** De taak zelf met alle subtaken die in hetzelfde commando zijn verwijderd. */
  function deletedTree(db: DatabaseSync, rootId: string, rev: number): string[] {
    const all = [rootId];
    const seen = new Set(all);
    let frontier = all;
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const part of chunked(frontier)) {
        const kids = db.prepare(`SELECT id FROM tasks WHERE is_deleted = 1 AND rev = ? AND parent_id IN (${placeholders(part.length)})`).all(rev, ...part) as Row[];
        for (const k of kids) if (!seen.has(k.id as string)) { seen.add(k.id as string); next.push(k.id as string); all.push(k.id as string); }
      }
      frontier = next;
    }
    return all;
  }

  /** Zet de taken in `ids` (met opmerkingen, bijlagen en herinneringen van dezelfde verwijdering) terug. */
  function restoreTasks(ctx: Ctx, ids: string[], rev: number, projectId: string, sectionId: string | null | undefined): void {
    const db = ctx.db;
    const tasks: Row[] = [];
    for (const part of chunked(ids)) tasks.push(...(db.prepare(`SELECT * FROM tasks WHERE id IN (${placeholders(part.length)})`).all(...part) as Row[]));
    for (const t of tasks) {
      quota(ctx, `tasks:p:${projectId}`, LIMITS.tasksPerProject, 'taken per project', () => countOf(db, 'SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND is_deleted = 0', projectId));
      const creator = t.creator_id as string | null;
      if (creator) quota(ctx, `tasks:u:${creator}`, LIMITS.tasksPerUser, 'taken per gebruiker', () => countOf(db, 'SELECT COUNT(*) AS n FROM tasks WHERE creator_id = ? AND is_deleted = 0', creator));
    }
    for (const part of chunked(ids)) {
      db.prepare(`UPDATE tasks SET is_deleted = 0, rev = ?, updated_at = ? WHERE id IN (${placeholders(part.length)})`).run(ctx.rev, ctx.now, ...part);
      db.prepare(`UPDATE comments SET is_deleted = 0, rev = ?, updated_at = ? WHERE is_deleted = 1 AND rev = ? AND task_id IN (${placeholders(part.length)})`).run(ctx.rev, ctx.now, rev, ...part);
      // een bijlage waarvan de inhoud al is opgeruimd (naam leeg) komt niet terug; binnen de termijn gebeurt dat niet
      db.prepare(`UPDATE attachments SET is_deleted = 0, rev = ?, updated_at = ? WHERE is_deleted = 1 AND rev = ? AND name <> '' AND task_id IN (${placeholders(part.length)})`).run(ctx.rev, ctx.now, rev, ...part);
    }
    // sectie, labels en toewijzing zoals ze nu kunnen
    for (const t of tasks) {
      const changes: Row = {};
      if (sectionId !== undefined && (t.section_id ?? null) !== sectionId) changes.section_id = sectionId;
      const labels = JSON.parse((t.labels as string | null) ?? '[]') as string[];
      const liveLabels = labels.filter((l) => (db.prepare('SELECT 1 FROM labels WHERE id = ? AND is_deleted = 0').get(l) !== undefined));
      if (liveLabels.length !== labels.length) changes.labels = liveLabels;
      if (t.assignee_id && !canEditRole(roleOf(db, t.assignee_id as string, projectId))) changes.assignee_id = null; // geen lid meer, of lezer
      if (Object.keys(changes).length > 0) updateRow(ctx, ENTITIES.task, t.id as string, changes);
    }
    // herinneringen: van wie nog lid is, met een bestaande plaats, en binnen zijn grens
    for (const part of chunked(ids)) {
      const reminders = db.prepare(`SELECT id, owner_id, place_id FROM reminders WHERE is_deleted = 1 AND rev = ? AND task_id IN (${placeholders(part.length)})`).all(rev, ...part) as Row[];
      for (const r of reminders) {
        const owner = r.owner_id as string;
        if (roleOf(db, owner, projectId) === null) continue;
        if (r.place_id && db.prepare('SELECT 1 FROM places WHERE id = ? AND is_deleted = 0').get(r.place_id as string) === undefined) continue;
        try {
          quota(ctx, `reminders:u:${owner}`, LIMITS.remindersPerUser, 'herinneringen per gebruiker', () => countOf(db, 'SELECT COUNT(*) AS n FROM reminders WHERE owner_id = ? AND is_deleted = 0', owner));
        } catch (err) {
          if (err instanceof SyncError && err.code === 'LIMIT_REACHED') continue; // zijn grens is bereikt: deze herinnering blijft weg
          throw err;
        }
        db.prepare('UPDATE reminders SET is_deleted = 0, rev = ?, updated_at = ? WHERE id = ?').run(ctx.rev, ctx.now, r.id as string);
      }
    }
  }

  function taskRestore(ctx: Ctx, args: Args): void {
    const id = onlyId(args);
    const row = getRow(ctx.db, ENTITIES.task, id);
    if (!row || roleOf(ctx.db, ctx.userId, row.project_id) === null) fail('NOT_FOUND', 'task.id: taak bestaat niet');
    if (row.is_deleted === 0) return; // al terug (of nooit weg): niets te doen
    checkMayRestore(ctx, row, row.project_id, ['task_delete', 'section_delete', 'project_delete'], 'task.id: de taak');
    let sectionId: string | null = (row.section_id as string | null) ?? null;
    if (row.parent_id) {
      const parent = getRow(ctx.db, ENTITIES.task, row.parent_id as string);
      if (!parent || parent.is_deleted === 1) fail('CONFLICT', 'de bovenliggende taak is verwijderd; zet die eerst terug');
      if (parent.project_id !== row.project_id) fail('CONFLICT', 'de bovenliggende taak staat intussen in een ander project');
      sectionId = (parent.section_id as string | null) ?? null; // een subtaak volgt de sectie van haar ouder
    } else if (sectionId !== null) {
      const section = getRow(ctx.db, ENTITIES.section, sectionId);
      if (!section || section.is_deleted === 1) fail('CONFLICT', 'de sectie van deze taak is verwijderd; zet die eerst terug');
    }
    restoreTasks(ctx, deletedTree(ctx.db, id, row.rev as number), row.rev as number, row.project_id as string, sectionId);
    activity.record(ctx, row.project_id as string, 'task_restored', { task_id: id, title: row.content });
  }

  function sectionRestore(ctx: Ctx, args: Args): void {
    const id = onlyId(args);
    const row = getRow(ctx.db, ENTITIES.section, id);
    if (!row || roleOf(ctx.db, ctx.userId, row.project_id) === null) fail('NOT_FOUND', 'section.id: sectie bestaat niet');
    if (row.is_deleted === 0) return;
    checkMayRestore(ctx, row, row.project_id, ['section_delete', 'project_delete'], 'section.id: de sectie');
    const projectId = row.project_id as string;
    quota(ctx, `sections:${projectId}`, LIMITS.sectionsPerProject, 'secties per project', () => countOf(ctx.db, 'SELECT COUNT(*) AS n FROM sections WHERE project_id = ? AND is_deleted = 0', projectId));
    ctx.db.prepare('UPDATE sections SET is_deleted = 0, rev = ?, updated_at = ? WHERE id = ?').run(ctx.rev, ctx.now, id);
    const ids = (ctx.db.prepare('SELECT id FROM tasks WHERE is_deleted = 1 AND rev = ? AND section_id = ?').all(row.rev as number, id) as Row[]).map((r) => r.id as string);
    if (ids.length > 0) restoreTasks(ctx, ids, row.rev as number, projectId, undefined);
    activity.record(ctx, projectId, 'section_restored', { section_id: id, title: row.name });
  }

  return { task_restore: taskRestore, section_restore: sectionRestore };
}
