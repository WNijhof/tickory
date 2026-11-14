// Het overzicht "Voltooid": alle afgevinkte taken, nieuwste eerst, gegroepeerd per dag van afvinken, voor één project of voor alle.
// Geen scherm. De client heeft alle taken lokaal; een lijst van duizenden voltooide taken blijft vlot doordat het scherm er
// maar een deel van tekent (`completedGroups` met een grens, de rest via "Meer tonen").
//
// Wat erin hoort: afgevinkte taken uit projecten waar je nu lid van bent en die niet gearchiveerd zijn. Wat er niet in kan staan:
// een terugkerende taak, want die blijft na afvinken open met de volgende datum (alleen de teller `completed_count` loopt op).

import { todayString } from './format.js';
import { foldedField, foldText } from './fold.js';
import { isArchivedProject } from './selectors.js';

/** De dag (JJJJ-MM-DD) waarop een taak is afgevinkt, in de tijdzone van dit apparaat. Het tijdstip komt van de server als UTC; zonder geldig tijdstip null. */
export function completedDay(iso) {
  const ms = Date.parse(iso ?? '');
  return Number.isNaN(ms) ? null : todayString(new Date(ms));
}

/** Het tijdstip van afvinken als "14:05" in de tijdzone van dit apparaat, of ''. */
export function completedTime(iso) {
  const ms = Date.parse(iso ?? '');
  if (Number.isNaN(ms)) return '';
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const newestFirst = (a, b) => {
  const x = Date.parse(a.completed_at ?? '') || 0;
  const y = Date.parse(b.completed_at ?? '') || 0;
  return y - x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
};

/**
 * De voltooide taken, nieuwste eerst. Een subtaak die samen met zijn ouder is afgevinkt blijft weg (de ouder staat er al); een subtaak van
 * een nog open taak staat er wel.
 * @param {{ projectId?: string | null, query?: string, userId?: string | null }} [options] `query`: hoofdletter- en accentongevoelig, in titel en beschrijving
 */
export function completedTasks(view, { projectId = null, query = '', userId = null } = {}) {
  const folded = foldText(String(query ?? '').trim());
  const member = new Set();
  if (userId) for (const m of view.members.values()) if (m.user_id === userId) member.add(m.project_id);
  const archived = new Map();
  const isArchived = (id) => {
    if (!archived.has(id)) archived.set(id, isArchivedProject(view, id));
    return archived.get(id);
  };
  const out = [];
  for (const task of view.tasks.values()) {
    if (!task.checked) continue;
    if (projectId && task.project_id !== projectId) continue;
    if (!view.projects.has(task.project_id) || isArchived(task.project_id)) continue;
    if (userId && member.size > 0 && !member.has(task.project_id)) continue;
    if (task.parent_id && view.tasks.get(task.parent_id)?.checked) continue;
    if (folded && !`${foldedField(task, 'content')}\n${foldedField(task, 'description')}`.includes(folded)) continue;
    out.push(task);
  }
  return out.sort(newestFirst);
}

/** Per project: hoeveel voltooide taken (voor de keuzelijst), de meeste eerst. Zonder zoekopdracht en zonder projectfilter. */
export function completedProjects(view, { userId = null } = {}) {
  const counts = new Map();
  for (const task of completedTasks(view, { userId })) counts.set(task.project_id, (counts.get(task.project_id) ?? 0) + 1);
  return [...counts.entries()]
    .map(([id, count]) => ({ project: view.projects.get(id), count }))
    .sort((a, b) => b.count - a.count || (a.project.name < b.project.name ? -1 : 1));
}

/**
 * Groepeert (al gesorteerde) voltooide taken per dag van afvinken, hooguit `limit` taken in totaal.
 * @returns {{ groups: { day: string | null, tasks: object[] }[], shown: number, total: number }}
 */
export function completedGroups(tasks, { limit = 100 } = {}) {
  const groups = [];
  const shown = tasks.slice(0, limit);
  for (const task of shown) {
    const day = completedDay(task.completed_at);
    const last = groups.at(-1);
    if (last && last.day === day) last.tasks.push(task);
    else groups.push({ day, tasks: [task] });
  }
  return { groups, shown: shown.length, total: tasks.length };
}
