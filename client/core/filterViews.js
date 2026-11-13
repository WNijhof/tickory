// De inhoud van de schermen voor labels en filters, als gewone gegevens (geen scherm): welke taken horen bij een label,
// wat levert een filter op (of welke fout), en hoeveel taken zijn dat. Alleen lezen.

import { evaluateFilter, sortTasks } from './filter.js';

/**
 * De taken met een label: open taken (en met `showCompleted` ook de afgevinkte), in de volgorde van de overzichten. Taken in
 * een gearchiveerd project doen niet mee.
 * @returns {{ tasks: object[], completedCount: number }}
 */
export function labelTasks(view, labelId, { showCompleted = false } = {}) {
  const archived = new Set();
  for (const p of view.projects.values()) if (p.is_archived) archived.add(p.id);
  const open = [];
  const done = [];
  for (const t of view.tasks.values()) {
    if (t.is_deleted || archived.has(t.project_id) || !(t.labels ?? []).includes(labelId)) continue;
    (t.checked ? done : open).push(t);
  }
  return { tasks: sortTasks(showCompleted ? [...open, ...done] : open, view), completedCount: done.length };
}

/**
 * Wat een opgeslagen filter nu oplevert (zie evaluateFilter): `{ ok: true, tasks, groups, includesCompleted, count }` of
 * `{ ok: false, error }`.
 * @param {{ query: string }} filter
 * @param {{ view: object, now?: Date, userId?: string | null, users?: object[] }} ctx
 */
export function filterOutcome(filter, ctx) {
  const outcome = evaluateFilter(filter.query, ctx);
  return outcome.ok ? { ...outcome, count: outcome.tasks.length } : outcome;
}
