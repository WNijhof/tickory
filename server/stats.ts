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
