// Het activiteitenlogboek per project: wie deed wat en wanneer (zie SPEC.md, hoofdstuk 5f, en shared/activity.js).
//
// De sync-engine (sync.ts) roept `record` aan in hetzelfde savepoint als het commando: mislukt het commando, dan staat er ook
// niets in het logboek. Het logboek gaat niet mee in de sync (dan zou elke delta groeien met iets wat je zelden bekijkt), maar
// heeft een eigen eindpunt: `GET /api/v1/projects/<id>/activity` (`listActivity`). Regels:
//   - alleen wie het project nu ziet, leest het logboek (ook een lezer); een oud-lid of een vreemde krijgt NOT_FOUND, net als
//     voor een project dat niet bestaat;
//   - een regel bewaart verwijzingen en een korte titel, nooit de tekst van een beschrijving of opmerking, en niets privés
//     (herinneringen, plaatsen, labels, filters en sjablonen komen er niet in);
//   - een verwijderd project neemt zijn logboek mee; na ACTIVITY_RETENTION_DAYS of boven MAX_ACTIVITY_PER_PROJECT regels per
//     project gaan de oudste weg.

import type { DatabaseSync } from 'node:sqlite';
import { ID_RE } from './schema.ts';
import { fail } from './rows.ts';
import type { Ctx, Row } from './rows.ts';
import { ACTIVITY_RETENTION_DAYS, MAX_ACTIVITY_PER_PROJECT, parseActivityQuery, shortTitle } from '../shared/activity.js';

export interface ActivityRef {
  task_id?: string | null;
  section_id?: string | null;
  comment_id?: string | null;
  attachment_id?: string | null;
  user_id?: string | null;
  title?: unknown;
  extra?: Record<string, unknown> | null;
}

export interface ActivityEntry {
  id: string; at: string; actor_id: string | null; kind: string;
  task_id: string | null; section_id: string | null; comment_id: string | null; attachment_id: string | null; user_id: string | null;
  title: string | null; extra: Record<string, unknown> | null;
}

/** Legt één regel vast voor `projectId`, namens de gebruiker van het commando. */
export function record(ctx: Ctx, projectId: string, kind: string, ref: ActivityRef = {}): void {
  ctx.db
    .prepare('INSERT INTO activity (project_id, at, actor_id, kind, task_id, section_id, comment_id, attachment_id, user_id, title, extra) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(
      projectId, ctx.now, ctx.userId, kind, ref.task_id ?? null, ref.section_id ?? null, ref.comment_id ?? null, ref.attachment_id ?? null,
      ref.user_id ?? null, shortTitle(ref.title) ?? null, ref.extra ? JSON.stringify(ref.extra) : null,
    );
  ctx.activity?.add(projectId);
}

/** Een verwijderd project neemt zijn logboek mee (het logboek gaat niet via de sync, dus er hoeft geen verwijdering mee). */
export function forgetProject(ctx: Ctx, projectId: string): void {
  ctx.db.prepare('DELETE FROM activity WHERE project_id = ?').run(projectId);
}

/** Per project hooguit MAX_ACTIVITY_PER_PROJECT regels: wat er boven valt (de oudste), gaat weg. Eén keer per verzoek, per geraakt project. */
export function capProjects(db: DatabaseSync, projects: Iterable<string>, max: number = MAX_ACTIVITY_PER_PROJECT): number {
  let removed = 0;
  const edge = db.prepare('SELECT seq FROM activity WHERE project_id = ? ORDER BY seq DESC LIMIT 1 OFFSET ?');
  const drop = db.prepare('DELETE FROM activity WHERE project_id = ? AND seq <= ?');
  for (const p of projects) {
    const row = edge.get(p, max) as Row | undefined;
    if (row) removed += Number(drop.run(p, row.seq as number).changes);
  }
  return removed;
}

/** Regels ouder dan de bewaartermijn gaan weg. */
export function pruneActivity(db: DatabaseSync, nowMs: number = Date.now()): number {
  const cutoff = new Date(nowMs - ACTIVITY_RETENTION_DAYS * 86_400_000).toISOString();
  return Number(db.prepare('DELETE FROM activity WHERE at < ?').run(cutoff).changes);
}

const toEntry = (r: Row): ActivityEntry => ({
  id: String(r.seq), at: r.at as string, actor_id: (r.actor_id as string | null) ?? null, kind: r.kind as string,
  task_id: (r.task_id as string | null) ?? null, section_id: (r.section_id as string | null) ?? null, comment_id: (r.comment_id as string | null) ?? null,
  attachment_id: (r.attachment_id as string | null) ?? null, user_id: (r.user_id as string | null) ?? null, title: (r.title as string | null) ?? null,
  extra: r.extra ? (JSON.parse(r.extra as string) as Record<string, unknown>) : null,
});

/**
 * Eén pagina van het logboek, de nieuwste eerst. `next` is de cursor voor de volgende (oudere) pagina, of null.
 * Alleen voor wie nu lid is van het project (elke rol); anders, en voor een onbekend of verwijderd project, NOT_FOUND.
 */
export function listActivity(db: DatabaseSync, userId: string, projectId: string, query: { before?: string | null; limit?: string | null; kinds?: string | null }): { entries: ActivityEntry[]; next: string | null } {
  if (!ID_RE.test(projectId)) fail('NOT_FOUND', 'dit project bestaat niet');
  const member = db.prepare(`SELECT 1 FROM project_members m JOIN projects p ON p.id = m.project_id
                             WHERE m.project_id = ? AND m.user_id = ? AND m.is_deleted = 0 AND p.is_deleted = 0`).get(projectId, userId);
  if (!member) fail('NOT_FOUND', 'dit project bestaat niet');
  const q = parseActivityQuery(query);
  if ('error' in q) fail('INVALID_ARG', q.error as string);
  const where = ['project_id = ?'];
  const params: (string | number)[] = [projectId];
  if (q.before !== null) { where.push('seq < ?'); params.push(q.before); }
  if (q.kinds) { where.push(`kind IN (${q.kinds.map(() => '?').join(', ')})`); params.push(...q.kinds); }
  const rows = db.prepare(`SELECT * FROM activity WHERE ${where.join(' AND ')} ORDER BY seq DESC LIMIT ?`).all(...params, q.limit + 1) as Row[];
  const more = rows.length > q.limit;
  const entries = rows.slice(0, q.limit).map(toEntry);
  return { entries, next: more ? entries[entries.length - 1].id : null };
}
