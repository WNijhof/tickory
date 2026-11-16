// De rekenkant van de tijdlijn (SPEC 5o): een dag of een week met uren, waarin taken met een tijd op hun plek staan met hun duur
// als hoogte, taken zonder tijd bovenaan per dag, en de zijbalk "In te plannen" met taken zonder datum (en wat te laat is).
// Geen scherm en geen tijdzone: tijden zijn minuten na middernacht, datums 'YYYY-MM-DD' (zie core/calendar.js voor de dagen).
//
// Overlappende taken op een dag komen naast elkaar te staan: elke groep taken die elkaar (via elkaar) overlapt, krijgt zoveel
// kolommen als er tegelijk lopen, en elke taak de eerste vrije kolom. Een taak zonder duur telt als DEFAULT_MINUTES lang.

import { occurrences, visibleRange, weekDays } from './calendar.js';

/** Hoe lang een taak met een tijd maar zonder duur op de tijdlijn staat. */
export const DEFAULT_MINUTES = 30;
/** Op hoeveel minuten slepen en klikken in de tijdlijn afronden. */
export const SNAP_MINUTES = 15;
export const DAY_MINUTES = 24 * 60;
/** Het uur waar de tijdlijn standaard heen scrolt (als er die dag niets eerder staat). */
export const DEFAULT_SCROLL_HOUR = 8;

/** "HH:MM" als minuten na middernacht; ongeldig geeft null. */
export function minutesOf(hhmm) {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm ?? '');
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
}

/** Minuten na middernacht als "HH:MM" (binnen de dag gehouden). */
export function hhmmOf(minutes) {
  const m = Math.max(0, Math.min(DAY_MINUTES - 1, Math.round(minutes)));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** Afronden op SNAP_MINUTES, binnen de dag (het laatste blok begint uiterlijk om 23:45). */
export const snap = (minutes, step = SNAP_MINUTES) => Math.max(0, Math.min(DAY_MINUTES - step, Math.round(minutes / step) * step));

/** De dagen van de tijdlijn: alleen `anchor` ('day') of de kalenderweek ervan ('week'). */
export const timelineDays = (mode, anchor) => (mode === 'day' ? [anchor.slice(0, 10)] : weekDays(anchor));

/**
 * Plaatst de taken met een tijd van één dag: begin, einde en kolom.
 * @param {{ start: number, end: number }[]} entries
 * @returns {{ column: number, columns: number }[]} per entry (in dezelfde volgorde)
 */
export function layoutColumns(entries) {
  const order = entries.map((e, i) => ({ ...e, i })).sort((a, b) => a.start - b.start || b.end - a.end || a.i - b.i);
  const out = new Array(entries.length);
  let group = [];
  let groupEnd = -1;
  let columnsEnd = []; // per kolom: tot wanneer hij bezet is
  const close = () => {
    const columns = Math.max(1, columnsEnd.length);
    for (const g of group) out[g.i] = { column: g.column, columns };
    group = [];
    columnsEnd = [];
  };
  for (const e of order) {
    if (group.length > 0 && e.start >= groupEnd) close();
    let column = columnsEnd.findIndex((end) => end <= e.start);
    if (column === -1) { column = columnsEnd.length; columnsEnd.push(e.end); } else columnsEnd[column] = e.end;
    group.push({ i: e.i, column });
    groupEnd = Math.max(groupEnd, e.end);
  }
  if (group.length > 0) close();
  return out;
}

/**
 * Wat de tijdlijn toont.
 * @param {{ tasks: Iterable<object>, mode: 'day' | 'week', anchor: string, today: string }} input
 * @returns {{
 *   days: { date: string, allDay: object[], timed: { task: object, date: string, start: number, end: number, real: boolean, column: number, columns: number }[] }[],
 *   unscheduled: object[], overdue: object[], earliest: number | null,
 * }}
 */
export function timelineModel({ tasks, mode, anchor, today }) {
  const days = timelineDays(mode, anchor);
  const from = days[0];
  const to = days[days.length - 1];
  const per = new Map(days.map((d) => [d, { date: d, allDay: [], timed: [] }]));
  const unscheduled = [];
  const overdue = [];
  for (const task of tasks) {
    if (task.checked) continue;
    if (!task.due) { if (!task.parent_id) unscheduled.push(task); continue; }
    if (task.due.date.slice(0, 10) < today) overdue.push(task);
    for (const o of occurrences(task, from, to)) {
      const day = per.get(o.date);
      if (!day) continue;
      const start = minutesOf(o.time);
      if (start === null) { day.allDay.push({ task, date: o.date, real: o.real }); continue; }
      const length = task.duration > 0 ? task.duration : DEFAULT_MINUTES;
      day.timed.push({ task, date: o.date, start, end: Math.min(DAY_MINUTES, start + length), real: o.real });
    }
  }
  let earliest = null;
  for (const day of per.values()) {
    day.timed.sort((a, b) => a.start - b.start || (a.task.priority ?? 4) - (b.task.priority ?? 4) || (a.task.id < b.task.id ? -1 : 1));
    const placed = layoutColumns(day.timed);
    day.timed.forEach((e, i) => Object.assign(e, placed[i]));
    day.allDay.sort((a, b) => (a.task.priority ?? 4) - (b.task.priority ?? 4) || ((a.task.order_key ?? '') < (b.task.order_key ?? '') ? -1 : 1));
    if (day.timed.length > 0) earliest = Math.min(earliest ?? DAY_MINUTES, day.timed[0].start);
  }
  const byOrder = (a, b) => ((a.order_key ?? '') < (b.order_key ?? '') ? -1 : (a.order_key ?? '') > (b.order_key ?? '') ? 1 : 0);
  unscheduled.sort((a, b) => (a.priority ?? 4) - (b.priority ?? 4) || byOrder(a, b));
  overdue.sort((a, b) => (a.due.date < b.due.date ? -1 : a.due.date > b.due.date ? 1 : 0));
  return { days: days.map((d) => per.get(d)), unscheduled, overdue, earliest };
}

/**
 * De nieuwe `due` als je een taak op de tijdlijn naar `date` om `minutes` zet: de tijd verandert, een herhaling blijft herhalen
 * (zoals reschedule in core/quickDates.js), de oude tekst ("morgen om 9 uur") vervalt.
 */
export function dueAt(due, date, minutes) {
  const next = { date: `${date}T${hhmmOf(minutes)}` };
  if (due?.recurrence) {
    next.recurrence = due.recurrence;
    if (due.string) next.string = due.string;
    if (due.lang) next.lang = due.lang;
  }
  return next;
}

/** Het bereik van de tijdlijn voor de kop ("16 – 22 nov" of één dag), zoals de kalender het rekent. */
export const timelineRange = (mode, anchor) => (mode === 'day' ? { from: anchor.slice(0, 10), to: anchor.slice(0, 10) } : visibleRange('week', anchor));
