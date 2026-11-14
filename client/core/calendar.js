// De rekenkant van de kalenderweergave: welke dagen staan er in een maand of week, welke weeknummers horen erbij, en op welke
// dagen valt een taak (ook een terugkerende, voor de komende voorkomens). Geen scherm, geen tijdzone: alle datums zijn
// 'YYYY-MM-DD' (of met 'THH:MM' erachter) en alles rekent in UTC, zodat zomertijd en de tijdzone van het apparaat nooit meetellen.
// Alleen `today` komt van buiten (de aanroeper bepaalt die in de tijdzone van het apparaat).
//
// De week begint op maandag. Weeknummers zijn ISO 8601: week 1 is de week met de eerste donderdag van het jaar, dus
// 1 januari kan nog in week 52 of 53 van het vorige jaar vallen en 31 december al in week 1 van het volgende.
// Namen van dagen en maanden komen uit `Intl` in de taal van de interface (de aanroeper geeft de locale mee).

import { nextOccurrence } from '../../shared/recurrence.js';
import { addDays } from './format.js';

/** Hoeveel voorkomens van een terugkerende taak we hooguit doorlopen (een dagelijkse taak die tien jaar te laat is, haalt dit nog net). */
export const MAX_OCCURRENCE_STEPS = 4000;

const utc = (day) => new Date(`${day.slice(0, 10)}T00:00:00Z`);
const iso = (date) => date.toISOString().slice(0, 10);
const pad = (n) => String(n).padStart(2, '0');

/** De weekdag volgens ISO: 1 = maandag … 7 = zondag. */
export const isoWeekday = (day) => utc(day).getUTCDay() || 7;

/** De maandag van de week waarin `day` valt. */
export const startOfWeek = (day) => addDays(day.slice(0, 10), 1 - isoWeekday(day));

/** De eerste dag van de maand van `day`. */
export const startOfMonth = (day) => `${day.slice(0, 7)}-01`;

/** De laatste dag van de maand van `day` (schrikkeljaar inbegrepen). */
export function endOfMonth(day) {
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7));
  return iso(new Date(Date.UTC(y, m, 0)));
}

/** `n` maanden verder (of terug), met dezelfde dag van de maand of de laatste dag als die maand korter is (31 jan + 1 maand = 28 of 29 feb). */
export function addMonths(day, n) {
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7)) - 1;
  const d = Number(day.slice(8, 10));
  const total = y * 12 + m + n;
  const ny = Math.floor(total / 12);
  const nm = total % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${String(ny).padStart(4, '0')}-${pad(nm + 1)}-${pad(Math.min(d, last))}`;
}

/** Het ISO-weeknummer en het jaar waar die week bij hoort (kan afwijken van het jaar van de datum). */
export function isoWeek(day) {
  const thursday = utc(addDays(day.slice(0, 10), 4 - isoWeekday(day)));
  const year = thursday.getUTCFullYear();
  const dayOfYear = Math.round((thursday - Date.UTC(year, 0, 1)) / 86_400_000);
  return { year, week: Math.floor(dayOfYear / 7) + 1 };
}

/** De zeven dagen van de week van `day`, maandag eerst. */
export function weekDays(day) {
  const monday = startOfWeek(day);
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

/**
 * De maand van `day` als hele weken (maandag tot en met zondag), zoals een maandkalender: 4 tot 6 rijen, met aan de randen
 * de dagen van de vorige en volgende maand.
 * @returns {{ month: string, weeks: { week: number, year: number, days: string[] }[] }} `month` is 'YYYY-MM'
 */
export function monthGrid(day) {
  const first = startOfMonth(day);
  const last = endOfMonth(day);
  const weeks = [];
  for (let monday = startOfWeek(first); monday <= last; monday = addDays(monday, 7)) {
    weeks.push({ ...isoWeek(monday), days: weekDays(monday) });
  }
  return { month: first.slice(0, 7), weeks };
}

/** Het zichtbare bereik: de eerste en laatste dag die het scherm toont ('month' met de randdagen, 'week' maandag tot zondag). */
export function visibleRange(mode, anchor) {
  if (mode === 'week') {
    const days = weekDays(anchor);
    return { from: days[0], to: days[6] };
  }
  const { weeks } = monthGrid(anchor);
  return { from: weeks[0].days[0], to: weeks[weeks.length - 1].days[6] };
}

/** Eén periode vooruit (`direction` 1) of terug (-1): een maand of een week. */
export function shiftPeriod(mode, anchor, direction) {
  return mode === 'week' ? addDays(anchor.slice(0, 10), 7 * direction) : addMonths(anchor.slice(0, 10), direction);
}

/**
 * De dagen waarop een taak in het bereik [from, to] valt. De eigen datum van de taak is echt (`real`); bij een herhaling komen
 * de volgende voorkomens erbij als `real: false`: die worden alleen getoond en nergens bewaard. Een taak zonder datum geeft niets.
 * @param {{ due?: { date: string, recurrence?: object } | null }} task
 * @returns {{ date: string, time: string | null, real: boolean }[]}
 */
export function occurrences(task, from, to) {
  const due = task?.due?.date;
  if (!due) return [];
  const out = [];
  const add = (stamp, real) => {
    const date = stamp.slice(0, 10);
    if (date >= from && date <= to) out.push({ date, time: stamp.length > 10 ? stamp.slice(11, 16) : null, real });
  };
  add(due, true);
  const rec = task.due.recurrence;
  if (!rec) return out;
  let current = due;
  try {
    for (let i = 0; i < MAX_OCCURRENCE_STEPS; i++) {
      const next = nextOccurrence(current, rec);
      if (next.slice(0, 10) <= current.slice(0, 10)) break; // stilstand: stop in plaats van eindeloos te lopen
      current = next;
      if (current.slice(0, 10) > to) break;
      add(current, false);
    }
  } catch { /* een herhaling die we niet kunnen lezen: alleen de eigen datum tonen */ }
  return out;
}

/** Volgorde binnen een dag: dag zonder tijd eerst, dan op tijd, dan op prioriteit (1 = hoogst), dan op eigen volgorde. */
function byDay(a, b) {
  if (a.time !== b.time) return a.time === null ? -1 : b.time === null ? 1 : a.time < b.time ? -1 : 1;
  if (a.task.priority !== b.task.priority) return (a.task.priority ?? 4) - (b.task.priority ?? 4);
  const ka = a.task.order_key ?? '';
  const kb = b.task.order_key ?? '';
  return ka < kb ? -1 : ka > kb ? 1 : a.task.id < b.task.id ? -1 : a.task.id > b.task.id ? 1 : 0;
}

/**
 * Wat de kalender toont voor een periode.
 * - `days`: elke dag van het bereik met zijn taken. Daar staan alleen openstaande taken van vandaag of later in: wat te laat is, staat apart.
 * - `overdue`: openstaande taken waarvan de (echte) datum voor vandaag ligt, oudste eerst. Voorkomens van een herhaling in het verleden
 *   tellen niet mee: de taak zelf schuift pas door als je haar afvinkt.
 * @param {{ tasks: Iterable<object>, mode: 'month' | 'week', anchor: string, today: string }} input
 * @returns {{ from: string, to: string, days: { date: string, entries: { task: object, date: string, time: string | null, real: boolean }[] }[], overdue: object[], total: number }}
 */
export function calendarModel({ tasks, mode, anchor, today }) {
  const { from, to } = visibleRange(mode, anchor);
  const perDay = new Map();
  const overdue = [];
  let total = 0;
  for (const task of tasks) {
    if (task.checked || !task.due) continue;
    if (task.due.date.slice(0, 10) < today) overdue.push(task);
    // het eerste bereik dat nodig is: vanaf vandaag (of het begin van het bereik als dat later ligt)
    for (const o of occurrences(task, from > today ? from : today, to)) {
      if (!perDay.has(o.date)) perDay.set(o.date, []);
      perDay.get(o.date).push({ task, ...o });
      total += 1;
    }
  }
  overdue.sort((a, b) => (a.due.date < b.due.date ? -1 : a.due.date > b.due.date ? 1 : byDay({ task: a, time: null }, { task: b, time: null })));
  const days = [];
  for (let day = from; day <= to; day = addDays(day, 1)) days.push({ date: day, entries: (perDay.get(day) ?? []).sort(byDay) });
  return { from, to, days, overdue, total };
}

// ---------- namen en titels (Intl, in de taal van de interface) ----------

const fmt = (locale, options, day) => new Intl.DateTimeFormat(locale, { timeZone: 'UTC', ...options }).format(utc(day));
const upperFirst = (text, locale) => (text ? text[0].toLocaleUpperCase(locale) + text.slice(1) : text);

/** De namen van de weekdagen, maandag eerst: 'short' ("ma") of 'long' ("maandag"). */
export function weekdayNames(locale, style = 'short') {
  const monday = '2024-01-01'; // een maandag
  return Array.from({ length: 7 }, (_, i) => fmt(locale, { weekday: style }, addDays(monday, i)));
}

/** De naam van een maand voluit ("november"), voor maand 1 tot en met 12. */
export const monthName = (locale, month) => fmt(locale, { month: 'long' }, `2024-${pad(month)}-01`);

/** De dag in een rijtje: "19 nov" ('dm'), "do 19 nov" ('short'), "donderdag 19 november" ('long') of met jaar ('full'). */
export function dayLabel(locale, day, style = 'short') {
  const options = {
    dm: { day: 'numeric', month: 'short' },
    short: { weekday: 'short', day: 'numeric', month: 'short' },
    long: { weekday: 'long', day: 'numeric', month: 'long' },
    full: { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' },
  }[style];
  return fmt(locale, options, day);
}

/** Kop boven de kalender: "November 2026" in de maandweergave, "9–15 nov 2026" in de weekweergave. */
export function periodTitle(mode, anchor, locale) {
  if (mode === 'week') {
    const days = weekDays(anchor);
    return new Intl.DateTimeFormat(locale, { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }).formatRange(utc(days[0]), utc(days[6]));
  }
  return upperFirst(fmt(locale, { month: 'long', year: 'numeric' }, anchor), locale);
}
