// Het productiviteitsoverzicht (SPEC.md, hoofdstuk 5g): hoeveel taken de gebruiker zelf per dag afvinkte, per project, uit het
// activiteitenlogboek (activity.ts). Eén eindpunt, `GET /api/v1/stats?days=<1-180>&tz=<IANA-naam>`, alleen voor jezelf:
//   - alleen je eigen regels (`actor_id` = jij), `task_completed` en `task_uncompleted`; wat anderen deden komt er nooit in, ook
//     niet in de telling per project;
//   - alleen uit projecten die je nu ziet (lid in elke rol, project niet verwijderd), zoals het logboek zelf;
//   - de dagen in de tijdzone uit `tz` (de web-app geeft die van het apparaat mee), anders `settings.timezone`, anders UTC.
// De telling zelf (heropenen schrapt de laatste afvinking, dagen in een tijdzone) staat in shared/stats.js, zodat de demo precies
// hetzelfde rekent.

import type { DatabaseSync } from 'node:sqlite';
import { fail } from './rows.ts';
import { isTimeZone, parseStatsQuery, statsSince, tallyCompletions } from '../shared/stats.js';

export type StatsAnswer = ReturnType<typeof tallyCompletions>;

/** Het overzicht voor `userId`. Een ongeldige `days` of `tz` is INVALID_ARG (HTTP 400). */
export function myStats(db: DatabaseSync, userId: string, query: { days?: string | null; tz?: string | null }, nowMs: number = Date.now()): StatsAnswer {
  const q = parseStatsQuery(query);
  if ('error' in q) fail('INVALID_ARG', q.error as string);
  let tz = q.tz as string | null;
  if (!tz) {
    const row = db.prepare('SELECT timezone FROM user_settings WHERE owner_id = ?').get(userId) as { timezone: string | null } | undefined;
    tz = row?.timezone && isTimeZone(row.timezone) ? row.timezone : 'UTC';
  }
  const entries = db.prepare(`SELECT a.at, a.kind, a.task_id, a.project_id FROM activity a
    WHERE a.actor_id = ? AND a.kind IN ('task_completed', 'task_uncompleted') AND a.at >= ?
      AND a.project_id IN (SELECT m.project_id FROM project_members m JOIN projects p ON p.id = m.project_id
                           WHERE m.user_id = ? AND m.is_deleted = 0 AND p.is_deleted = 0)
    ORDER BY a.seq`).all(userId, statsSince(nowMs, q.days as number), userId) as { at: string; kind: string; task_id: string | null; project_id: string }[];
  return tallyCompletions(entries, { tz, nowMs, days: q.days as number });
}

/** Zoveel afvinkingen van terugkerende taken geeft `recurringCompletions` hooguit terug. */
export const RECURRING_LIMIT = 500;

/**
 * Afvinkingen van terugkerende taken (`GET /api/v1/completed/recurring?days=<1-180>`), voor het overzicht Voltooid. Zo'n taak blijft
 * na afvinken open met de volgende datum, dus als afgevinkte taak bestaat ze nergens; het logboek (activity.ts) houdt elke keer bij.
 * Van iedereen, maar alleen uit projecten waar je nu lid van bent (zoals het logboek zelf), de nieuwste eerst. Een afvinking die
 * daarna is teruggedraaid (`task_uncompleted` van dezelfde taak, later) telt niet.
 */
export function recurringCompletions(db: DatabaseSync, userId: string, query: { days?: string | null }, nowMs: number = Date.now()) {
  const q = parseStatsQuery({ days: query.days ?? null, tz: null });
  if ('error' in q) fail('INVALID_ARG', q.error as string);
  const rows = db.prepare(`SELECT a.seq, a.at, a.kind, a.task_id, a.project_id, a.actor_id, a.title, a.extra FROM activity a
    WHERE a.kind IN ('task_completed', 'task_uncompleted') AND a.at >= ?
      AND a.project_id IN (SELECT m.project_id FROM project_members m JOIN projects p ON p.id = m.project_id
                           WHERE m.user_id = ? AND m.is_deleted = 0 AND p.is_deleted = 0)
    ORDER BY a.seq DESC LIMIT ?`).all(statsSince(nowMs, q.days as number), userId, RECURRING_LIMIT * 4) as {
      seq: number; at: string; kind: string; task_id: string | null; project_id: string; actor_id: string | null; title: string | null; extra: string | null;
    }[];
  const undone = new Map<string, number>(); // taak -> hoeveel latere "heropend" nog een afvinking schrappen
  const entries = [];
  for (const r of rows) {
    if (!r.task_id) continue;
    if (r.kind === 'task_uncompleted') { undone.set(r.task_id, (undone.get(r.task_id) ?? 0) + 1); continue; }
    if ((undone.get(r.task_id) ?? 0) > 0) { undone.set(r.task_id, undone.get(r.task_id)! - 1); continue; }
    let recurring = false;
    try { recurring = JSON.parse(r.extra ?? 'null')?.recurring === true; } catch { /* geen geldige extra */ }
    if (!recurring) continue;
    entries.push({ id: String(r.seq), task_id: r.task_id, project_id: r.project_id, actor_id: r.actor_id, title: r.title ?? '', at: r.at });
    if (entries.length >= RECURRING_LIMIT) break;
  }
  return { entries };
}
