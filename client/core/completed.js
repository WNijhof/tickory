// Het overzicht "Voltooid": alle afgevinkte taken, nieuwste eerst, gegroepeerd per dag van afvinken, voor één project of voor alle.
// Geen scherm. De client heeft alle taken lokaal; een lijst van duizenden voltooide taken blijft vlot doordat het scherm er
// maar een deel van tekent (`completedGroups` met een grens, de rest via "Meer tonen").
//
// Wat erin hoort: afgevinkte taken uit projecten waar je nu lid van bent en die niet gearchiveerd zijn. Een terugkerende taak blijft na
// afvinken open met de volgende datum; die afvinkingen komen van de server (`GET /api/v1/completed/recurring`, uit het logboek) en
// staan met `recurringEntries` op hun dag tussen de rest.

import { addDays, clockText, todayString } from './format.js';
import { addMonths, endOfMonth, startOfCalendarWeek, startOfMonth } from './calendar.js';
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
  return clockText(`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`);
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

/**
 * De afvinkingen van terugkerende taken (van de server) die hier horen: uit een project dat je ziet en niet gearchiveerd is, eventueel
 * van één project, en met de zoekterm in de titel. Elk krijgt `completed_at` (het tijdstip) en `recurring: true`.
 */
export function recurringEntries(view, entries, { projectId = null, query = '' } = {}) {
  const folded = foldText(String(query ?? '').trim());
  const out = [];
  for (const e of entries ?? []) {
    if (!e || typeof e.task_id !== 'string' || typeof e.at !== 'string') continue;
    if (projectId && e.project_id !== projectId) continue;
    if (!view.projects.has(e.project_id) || isArchivedProject(view, e.project_id)) continue;
    if (folded && !foldText(String(e.title ?? '')).includes(folded)) continue;
    out.push({ ...e, completed_at: e.at, recurring: true });
  }
  return out;
}

// ---------- een periode kiezen ----------

/** De perioden in de keuzelijst; 'custom' is een eigen begin- en einddag. */
export const PERIODS = Object.freeze(['all', 'today', 'yesterday', 'week', 'lastWeek', 'month', 'lastMonth', 'custom']);

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * De eerste en laatste dag (JJJJ-MM-DD, beide inclusief) van een periode rond `today`, of null voor "alles". De week begint op de dag
 * uit Instellingen › Algemeen (zoals de kalender). Bij 'custom' komen `from` en `to` uit de keuze; een lege kant is open, en staan ze
 * verkeerd om, dan worden ze omgedraaid.
 * @returns {{ from: string | null, to: string | null } | null}
 */
export function periodRange(period, today, { from = '', to = '' } = {}) {
  switch (period) {
    case 'today': return { from: today, to: today };
    case 'yesterday': { const y = addDays(today, -1); return { from: y, to: y }; }
    case 'week': { const start = startOfCalendarWeek(today); return { from: start, to: addDays(start, 6) }; }
    case 'lastWeek': { const start = addDays(startOfCalendarWeek(today), -7); return { from: start, to: addDays(start, 6) }; }
    case 'month': return { from: startOfMonth(today), to: endOfMonth(today) };
    case 'lastMonth': { const prev = addMonths(startOfMonth(today), -1); return { from: prev, to: endOfMonth(prev) }; }
    case 'custom': {
      let a = DAY.test(from) ? from : null;
      let b = DAY.test(to) ? to : null;
      if (a && b && a > b) [a, b] = [b, a];
      return a || b ? { from: a, to: b } : null;
    }
    default: return null;
  }
}

/** Alleen wat binnen de periode is afgevinkt (de dag van afvinken op dit apparaat). Zonder periode: alles. */
export function inPeriod(items, range) {
  if (!range) return items;
  return items.filter((x) => {
    const day = completedDay(x.completed_at);
    return day !== null && (!range.from || day >= range.from) && (!range.to || day <= range.to);
  });
}

/** Voltooide taken en afvinkingen van terugkerende taken samen, de nieuwste eerst. */
export const mergeCompleted = (tasks, entries) => [...tasks, ...entries].sort(newestFirst);

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
